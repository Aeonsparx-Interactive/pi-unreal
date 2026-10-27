/**
 * pi-unreal — Unreal Engine awareness for the Pi coding agent.
 *
 * Three read-only tools remove the two things an agent gets wrong most often in a UE codebase:
 * which engine a project actually resolves to, and which plugins/modules the engine will see.
 *
 *   unreal_resolve_engine   — .uproject `EngineAssociation` → absolute engine root + Build.version
 *   unreal_project_inspect  — modules, targets, plugin references resolved against the real index
 *   unreal_plugin_inspect   — one .uplugin: modules, version, dependencies, source root
 *
 * Resolution mirrors `FDesktopPlatformWindows::TryGetInstallationPathFromRegistry`
 * (`Engine/Source/Developer/DesktopPlatform/Private/DesktopPlatformBase.cpp:459-511`) and
 * `DesktopPlatformWindows.cpp:101-161`; plugin discovery mirrors
 * `UnrealBuildTool.System.ReadAvailablePlugins` (`Plugins.cs:322`).
 *
 * The extension never writes to the engine, never touches the registry, and blocks the edits
 * this machine's conventions forbid (`.uasset`/`.umap` hand-edits, `clang-format` on `*.cs`).
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { clearCache, cacheStats, computeCacheKey, loadCachedIndex, saveCachedIndex } from "./lib/cache.ts";
import { parseUplugin, parseUproject, type EngineVersion, type UpluginDescriptor, type UprojectDescriptor } from "./lib/descriptors.ts";
import { enumerateInstallations, resolveEngineForProject, findProjectFile, type EngineResolution, type ResolutionStatus } from "./lib/engine-resolver.ts";
import { buildPluginIndex, computeScanDirs, resolveProjectPlugins, type PluginIndex, type PluginReferenceResult } from "./lib/plugin-resolver.ts";
import { createWindowsRegistryReader, type RegistryReader } from "./lib/registry.ts";
import { indexTools, unrealModuleCommand, unrealSymbolCommand } from "./lib/pi-tools.ts";
import { joinPath, normalizePath, parentDir, realFs, truncateLines, type JsonValue } from "./lib/util.ts";

/* ──────────────────────────────────────────────────────────────────────────── session state */

let registry: RegistryReader | undefined;
function getRegistry(): RegistryReader {
	registry ??= createWindowsRegistryReader({ timeoutMs: 8000 });
	return registry;
}

let contextCardInjected = false;

/** Cached `tasklist` probe: is a UE editor process running right now? */
let editorProbe: { atMs: number; running: boolean } | undefined;
function editorRunning(ttlMs = 4000): boolean {
	const now = Date.now();
	if (editorProbe && now - editorProbe.atMs < ttlMs) return editorProbe.running;
	let running = false;
	try {
		const out = execFileSync("tasklist", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq UnrealEditor*"], { encoding: "utf8", timeout: 4000, windowsHide: true });
		running = /unrealeditor/i.test(out);
	} catch {
		running = false;
	}
	editorProbe = { atMs: now, running };
	return running;
}

/* ──────────────────────────────────────────────────────────────────────────── shared helpers */

/** `structuredContent` must be plain JSON; strips class instances, `undefined`, and Maps. */
function toJson(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** Directory a `.uproject` lives in — the project root UBT uses for `Plugins` discovery. */
function projectDirOf(descriptor: UprojectDescriptor): string {
	return parentDir(descriptor.path) ?? descriptor.path;
}

function expandPath(input: string, cwd: string): string {
	const trimmed = input.trim().replace(/^"([^"]*)"$/, "$1").replace(/^'([^']*)'$/, "$1");
	return normalizePath(isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed));
}

interface LocatedProject {
	path?: string;
	notes: string[];
}

/** Resolve the project a request is about: explicit path, then nearest `.uproject` from cwd. */
function locateProject(explicit: string | undefined, cwd: string, fs = realFs): LocatedProject {
	const notes: string[] = [];
	if (explicit && explicit.trim()) {
		const candidate = expandPath(explicit, cwd);
		if (!fs.exists(candidate)) return { notes: [`path does not exist: ${candidate}`] };
		if (fs.isDirectory(candidate)) {
			const found = fs.listDir(candidate).find((entry) => entry.toLowerCase().endsWith(".uproject"));
			if (!found) return { notes: [`no .uproject directly inside ${candidate}`] };
			return { path: joinPath(candidate, found), notes: [`found ${found} under the given directory`] };
		}
		if (!candidate.toLowerCase().endsWith(".uproject")) {
			notes.push(`given path is not a .uproject; parsed as text where possible`);
			return { path: candidate, notes };
		}
		return { path: candidate, notes };
	}
	const found = findProjectFile(cwd, fs, 4);
	if (found) return { path: found, notes: [`nearest .uproject found from cwd: ${found}`] };
	notes.push(`no .uproject within 4 levels above ${normalizePath(cwd)}; pass project: <path-to.uproject>`);
	return { notes };
}

function formatVersion(version: EngineVersion | undefined): string {
	return version?.raw ?? "unknown";
}

function engineLines(resolution: EngineResolution): string[] {
	const lines: string[] = [];
	if (resolution.status === "resolved") {
		lines.push(
			`engine: ${resolution.engineRoot}`,
			`  version ${formatVersion(resolution.version)} | ${resolution.installedBuild ? "installed build" : "source build"} | association "${resolution.engineAssociation ?? ""}" (${resolution.associationKind}) via ${resolution.source}`,
			`  Build.version: ${resolution.buildVersionPath}`,
		);
		return lines;
	}
	if (resolution.status === "ambiguous") {
		lines.push(`engine: AMBIGUOUS — more than one valid installation matches the association`);
		for (const candidate of resolution.candidates) {
			lines.push(`  ${candidate.root} [${candidate.source}] ${formatVersion(candidate.version)}${candidate.validRoot ? "" : " (invalid root)"}`);
		}
		lines.push(`  pick one and pass engineRootHint`);
		return lines;
	}
	lines.push(`engine: UNRESOLVED — association "${resolution.engineAssociation ?? ""}" (${resolution.associationKind}) has no matching installation`);
	for (const candidate of resolution.candidates) {
		lines.push(`  rejected ${candidate.root} [${candidate.source}] ${formatVersion(candidate.version)}${candidate.notes.length ? ` — ${candidate.notes.join("; ")}` : ""}`);
	}
	for (const note of resolution.remediation) lines.push(`  → ${note}`);
	return lines;
}

function pluginLines(results: PluginReferenceResult[], limit: number): string[] {
	const lines: string[] = [];
	const shown = results.slice(0, limit);
	for (const result of shown) {
		const status = result.plugin ? `${result.status} ← ${result.plugin.source}` : result.status;
		lines.push(`  ${result.name}: ${status}`);
		for (const note of result.notes) lines.push(`      · ${note}`);
	}
	if (results.length > limit) lines.push(`  … ${results.length - limit} more references (raise pluginLimit)`);
	const counts = new Map<string, number>();
	for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
	const summary = [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
	lines.push(`  totals: ${summary} of ${results.length} references`);
	return lines;
}

function descriptorLines(descriptor: UpluginDescriptor): string[] {
	const lines = [
		`plugin: ${descriptor.name}`,
		`  path ${descriptor.path}`,
		`  version ${descriptor.version ?? "unset"}${descriptor.semVersion ? ` (SemVersion ${descriptor.semVersion})` : ""}${descriptor.versionName ? ` "${descriptor.versionName}"` : ""}`,
		`  EngineVersion ${descriptor.engineVersion?.raw ?? "unset"} | category ${descriptor.category ?? "unset"}`,
		`  EnabledByDefault ${descriptor.enabledByDefault} | CanContainContent ${descriptor.canContainContent} | Installed ${descriptor.installed}${descriptor.isBetaVersion ? " | IsBetaVersion true" : ""}`,
	];
	if (descriptor.supportedTargetPlatforms.length) lines.push(`  SupportedTargetPlatforms ${descriptor.supportedTargetPlatforms.join(", ")}`);
	lines.push(`  modules (${descriptor.modules.length}):`);
	for (const entry of descriptor.modules) {
		const flags = [
			entry.descriptor.type ?? "Runtime",
			entry.descriptor.loadingPhase ? `phase ${entry.descriptor.loadingPhase}` : undefined,
			entry.descriptor.platformAllowList.length ? `allow [${entry.descriptor.platformAllowList.join(",")}]` : undefined,
			entry.descriptor.platformDenyList.length ? `deny [${entry.descriptor.platformDenyList.join(",")}]` : undefined,
			entry.descriptor.additionalDependencies.length ? `deps ${entry.descriptor.additionalDependencies.join(",")}` : undefined,
		]
			.filter(Boolean)
			.join(" | ");
		lines.push(`    ${entry.moduleName} — ${flags}`);
	}
	if (descriptor.plugins.length) {
		lines.push(`  plugin dependencies (${descriptor.plugins.length}):`);
		for (const ref of descriptor.plugins) {
			lines.push(`    ${ref.name}${ref.enabled ? "" : " (Enabled: false)"}${ref.optional ? " optional" : ""}${ref.activate ? " activate" : ""}${ref.semVersion ? ` v${ref.semVersion}` : ""}`);
		}
	}
	for (const diagnostic of descriptor.diagnostics) lines.push(`  ! ${diagnostic}`);
	return lines;
}

async function getIndexFor(
	engineRoot: string | undefined,
	projectDir: string | undefined,
	descriptor: UprojectDescriptor | undefined,
	version: EngineVersion | undefined,
): Promise<{ index: PluginIndex; cache: "hit" | "miss" }> {
	const scanOptions = {
		engineRoot,
		projectDir,
		additionalPluginDirectories: descriptor?.additionalPluginDirectories,
		additionalRootDirectories: descriptor?.additionalRootDirectories,
	};
	const scanDirs = computeScanDirs(scanOptions).map((spec) => spec.dir);
	const { key, roots } = computeCacheKey({ engineRoot, projectDir, scannedDirs: scanDirs, versionChangelist: version?.changelist });
	const cached = loadCachedIndex(key);
	if (cached) return { index: cached, cache: "hit" };
	const index = await buildPluginIndex(scanOptions);
	saveCachedIndex(index, key, roots);
	return { index, cache: "miss" };
}

/* ──────────────────────────────────────────────────────────────────────────── schemas */

const VersionSchema = Type.Object({
	major: Type.Number(),
	minor: Type.Number(),
	patch: Type.Number(),
	changelist: Type.Number(),
	branchName: Type.Optional(Type.String()),
	raw: Type.String(),
});

const CandidateSchema = Type.Object({
	identifier: Type.String(),
	root: Type.String(),
	source: Type.String(),
	rank: Type.Number(),
	directoryExists: Type.Boolean(),
	validRoot: Type.Boolean(),
	version: Type.Optional(VersionSchema),
	versionMajorMinor: Type.Optional(Type.String()),
	versionMatches: Type.Boolean(),
	notes: Type.Array(Type.String()),
});

const EngineOutputSchema = Type.Object({
	status: Type.Union([Type.Literal("resolved"), Type.Literal("ambiguous"), Type.Literal("unresolved")]),
	projectPath: Type.Optional(Type.String()),
	engineAssociation: Type.Optional(Type.String()),
	associationKind: Type.String(),
	engineRoot: Type.Optional(Type.String()),
	identifier: Type.Optional(Type.String()),
	version: Type.Optional(VersionSchema),
	source: Type.Optional(Type.String()),
	installedBuild: Type.Optional(Type.Boolean()),
	buildVersionPath: Type.Optional(Type.String()),
	candidates: Type.Array(CandidateSchema),
	diagnostics: Type.Array(Type.String()),
	remediation: Type.Array(Type.String()),
});

const PluginSummarySchema = Type.Object({
	name: Type.String(),
	path: Type.String(),
	source: Type.String(),
	version: Type.Optional(Type.String()),
	engineVersionRaw: Type.Optional(Type.String()),
	modules: Type.Array(Type.Object({ moduleName: Type.String(), type: Type.Optional(Type.String()), loadingPhase: Type.Optional(Type.String()) })),
});

const ProjectOutputSchema = Type.Object({
	projectPath: Type.String(),
	engine: EngineOutputSchema,
	modules: Type.Array(Type.Object({ moduleName: Type.String(), type: Type.Optional(Type.String()), loadingPhase: Type.Optional(Type.String()) })),
	targetPlatforms: Type.Array(Type.String()),
	pluginReferences: Type.Array(
		Type.Object({
			name: Type.String(),
			status: Type.String(),
			plugin: Type.Optional(PluginSummarySchema),
			notes: Type.Array(Type.String()),
		}),
	),
	pluginIndex: Type.Object({ engineRoot: Type.Optional(Type.String()), scannedDirs: Type.Array(Type.String()), scannedFiles: Type.Number(), cache: Type.String() }),
	diagnostics: Type.Array(Type.String()),
});

const PluginOutputSchema = Type.Object({
	pluginPath: Type.String(),
	name: Type.String(),
	source: Type.String(),
	version: Type.Optional(Type.String()),
	semVersion: Type.Optional(Type.String()),
	engineVersionRaw: Type.Optional(Type.String()),
	enabledByDefault: Type.Boolean(),
	canContainContent: Type.Boolean(),
	installed: Type.Boolean(),
	supportedTargetPlatforms: Type.Array(Type.String()),
	modules: Type.Array(Type.Object({ moduleName: Type.String(), type: Type.Optional(Type.String()), loadingPhase: Type.Optional(Type.String()) })),
	dependencies: Type.Array(Type.Object({ name: Type.String(), status: Type.String(), notes: Type.Array(Type.String()) })),
	diagnostics: Type.Array(Type.String()),
});

const EngineParams = Type.Object({
	project: Type.Optional(Type.String({ description: "Path to the .uproject, or a directory containing one. Defaults to the nearest .uproject from the working directory." })),
	engineRootHint: Type.Optional(Type.String({ description: "Absolute engine root to trust above registry and environment sources." })),
});

const ProjectParams = Type.Object({
	project: Type.Optional(Type.String({ description: "Path to the .uproject, or a directory containing one." })),
	engineRootHint: Type.Optional(Type.String({ description: "Absolute engine root to trust above registry sources." })),
	includePlugins: Type.Optional(Type.Boolean({ description: "Resolve .uproject plugin references against the on-disk plugin index. Default true." })),
	pluginLimit: Type.Optional(Type.Number({ description: "Maximum plugin references to render. Default 40." })),
});

const PluginParams = Type.Object({
	plugin: Type.Optional(Type.String({ description: "Plugin name, or a path to a .uplugin. Defaults to the .uplugin nearest the working directory." })),
	project: Type.Optional(Type.String({ description: "Project used to build the plugin index. Defaults to the nearest .uproject." })),
	engineRootHint: Type.Optional(Type.String({ description: "Absolute engine root to trust above registry sources." })),
});

/* ──────────────────────────────────────────────────────────────────────────── tools */

const resolveEngineTool = defineTool({
	name: "unreal_resolve_engine",
	label: "UE engine",
	description: "Resolve a .uproject EngineAssociation to the absolute engine root, version, and installation type.",
	promptSnippet: "Resolve which Unreal Engine installation a .uproject points at",
	promptGuidelines: [
		"Call unreal_resolve_engine before using any Engine/... path; never guess an engine root from a directory name.",
		"Treat status 'unresolved' as a blocker to report, not a thing to work around.",
	],
	parameters: EngineParams,
	outputSchema: EngineOutputSchema,
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	executionMode: "parallel",

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const located = locateProject(params.project, ctx.cwd);
		if (!located.path) {
			return {
				content: [{ type: "text", text: `No project file: ${located.notes.join(" | ")}` }],
				details: { status: "unresolved" as ResolutionStatus, associationKind: "unknown" as const, candidates: [], diagnostics: located.notes, remediation: ["pass project: <path/to/Project.uproject>"] },
				structuredContent: toJson({ status: "unresolved", associationKind: "unknown", candidates: [], diagnostics: located.notes, remediation: ["pass project: <path/to/Project.uproject>"] }),
				isError: true,
			};
		}
		const resolution = await resolveEngineForProject(located.path, {
			registry: getRegistry(),
			userEngineRoots: params.engineRootHint ? [params.engineRootHint] : [],
		});
		const lines = [`project: ${resolution.projectPath ?? located.path}`, ...engineLines(resolution), ...resolution.diagnostics.map((note) => `  ! ${note}`)];
		return {
			content: [{ type: "text", text: truncateLines(lines.join("\n"), 60).text }],
			details: resolution,
			structuredContent: toJson(resolution),
			isError: resolution.status === "unresolved",
		};
	},
});

const projectInspectTool = defineTool({
	name: "unreal_project_inspect",
	label: "UE project",
	description: "Inspect a .uproject: engine resolution, game modules, target platforms, and every plugin reference resolved against the plugins that exist on disk.",
	promptSnippet: "Inspect a UE project's modules, targets, and plugin references",
	promptGuidelines: [
		"Use unreal_project_inspect before adding a module, plugin reference, or Build.cs dependency — plugin names must be verified against the index, not remembered.",
		"Report 'missing' plugin references verbatim: the name, the scanned roots, and whether the reference is Optional.",
	],
	parameters: ProjectParams,
	outputSchema: ProjectOutputSchema,
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	executionMode: "sequential",

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const located = locateProject(params.project, ctx.cwd);
		if (!located.path || !located.path.toLowerCase().endsWith(".uproject")) {
			const notes = located.path ? [`not a .uproject: ${located.path}`] : located.notes;
			return { content: [{ type: "text", text: `Cannot inspect project: ${notes.join(" | ")}` }], details: undefined, isError: true };
		}
		const descriptor = parseUproject(located.path, realFs);
		const resolution = await resolveEngineForProject(located.path, {
			registry: getRegistry(),
			userEngineRoots: params.engineRootHint ? [params.engineRootHint] : [],
		});

		const lines: string[] = [`project: ${descriptor.path}`, `association: "${descriptor.engineAssociation ?? ""}" (${resolution.associationKind})`, ...engineLines(resolution)];
		lines.push(`modules (${descriptor.modules.length}): ${descriptor.modules.map((entry) => `${entry.moduleName} ${entry.descriptor.type ?? "Runtime"}`).join(", ") || "none"}`);
		if (descriptor.targetPlatforms.length) lines.push(`targetPlatforms: ${descriptor.targetPlatforms.join(", ")}`);
		if (descriptor.additionalPluginDirectories.length) lines.push(`additionalPluginDirectories: ${descriptor.additionalPluginDirectories.join(", ")}`);

		const pluginResults: PluginReferenceResult[] = [];
		let pluginIndex: PluginIndex | undefined;
		let cacheState = "skipped";
		if (params.includePlugins !== false && resolution.status !== "unresolved") {
			const built = await getIndexFor(resolution.engineRoot, projectDirOf(descriptor), descriptor, resolution.version);
			pluginIndex = built.index;
			cacheState = built.cache;
			pluginResults.push(...resolveProjectPlugins(descriptor, built.index, resolution.version));
			lines.push(`plugin index: ${built.index.scannedFiles} .uplugin over [${built.index.scannedDirs.join(" | ")}] (cache ${built.cache})`);
			lines.push("plugin references:");
			lines.push(...pluginLines(pluginResults, params.pluginLimit ?? 40));
		} else {
			lines.push(`plugin references: ${descriptor.plugins.length} declared, not resolved against disk`);
		}
		for (const diagnostic of descriptor.diagnostics) lines.push(`  ! ${diagnostic}`);

		const report = {
			projectPath: descriptor.path,
			engine: resolution,
			modules: descriptor.modules.map((entry) => ({ moduleName: entry.moduleName, type: entry.descriptor.type, loadingPhase: entry.descriptor.loadingPhase })),
			targetPlatforms: descriptor.targetPlatforms,
			pluginReferences: pluginResults.map((result) => ({
				name: result.name,
				status: result.status,
				plugin: result.plugin ? { name: result.plugin.name, path: result.plugin.path, source: result.plugin.source, version: result.plugin.version, engineVersionRaw: result.plugin.engineVersionRaw, modules: result.plugin.modules } : undefined,
				notes: result.notes,
			})),
			pluginIndex: { engineRoot: pluginIndex?.engineRoot, scannedDirs: pluginIndex?.scannedDirs ?? [], scannedFiles: pluginIndex?.scannedFiles ?? 0, cache: cacheState },
			diagnostics: descriptor.diagnostics,
		};
		return {
			content: [{ type: "text", text: truncateLines(lines.join("\n"), 140).text }],
			details: report,
			structuredContent: toJson(report),
		};
	},
});

const pluginInspectTool = defineTool({
	name: "unreal_plugin_inspect",
	label: "UE plugin",
	description: "Inspect one .uplugin: version fields, modules with loading phases, declared plugin dependencies, and target platform gating.",
	promptSnippet: "Inspect a .uplugin descriptor and its module list",
	promptGuidelines: [
		"Use unreal_plugin_inspect before adding a module dependency so the module name, Type, and LoadingPhase come from the descriptor.",
	],
	parameters: PluginParams,
	outputSchema: PluginOutputSchema,
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	executionMode: "sequential",

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const located = locateProject(params.project, ctx.cwd);
		const resolution = located.path && located.path.toLowerCase().endsWith(".uproject")
			? await resolveEngineForProject(located.path, { registry: getRegistry(), userEngineRoots: params.engineRootHint ? [params.engineRootHint] : [] })
			: undefined;
		const descriptor = located.path ? parseUproject(located.path, realFs) : undefined;
		let index: PluginIndex | undefined;
		if (resolution?.status !== "unresolved" && (located.path || descriptor)) {
			index = (await getIndexFor(resolution?.engineRoot, descriptor ? projectDirOf(descriptor) : undefined, descriptor, resolution?.version)).index;
		}

		let pluginPath: string | undefined;
		const notes: string[] = [];
		const wanted = params.plugin?.trim();
		if (wanted) {
			const asPath = expandPath(wanted, ctx.cwd);
			if (asPath.toLowerCase().endsWith(".uplugin") && realFs.exists(asPath)) pluginPath = asPath;
			else if (index) {
				const bucket = index.byName.get(wanted.toLowerCase());
				if (bucket?.[0]) {
					pluginPath = bucket[0].path;
					notes.push(`resolved name "${wanted}" to ${bucket[0].source} plugin`);
				} else notes.push(`no plugin named "${wanted}" in the index`);
			}
		} else if (index) {
			const cwd = normalizePath(ctx.cwd);
			pluginPath = index.entries
				.filter((entry) => cwd.startsWith(entry.dir + "/") || entry.dir.startsWith(cwd))
				.sort((a, b) => b.dir.length - a.dir.length)[0]?.path;
			if (pluginPath) notes.push(`nearest .uplugin to cwd: ${pluginPath}`);
		}
		if (!pluginPath) {
			return {
				content: [{ type: "text", text: `No plugin resolved. ${notes.join(" | ") || "pass plugin: <name or path.uplugin>"}` }],
				details: undefined,
				isError: true,
			};
		}

		const uplugin = parseUplugin(pluginPath, realFs);
		const dependencyResults = uplugin.plugins.map((ref) => ({ name: ref.name, status: "unresolved", notes: [] as string[] }));
		if (index) {
			dependencyResults.length = 0;
			for (const ref of uplugin.plugins) {
				const bucket = index.byName.get(ref.name.toLowerCase());
				const winner = bucket?.[0];
				dependencyResults.push({
					name: ref.name,
					status: !ref.enabled ? "disabled" : winner ? "resolved" : "missing",
					notes: winner ? [`${winner.source} ${winner.path}`] : [`not found in [${index.scannedDirs.join(" | ")}]`],
				});
			}
		}

		const source = index?.entries.find((entry) => entry.path === pluginPath)?.source ?? (pluginPath.includes("/Engine/Plugins/") ? "Engine" : "Project");
		const lines = [...descriptorLines(uplugin), ...notes.map((note) => `  · ${note}`)];
		const report = {
			pluginPath: uplugin.path,
			name: uplugin.name,
			source,
			version: uplugin.version,
			semVersion: uplugin.semVersion,
			engineVersionRaw: uplugin.engineVersion?.raw,
			enabledByDefault: uplugin.enabledByDefault,
			canContainContent: uplugin.canContainContent,
			installed: uplugin.installed,
			supportedTargetPlatforms: uplugin.supportedTargetPlatforms,
			modules: uplugin.modules.map((entry) => ({ moduleName: entry.moduleName, type: entry.descriptor.type, loadingPhase: entry.descriptor.loadingPhase })),
			dependencies: dependencyResults,
			diagnostics: uplugin.diagnostics,
		};
		return { content: [{ type: "text", text: truncateLines(lines.join("\n"), 120).text }], details: report, structuredContent: toJson(report) };
	},
});

/* ──────────────────────────────────────────────────────────────────────────── commands */

async function reportProject(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const located = locateProject(args || undefined, ctx.cwd);
	if (!located.path) {
		ctx.ui.notify(`No .uproject found. ${located.notes.join(" | ")}`, "warning");
		return;
	}
	const resolution = await resolveEngineForProject(located.path, { registry: getRegistry() });
	const descriptor = located.path.toLowerCase().endsWith(".uproject") ? parseUproject(located.path, realFs) : undefined;
	const lines = [`project ${located.path}`, ...engineLines(resolution)];
	if (descriptor) {
		lines.push(`modules: ${descriptor.modules.map((entry) => `${entry.moduleName} (${entry.descriptor.type ?? "Runtime"})`).join(", ") || "none"}`);
		lines.push(`plugins declared: ${descriptor.plugins.length}`);
		if (resolution.status !== "unresolved") {
			const built = await getIndexFor(resolution.engineRoot, projectDirOf(descriptor), descriptor, resolution.version);
			lines.push(`plugin index: ${built.index.scannedFiles} .uplugin (cache ${built.cache})`);
			lines.push(...pluginLines(resolveProjectPlugins(descriptor, built.index, resolution.version), 25));
		}
	}
	ctx.ui.notify(truncateLines(lines.join("\n"), 40).text, "info");
}

async function reportEngines(ctx: ExtensionCommandContext): Promise<void> {
	const installs = await enumerateInstallations({ registry: getRegistry() });
	const lines = installs.map(
		(install) =>
			`${install.identifier.padEnd(10)} ${install.source.padEnd(18)} ${install.validRoot ? "valid  " : "INVALID"} ${install.root}${install.version ? ` ${install.version.raw}` : ""}`,
	);
	ctx.ui.notify(lines.length ? `engine installations (${lines.length}):\n${lines.join("\n")}` : "no engine installations discovered", "info");
}

/* ──────────────────────────────────────────────────────────────────────────── context card */

async function buildContextCard(cwd: string): Promise<string | undefined> {
	const project = findProjectFile(cwd, realFs, 4);
	if (!project) return undefined;
	const descriptor = parseUproject(project, realFs);
	const resolution = await resolveEngineForProject(project, { registry: getRegistry() });
	const lines = [
		"Unreal Engine context (auto-detected at session start; re-verify with unreal_resolve_engine):",
		`  project ${project}`,
		...engineLines(resolution).map((line) => `  ${line}`),
		`  modules: ${descriptor.modules.map((entry) => `${entry.moduleName}(${entry.descriptor.type ?? "Runtime"})`).join(" ") || "none"}`,
		`  plugin references declared: ${descriptor.plugins.length}`,
		"  engine sources for this machine live under C:/Program Files/Epic Games (UE_*) plus source builds; registry + dir-scan are consulted by the tools — do not infer.",
		"  conventions: editor closed before C++ edits; never hand-edit .uasset/.umap; never clang-format .cs.",
		"  tools: unreal_resolve_engine, unreal_project_inspect, unreal_plugin_inspect. Commands: /unreal, /unreal-engines, /unreal-cache.",
	];
	return lines.join("\n");
}

/* ──────────────────────────────────────────────────────────────────────────── gate */

const BINARY_ASSET_EXT = [".uasset", ".umap"];
/** UE's own sourceFileExtensions (minus `cs`, which is C# and not live-compiled by the editor). */
const CPP_EXT = [".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hxx", ".inl", ".cpp.inl", ".hpp.inl", ".template", ".inc"];

function targetPath(input: Record<string, unknown> | undefined): string | undefined {
	const value = input?.path;
	return typeof value === "string" && value.trim() ? normalizePath(value) : undefined;
}

/** Machine conventions enforced on every write: binary assets, live-editor C++ edits, clang-format on .cs. */
export function gateCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	options: { editorRunning?: boolean } = {},
): { block?: boolean; reason?: string } | undefined {
	const input = event.input as Record<string, unknown> | undefined;

	if (event.toolName === "edit" || event.toolName === "write") {
		const path = targetPath(input);
		if (path) {
			const lower = path.toLowerCase();
			const assetExt = BINARY_ASSET_EXT.find((ext) => lower.endsWith(ext));
			if (assetExt) {
				return {
					block: true,
					reason: `${assetExt} is a cooked binary asset. Author it in the running editor (asset tools / UI) — hand-editing corrupts it, and a source-control diff of it is meaningless.`,
				};
			}
			if (CPP_EXT.some((ext) => lower.endsWith(ext)) && (options.editorRunning ?? editorRunning())) {
				ctx.ui.notify(`UnrealEditor is running while editing ${path} — newly compiled C++ will not load into the running editor. Close the editor, then build with UnrealEngine-BuildProjectEditor.`, "warning");
			}
		}
	}

	if (event.toolName === "bash" || event.toolName === "powershell") {
		const command = typeof input?.command === "string" ? input.command : "";
		if (/clang-format/i.test(command) && /[^\s'"]+\.cs\b/i.test(command)) {
			return {
				block: true,
				reason: "clang-format must never touch *.cs — it applies the C# language rule and can empty the file (verified on Source/Lp.Target.cs). Format C++ with Script/Dev/Format-Cpp.ps1.",
			};
		}
	}
	return undefined;
}

/* ──────────────────────────────────────────────────────────────────────────── entry */

export default function (pi: ExtensionAPI) {
	pi.registerTool(resolveEngineTool);
	pi.registerTool(projectInspectTool);
	pi.registerTool(pluginInspectTool);
	for (const tool of indexTools) pi.registerTool(tool);

	pi.registerCommand("unreal-symbol", {
		description: "Where is this UE symbol defined? (project + plugins, then engine if an engine index exists)",
		async handler(query: string, ctx: ExtensionCommandContext) {
			const term = query.trim();
			if (!term) {
				ctx.ui.notify("usage: /unreal-symbol <symbol>  (qualified works: AActor:Tick)", "info");
				return;
			}
			ctx.ui.notify("indexing / looking up…", "info");
			const text = await unrealSymbolCommand(term, ctx.cwd);
			ctx.ui.notify(truncateLines(text, 40).text, "info");
		},
	});

	pi.registerCommand("unreal-module", {
		description: "Module directory, dependency lists, defines file, standard and SDK (from UnrealBuildTool Query)",
		async handler(name: string, ctx: ExtensionCommandContext) {
			const module = name.trim();
			if (!module) {
				ctx.ui.notify("usage: /unreal-module <ModuleName>", "info");
				return;
			}
			ctx.ui.notify("running UnrealBuildTool Query (cached after the first run)…", "info");
			const text = await unrealModuleCommand(module, ctx.cwd);
			ctx.ui.notify(truncateLines(text, 40).text, "info");
		},
	});

	pi.registerCommand("unreal", {
		description: "Inspect the Unreal Engine project for this directory (engine, modules, plugins)",
		handler: async (args, ctx) => {
			await reportProject(args, ctx);
		},
	});

	pi.registerCommand("unreal-engines", {
		description: "List every Unreal Engine installation this machine can resolve",
		handler: async (_args, ctx) => {
			await reportEngines(ctx);
		},
	});

	pi.registerCommand("unreal-cache", {
		description: "Show or clear the pi-unreal plugin index cache: /unreal-cache [stats|clear]",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "clear") {
				const cleared = clearCache();
				ctx.ui.notify(`Cleared ${cleared.removed} cached indexes (${cleared.dir})`, "info");
				return;
			}
			const stats = cacheStats();
			ctx.ui.notify(`plugin index cache: ${stats.files} files, ${stats.entries} plugin entries, ${(stats.bytes / 1024).toFixed(0)} KB\n${stats.dir}`, "info");
		},
	});

	pi.on("session_start", () => {
		contextCardInjected = false;
		editorProbe = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") return;
		if (contextCardInjected) return;
		try {
			const card = await buildContextCard(ctx.cwd);
			if (!card) return;
			contextCardInjected = true;
			return { message: { customType: "unreal:context", content: card, display: true, details: { source: "pi-unreal" } } };
		} catch {
			return undefined;
		}
	});

	pi.on("tool_call", (event, ctx) => gateCall(event, ctx));
}
