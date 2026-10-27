/**
 * UBT Query orchestration: derive a target, cache the two Query JSON documents, and hand the parsed
 * payload to the index layer.
 *
 * Two measurements drive this file:
 *
 * 1. **Query is expensive and asked for repeatedly.** `TargetDetails` for `LpEditor Win64 Development`
 *    costs ~6 s and 40 MB of JSON; `TargetModuleReferences` ~3 s. Agents ask the same build question
 *    dozens of times per session, so the JSON is cached in the pi cache dir
 *    (`<cache>/query/<target>.<platform>.<config>/`), never in the project tree (1.5 GB of build
 *    output is somebody else's problem) and never in git.
 *
 * 2. **`-NoIntellisense` voids the payload.** Measured: `dirToModule` survives, every
 *    `moduleToCompileSettings` entry (defines, include paths, compiler args) and every `modules`
 *    entry (source file lists) becomes `null`. The intellisense pass is what computes them, so this
 *    file never passes that flag — the first run pays ~17 s, every later run pays 0.
 *
 * A target never has to be typed: `pickTarget` derives it from the `.uproject` `Modules` section,
 * then plugin allowlists, then `*.Target.cs` files, then the engine editor target, and reports which
 * rule matched.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { joinPath, normalizePath, parentDir, baseName, realFs, type FsAdapter } from "./util.ts";
import { cacheDir } from "./cache.ts";
import { parseUproject } from "./descriptors.ts";
import { findProjectFile } from "./engine-resolver.ts";
import { discoverTargets, hostPlatform, parseModuleReferences, parseTargetDetails, pickDefaultTarget, readQueryJson, runQuery, type QueryName, type UbtModuleRefs, type TargetDetails } from "./ubt.ts";

export interface TargetChoice {
	target: string;
	platform: string;
	configuration: string;
	/** Which rule produced the target — printed so a wrong guess is visible, not silent. */
	source: "explicit" | "uproject-modules" | "plugin-allowlist" | "target-file" | "engine-editor" | "host-default";
	notes: string[];
}

export interface CachePaths {
	root: string;
	targetDetails: string;
	moduleReferences: string;
}

export interface QueryCacheState {
	paths: CachePaths;
	/** True when both documents exist and carry a payload (not the `-NoIntellisense` skeleton). */
	usable: boolean;
	targetDetails?: { path: string; bytes: number; ageMs: number };
	moduleReferences?: { path: string; bytes: number; ageMs: number };
	notes: string[];
}

export interface EnsureQueryInput {
	cacheRoot?: string;
	choice: TargetChoice;
	engineRoot?: string;
	projectPath?: string;
	refresh?: boolean;
	fs?: FsAdapter;
	onStdout?: (chunk: string) => void;
}

export interface EnsureQueryResult {
	paths?: CachePaths;
	source: "cache" | "query" | "missing";
	details?: TargetDetails;
	refs?: Map<string, UbtModuleRefs>;
	durationsMs: { targetDetails?: number; moduleReferences?: number };
	notes: string[];
	warnings: string[];
}

/* ───────────────────────────────────────────────────────────── target derivation */

/**
 * Derive (target, platform, configuration). Order of rules, first hit wins; the winning rule is
 * reported. Explicit arguments always win, so a caller that knows better is never argued with.
 */
export function pickTarget(options: { cwd: string; target?: string; platform?: string; configuration?: string; engineRoot?: string; fs?: FsAdapter }): TargetChoice {
	const fs = options.fs ?? realFs;
	const platform = options.platform ?? hostPlatform();
	const configuration = options.configuration ?? "Development";
	const notes: string[] = [];
	const projectPath = findProjectFile(options.cwd, fs);
	const projectDir = projectPath ? parentDir(projectPath) : undefined;
	const projectName = projectPath ? baseName(projectPath).replace(/\.uproject$/i, "") : undefined;
	const targets = discoverTargets({ projectDir, engineRoot: options.engineRoot, projectDepth: 3, fs });

	if (options.target) {
		const known = targets.some((t) => t.name.toLowerCase() === options.target!.toLowerCase());
		if (!known && projectDir) notes.push(`target '${options.target}' has no *.Target.cs under ${projectDir} (projectDir searched; a plugin or engine target may supply it)`);
		return { target: options.target, platform, configuration, source: "explicit", notes };
	}

	// 1. The .uproject Modules section: a project module's editor target is the normal answer.
	if (projectPath) {
		const descriptor = parseUproject(projectPath, fs);
		const modules = descriptor.modules.map((m) => m.moduleName);
		if (modules.length) {
		const editor = targets.find((t) => t.kind === "project" && modules.some((m) => t.name === `${m}Editor`) || t.kind === "project" && /editor$/i.test(t.name));
			const exact = targets.find((t) => t.kind === "project" && modules.includes(t.name));
			const chosen = editor ?? exact;
			if (chosen) {
				notes.push(`.uproject Modules = [${modules.join(", ")}] -> ${chosen.name}`);
				return { target: chosen.name, platform, configuration, source: "uproject-modules", notes };
			}
			notes.push(`.uproject Modules = [${modules.join(", ")}] but no matching *.Target.cs under ${projectDir ?? "?"}`);
		}

		// 2. Plugin allowlists: an enabled plugin whose name matches a project target.
		const enabled = descriptor.plugins.filter((p) => p.enabled !== false).map((p) => p.name);
		const fromPlugin = targets.find((t) => t.kind === "project" && enabled.some((name) => t.name.toLowerCase().startsWith(name.toLowerCase())));
		if (fromPlugin) {
			notes.push(`matched enabled plugin -> ${fromPlugin.name}`);
			return { target: fromPlugin.name, platform, configuration, source: "plugin-allowlist", notes };
		}
	}

	// 3. Any project target, then the engine editor target, then a host-specific guess.
	const projectTarget = pickDefaultTarget(targets.filter((t) => t.kind === "project"), projectName);
	if (projectTarget) {
		notes.push(`no .uproject Modules match; picked ${projectTarget.name} from *.Target.cs`);
		return { target: projectTarget.name, platform, configuration, source: "target-file", notes };
	}
	const engineEditor = targets.find((t) => t.kind === "engine" && /editor/i.test(t.name));
	if (engineEditor) {
		notes.push(`no project target; engine editor target ${engineEditor.name}`);
		return { target: engineEditor.name, platform, configuration, source: "engine-editor", notes };
	}
	// A guessed project target has no *.Target.cs to back it, so UBT would fail: report the
	// guess, and make the failure mode explicit in the note.
	const guess = `${projectName ?? "Target"}Editor`;
	notes.push(`no *.Target.cs found for this project; guessed ${guess} — if UBT reports an unknown target, pass 'target' explicitly`);
	return { target: guess, platform, configuration, source: "host-default", notes };
}

/* ──────────────────────────────────────────────────────────────────── the cache */

export function queryCachePaths(choice: TargetChoice, root = cacheDir()): CachePaths {
	const dir = joinPath(root, "query", `${choice.target}.${choice.platform}.${choice.configuration}`);
	return { root: dir, targetDetails: joinPath(dir, "TargetDetails.json"), moduleReferences: joinPath(dir, "TargetModuleReferences.json") };
}

/** Payload check, not existence check: a `-NoIntellisense` document exists and is worthless. */
function payloadOk(path: string, query: QueryName): boolean {
	if (!existsSync(path)) return false;
	try {
		const json = readQueryJson(path) as Record<string, unknown> | undefined;
		if (!json || typeof json !== "object") return false;
		if (query === "TargetDetails") {
			const settings = json.moduleToCompileSettings as Record<string, unknown> | undefined;
			return !!settings && Object.keys(settings).length > 0;
		}
		const modules = json.modules as Record<string, unknown> | undefined;
		return !!modules && Object.keys(modules).length > 0;
	} catch {
		return false;
	}
}

function describe(path: string) {
	const stat = statSync(path);
	return { path, bytes: stat.size, ageMs: Math.max(0, Date.now() - stat.mtimeMs) };
}

export function queryCacheState(root: string, choice: TargetChoice, fs: FsAdapter = realFs): QueryCacheState {
	void fs;
	const paths = queryCachePaths(choice, root);
	const notes: string[] = [];
	const targetDetails = existsSync(paths.targetDetails) ? describe(paths.targetDetails) : undefined;
	const moduleReferences = existsSync(paths.moduleReferences) ? describe(paths.moduleReferences) : undefined;
	const detailsOk = targetDetails ? payloadOk(paths.targetDetails, "TargetDetails") : false;
	const refsOk = moduleReferences ? payloadOk(paths.moduleReferences, "TargetModuleReferences") : false;
	if (targetDetails && !detailsOk) notes.push(`cached TargetDetails has no moduleToCompileSettings payload — it was produced with -NoIntellisense, refresh it`);
	if (moduleReferences && !refsOk) notes.push(`cached TargetModuleReferences has no modules payload — it was produced with -NoIntellisense, refresh it`);
	if (!targetDetails || !moduleReferences) notes.push(`query cache empty for ${choice.target} ${choice.platform} ${choice.configuration}; the first Query costs ~17 s`);
	return { paths, usable: detailsOk && refsOk, targetDetails, moduleReferences, notes };
}

/**
 * Return parsed Query data, running UBT only when the cache cannot serve the request.
 * `refresh` is the only way to re-run a usable cache; a missing cache is always filled.
 */
export async function ensureQueryJson(input: EnsureQueryInput): Promise<EnsureQueryResult> {
	const fs = input.fs ?? realFs;
	const root = input.cacheRoot ?? cacheDir(fs);
	const paths = queryCachePaths(input.choice, root);
	const notes: string[] = [];
	const warnings: string[] = [];
	const durationsMs: { targetDetails?: number; moduleReferences?: number } = {};
	const state = queryCacheState(root, input.choice, fs);
	notes.push(...state.notes);

	if (state.usable && !input.refresh) {
		const details = parseTargetDetails(readQueryJson(paths.targetDetails));
		const refs = parseModuleReferences(readQueryJson(paths.moduleReferences));
		notes.push(`query cache hit: ${Math.round((state.targetDetails?.bytes ?? 0) / 1024)} KB + ${Math.round((state.moduleReferences?.bytes ?? 0) / 1024)} KB, age ${humanAge(state.targetDetails?.ageMs ?? 0)}`);
		return { paths, source: "cache", details, refs, durationsMs, notes, warnings };
	}

	if (!input.engineRoot) {
		notes.push("no engine root resolved for this project, so Query cannot run");
		return { source: "missing", durationsMs, notes, warnings };
	}

	const identity = {
		target: input.choice.target,
		platform: input.choice.platform,
		configuration: input.choice.configuration,
		projectPath: input.projectPath,
	};
	try {
		mkdirSync(paths.root, { recursive: true });
	} catch (error) {
		warnings.push(`cannot create ${paths.root}: ${error instanceof Error ? error.message : String(error)}`);
		return { source: "missing", durationsMs, notes, warnings };
	}

	const run = async (query: QueryName, dest: string) => {
		const result = await runQuery({ ...identity, query, engineRoot: input.engineRoot!, outputPath: dest, fs, onStdout: input.onStdout });
		durationsMs[query === "TargetDetails" ? "targetDetails" : "moduleReferences"] = result.durationMs;
		if (result.json === undefined) {
			warnings.push(`${query} failed (exit ${result.exitCode}, ${humanAge(result.durationMs)}): ${result.notes.join(" ")}`);
			return undefined;
		}
		if (normalizePath(result.outputPath) !== normalizePath(dest)) {
			// UBT wrote where it wanted (its `Writing <path>` line); mirror it into the cache.
			try {
				mkdirSync(parentDir(dest) ?? paths.root, { recursive: true });
				writeFileSync(dest, readFileSync(result.outputPath, "utf8"), "utf8");
			} catch (error) {
				warnings.push(`${query}: cached copy failed (${error instanceof Error ? error.message : String(error)}); using ${result.outputPath}`);
			}
		}
		const ok = payloadOk(dest, query) || payloadOk(result.outputPath, query);
		if (!ok) warnings.push(`${query} produced JSON without a payload — UBT ran with intellisense disabled; rerun with refresh`);
		notes.push(`${query}: ${humanAge(result.durationMs)} via ${result.ubtPath}`);
		return result.json;
	};

	const detailsJson = await run("TargetDetails", paths.targetDetails);
	if (detailsJson === undefined) return { source: "missing", durationsMs, notes, warnings };
	const refsJson = await run("TargetModuleReferences", paths.moduleReferences);

	const details = parseTargetDetails(detailsJson);
	const refs = parseModuleReferences(refsJson ?? {});
	return { paths, source: "query", details, refs, durationsMs, notes, warnings };
}

/** Compact rendering of a target choice, for tool output and the context card. */
export function targetReport(choice: TargetChoice, state: QueryCacheState) {
	return {
		target: choice.target,
		platform: choice.platform,
		configuration: choice.configuration,
		derivedFrom: choice.source,
		notes: choice.notes,
		cache: { dir: state.paths.root, usable: state.usable, targetDetailsBytes: state.targetDetails?.bytes, moduleReferencesBytes: state.moduleReferences?.bytes, age: state.targetDetails ? humanAge(state.targetDetails.ageMs) : undefined, notes: state.notes },
	};
}

export function humanAge(ageMs: number): string {
	if (!Number.isFinite(ageMs)) return "unknown";
	const seconds = ageMs / 1000;
	if (seconds < 90) return `${Math.round(seconds)}s`;
	const minutes = seconds / 60;
	if (minutes < 90) return `${Math.round(minutes)}min`;
	const hours = minutes / 60;
	if (hours < 48) return `${Math.round(hours)}h`;
	return `${Math.round(hours / 24)}d`;
}
