/**
 * Tool layer: turns the resolver/index/query libraries into the calls the `unreal_*` tools make.
 *
 * Everything here is a plain function (no pi types) so `tmp/smoke.mjs` can exercise the same code
 * paths the tools do. Two invariants matter for how the tools behave:
 *
 * 1. **Indexing is opt-in and scoped.** A definitions index over the project + its plugins is a
 *    few seconds; one over `Engine/Source/{Runtime,Editor,Developer}` is minutes. The engine index
 *    is only built when the caller asks for `scope: "engine"` / `"all"`, and says so in `notes`.
 * 2. **Module attribution prefers UBT's own answer.** When Query JSON exists, `dirToModule` decides
 *    which module owns a directory; `*.Build.cs` location is the fallback (`meta.source`).
 */

import { parseUproject, type EngineVersion } from "./descriptors.ts";
import { cacheDir } from "./cache.ts";
import { buildPluginIndex, resolveProjectPlugins } from "./plugin-resolver.ts";
import { findProjectFile, resolveEngineForProject, type ResolverDeps } from "./engine-resolver.ts";
import { ensureQueryJson, pickTarget, queryCacheState, humanAge, type CachePaths, type TargetChoice } from "./query.ts";
import {
	assembleRoots,
	buildIndex,
	contextFor,
	findFileBySuffix,
	indexKeyFor,
	listFiles,
	listIndexes,
	listModules,
	listSymbols,
	lookupSymbol,
	moduleFromBuildCs,
	pickIndex,
	readDefines,
	symbolsInFile,
	type ContextUnit,
	type IndexState,
	type LookupResult,
	type IndexScope,
	type ScanRoot,
	DEFAULT_ENGINE_AREAS,
} from "./store.ts";
import { hostPlatform, parseModuleReferences, parseTargetDetails, readQueryJson, type UbtModuleRefs, type UbtModuleSettings } from "./ubt.ts";
import { baseName, joinPath, normalizePath, realFs, type FsAdapter } from "./util.ts";

/** Where the project, its engine, and its enabled plugins live. */
export interface Workspace {
	cwd: string;
	projectPath?: string;
	projectDir?: string;
	projectName?: string;
	engineRoot?: string;
	engineVersion?: EngineVersion;
	/** Directories of plugins the `.uproject` enables, used as index roots. */
	pluginDirs: string[];
	notes: string[];
}

export async function resolveWorkspace(cwd: string, fs: FsAdapter = realFs, deps: ResolverDeps = {}): Promise<Workspace> {
	const notes: string[] = [];
	const workspace: Workspace = { cwd: normalizePath(cwd), pluginDirs: [], notes };

	const projectPath = findProjectFile(workspace.cwd, fs, 4);
	if (!projectPath) {
		notes.push("no *.uproject found within 4 levels of the working directory");
		return workspace;
	}
	workspace.projectPath = projectPath;
	workspace.projectDir = normalizePath(projectPath.slice(0, projectPath.length - baseName(projectPath).length).replace(/\/$/, ""));
	workspace.projectName = baseName(projectPath).replace(/\.uproject$/i, "");

	const resolution = await resolveEngineForProject(projectPath, { fs, ...deps });
	if (resolution.status === "resolved" && resolution.engineRoot) {
		workspace.engineRoot = resolution.engineRoot;
		workspace.engineVersion = resolution.version;
		notes.push(`engine ${resolution.version?.raw ?? resolution.identifier ?? "?"} at ${resolution.engineRoot} (${resolution.source}, ${resolution.installedBuild ? "installed" : "source"} build)`);
	} else {
		notes.push(`engine ${resolution.status}: ${resolution.diagnostics[0] ?? "see unreal_resolve_engine"}`);
	}

	try {
		const descriptor = parseUproject(projectPath, fs);
		const index = await buildPluginIndex({
			engineRoot: workspace.engineRoot,
			projectDir: workspace.projectDir,
			additionalPluginDirectories: descriptor.additionalPluginDirectories,
			additionalRootDirectories: descriptor.additionalRootDirectories,
			fs,
		});
		const refs = resolveProjectPlugins(descriptor, index, workspace.engineVersion);
		workspace.pluginDirs = refs.filter((ref) => ref.plugin).map((ref) => normalizePath(ref.plugin!.dir));
		const missing = refs.filter((ref) => ref.status === "missing").map((ref) => ref.name);
		if (missing.length) notes.push(`plugin references with no descriptor: ${missing.join(", ")}`);
		notes.push(`${workspace.pluginDirs.length} enabled plugin reference(s) resolved for index roots`);
	} catch (error) {
		notes.push(`plugin resolution failed: ${(error as Error).message}`);
	}

	return workspace;
}

export type Scope = "project" | "engine" | "all";
export type Mode = "definitions" | "full";

export interface IndexRequest {
	workspace: Workspace;
	mode: Mode;
	scope: Exclude<Scope, "all">;
	target?: string;
	platform?: string;
	configuration?: string;
	/** Query JSON paths for `mode: "full"`; obtained from `ensureQueryJson`. */
	queryFiles?: CachePaths;
	refresh?: boolean;
	engineAreas?: string[];
	/** Default false: a lookup never blocks on a minutes-long engine scan. Only `unreal_index` opts in. */
	allowEngineBuild?: boolean;
	onProgress?: (message: string) => void;
	fs?: FsAdapter;
}

export interface IndexHandle {
	key: string;
	index?: IndexState;
	built: boolean;
	durationMs?: number;
	warnings: string[];
	notes: string[];
	roots: ScanRoot[];
}

/** Load a matching index, building it when absent (or when `refresh` is set). */
export async function ensureIndex(request: IndexRequest): Promise<IndexHandle> {
	const fs = request.fs ?? realFs;
	const workspace = request.workspace;
	const engineScope = request.scope === "engine";
	const roots = assembleRoots({
		projectRoot: engineScope ? undefined : workspace.projectDir,
		pluginDirs: engineScope ? [] : workspace.pluginDirs,
		engineRoot: engineScope ? workspace.engineRoot : undefined,
		includeEngine: engineScope,
		engineAreas: engineScope ? request.engineAreas : undefined,
		fs,
	});
	const scope: IndexScope = engineScope ? "Engine" : "Project";
	const notes = [...roots.notes];
	if (!roots.roots.length) {
		return { key: "none", built: false, warnings: [`no C++ module roots for scope '${request.scope}'`], notes, roots: [] };
	}

	const key = indexKeyFor({ mode: request.mode, roots: roots.roots.map((root) => root.dir), scope, target: request.target, platform: request.platform, configuration: request.configuration });
	if (!request.refresh) {
		const existing = pickIndex({ key, mode: request.mode, scope, projectRoot: engineScope ? undefined : workspace.projectDir, engineRoot: engineScope ? workspace.engineRoot : undefined, roots: roots.roots.map((root) => root.dir) }).index;
		if (existing) {
			notes.push(`using cached index ${existing.key} (${existing.meta.counts.symbols} symbols, ${humanAge(Date.now() - Date.parse(existing.meta.generatedAt))} old)`);
			return { key, index: existing, built: false, warnings: [], notes, roots: roots.roots };
		}
	}

	if (engineScope && !request.allowEngineBuild) {
		const areas = (request.engineAreas?.length ? request.engineAreas : DEFAULT_ENGINE_AREAS).join(", ");
		notes.push(`no engine index for ${areas}. Building one scans every .h/.cpp in those areas (tens of thousands of files): minutes the first time, cached afterwards.`);
		notes.push("call unreal_index with scope \"engine\" (engineAreas narrows the scan, e.g. [\"Runtime\"]), then re-run this lookup");
		return { key, built: false, warnings: [], notes, roots: roots.roots };
	}

	const scopeNote = request.scope === "engine" ? "indexing Engine/Source (first engine index takes minutes, then it is cached)" : "indexing project and plugin sources";
	notes.push(scopeNote);
	request.onProgress?.(scopeNote);
	const started = Date.now();
	const build = await buildIndex({
		key,
		mode: request.mode,
		roots: roots.roots,
		engineRoot: workspace.engineRoot,
		projectRoot: workspace.projectDir,
		projectName: workspace.projectName,
		target: request.target,
		platform: request.platform,
		configuration: request.configuration,
		scope,
		queryFiles: request.queryFiles,
	});
	const warnings = [...build.warnings];
	const loaded = pickIndex({ key, mode: request.mode }).index;
	if (!loaded) warnings.push(`index ${key} was written but could not be reloaded; check ${cacheDir(fs)}`);
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	notes.push(`built ${key}: ${build.counts.symbols} symbols from ${build.counts.files} files in ${seconds}s (module attribution: ${build.source})`);
	return { key, index: loaded, built: true, durationMs: Date.now() - started, warnings, notes, roots: roots.roots };
}

export interface SymbolLookupInput {
	cwd: string;
	query: string;
	scope?: Scope;
	limit?: number;
	prefix?: boolean;
	substring?: boolean;
	module?: string;
	includeEngine?: boolean;
	/** Engine areas for the engine index (`"Runtime"`, `"Runtime/Core"`, …). Default `Runtime`, `Editor`, `Developer`. */
	engineAreas?: string[];
	/** Opt in to a minutes-long first engine build. Default false: the tool says how, it never stalls. */
	allowEngineBuild?: boolean;
	onProgress?: (message: string) => void;
	fs?: FsAdapter;
	deps?: ResolverDeps;
}

/** Definitions lookup. Project + plugin index by default; engine index only when asked. */
export async function symbolLookup(input: SymbolLookupInput) {
	const fs = input.fs ?? realFs;
	const notes: string[] = [];
	const warnings: string[] = [];
	const workspace = await resolveWorkspace(input.cwd, fs, input.deps);
	const scope: Scope = input.scope ?? (input.includeEngine ? "all" : "project");
	const limit = input.limit ?? 25;
	const indexes: { key: string; scope: Scope; defs: number; generatedAt: number }[] = [];
	const results: LookupResult[] = [];

	const project = await ensureIndex({ workspace, mode: "definitions", scope: "project", onProgress: input.onProgress, fs });
	if (project.index) {
		indexes.push({ key: project.key, scope: "project", defs: project.index.meta.counts.symbols, generatedAt: Date.parse(project.index.meta.generatedAt) });
		results.push(...lookupSymbol(project.index, input.query, { limit, prefix: input.prefix, substring: input.substring, module: input.module }));
	}
	notes.push(...project.notes);
	warnings.push(...project.warnings);

	const wantsEngine = scope === "engine" || scope === "all";
	if (wantsEngine) {
		if (!workspace.engineRoot) warnings.push("no engine resolved, so the engine index was skipped");
		else {
			const engine = await ensureIndex({ workspace, mode: "definitions", scope: "engine", engineAreas: input.engineAreas, allowEngineBuild: input.allowEngineBuild, onProgress: input.onProgress, fs });
			if (engine.index) {
				indexes.push({ key: engine.key, scope: "engine", defs: engine.index.meta.counts.symbols, generatedAt: Date.parse(engine.index.meta.generatedAt) });
				results.push(...lookupSymbol(engine.index, input.query, { limit, prefix: input.prefix, substring: input.substring, module: input.module }));
			}
			notes.push(...engine.notes);
			warnings.push(...engine.warnings);
		}
	} else {
		const engineIndexes = listIndexes().filter((state) => !!state.meta.engineRoot && !state.meta.projectRoot);
		if (engineIndexes.length) notes.push(`engine index cached (${engineIndexes[0]?.key}); pass scope 'all' to search it`);
		else notes.push("engine index not built — pass scope 'engine' or 'all' for engine symbols (first build takes minutes)");
	}

	// Rank first, kind second: sorting by kind/name is what made a plugin forward declaration beat
	// the engine's real `UCLASS` row and then get cut by the limit.
	results.sort((a, b) => a.rank - b.rank || Number(b.marker.includes("forward")) - Number(a.marker.includes("forward")) || a.kind.localeCompare(b.kind) || a.symbol.localeCompare(b.symbol));
	return { query: input.query, scope, total: results.length, results: results.slice(0, limit), indexes, notes, warnings, workspace: { projectPath: workspace.projectPath, engineRoot: workspace.engineRoot } };
}

export interface SymbolListInput {
	cwd: string;
	prefix: string;
	scope?: Scope;
	kind?: string;
	module?: string;
	limit?: number;
	engineAreas?: string[];
	allowEngineBuild?: boolean;
	fs?: FsAdapter;
	deps?: ResolverDeps;
}

/** Prefix listing — cheap, and the way to discover `FX`/`U`/`A` families. */
export async function symbolList(input: SymbolListInput) {
	const fs = input.fs ?? realFs;
	const workspace = await resolveWorkspace(input.cwd, fs, input.deps);
	const scope: Scope = input.scope ?? "project";
	const notes: string[] = [];
	const handles: IndexHandle[] = [];
	const project = await ensureIndex({ workspace, mode: "definitions", scope: "project", engineAreas: input.engineAreas, fs });
	handles.push(project);
	if (scope !== "project" && workspace.engineRoot) handles.push(await ensureIndex({ workspace, mode: "definitions", scope: "engine", engineAreas: input.engineAreas, allowEngineBuild: input.allowEngineBuild, fs }));

	const symbols: ReturnType<typeof listSymbols> = [];
	for (const handle of handles) {
		if (!handle.index) continue;
		symbols.push(...listSymbols(handle.index, input.prefix, { limit: input.limit ?? 50, kind: input.kind, module: input.module }));
		notes.push(...handle.notes);
	}
	symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));
	return { prefix: input.prefix, scope, total: symbols.length, symbols: symbols.slice(0, input.limit ?? 50), notes, indexes: handles.map((handle) => handle.key) };
}

export interface FileContextInput {
	cwd: string;
	file: string;
	mode?: Mode;
	allowEngineBuild?: boolean;
	includeDefines?: boolean;
	limit?: number;
	engineAreas?: string[];
	refresh?: boolean;
	onProgress?: (message: string) => void;
	fs?: FsAdapter;
	deps?: ResolverDeps;
}

/** One file, everything needed to reason about compiling it. */
export async function fileContext(input: FileContextInput) {
	const fs = input.fs ?? realFs;
	const notes: string[] = [];
	const warnings: string[] = [];
	const workspace = await resolveWorkspace(input.cwd, fs, input.deps);
	let mode: Mode = input.mode ?? "definitions";
	let file = normalizePath(input.file);
	if (!/^([a-z]:)?[\/]/i.test(file)) {
		for (const base of [input.cwd, workspace.projectDir]) {
			if (!base) continue;
			const candidate = normalizePath(joinPath(base, file));
			if (fs.exists(candidate)) {
				notes.push(`resolved relative path to ${candidate}`);
				file = candidate;
				break;
			}
		}
	}

	let queryFiles: CachePaths | undefined;
	let choice: TargetChoice | undefined;
	if (mode === "full") {
		choice = pickTarget({ cwd: input.cwd, engineRoot: workspace.engineRoot, fs });
		const ensured = await ensureQueryJson({ cacheRoot: cacheDir(fs), choice, engineRoot: workspace.engineRoot, fs, onStdout: input.onProgress });
		queryFiles = ensured.source === "missing" ? undefined : ensured.paths;
		notes.push(...ensured.notes);
		warnings.push(...ensured.warnings);
		if (!queryFiles) {
			mode = "definitions";
			warnings.push("falling back to definitions mode: UnrealBuildTool Query produced no JSON");
		}
	}

	const scope: Scope = file.includes("/Engine/Source/") ? "engine" : "project";
	const handle = await ensureIndex({ workspace, mode, scope, target: choice?.target, platform: choice?.platform, configuration: choice?.configuration, queryFiles, refresh: input.refresh, allowEngineBuild: input.allowEngineBuild, engineAreas: input.engineAreas, onProgress: input.onProgress, fs });
	notes.push(...handle.notes);
	warnings.push(...handle.warnings);
	if (!handle.index) return { file, mode, notes, warnings, error: `no index available for ${scope} sources` };

	let context = contextFor(handle.index, file, { limit: input.limit ?? 40, queryFiles: queryFiles ?? handle.index.meta.queryFiles });
	if (!context) {
		// A bare file name is the common case; resolve it against what the index actually holds.
		const matches = findFileBySuffix(handle.index, baseName(file), 6);
		if (matches.length === 1) {
			file = matches[0]!;
			notes.push(`resolved '${input.file}' to ${file} via the index`);
			context = contextFor(handle.index, file, { limit: input.limit ?? 40, queryFiles: queryFiles ?? handle.index.meta.queryFiles });
		} else if (matches.length > 1) {
			return { file, mode, notes: [...notes, `multiple indexed files match '${baseName(file)}': ${matches.join(", ")}`], warnings, error: "ambiguous file name; pass a path with more directories" };
		}
	}
	if (!context) {
		const other = mode === "full" ? "definitions" : "full";
		const fallback = pickIndex({ mode: other as Mode, projectRoot: workspace.projectDir, engineRoot: workspace.engineRoot }).index;
		if (fallback) {
			const fromOther = contextFor(fallback, file, { limit: input.limit ?? 40, queryFiles: fallback.meta.queryFiles });
			if (fromOther) {
				notes.push(`file found in the ${other}-mode index ${fallback.key}, not ${mode}`);
				return { file, mode: other, module: moduleFromBuildCs(file), context: fromOther, symbols: symbolsInFile(fallback, file, input.limit ?? 40), defines: input.includeDefines ? fromOther.defines : undefined, notes, warnings };
			}
		}
		return { file, mode, notes, warnings, error: `${file} is not in index ${handle.key} (it may be outside the scanned module roots, in ThirdParty, or a generated header in Intermediate/)` };
	}

	const symbols = symbolsInFile(handle.index, file, input.limit ?? 40);
	const defines = input.includeDefines ? context.defines : undefined;
	if (!context.includePaths?.length) notes.push("no include paths in this mode — build mode 'full' (unreal_index, mode: \"full\") for includePaths and the forced-included defines file");
	notes.push(`module attribution: ${handle.index.meta.source === "ubt" ? "UnrealBuildTool Query dirToModule" : "*.Build.cs location (run a full-mode index for UBT's own answer)"}`);
	return {
		file,
		mode,
		module: context.module || moduleFromBuildCs(file),
		indexKey: handle.key,
		symbols,
		compile: context,
		defines,
		notes,
		warnings,
	};
}

export interface BuildContextInput {
	cwd: string;
	target?: string;
	platform?: string;
	configuration?: string;
	module?: string;
	file?: string;
	includeDefines?: boolean;
	refresh?: boolean;
	limit?: number;
	engineAreas?: string[];
	onProgress?: (message: string) => void;
	fs?: FsAdapter;
	deps?: ResolverDeps;
}

/**
 * The compile environment UnrealBuildTool actually uses: target identity, defines, standard,
 * SDK, include paths, and module dependencies — from Query JSON, cached in the pi cache.
 */
export async function buildContext(input: BuildContextInput) {
	const fs = input.fs ?? realFs;
	const workspace = await resolveWorkspace(input.cwd, fs, input.deps);
	if (!workspace.engineRoot) return { error: "no engine resolved for this project; run unreal_resolve_engine", notes: workspace.notes };

	const root = cacheDir(fs);
	const choice = pickTarget({ cwd: input.cwd, target: input.target, platform: input.platform, configuration: input.configuration, engineRoot: workspace.engineRoot, fs });
	const before = queryCacheState(root, choice, fs);
	const notes: string[] = [`target ${choice.target} ${choice.platform} ${choice.configuration} (derived from ${choice.source})`];
	const warnings: string[] = [...before.notes];

	const ensured = await ensureQueryJson({ cacheRoot: root, choice, engineRoot: workspace.engineRoot, refresh: input.refresh, fs, onStdout: input.onProgress });
	notes.push(...ensured.notes);
	warnings.push(...ensured.warnings);
	if (!ensured.paths) return { target: choice, notes, warnings, error: "UnrealBuildTool Query produced no JSON; inspect the notes for the spawn failure" };

	const details = parseTargetDetails(readQueryJson(ensured.paths.targetDetails));
	const moduleRefs: Map<string, UbtModuleRefs> = parseModuleReferences(readQueryJson(ensured.paths.moduleReferences));

	const wanted = input.module ?? (input.file ? moduleFromBuildCs(normalizePath(input.file)) : undefined) ?? workspace.projectName;
	const refs = wanted ? moduleRefs.get(wanted) : undefined;
	const settings = refs ? details.settings.get(refs.moduleDirectory) : undefined;
	if (!refs) notes.push(`no Query entry for module '${wanted ?? ""}'; pass 'module' — ${moduleRefs.size} modules in this target's graph`);
	else if (!settings) notes.push(`module '${wanted}' has module references but no compile settings entry in TargetDetails`);

	const headers = refs ? [...refs.public, ...refs.private, ...refs.publicInclude, ...refs.privateInclude] : [];
	if (refs && !settings) notes.push("compile settings (includePaths, standard, forced includes) live in TargetDetails; this target's TargetDetails entry for the module was empty");
	const handle = await ensureIndex({ workspace, mode: "definitions", scope: "project", engineAreas: input.engineAreas, fs });
	const indexModules = handle.index ? listModules(handle.index, { limit: input.limit ?? 40 }) : [];

	return {
		target: choice,
		queryCache: { targetDetails: ensured.paths.targetDetails, moduleReferences: ensured.paths.moduleReferences, source: ensured.source, durationMs: ensured.durationsMs },
		isTestTarget: details.isTestTarget,
		launch: details.launch,
		module: refs ? { name: wanted, directory: refs.moduleDirectory, dependencies: refs.public.length + refs.private.length, publicHeaders: refs.public.length, privateHeaders: refs.private.length, publicInclude: refs.publicInclude, privateInclude: refs.privateInclude, dynamicallyLoaded: refs.dynamicallyLoaded, circular: refs.circular, standard: settings?.standard, windowsSdkVersion: settings?.windowsSdkVersion, compilerPath: settings?.compilerPath, includePaths: settings?.includePaths.length ?? 0, forcedIncludes: settings?.forcedIncludes ?? [], definesFile: settings?.definesFile } : undefined,
		headerCount: headers.length,
		defines: input.includeDefines ? settings?.defines ?? [] : undefined,
		modulesInTarget: [...moduleRefs.keys()].sort().slice(0, input.limit ?? 40),
		projectModules: indexModules,
		modulesTotal: moduleRefs.size,
		targetModules: details.dirModules.length,
		notes,
		warnings,
	};
}

/** What is cached right now: symbol indexes and Query JSON, with ages and costs. */
export function indexStatus(cwd: string, fs: FsAdapter = realFs) {
	const root = cacheDir(fs);
	const indexes = listIndexes().map((state) => ({
		key: state.key,
		mode: state.meta.mode,
		generatedAt: state.meta.generatedAt,
		ageMs: Date.now() - Date.parse(state.meta.generatedAt),
		defs: state.meta.counts.symbols,
		files: state.meta.counts.files,
		defsByKind: state.meta.defsByKind,
		source: state.meta.source,
		target: state.meta.target,
		scope: state.scope,
		roots: state.meta.roots.length,
		sizeMb: Math.round(state.meta.sizeBytes / 1024 / 1024),
		issues: state.issues,
	}));
	const choice = pickTarget({ cwd, fs });
	const query = queryCacheState(root, choice, fs);
	return { cacheDir: root, indexes, query: { target: choice, usable: query.usable, targetDetails: query.targetDetails, moduleReferences: query.moduleReferences, notes: query.notes } };
}

export { hostPlatform };

export interface IndexBuildInput {
	cwd: string;
	scope: Exclude<Scope, "all">;
	mode: Mode;
	engineAreas?: string[];
	target?: string;
	platform?: string;
	configuration?: string;
	refresh?: boolean;
	onProgress?: (message: string) => void;
	fs?: FsAdapter;
	deps?: ResolverDeps;
}

/**
 * Build (or rebuild) one symbol index. This is the only entry point that opts in to a minutes-long
 * Engine/Source scan — lookups report the cost and hand back, they never stall an agent.
 */
export async function indexBuild(input: IndexBuildInput) {
	const fs = input.fs ?? realFs;
	const workspace = await resolveWorkspace(input.cwd, fs, input.deps);
	const notes: string[] = [];
	let queryFiles: CachePaths | undefined;

	if (input.mode === "full") {
		if (!workspace.engineRoot) return { key: "none", built: false, symbols: 0, files: 0, durationMs: 0, roots: 0, notes: [...workspace.notes, "no engine resolved, so UnrealBuildTool Query cannot run (run unreal_resolve_engine)"] };
		const choice = pickTarget({ cwd: input.cwd, target: input.target, platform: input.platform, configuration: input.configuration, engineRoot: workspace.engineRoot, fs });
		const ensured = await ensureQueryJson({ cacheRoot: cacheDir(fs), choice, engineRoot: workspace.engineRoot, refresh: input.refresh, fs, onStdout: input.onProgress });
		notes.push(...ensured.notes);
		queryFiles = ensured.paths;
	}

	const handle = await ensureIndex({
		workspace,
		mode: input.mode,
		scope: input.scope,
		engineAreas: input.engineAreas,
		allowEngineBuild: true,
		refresh: input.refresh,
		target: input.target,
		platform: input.platform,
		configuration: input.configuration,
		queryFiles,
		onProgress: input.onProgress,
		fs,
	});

	return {
		key: handle.key,
		built: handle.built,
		mode: input.mode,
		scope: input.scope,
		engineAreas: input.engineAreas ?? DEFAULT_ENGINE_AREAS,
		symbols: handle.index?.meta.counts.symbols ?? 0,
		files: handle.index?.meta.counts.files ?? 0,
		modules: handle.index?.meta.counts.modules ?? 0,
		defsByKind: handle.index?.meta.defsByKind,
		durationMs: handle.durationMs,
		roots: handle.roots.length,
		indexDir: handle.index?.dir,
		notes: [...workspace.notes, ...handle.notes, ...notes],
		warnings: handle.warnings,
	};
}
