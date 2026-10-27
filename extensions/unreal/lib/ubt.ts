/**
 * UnrealBuildTool as the source of build facts, in a shell, with no IDE and no compiler.
 *
 * UE 5.8 ships `Engine/Source/Programs/UnrealBuildTool/Modes/QueryMode.cs`, which answers questions
 * an agent keeps re-deriving by grepping:
 *
 *   TargetDetails            dirToModule (2,159 directories on a Lp/5.8 install) + per-module
 *                            includePaths / defines / standard / forcedIncludes / compilerPath /
 *                            compilerArgs / compilerAdditionalArgs / windowsSdkVersion (1,079 modules)
 *   TargetModuleReferences   per-module public / private / publicInclude / privateInclude /
 *                            dynamicallyLoaded / circular dependency lists
 *
 * Measured on this box (Lp, LpEditor/Win64/Development): TargetDetails 6.0 s (40.4 MB of JSON),
 * TargetModuleReferences 2.1 s (994 KB). They run in UBT's own `UnrealIntermediateEnvironment.Query`
 * environment, so they do not collide with a normal build's makefiles.
 *
 * Two measured traps:
 *   - `-NoIntellisense` makes TargetDetails return `dirToModule: null` and
 *     `moduleToCompileSettings: null` — the intellisense pass is what computes per-module compile
 *     settings, so the 2.6 s variant is a fast empty file. Never pass it here.
 *   - `defines` is `[]` for every module in TargetDetails. The real defines live in the
 *     `Definitions*.h` listed under `forcedIncludes` (e.g.
 *     `Engine/Intermediate/Build/Win64/x64/UnrealEditor/Development/Engine/Definitions.h`), so
 *     `unreal_context` reads that file instead of trusting the JSON field.
 *
 * Why not the IDE databases a UE developer already has: Visual Studio stores IntelliSense facts in
 * `Browse.VC.db`, which is SQLCipher-encrypted with no public API, and Rider resolves symbols
 * in-process over RiderLink with no CLI. Both derive from these same UBT target rules, so reading UBT
 * is the compiler-agnostic route — an MSVC-only box gets the facts a clang database would give,
 * including the real `cl.exe` path and `/std:` flag.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { joinPath, normalizePath, realFs, shortHash, type FsAdapter } from "./util.ts";

export interface UbtModuleSettings {
	includePaths: string[];
	/** Always empty in TargetDetails; the real defines are in `definesFile`. */
	defines: string[];
	standard: string;
	forcedIncludes: string[];
	compilerPath: string;
	compilerArgs: string[];
	compilerAdditionalArgs: { c: string[]; cpp: string[] };
	windowsSdkVersion: string;
	/** The `Definitions*.h` forced include that actually carries the module's defines. */
	definesFile: string;
}

export interface UbtModuleRefs {
	shortName: string;
	moduleDirectory: string;
	intermediateDirectory: string;
	public: string[];
	private: string[];
	publicInclude: string[];
	privateInclude: string[];
	dynamicallyLoaded: string[];
	circular: string[];
}

export interface UbtTargetIdentity {
	target: string;
	platform: string;
	configuration: string;
	projectPath?: string;
}

export interface TargetRef {
	name: string;
	kind: "project" | "engine";
	path: string;
}

export interface UbtBinary {
	path: string;
	kind: "exe" | "bat" | "sh";
}

export type QueryName = "TargetDetails" | "TargetModuleReferences";

export interface QueryOptions extends UbtTargetIdentity {
	query: QueryName;
	engineRoot: string;
	outputPath?: string;
	timeoutMs?: number;
	fs?: FsAdapter;
	spawnImpl?: typeof spawn;
	onStdout?: (chunk: string) => void;
}

export interface QueryResult {
	json: unknown;
	/** Where the JSON came from (UBT's own `Writing <path>` line wins over the requested path). */
	outputPath: string;
	stdout: string;
	exitCode: number;
	durationMs: number;
	ubtPath: string;
	args: string[];
	notes: string[];
}

export interface TargetDetails {
	dirModules: { prefix: string; module: string }[];
	settings: Map<string, UbtModuleSettings>;
	launch: { description?: string; binaryPath?: string; arguments: string[] };
	isTestTarget: boolean;
	/** Present when `-NoIntellisense` was used, or the query ran with no intellisense pass. */
	notes: string[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/* ──────────────────────────────────────────────────────────────────────────── discovery */

export function hostPlatform(platform = process.platform): string {
	if (platform === "win32") return "Win64";
	if (platform === "darwin") return "Mac";
	if (platform === "linux" || platform.startsWith("freebsd")) return "Linux";
	return "Win64";
}

/**
 * Locate a runnable UBT. Installed builds ship the precompiled .exe; source builds ship the batch
 * scripts (which compile UBT itself on first use, so they are the fallback, not the default).
 */
export function locateUbt(engineRoot: string, fs: FsAdapter = realFs): UbtBinary | undefined {
	const root = normalizePath(engineRoot);
	const candidates: UbtBinary[] = [
		{ path: joinPath(root, "Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.exe"), kind: "exe" },
		{ path: joinPath(root, "Engine/Build/BatchFiles/Build.bat"), kind: "bat" },
		{ path: joinPath(root, "Engine/Build/BatchFiles/Build.sh"), kind: "sh" },
	];
	return candidates.find((candidate) => fs.exists(candidate.path));
}

/**
 * Targets available near a project: `*.Target.cs` under the project's `Source/` (project targets,
 * e.g. `LpEditor`) and under `Engine/Source/Programs/*` (engine targets, e.g. `UnrealEditor`). The
 * file name minus `.Target.cs` is the target name, which is UBT's own rule.
 */
/**
 * Target inventory.
 *
 * `projectDepth` controls how deep the project scan goes: UE layouts put `*.Target.cs` next to
 * `Source/<Module>/`, one level under `Source`, so depth 1 is the norm. Engine `Programs/*`
 * targets are always one level deep.
 */
export function discoverTargets(input: { projectDir?: string; engineRoot?: string; projectDepth?: number; fs?: FsAdapter }): TargetRef[] {
	const fs = input.fs ?? realFs;
	const out: TargetRef[] = [];
	const skip = new Set(["Intermediate", "Binaries", "Saved", "ThirdParty"]);
	const push = (dir: string, kind: TargetRef["kind"], maxDepth: number) => {
		if (!dir) return;
		// Depth is tracked per directory: a single constant depth lets the walk reach leaves and
		// report nothing, which is how a project's `Source/<Target>/<Target>.Target.cs` gets missed.
		const queue: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
		while (queue.length) {
			const current = queue.shift()!;
			for (const name of fs.listDir(current.dir)) {
				const abs = normalizePath(joinPath(current.dir, name));
				if (fs.isDirectory(abs)) {
					if (current.depth < maxDepth && !skip.has(name)) queue.push({ dir: abs, depth: current.depth + 1 });
					continue;
				}
				const match = /^(.+)\.target\.cs$/i.exec(name);
				const targetName = match?.[1];
				if (targetName) out.push({ name: targetName, kind, path: abs });
			}
		}
	};
	if (input.projectDir) push(joinPath(normalizePath(input.projectDir), "Source"), "project", input.projectDepth ?? 1);
	if (input.engineRoot) push(joinPath(normalizePath(input.engineRoot), "Engine/Source/Programs"), "engine", 1);
	return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "project" ? -1 : 1));
}

/** Prefer the project's editor target (it compiles the editor modules an agent works on). */
export function pickDefaultTarget(targets: TargetRef[], projectName?: string): TargetRef | undefined {
	const byName = new Map(targets.map((target) => [target.name.toLowerCase(), target]));
	for (const name of projectName ? [`${projectName.toLowerCase()}editor`, projectName.toLowerCase()] : []) {
		const found = byName.get(name);
		if (found) return found;
	}
	return byName.get("unrealeditor") ?? targets.find((target) => target.kind === "project");
}

/** `-Mode=Query` argument list, in the order a human would type it. */
export function buildQueryArgs(input: QueryOptions & { outputPath: string }): string[] {
	const args = ["-Mode=Query", `-Query=${input.query}`, `-Target=${input.target}`, `-Platform=${input.platform}`, `-Configuration=${input.configuration}`];
	if (input.projectPath) args.push(`-Project=${input.projectPath}`);
	args.push(`-OutputPath=${input.outputPath}`);
	// Deliberately no -NoIntellisense: it nulls the payload (see the module header).
	return args;
}

/** Stable output path per (query, target identity), so a rerun overwrites instead of accumulating. */
export function queryOutputPath(query: QueryName, identity: UbtTargetIdentity, base = tmpdir()): string {
	const key = shortHash(`${identity.target}|${identity.platform}|${identity.configuration}|${identity.projectPath ?? "engine"}`);
	const dir = normalizePath(joinPath(base, "pi-unreal-ubt"));
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		/* best-effort: a failure surfaces as the missing-output note in runQuery */
	}
	return joinPath(dir, `${query}-${key}.json`);
}

/* ──────────────────────────────────────────────────────────────────────────── run */

/**
 * Run one UBT query and parse the JSON it writes. Failure is data, not an exception: `json` stays
 * `undefined` and `notes` carries the exit code plus UBT's last output lines, so the caller can keep
 * going with a heuristic index and report exactly why.
 */
export async function runQuery(input: QueryOptions): Promise<QueryResult> {
	const started = Date.now();
	const notes: string[] = [];
	const binary = locateUbt(input.engineRoot, input.fs ?? realFs);
	if (!binary) {
		return {
			json: undefined,
			outputPath: "",
			stdout: "",
			exitCode: -1,
			durationMs: 0,
			ubtPath: "",
			args: [],
			notes: [`no UnrealBuildTool under ${normalizePath(input.engineRoot)} (expected Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.exe, or Engine/Build/BatchFiles/Build.bat|.sh)`],
		};
	}

	const outputPath = input.outputPath ?? queryOutputPath(input.query, input);
	const args = buildQueryArgs({ ...input, outputPath });
	const spawnImpl = input.spawnImpl ?? spawn;
	// The .exe is spawned without a shell, so paths containing spaces ("Program Files") need no quoting.
	const child =
		binary.kind === "exe"
			? spawnImpl(binary.path, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
			: spawnImpl(`"${binary.path}"`, args.map(shellQuote), { windowsHide: true, shell: true, stdio: ["ignore", "pipe", "pipe"] });

	const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
		let text = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			const slice = chunk.toString("utf8");
			text += slice;
			input.onStdout?.(slice);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
		});
		const timer = setTimeout(() => child.kill(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ stdout: `${text}\nspawn error: ${error.message}`, exitCode: -1 });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout: text, exitCode: code ?? -1 });
		});
	});

	// UBT prints `Writing <path>...` for the file it produced; that is the authoritative location.
	const written = writtenPathFrom(stdout) ?? normalizePath(outputPath);
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(written, "utf8"));
	} catch (error) {
		notes.push(`no parseable JSON at ${written}: ${(error as Error).message.split("\n")[0]}`);
		if (exitCode !== 0) notes.push(`UnrealBuildTool exit code ${exitCode}`);
		const tail = stdout.trimEnd().split(/\r?\n/).slice(-10).join("\n  ");
		if (tail) notes.push(`ubt output:\n  ${tail}`);
	}

	return { json, outputPath: written, stdout, exitCode: json === undefined ? -1 : 0, durationMs: Date.now() - started, ubtPath: binary.path, args, notes };
}

const shellQuote = (arg: string) => (/^[A-Za-z0-9:./=_,+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/** UBT prints `Writing <absolute path>...` for each query output file. */
export function writtenPathFrom(stdout: string): string | undefined {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const written = /^Writing\s+(.+?)\.{3}\s*$/.exec(lines[i]?.trim() ?? "");
		const writtenPath = written?.[1];
		if (writtenPath) return normalizePath(writtenPath);
	}
	return undefined;
}

/* ──────────────────────────────────────────────────────────────────────────── parse */

const asArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map(normalizePath) : []);
const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const isDefinitionsHeader = (path: string) => /\/definitions(\.[^/]*)?\.h$/i.test(path);

export function parseTargetDetails(json: unknown): TargetDetails {
	const root = (json ?? {}) as Record<string, unknown>;
	const dirToModule = (root.dirToModule ?? {}) as Record<string, string>;
	const settingsIn = (root.moduleToCompileSettings ?? {}) as Record<string, Record<string, unknown>>;
	const notes: string[] = [];
	if (root.dirToModule === null) notes.push("dirToModule is null — this Query JSON was produced with -NoIntellisense, which disables the pass that computes it");
	if (root.moduleToCompileSettings === null) notes.push("moduleToCompileSettings is null — this Query JSON was produced with -NoIntellisense");

	const dirModules: { prefix: string; module: string }[] = [];
	for (const [dir, module] of Object.entries(dirToModule)) {
		if (typeof module !== "string" || !dir) continue;
		dirModules.push({ prefix: normalizePath(dir), module });
	}
	dirModules.sort((a, b) => b.prefix.length - a.prefix.length);

	const settings = new Map<string, UbtModuleSettings>();
	for (const [module, value] of Object.entries(settingsIn)) {
		const forcedIncludes = asArray(value.forcedIncludes);
		settings.set(module, {
			includePaths: asArray(value.includePaths),
			defines: asStrings(value.defines),
			standard: typeof value.standard === "string" ? value.standard : "",
			forcedIncludes,
			compilerPath: typeof value.compilerPath === "string" ? normalizePath(value.compilerPath) : "",
			compilerArgs: asStrings(value.compilerArgs),
			compilerAdditionalArgs: {
				c: asStrings((value.compilerAdditionalArgs as Record<string, unknown> | undefined)?.c),
				cpp: asStrings((value.compilerAdditionalArgs as Record<string, unknown> | undefined)?.cpp),
			},
			windowsSdkVersion: typeof value.windowsSdkVersion === "string" ? value.windowsSdkVersion : "",
			definesFile: forcedIncludes.find(isDefinitionsHeader) ?? "",
		});
	}

	const launch = (root.launchSettings ?? {}) as Record<string, unknown>;
	return {
		dirModules,
		settings,
		launch: { description: typeof launch.description === "string" ? launch.description : undefined, binaryPath: typeof launch.binaryPath === "string" ? normalizePath(launch.binaryPath) : undefined, arguments: asArray(launch.arguments) },
		isTestTarget: root.isTestTarget === true,
		notes,
	};
}

export function parseModuleReferences(json: unknown): Map<string, UbtModuleRefs> {
	const modules = ((json as Record<string, unknown> | undefined)?.modules ?? {}) as Record<string, Record<string, unknown>>;
	const out = new Map<string, UbtModuleRefs>();
	for (const [name, value] of Object.entries(modules)) {
		out.set(name, {
			shortName: typeof value.shortName === "string" ? value.shortName : "",
			moduleDirectory: normalizePath((value.moduleDirectory as string) ?? ""),
			intermediateDirectory: normalizePath((value.intermediateDirectory as string) ?? ""),
			public: asStrings(value.public),
			private: asStrings(value.private),
			publicInclude: asStrings(value.publicInclude),
			privateInclude: asStrings(value.privateInclude),
			dynamicallyLoaded: asStrings(value.dynamicallyLoaded),
			circular: asStrings(value.circular),
		});
	}
	return out;
}

/** Read a Query JSON file already on disk (fixture tests, and `unreal_context` without rebuilding). */
export function readQueryJson(path: string): unknown {
	return JSON.parse(readFileSync(normalizePath(path), "utf8"));
}

export function hasQueryJson(path: string): boolean {
	try {
		return existsSync(normalizePath(path));
	} catch {
		return false;
	}
}
