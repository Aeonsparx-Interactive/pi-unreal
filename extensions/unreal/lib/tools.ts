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
import { buildPluginIndex, resolveProjectPlugins, type PluginReferenceResult, type PluginSummary } from "./plugin-resolver.ts";
import { findProjectFile, resolveEngineForProject, type ResolverDeps } from "./engine-resolver.ts";
import { ensureQueryJson, pickTarget, queryCachePaths, queryCacheState, humanAge, type CachePaths, type TargetChoice } from "./query.ts";
import {
	assembleRoots,
	auditCache,
	buildHeaderIndex,
	buildIndex,
	collectCallSites,
	contextFor,
	expectedKeyFor,
	findFileBySuffix,
	findRowsByMember,
	indexKeyFor,
	keyFingerprint,
	listFiles,
	headerKeyFor,
	listHeaderIndexes,
	listIndexes,
	listModules,
	listSymbols,
	loadHeaderIndex,
	lookupHeaderPaths,
	lookupSymbol,
	moduleFromBuildCs,
	moduleFromSourcePath,
	nameTokens,
	pickHeaderIndex,
	pickIndex,
	pluginFamilyOfPath,
	pluginFamilyOfQuery,
	pruneCache,
	readDefines,
	rootKindsNote,
	splitQualified,
	suggestFileNames,
	suggestHeaderPaths,
	symbolsInFile,
	type ContextUnit,
	type DefRow,
	type HeaderIndex,
	type HeaderRow,
	type IndexState,
	type LookupResult,
	type IndexScope,
	type ScanRoot,
	DEFAULT_ENGINE_AREAS,
} from "./store.ts";
import { hostPlatform, parseModuleReferences, parseTargetDetails, readQueryJson, type UbtModuleRefs, type UbtModuleSettings } from "./ubt.ts";
import { discoverTargets, pickDefaultTarget } from "./ubt.ts";
import { clangdCheck, clangdSearchDirs, compileCommandFor, databasesIn, describeDatabase, discoverClangd, ensureCompileDb, installCompileDb, listCompileDbs, readClangdConfig, responseFileStatus, type InstallResult } from "./compiledb.ts";
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
	/**
	 * Declared module names per plugin root dir (from each `.uplugin`). A module directory takes the
	 * name of its `*.Build.cs` file, which is how `Engine/Plugins/Animation/PoseSearch/Source/Runtime`
	 * is module `PoseSearch` and not the directory leaf `Runtime`.
	 */
	pluginModuleNames: Record<string, string[]>;
	/** Every `.uproject` reference with its resolved descriptor — the source of 'is this plugin available'. */
	pluginRefs: PluginReferenceResult[];
	/** Every plugin descriptor the scan found, including plugins the `.uproject` does not reference. */
	plugins: PluginSummary[];
	notes: string[];
}

export async function resolveWorkspace(cwd: string, fs: FsAdapter = realFs, deps: ResolverDeps = {}): Promise<Workspace> {
	const notes: string[] = [];
	const workspace: Workspace = { cwd: normalizePath(cwd), pluginDirs: [], pluginModuleNames: {}, pluginRefs: [], plugins: [], notes };

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
		workspace.pluginRefs = refs;
		workspace.plugins = index.entries;
		workspace.pluginDirs = refs.filter((ref) => ref.plugin).map((ref) => normalizePath(ref.plugin!.dir));
		for (const entry of index.entries) {
			const names = entry.modules.map((module) => module.moduleName).filter(Boolean);
			if (names.length) workspace.pluginModuleNames[normalizePath(entry.dir)] = names;
		}
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
	const areas = engineScope ? (request.engineAreas?.length ? request.engineAreas : DEFAULT_ENGINE_AREAS) : undefined;
	const roots = assembleRoots({
		projectRoot: engineScope ? undefined : workspace.projectDir,
		// Engine-scope indexes cover Engine/Source areas and the `engineAreas` dial of Engine/Plugins trees.
		// They do NOT carry the project's enabled plugin roots any more: those belong to the project index,
		// whose key is exactly that root set. Fingerprinting them into the engine key made an unrelated
		// `.uproject` plugin add orphan a 251 MB / 1,240,246-symbol engine scan (field-findings 2026-10-28 §2).
		// A scope `engine`/`all` answer is the union of the project index and the engine index (`scopeIndexes`).
		pluginDirs: engineScope ? [] : workspace.pluginDirs,
		pluginModuleNames: workspace.pluginModuleNames,
		engineRoot: engineScope ? workspace.engineRoot : undefined,
		includeEngine: engineScope,
		engineAreas: areas,
		fs,
	});
	const scope: IndexScope = engineScope ? "Engine" : "Project";
	const rootDirs = roots.roots.map((root) => root.dir);
	const coverage = { projectRoot: workspace.projectDir, engineRoot: workspace.engineRoot };
	const notes = [...roots.notes];
	if (!roots.roots.length) {
		return { key: "none", built: false, warnings: [`no C++ module roots for scope '${request.scope}'`], notes, roots: [] };
	}
	notes.push(`covers ${rootKindsNote(rootDirs, coverage)}`);

	const key = indexKeyFor({
		mode: request.mode,
		roots: rootDirs,
		scope,
		target: request.target,
		platform: request.platform,
		configuration: request.configuration,
		engineRoot: workspace.engineRoot,
		areas,
	});
	if (!request.refresh) {
		const existing = pickIndex({ key, mode: request.mode, scope, projectRoot: engineScope ? undefined : workspace.projectDir, engineRoot: engineScope ? workspace.engineRoot : undefined, roots: rootDirs }).index;
		if (existing) {
			notes.push(`using cached index ${existing.key} (${existing.meta.counts.symbols} symbols, ${existing.meta.counts.files} files, ${humanAge(Date.now() - Date.parse(existing.meta.generatedAt))} old)`);
			const stale = indexCoverageNote(existing);
			if (stale) notes.push(stale);
			return { key, index: existing, built: false, warnings: [], notes, roots: roots.roots };
		}
	}

	if (engineScope && !request.allowEngineBuild) {
		const joined = (areas ?? DEFAULT_ENGINE_AREAS).join(", ");
		notes.push(`no engine index for ${joined}. Building one scans every .h/.cpp in those areas (tens of thousands of files): minutes the first time, cached afterwards. The project index (${workspace.pluginDirs.length} enabled plugin root(s) + project sources) is scanned alongside it for scope "engine"/"all" answers, so plugin-shipped types do not need an engine scan.`);
		notes.push(`call unreal_index with scope "engine" (engineAreas narrows the scan, e.g. ["Runtime"]; add ["Plugins"] for every engine plugin's sources, ["Plugins/Animation/PhysicsControl"] for one)`);
		notes.push('unreal_index action "headers" answers "does this header exist in this engine version" in seconds without a content scan');
		return { key, built: false, warnings: [], notes, roots: roots.roots };
	}

	const scopeNote = request.scope === "engine" ? `indexing Engine/Source / Engine/Plugins areas (${(areas ?? DEFAULT_ENGINE_AREAS).join(", ")}); the first engine index takes minutes, then it is cached` : "indexing project and plugin sources";
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
		areas,
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

/** Coverage of an already-built index, read from its own meta — the line a warm cache must print. */
export function indexCoverageNote(state: IndexState): string {
	const kinds = Object.entries(state.meta.rootKinds ?? {})
		.map(([kind, count]) => `${count} ${kind} root(s)`)
		.join(", ");
	return `index ${state.key} covers ${kinds || `${state.meta.roots.length} root(s)`}${state.meta.areas?.length ? ` (engineAreas ${state.meta.areas.join(", ")})` : ""}`;
}

/**
 * The indexes one lookup scope searches.
 *
 * `project` → the project index (project sources + the plugin roots this .uproject enables).
 * `engine` and `all` → the project index ∪ the engine index. An engine scan is minutes and is only
 * built on demand, so a lookup must never answer 0 rows for a plugin-shipped type that the project
 * index already contains (measured: `MoverInputCmdContext` 105 rows from the project index, 0 rows
 * from `scope "engine"` with no engine index — field-findings 2026-10-28 §2).
 */
export async function scopeIndexes(request: Omit<IndexRequest, "scope"> & { scope: Scope }): Promise<IndexHandle[]> {
	const handles: IndexHandle[] = [];
	const project = await ensureIndex({ ...request, scope: "project" });
	handles.push(project);
	if (request.scope === "project") return handles;
	const engine = await ensureIndex({ ...request, scope: "engine", engineAreas: request.engineAreas });
	handles.push(engine);
	return handles;
}

/** Root sets a lookup of each scope searches right now — the line `status` must print next to index keys. */
export function currentRootSets(
	workspace: Workspace,
	options: { engineAreas?: string[]; fs?: FsAdapter } = {},
): { engine: string[]; project: string[]; engineAreas: string[] } {
	const fs = options.fs ?? realFs;
	const areas = options.engineAreas?.length ? options.engineAreas : DEFAULT_ENGINE_AREAS;
	const engine = assembleRoots({ pluginDirs: [], engineRoot: workspace.engineRoot, includeEngine: true, engineAreas: areas, fs }).roots.map((root) => root.dir);
	const project = assembleRoots({ projectRoot: workspace.projectDir, pluginDirs: workspace.pluginDirs, pluginModuleNames: workspace.pluginModuleNames, fs }).roots.map((root) => root.dir);
	return { engine, project, engineAreas: areas };
}

/** What an index actually scanned, in root-kind vocabulary — the only honest form of a 0-row answer. */
export interface Coverage {
	key: string;
	scope: Scope;
	kinds: string;
	areas: string[];
	roots: number;
}

function coverageOf(handle: IndexHandle, workspace: Workspace, scope: Scope, areas?: string[]): Coverage {
	return {
		key: handle.key,
		scope,
		kinds: rootKindsNote(handle.roots.map((root) => root.dir), { projectRoot: workspace.projectDir, engineRoot: workspace.engineRoot }),
		areas: areas ?? [],
		roots: handle.roots.length,
	};
}

/**
 * Engine plugins present on disk that the `.uproject` does not reference. They are compiled by the
 * target graph (their modules show up in `TargetModuleReferences`), and they are loaded when
 * `EnabledByDefault` is true — but they are not index roots, so a symbol lookup cannot see them.
 * This is the coverage hole behind every "the engine has no such type" answer.
 */
export function unreferencedEnginePlugins(workspace: Workspace): { enginePlugins: number; referenced: number; names: string[] } {
	const referenced = new Set(workspace.pluginRefs.map((ref) => ref.name.toLowerCase()));
	const seen = new Map<string, true>();
	for (const plugin of workspace.plugins) {
		if (plugin.source === "Engine" && !referenced.has(plugin.name.toLowerCase())) seen.set(plugin.name, true);
	}
	return { enginePlugins: workspace.plugins.filter((plugin) => plugin.source === "Engine").length, referenced: referenced.size, names: [...seen.keys()].sort() };
}

function coverageLines(coverage: Coverage[]): string[] {
	return coverage.map((entry) => `scanned ${entry.scope} index ${entry.key}: ${entry.kinds}${entry.areas.length ? `; engineAreas ${entry.areas.join(", ")}` : ""}${entry.roots === 0 ? " (nothing scanned)" : ""}`);
}

/** Header index for a resolved engine, if one is already built. Never built here: lookups report, they do not scan. */
export function headerIndexForEngine(engineRoot?: string): HeaderIndex | undefined {
	if (!engineRoot) return undefined;
	const wanted = normalizePath(engineRoot).toLowerCase();
	return listHeaderIndexes().find((header) => header.healthy && normalizePath(header.meta.engineRoot ?? "").toLowerCase() === wanted);
}

/** The `engineAreas` dial that scans exactly this plugin: its path under Engine/Plugins. */
function pluginAreaLabel(workspace: Workspace, plugin: PluginSummary): string {
	const pluginsRoot = normalizePath(joinPath(workspace.engineRoot ?? "", "Engine/Plugins"));
	const dir = normalizePath(plugin.dir);
	if (dir.toLowerCase().startsWith(`${pluginsRoot.toLowerCase()}/`)) return `Plugins/${dir.slice(pluginsRoot.length + 1)}`;
	return `Plugins/<Category>/${plugin.name}`;
}

/** Header index for this project's own sources and plugins, if one is already built. */
export function headerIndexForProject(workspace: Workspace): HeaderIndex | undefined {
	const roots = projectHeaderRoots(workspace);
	if (!roots.length) return undefined;
	return pickHeaderIndex(roots);
}

function isUnder(path: string, dir?: string): boolean {
	if (!dir) return false;
	const p = normalizePath(path).toLowerCase();
	const d = normalizePath(dir).toLowerCase();
	return p === d || p.startsWith(`${d}/`);
}

/** Plugin descriptor that owns a file path, by root prefix (project plugins beat engine ones by path shape anyway). */
export function pluginForPath(workspace: Workspace, file: string): PluginSummary | undefined {
	for (const plugin of workspace.plugins) {
		if (isUnder(file, plugin.dir)) return plugin;
	}
	return undefined;
}

/** Roots a path-only header index needs: engine source areas + every engine plugin's sources. */
export function engineHeaderRoots(workspace: Workspace, areas?: string[]): ScanRoot[] {
	if (!workspace.engineRoot) return [];
	const engineAreas = areas?.length ? areas : ["Runtime", "Plugins"];
	return assembleRoots({ engineRoot: workspace.engineRoot, includeEngine: true, engineAreas, pluginModuleNames: workspace.pluginModuleNames, fs: realFs }).roots;
}

/** Roots a path-only header index needs for the project side: its `Source` tree and its plugins' sources. */
export function projectHeaderRoots(workspace: Workspace, fs: FsAdapter = realFs): string[] {
	const roots = assembleRoots({ projectRoot: workspace.projectDir, pluginDirs: workspace.pluginDirs, pluginModuleNames: workspace.pluginModuleNames, fs }).roots;
	return roots.map((root) => root.dir);
}

export interface HeaderAnswer {
	name: string;
	exists: boolean;
	found: { file: string; module: string; kind: string; match: string; plugin?: string; pluginSource?: PluginSummary["source"]; enabledByDefault?: boolean; referencedInUproject?: boolean; inTargetGraphHint?: string }[];
	candidates: { file: string; module: string; kind?: string; match?: string; reason?: string }[];
	indexKey?: string;
	rootsScanned: string;
	notes: string[];
	warnings: string[];
}

/**
 * "Does this header exist in THIS engine version?" — a path question, answered from the header index.
 *
 * A definitions index cannot answer it: absence of a symbol row is a statement about the roots that
 * were scanned, not about the engine. This answers with file paths only, and labels them as file
 * names, never as types.
 */
export function headerLookup(input: { name: string; workspace: Workspace; header?: HeaderIndex; limit?: number }): HeaderAnswer {
	const name = input.name.trim();
	const notes: string[] = [];
	const warnings: string[] = [];
	const workspace = input.workspace;
	const header = input.header;
	if (!header) {
		const engine = workspace.engineRoot ? "scope engine (Engine/Source areas + every Engine/Plugins source)" : "the project's own sources";
		return {
			name,
			exists: false,
			found: [],
			candidates: [],
			rootsScanned: "none",
			notes: [...notes, `no header index for ${engine}; build one with unreal_index action "headers" (walks file paths only: seconds, no content scan, cached under the pi cache)`],
			warnings,
		};
	}

	const referenced = new Set(workspace.pluginRefs.map((ref) => ref.name.toLowerCase()));
	const decorate = (row: HeaderRow) => {
		const plugin = pluginForPath(workspace, row.file);
		return {
			file: row.file,
			module: row.module,
			kind: row.kind,
			match: row.match,
			plugin: plugin?.name,
			pluginSource: plugin?.source,
			enabledByDefault: plugin?.enabledByDefault,
			referencedInUproject: plugin ? referenced.has(plugin.name.toLowerCase()) : undefined,
		};
	};

	const exact = lookupHeaderPaths(header, name, { limit: input.limit ?? 12 });
	const candidates = exact.length ? [] : suggestHeaderPaths(header, name, { limit: 8, family: pluginFamilyOfQuery(name) });
	const rootsScanned = rootKindsNote(header.meta.roots, { projectRoot: header.meta.projectRoot, engineRoot: header.meta.engineRoot });
	notes.push(`header index ${header.key} (${header.meta.files} header paths, ${rootsScanned})`);
	if (!exact.length) {
		notes.push(`'${name}' is not a file path in this engine index`);
		if (candidates.length) notes.push(`  closest real file names (files, not types):\n${candidates.map((row) => `    ${row.file}  [${row.module}]${row.reason ? `  (${row.reason})` : ""}`).join("\n")}`);
		warnings.push(`'${name}' was not found; the answer is about file paths, not about C++ types`);
	}
	return { name, exists: exact.length > 0, found: exact.map(decorate), candidates: candidates.map((row) => ({ file: row.file, module: row.module, kind: row.kind, match: row.match, reason: row.reason })), indexKey: header.key, rootsScanned, notes, warnings };
}

/**
 * A 0-row answer for `<Type>:<Member>_Implementation` is a UHT fact, not a miss (field-findings
 * 2026-10-28 §8). `IMoverInputProducerInterface:ProduceInput_Implementation` returns nothing because
 * UnrealHeaderTool generates `_Implementation` members on the *implementers*, never on the interface
 * declaration (`ProduceInput` is `UFUNCTION(BlueprintNativeEvent)` in `MoverSimulationTypes.h`).
 * Name the declared member, then list the implementer rows the indexes do hold.
 */
export function zeroResultUhtNotes(query: string, indexes: IndexState[]): string[] {
	const { owner, member } = splitQualified(baseName(query).replace(/\.(h|hpp|hxx|inl)$/i, ""));
	if (!member.endsWith("_Implementation") || member.length <= "_implementation".length) return [];
	const declared = member.slice(0, -"_Implementation".length);
	const notes = [`'${member}' is the UnrealHeaderTool-generated thunk of a BlueprintNativeEvent/BlueprintImplementableEvent: it is emitted on every IMPLEMENTER, never on the declaring ${owner ? `interface ${owner}` : "type"} — a 0-row answer here is correct, not a search failure`];
	notes.push(`the declared member is '${declared}': unreal_symbol query '${owner ? `${owner}:${declared}` : declared}' (definition + implementer declarations), then unreal_symbol_list prefix '${declared}' for the family`);
	const implementers = new Map<string, string>();
	for (const index of indexes) {
		// The qualified-member scan, not `lookupSymbol`: the definitions store keeps the QUALIFIED row
		// (`ALpMoverPawn:ProduceInput_Implementation`), and on the live box a BARE
		// `ProduceInput_Implementation` row also exists (ChaosMover), which lookupSymbol's exact pass
		// matches — so its substring pass never runs and the implementers stay invisible.
		for (const row of findRowsByMember(index, `${declared}_Implementation`, { limit: 200 })) {
			implementers.set(row.symbol, `${row.symbol}  ${row.file}:${row.line}  [${row.module}]`);
		}
	}
	if (implementers.size) {
		const lines = [...implementers.values()].sort().slice(0, 8);
		notes.push(`implementer rows found (${implementers.size}): ${lines.join(" · ")}${implementers.size > 8 ? " …" : ""}`);
	} else {
		notes.push(`no implementer of '${declared}' in the scanned indexes: unreal_symbol query '${declared}' scope "all" prefix true, or engineAreas ["Plugins"] when the implementer lives in an unreferenced plugin`);
	}
	return notes.map((note) => `uht: ${note}`);
}

/** Notes a 0-row answer must carry: what was scanned, what was not, and the exact next call. */
export function zeroResultNotes(input: { query: string; scope: Scope; workspace: Workspace; coverage: Coverage[]; engineAreas?: string[]; indexes: IndexState[]; header?: HeaderIndex }): string[] {
	const notes: string[] = [`no definitions matched '${input.query}' in scope '${input.scope}'`];
	notes.push(...zeroResultUhtNotes(input.query, input.indexes));
	notes.push(...coverageLines(input.coverage));

	const wantsEngine = input.scope === "engine" || input.scope === "all";
	if (input.workspace.engineRoot) {
		const gap = unreferencedEnginePlugins(input.workspace);
		if (wantsEngine) {
			notes.push(`engine plugins on disk: ${gap.enginePlugins}, referenced by this .uproject: ${gap.referenced}; the engine index scans referenced plugins only`);
			notes.push(`a plugin the project does not reference is not in any index root: pass engineAreas ["Plugins"] (every Engine/Plugins source, ~2.8x the Runtime scan) or ["Plugins/<Category>/<Plugin>"] for one plugin`);
			const near = rankNamesByQuery(gap.names, input.query);
			if (near.length) notes.push(`unreferenced engine plugins whose name matches the query: ${near.slice(0, 6).join(", ")}${gap.names.length > 6 ? ` (of ${gap.names.length} unreferenced engine plugins with sources here)` : ""}`);
		}
		notes.push(input.header ? `header index ${input.header.key} covers ${rootKindsNote(input.header.meta.roots, { engineRoot: input.header.meta.engineRoot })}` : `asking whether a header exists is a path question, not a symbol question: unreal_index action "headers" (path walk only, seconds) answers it from ${input.workspace.engineRoot}/Engine/Plugins and Engine/Source`);
	}
	if (!wantsEngine) {
		notes.push("a project index contains the project and its enabled plugins only; engine sources are not scanned: pass scope \"engine\" (first build takes minutes) or scope \"all\"");
	}

	const suggestions = new Map<string, { file: string; module: string }>();
	for (const index of input.indexes) {
		for (const row of suggestFileNames(index, input.query, { limit: 4 })) {
			if (!suggestions.has(row.file)) suggestions.set(row.file, { file: row.file, module: row.module });
		}
	}
	if (suggestions.size) {
		notes.push(`closest indexed FILE names (file names, not types — they are not proof a type exists):\n${[...suggestions.values()].slice(0, 6).map((row) => `    ${row.file}  [${row.module}]`).join("\n")}`);
	}

	notes.push(`next: unreal_symbol query '${input.query.replace(/\.(h|hpp|hxx|inl)$/i, "")}' scope "all" prefix true, or unreal_index action "headers" name "${input.query}"`);
	return notes;
}

/** Names ranked by how many of the query's name tokens they contain — the gap list must answer *this* question. */
function rankNamesByQuery(names: string[], query: string): string[] {
	const tokens = nameTokens(baseName(query).replace(/\.(h|hpp|hxx|inl|cpp|cc|c)$/i, ""));
	if (!tokens.length) return names;
	const scored = names.map((name) => {
		const mine = new Set(nameTokens(name));
		let hits = 0;
		for (const token of tokens) if (mine.has(token)) hits++;
		return { name, hits };
	});
	return scored.filter((entry) => entry.hits > 0).sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name)).map((entry) => entry.name);
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
	/** Engine areas for the engine index: `"Runtime"`, `"Runtime/Core"`, `"Editor"`, or the plugin dials `"Plugins"` / `"Plugins/Animation/PhysicsControl"`. Default `DEFAULT_ENGINE_AREAS` (`["Runtime"]`). */
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
	const indexes: { key: string; scope: Scope; defs: number; files: number; generatedAt: number }[] = [];
	const results: LookupResult[] = [];
	const coverage: Coverage[] = [];
	const searched: IndexState[] = [];

	// Union search: the project index (project sources + the plugin roots this .uproject enables) is the
	// cheap half and is ALWAYS searched; the engine index is the expensive half and is searched for
	// scope engine/all. Naming them separately is the point — an answer that says "0 in scope engine"
	// while the plugin type sits in the project index is a lie about coverage.
	const project = await ensureIndex({ workspace, mode: "definitions", scope: "project", onProgress: input.onProgress, fs });
	if (project.index) {
		indexes.push({ key: project.key, scope: "project", defs: project.index.meta.counts.symbols, files: project.index.meta.counts.files, generatedAt: Date.parse(project.index.meta.generatedAt) });
		searched.push(project.index);
		results.push(...lookupSymbol(project.index, input.query, { limit, prefix: input.prefix, substring: input.substring, module: input.module }));
	}
	notes.push(...project.notes);
	warnings.push(...project.warnings);
	coverage.push(coverageOf(project, workspace, "project"));
	if (scope !== "project") {
		notes.push(`scope '${scope}' searches the union: project index ${project.key} (${rootKindsNote(project.roots.map((root) => root.dir), { projectRoot: workspace.projectDir, engineRoot: workspace.engineRoot })})${workspace.engineRoot ? " ∪ engine index" : " (no engine resolved)"}`);
	}

	const wantsEngine = scope === "engine" || scope === "all";
	if (wantsEngine) {
		if (!workspace.engineRoot) warnings.push("no engine resolved, so the engine index was skipped");
		else {
			const engine = await ensureIndex({ workspace, mode: "definitions", scope: "engine", engineAreas: input.engineAreas, allowEngineBuild: input.allowEngineBuild, onProgress: input.onProgress, fs });
			if (engine.index) {
				indexes.push({ key: engine.key, scope: "engine", defs: engine.index.meta.counts.symbols, files: engine.index.meta.counts.files, generatedAt: Date.parse(engine.index.meta.generatedAt) });
				searched.push(engine.index);
				results.push(...lookupSymbol(engine.index, input.query, { limit, prefix: input.prefix, substring: input.substring, module: input.module }));
			}
			notes.push(...engine.notes);
			warnings.push(...engine.warnings);
			coverage.push(coverageOf(engine, workspace, "engine", input.engineAreas));
		}
	} else {
		const engineIndexes = listIndexes().filter((state) => state.scope === "Engine");
		if (engineIndexes.length) {
			const best = engineIndexes[0];
			notes.push(`engine index cached (${best?.key}; ${best ? rootKindsNote(best.meta.roots, { engineRoot: best.meta.engineRoot }) : "roots unknown"}${best?.meta.areas?.length ? `; areas ${best.meta.areas.join(", ")}` : ""}) — pass scope 'all' to search it`);
		} else {
			notes.push("engine index not built — pass scope 'engine' or 'all' for engine symbols (first build takes minutes; engineAreas [\"Plugins\"] adds every engine plugin's sources). The project index searched here already covers the plugin roots this .uproject enables.");
		}
	}

	// A plugin root appears in both the project index and the engine index, so `all` sees the same
	// declaration twice. Same symbol/file/line is one fact: keep the first, drop the echo.
	const unique = new Map<string, LookupResult>();
	for (const row of results) {
		const id = `${row.symbol}\u0000${row.file}\u0000${row.line}`;
		const kept = unique.get(id);
		if (!kept || row.rank < kept.rank) unique.set(id, row);
	}
	results.length = 0;
	results.push(...unique.values());

	// Rank first, kind second: sorting by kind/name is what made a plugin forward declaration beat
	// the engine's real `UCLASS` row and then get cut by the limit.
	results.sort((a, b) => a.rank - b.rank || Number(b.marker.includes("forward")) - Number(a.marker.includes("forward")) || a.kind.localeCompare(b.kind) || a.symbol.localeCompare(b.symbol));
	const total = results.length;
	if (!total) {
		notes.push(...zeroResultNotes({ query: input.query, scope, workspace, coverage, engineAreas: input.engineAreas, indexes: searched, header: wantsEngine ? headerIndexForEngine(workspace.engineRoot) : headerIndexForProject(workspace) }));
	}
	return { query: input.query, scope, total, results: results.slice(0, limit), indexes, coverage, notes, warnings, workspace: { projectPath: workspace.projectPath, engineRoot: workspace.engineRoot } };
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
	const project = await ensureIndex({ workspace, mode: "definitions", scope: "project", engineAreas: input.engineAreas, fs });
	const handles: IndexHandle[] = [project];
	if (scope !== "project" && workspace.engineRoot) handles.push(await ensureIndex({ workspace, mode: "definitions", scope: "engine", engineAreas: input.engineAreas, allowEngineBuild: input.allowEngineBuild, fs }));

	const symbols: ReturnType<typeof listSymbols> = [];
	const seen = new Set<string>();
	for (const handle of handles) {
		if (!handle.index) continue;
		for (const row of listSymbols(handle.index, input.prefix, { limit: input.limit ?? 50, kind: input.kind, module: input.module })) {
			const id = `${row.symbol}\u0000${row.file}\u0000${row.line}`;
			if (seen.has(id)) continue;
			seen.add(id);
			symbols.push(row);
		}
		notes.push(...handle.notes);
	}
	symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));
	return { prefix: input.prefix, scope, total: symbols.length, symbols: symbols.slice(0, input.limit ?? 50), notes, indexes: handles.map((handle) => handle.key) };
}

/** Scope by path shape. Engine plugins are engine sources; project plugins are project sources. */
export function scopeForPath(file: string, workspace: Workspace): Exclude<Scope, "all"> {
	const p = normalizePath(file).toLowerCase();
	if (workspace.engineRoot) {
		const er = normalizePath(workspace.engineRoot).toLowerCase();
		if (p.startsWith(`${er}/engine/plugins/`) || p.startsWith(`${er}/engine/source/`)) return "engine";
	}
	// An engine-shaped path with no resolved engine root: answer it as engine, say why it failed.
	if (/\/engine\/plugins\/[^/]+\/source\//.test(p) || /\/engine\/source\//.test(p)) return "engine";
	return "project";
}

/**
 * The header-index answer for a path a symbol index cannot see — usable with NO symbol index at all.
 *
 * This is the answer an engine C++ question needs when there is no engine scan: the path exists, its
 * module, its owning plugin and availability, the target that graph was read from, and how to get the
 * symbol-level answer. The header index is keyed by engine + areas, so unlike an engine symbol index it
 * is still standing after `.uproject` plugin edits (field-findings 2026-10-28 §4).
 */
async function headerPathAnswer(args: { file: string; workspace: Workspace; scope: Exclude<Scope, "all">; mode: Mode; notes: string[]; warnings: string[]; cwd: string; fs: FsAdapter }): Promise<FileContextResult | undefined> {
	const { file, workspace, scope, mode, notes, warnings, fs } = args;
	const header = scope === "engine" ? headerIndexForEngine(workspace.engineRoot) : headerIndexForProject(workspace);
	if (!header) {
		notes.push(`no header index for scope '${scope}' — unreal_index action "headers" builds one in seconds (a path walk, no content read), and its key is (engine, areas): .uproject plugin edits do not invalidate it`);
		return undefined;
	}
	notes.push(`header index ${header.key}: ${header.meta.files} header paths from ${rootKindsNote(header.meta.roots, { projectRoot: header.meta.projectRoot, engineRoot: header.meta.engineRoot })}${header.meta.areas?.length ? ` (engineAreas ${header.meta.areas.join(", ")})` : ""}, ${humanAge(header.ageMs)} old`);
	const rows = lookupHeaderPaths(header, baseName(file), { limit: 6 });
	const hit = rows.find((row) => row.file.toLowerCase() === file.toLowerCase());
	if (!hit) {
		notes.push(`header index ${header.key} has no file named '${baseName(file)}'${rows.length ? `; closest: ${rows.map((row) => row.file).join(", ")}` : ""}`);
		return undefined;
	}
	const plugin = pluginForPath(workspace, hit.file);
	const referenced = plugin ? workspace.pluginRefs.some((ref) => ref.name.toLowerCase() === plugin.name.toLowerCase()) : false;
	const module = hit.module || moduleFromSourcePath(hit.file) || moduleFromBuildCs(hit.file);
	notes.push(`file exists in header index ${header.key} (${hit.kind}, module ${module}) but is not in any symbol-index root`);
	if (plugin) {
		notes.push(`owning plugin ${plugin.name} [${plugin.source}] · EnabledByDefault ${plugin.enabledByDefault} · .uproject reference ${referenced ? "yes" : "no"}`);
		notes.push(`compile C++ from it: unreal_index action build scope engine engineAreas ["${pluginAreaLabel(workspace, plugin)}"] (one plugin's sources), then re-run this call`);
	} else {
		notes.push(`module ${module} resolved from the /Source/<Module>/ path shape: no *.Build.cs-based route is possible for a file no index has read`);
	}
	// Target availability from the Query cache only: this is a miss path, so never start a ~17 s Query here.
	const cached = cachedTargetModules(args.cwd, workspace, fs);
	const availability = cached.moduleRefs && module ? moduleAvailability({ workspace, moduleRefs: cached.moduleRefs, moduleName: module, target: cached.target }) : undefined;
	if (availability) {
		notes.push(`availability in ${cached.target}:`, ...availability.notes);
		notes.push(`query cache read: TargetDetails ${Math.round((cached.targetDetailsBytes ?? 0) / 1024)} KB, ${humanAge(cached.targetDetailsAgeMs ?? 0)} old (unreal_context mode "full" refreshes it)`);
	} else {
		notes.push(cached.note ?? `target availability needs the Query cache: unreal_context module "${module}" answers it in seconds once cached`);
	}
	if (scope === "engine") {
		notes.push(`no engine symbol index for these roots: refresh with unreal_index action build scope engine${header.meta.areas?.length ? ` engineAreas ["${header.meta.areas.join('", "')}"]` : ""} (minutes the first time, cached after), then re-run this call`);
	}
	return {
		file,
		mode,
		module,
		indexKey: header.key,
		headerOnly: true,
		headerKind: hit.kind,
		headerAgeMs: header.ageMs,
		pluginName: plugin?.name,
		pluginSource: plugin?.source,
		enabledByDefault: plugin?.enabledByDefault,
		referencedInUproject: referenced,
		target: cached.target,
		inTargetGraph: availability?.inTargetGraph,
		availability: availability ? [availability.notes.join("\n")] : undefined,
		moduleAvailabilityNotes: availability?.notes,
		notes,
		warnings,
	};
}

/** Target facts from the Query cache, never a UnrealBuildTool run. */
function cachedTargetModules(cwd: string, workspace: Workspace, fs: FsAdapter): { moduleRefs?: Map<string, UbtModuleRefs>; target: string; targetDetailsBytes?: number; targetDetailsAgeMs?: number; note?: string } {
	const choice = pickTarget({ cwd, engineRoot: workspace.engineRoot, fs });
	const state = queryCacheState(cacheDir(fs), choice, fs);
	if (!state.usable) return { target: choice.target, note: `target availability needs the Query cache (${state.notes.join("; ")})` };
	try {
		const paths = queryCachePaths(choice, cacheDir(fs));
		return { moduleRefs: parseModuleReferences(readQueryJson(paths.moduleReferences)), target: choice.target, targetDetailsBytes: state.targetDetails?.bytes, targetDetailsAgeMs: state.targetDetails?.ageMs };
	} catch (error) {
		return { target: choice.target, note: `cached Query JSON unreadable: ${String(error)}` };
	}
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

/** Every shape `fileContext` can answer with: a compiled-unit context, a module/definitions context, a header-index-only answer, a file candidate list, or an error. */
export type FileContextResult = {
	file: string;
	mode: Mode;
	notes: string[];
	warnings: string[];
	indexKey?: string;
	key?: string;
	roots?: ScanRoot[];
	candidates?: string[];
	module?: string;
	target?: string;
	platform?: string;
	configuration?: string;
	queryCache?: Record<string, unknown>;
	compile?: ContextUnit;
	context?: ContextUnit;
	defines?: string[];
	symbols?: DefRow[];
	headerOnly?: boolean;
	headerKind?: string;
	headerAgeMs?: number;
	pluginName?: string;
	pluginSource?: string;
	enabledByDefault?: boolean;
	referencedInUproject?: boolean;
	inTargetGraph?: boolean;
	availability?: string[];
	moduleAvailabilityNotes?: string[];
	error?: string;
};

/** One file, everything needed to reason about compiling it. */
export async function fileContext(input: FileContextInput): Promise<FileContextResult> {
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

	const scope: Exclude<Scope, "all"> = scopeForPath(file, workspace);
	const indexRequest = { workspace, mode, target: choice?.target, platform: choice?.platform, configuration: choice?.configuration, queryFiles, refresh: input.refresh, allowEngineBuild: input.allowEngineBuild, engineAreas: input.engineAreas, onProgress: input.onProgress, fs };
	let handle = await ensureIndex({ ...indexRequest, scope });
	notes.push(...handle.notes);
	warnings.push(...handle.warnings);
	// An engine plugin this .uproject enables is IN the project index's root set. An engine-scope miss
	// must search that index rather than report `no index available for engine sources` for a file the
	// project index already contains (field-findings 2026-10-27 §3: `PhysicsControlComponent.h`).
	if (!handle.index && scope === "engine") {
		const project = await ensureIndex({ ...indexRequest, scope: "project", refresh: false });
		notes.push(...project.notes);
		if (project.index) {
			notes.push(`no engine index for ${scope} sources; searched the project index ${project.key} instead — it covers the plugin roots this .uproject enables (${rootKindsNote(project.roots.map((root) => root.dir), { projectRoot: workspace.projectDir, engineRoot: workspace.engineRoot })})`);
			handle = project;
		}
	}
	// Header-index fallback: the path question is answerable even with no symbol index at all. The engine
	// header index is keyed by (engine, areas) and survives .uproject edits, so it is exactly the surface
	// left standing when an engine symbol scan is missing (field-findings 2026-10-28 §4).
	if (!handle.index) {
		const answer = await headerPathAnswer({ file, workspace, scope, mode, notes, warnings, cwd: input.cwd, fs });
		return answer ?? { file, mode, notes, warnings, error: `no index available for ${scope} sources` };
	}

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
				return { file, mode: other, module: moduleFromBuildCs(file), compile: fromOther, context: fromOther, symbols: symbolsInFile(fallback, file, input.limit ?? 40), defines: input.includeDefines ? fromOther.defines : undefined, notes, warnings };
			}
		}
		// The path question is answerable even when the symbol question is not: a header can exist in a
		// plugin this project never indexed, and 'not in index' must not read as 'does not exist'.
		const fromHeader = await headerPathAnswer({ file, workspace, scope, mode, notes, warnings, cwd: input.cwd, fs });
		if (fromHeader) return fromHeader;
		return { file, mode, notes, warnings, error: `${file} is not in index ${handle.key} (${indexCoverageNote(handle.index)}). It may be outside the scanned module roots, in ThirdParty, or a generated header in Intermediate/. unreal_index action "headers" answers whether the path exists in this engine version.` };
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

export interface ModuleAvailability {
	module: string;
	target: string;
	inTargetGraph: boolean;
	directory?: string;
	type?: string;
	plugin?: string;
	pluginSource?: PluginSummary["source"];
	enabledByDefault?: boolean;
	referencedInUproject: boolean;
	notes: string[];
}

/**
 * Is this module usable here? Two independent facts the `.uproject` alone cannot answer:
 * `TargetModuleReferences` says whether the target's graph compiles the module at all, and the plugin
 * descriptor says who owns it and whether it loads without a reference (`EnabledByDefault`).
 */
export function moduleAvailability(input: { workspace: Workspace; moduleRefs: Map<string, UbtModuleRefs>; moduleName: string; target: string }): ModuleAvailability {
	const { workspace, moduleRefs, moduleName, target } = input;
	const refs = moduleRefs.get(moduleName);
	const plugin = (refs?.moduleDirectory ? workspace.plugins.find((entry) => isUnder(refs.moduleDirectory, entry.dir)) : undefined) ?? workspace.plugins.find((entry) => entry.modules.some((module) => module.moduleName === moduleName));
	const declared = plugin?.modules.find((module) => module.moduleName === moduleName);
	const referenced = plugin ? workspace.pluginRefs.some((ref) => ref.name.toLowerCase() === plugin.name.toLowerCase()) : false;
	const type = refs?.type || declared?.type;
	const notes: string[] = [`  in ${target} module graph: ${refs ? `yes (${refs.moduleDirectory})` : "no — TargetModuleReferences has no entry for it"}`];
	if (plugin) {
		notes.push(`  owning plugin ${plugin.name} [${plugin.source}] · declared module Type ${type ?? "unset"}`);
		notes.push(`  .uproject reference: ${plugin.source === "Engine" ? (referenced ? "referenced" : "NOT referenced") : "not an engine-plugin reference"}`);
		if (!referenced) notes.push(plugin.enabledByDefault ? "  EnabledByDefault true: it loads with no .uproject reference" : "  EnabledByDefault false: runtime use needs a .uproject reference with Enabled true");
	} else {
		notes.push("  no .uplugin declares this module (engine source module, project module, or a name the graph does not contain)");
	}
	return { module: moduleName, target, inTargetGraph: Boolean(refs), directory: refs?.moduleDirectory, type, plugin: plugin?.name, pluginSource: plugin?.source, enabledByDefault: plugin?.enabledByDefault, referencedInUproject: referenced, notes };
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

	const availability = wanted ? moduleAvailability({ workspace, moduleRefs, moduleName: wanted, target: `${choice.target} ${choice.platform} ${choice.configuration}` }) : undefined;
	if (availability) notes.push(...availability.notes);

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
		availability,
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

/** What is cached right now: symbol indexes, header indexes, Query JSON, generated compile
 * databases — with ages, coverage, costs, the root set current lookups search, and the cache bytes a
 * lookup can no longer reach. */
export function indexStatus(cwd: string, fs: FsAdapter = realFs, workspace?: Workspace) {
	const root = cacheDir(fs);
	const audit = auditCache();
	const indexes = listIndexes().map((state) => ({
		key: state.key,
		mode: state.meta.mode,
		generatedAt: state.meta.generatedAt,
		ageMs: Date.now() - Date.parse(state.meta.generatedAt),
		defs: state.meta.counts?.symbols ?? 0,
		files: state.meta.counts?.files ?? 0,
		defsByKind: state.meta.defsByKind,
		source: state.meta.source,
		target: state.meta.target,
		scope: state.scope,
		roots: state.meta.roots.length,
		rootKinds: state.meta.rootKinds,
		coverage: rootKindsNote(state.meta.roots, { projectRoot: state.meta.projectRoot, engineRoot: state.meta.engineRoot }),
		areas: state.meta.areas,
		sizeMb: Math.round(state.meta.sizeBytes / 1024 / 1024),
		expectedKey: expectedKeyFor(state),
		selectedByLookups: keyFingerprint(state.key) === keyFingerprint(expectedKeyFor(state)),
		issues: state.issues,
	}));
	const headers = listHeaderIndexes().map((header) => ({
		key: header.key,
		generatedAt: header.meta.generatedAt,
		ageMs: header.ageMs,
		files: header.meta.files,
		roots: header.meta.roots.length,
		rootKinds: header.meta.rootKinds,
		coverage: rootKindsNote(header.meta.roots, { projectRoot: header.meta.projectRoot, engineRoot: header.meta.engineRoot }),
		areas: header.meta.areas,
		sizeMb: Math.round(header.meta.sizeBytes / 1024 / 1024),
		issues: header.issues,
	}));
	const choice = pickTarget({ cwd, fs });
	const query = queryCacheState(root, choice, fs);
	const compileDbs = listCompileDbs(root);
	const notes = [
		"engine scope covers Engine/Source areas + the engineAreas dial of Engine/Plugins trees; the project's enabled plugin roots belong to the PROJECT index, and a scope \"engine\"/\"all\" answer is the union of both",
		"an index key encodes what it scanned, so a key that is not listed here is not what the last lookup searched — check the rootKinds line before trusting a 0",
	];
	if (workspace) {
		const sets = currentRootSets(workspace, { fs });
		notes.push(`current lookup root sets: engine scope = ${sets.engine.length} root(s) (engineAreas ${sets.engineAreas.join(", ")}, keyed by engineRoot+areas, not by project plugin roots); project scope = ${sets.project.length} root(s) (project sources + ${workspace.pluginDirs.length} enabled plugin root(s))`);
		const orphaned = indexes.filter((index) => index.scope === "Engine" && !index.selectedByLookups);
		for (const index of orphaned) notes.push(`near miss: index ${index.key} (${index.defs?.toLocaleString() ?? "?"} symbols, ${Number.isFinite(index.sizeMb) ? index.sizeMb.toFixed(1) : "?"} MB) is keyed by its root set — 1.2 keys engine scope by (engineRoot, engineAreas), so no lookup selects it; the key current lookups ask for is ${index.expectedKey}. Rebuild with unreal_index action "build" scope engine (minutes), then unreal_index action prune`);
	}
	const dead = audit.entries.filter((entry) => entry.reclaimable);
	notes.push(audit.notes[0] ?? "");
	if (dead.length) {
		notes.push(`reclaimable ${dead.map((entry) => `${entry.kind} ${entry.key} (${(Math.round((entry.bytes / 1024 / 1024) * 10) / 10).toFixed(1)} MB: ${entry.reclaimable})`).join(" · ")}`);
		notes.push(`unreal_index action "prune" deletes exactly these (derived data: every one is rebuildable); query/ and compiledb/ need the explicit query / compileDb flags`);
	}
	if (compileDbs.length) {
		for (const db of compileDbs) notes.push(`generated compile database ${db.key}: ${db.entries} entries, ${(Math.round((db.bytes / 1024) * 10) / 10).toFixed(1)} KB, ${humanAge(db.ageMs)} old → ${db.path} (this path is NOT what clangd reads: unreal_index action "compiledb" installTo <dir clangd reads> copies it and prints the .clangd lines)`);
	} else {
		notes.push('no generated compile database: unreal_index action "compiledb" (UBT GenerateClangDatabase + the /Yu, /Fm, /link strip)');
	}
	// The line the 2026-10-28 session needed: what clangd's own compile database covers, measured
	// against the TU set on disk. `status` is the cheap entry point; the full probe is action "clangd".
	if (workspace) {
		const projectDir = workspace.projectDir ?? workspace.cwd;
		const config = readClangdConfig(projectDir, fs);
		const dirs = clangdSearchDirs(projectDir, config);
		const live = dirs.dirs.flatMap((dir) => databasesIn(dir).map((path) => describeDatabase(path, compileDbScope({ projectDir, pluginDirs: workspace.pluginDirs, engineRoot: workspace.engineRoot, scope: "project" }).map((dir) => ({ dir })))));
		notes.push(live.length
			? `live compile database (clangd reads ${dirs.dirs.join(" | ")}): ${live.map((db) => `${db.entries} entries, covers ${db.coveredTus}/${db.tuCount} translation units on disk, ${humanAge(db.ageMs)} old`).join(" · ")} — unreal_index action "clangd" for the file-level answer`
			: `no live compile database: clangd has none in ${dirs.dirs.join(" | ") || "(no directory)"} → get_diagnostics can only guess flags. unreal_index action "clangd" prints the file-level probe`);
	}
	notes.push('clangd health (is the database it reads current?): unreal_index action "clangd" — reads the project .clangd, counts live-database entries against the TU set on disk, names missing files');
	return { cacheDir: root, indexes, headers, notes, cache: { reclaimableBytes: audit.reclaimableBytes, keptBytes: audit.keptBytes, entries: audit.entries.map((entry) => ({ kind: entry.kind, key: entry.key, bytes: entry.bytes, ageMs: entry.ageMs, reclaimable: entry.reclaimable, counts: entry.counts })) }, compileDbs, roots: workspace ? currentRootSets(workspace, { fs }) : undefined, query: { target: choice, usable: query.usable, targetDetails: query.targetDetails, moduleReferences: query.moduleReferences, notes: query.notes } };
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

/* ─────────────────────────────────────────────── header (path-only) index */

export interface HeaderReportInput {
	cwd: string;
	/** Header name or path to answer, e.g. `"PhysicsControlComponent.h"` or `"Mover/Public/MoverTypes.h"`. */
	name?: string;
	/** Which side to index. Default `all` (engine plugin sources + engine sources + project sources). */
	scope?: Exclude<Scope, "all"> | "all";
	/** Build when absent. Default false: a lookup reports the cost, it never scans on its own. */
	build?: boolean;
	/** Engine areas to walk. Default `["Runtime", "Plugins"]` — the whole plugin tree is the point of this index. */
	engineAreas?: string[];
	refresh?: boolean;
	limit?: number;
	fs?: FsAdapter;
	deps?: ResolverDeps;
	onProgress?: (message: string) => void;
}

/**
 * The 'does this header exist in THIS engine version' answer.
 *
 * A definitions index cannot give it: absence of a symbol row is a statement about the roots that were
 * scanned. This is a path walk (no content read), cached under the pi cache, and it names the plugin
 * that owns each hit plus the two availability facts a `.uproject` reader needs — `EnabledByDefault`
 * and whether the project references the plugin at all.
 */
export async function headerReport(input: HeaderReportInput) {
	const fs = input.fs ?? realFs;
	const workspace = await resolveWorkspace(input.cwd, fs, input.deps);
	const scope = input.scope ?? "all";
	const notes: string[] = [...workspace.notes];
	const warnings: string[] = [];

	const roots: ScanRoot[] = [];
	if (scope === "all" || scope === "engine") roots.push(...engineHeaderRoots(workspace, input.engineAreas));
	if (scope === "all" || scope === "project") roots.push(...assembleRoots({ projectRoot: workspace.projectDir, pluginDirs: workspace.pluginDirs, pluginModuleNames: workspace.pluginModuleNames, fs }).roots);
	const dirs = roots.map((root) => root.dir);
	if (!dirs.length) {
		notes.push("no C++ roots to walk: no project `Source` tree and no resolved engine");
		return { built: false, exists: false, name: input.name, roots: 0, files: 0, durationMs: 0, rootKinds: "none", found: [], candidates: [], notes, warnings };
	}

	const kinds = rootKindsNote(dirs, { projectRoot: workspace.projectDir, engineRoot: workspace.engineRoot });
	let header = pickHeaderIndex(dirs);
	if (header && !input.refresh) {
		notes.push(`using cached header index ${header.key} (${header.meta.files} header paths, ${header.ageMs ? humanAge(header.ageMs) : "fresh"} old)`);
	} else if (!header && !input.build) {
		notes.push(`no header index for ${kinds}. Build it with unreal_index action "headers" — a path walk only (no content read): seconds, cached afterwards, ~52,000 plugin headers on a UE 5.8 install.`);
		notes.push(`  engineAreas default here is ["Runtime", "Plugins"]: every Engine/Plugins source tree, which is where Mover, PoseSearch, PhysicsControl, BlendStack, SmartObjects and StateTree live`);
		return { built: false, exists: false, name: input.name, roots: dirs.length, files: 0, durationMs: 0, rootKinds: kinds, found: [], candidates: [], notes, warnings };
	} else {
		const key = headerKeyFor({ roots: dirs, label: scope === "project" ? workspace.projectName : workspace.engineRoot ? baseName(workspace.engineRoot) : "index" });
		const areaNote = `walking header paths for ${kinds}`;
		notes.push(areaNote);
		input.onProgress?.(areaNote);
		const built = await buildHeaderIndex({ key, roots, engineRoot: workspace.engineRoot, projectRoot: workspace.projectDir, areas: input.engineAreas ?? (scope === "project" ? undefined : ["Runtime", "Plugins"]) });
		const loaded = loadHeaderIndex(built.key);
		if (!loaded) warnings.push(`header index ${built.key} was written but could not be reloaded`);
		header = loaded;
		notes.push(`built ${built.key}: ${built.files} header paths in ${(built.durationMs / 1000).toFixed(1)}s`);
	}

	if (!input.name || !header) {
		return { built: true, name: input.name, key: header?.key, files: header?.meta.files ?? 0, roots: dirs.length, durationMs: 0, rootKinds: kinds, exists: header ? undefined : false, found: [], candidates: [], notes, warnings };
	}

	const answer = headerLookup({ name: input.name, workspace, header, limit: input.limit });
	notes.push(...answer.notes);
	warnings.push(...answer.warnings);
	return {
		built: true,
		key: header.key,
		files: header.meta.files,
		roots: dirs.length,
		rootKinds: kinds,
		name: input.name,
		exists: answer.exists,
		found: answer.found,
		candidates: answer.candidates,
		notes,
		warnings,
	};
}

/* ────────────────────────────────────────────────────────────── compile database */

/** Default clangd scope: the project, its enabled plugins, and (with 'engine') all of Engine/Source AND Engine/Plugins sources. */
export function compileDbScope(input: { projectDir?: string; pluginDirs?: string[]; engineRoot?: string; scope: "project" | "project+engine" }): string[] {
	const include = [input.projectDir, ...(input.pluginDirs ?? [])].filter((dir): dir is string => Boolean(dir)).map(normalizePath);
	// Engine plugins ship most of the types a gameplay project overrides (Mover, PoseSearch, PhysicsControl,
	// SmartObjects, …). Listing only Engine/Source leaves their .cpp bodies out of the database, which is
	// the same coverage hole the engine symbol scope had.
	if (input.scope === "project+engine" && input.engineRoot) {
		include.push(normalizePath(joinPath(input.engineRoot, "Engine/Source")));
		include.push(normalizePath(joinPath(input.engineRoot, "Engine/Plugins")));
	}
	return include;
}

export interface CompileDbInput {
	cwd: string;
	/** 'project' = project + enabled plugin sources. 'project+engine' adds all of Engine/Source. */
	scope?: "project" | "project+engine";
	/** Explicit include prefixes; overrides 'scope'. */
	include?: string[];
	target?: string;
	platform?: string;
	configuration?: string;
	refresh?: boolean;
	/** Run `clangd --check` on this file after generating (acceptance gate). */
	check?: string;
	/** Opt-in wiring: copy the generated database to this directory (where clangd reads) and print the exact `.clangd` lines. */
	installTo?: string;
	timeoutMs?: number;
	onProgress?: (message: string) => void;
	fs?: FsAdapter;
	deps?: ResolverDeps;
}

/**
 * Generate and normalize UBT's clangd database, then optionally prove it with `clangd --check`.
 * Generation costs minutes (UBT regenerates the makefile and runs UHT), and the engine-wide scope
 * is ~1 GB: this is the expensive path, and only the explicit tool call reaches it.
 */
export async function compileDbReport(input: CompileDbInput) {
	const fs = input.fs ?? realFs;
	const workspace = await resolveWorkspace(input.cwd, fs, input.deps);
	const scope = input.scope ?? "project";

	if (!workspace.engineRoot) {
		return { ok: false, notes: [...workspace.notes, "no engine resolved, so UnrealBuildTool cannot run (see unreal_resolve_engine)"], warnings: [] as string[], entries: 0, seconds: 0, reused: false };
	}
	const target = input.target ?? pickDefaultTarget(discoverTargets({ projectDir: workspace.projectDir, engineRoot: workspace.engineRoot, fs }), workspace.projectName)?.name;
	if (!target) {
		return { ok: false, notes: [...workspace.notes, "no *.Target.cs found, so the compile database has no target to generate for"], warnings: [] as string[], entries: 0, seconds: 0, reused: false };
	}

	const include = input.include?.length ? input.include.map(normalizePath) : compileDbScope({ projectDir: workspace.projectDir, pluginDirs: workspace.pluginDirs, engineRoot: workspace.engineRoot, scope });
	let install: InstallResult | undefined;
	const ensured = await ensureCompileDb({
		engineRoot: workspace.engineRoot,
		projectPath: workspace.projectPath,
		target,
		platform: input.platform,
		configuration: input.configuration,
		include,
		dropHeaders: true,
		refresh: input.refresh,
		timeoutMs: input.timeoutMs,
		onProgress: input.onProgress,
	});

	const dbDir = ensured.path.replace(/\/compile_commands\.json$/, "");
	const config = readClangdConfig(workspace.projectDir ?? workspace.cwd, fs);
	const search = clangdSearchDirs(workspace.projectDir ?? workspace.cwd, config);
	const live = search.dirs.flatMap((dir) => databasesIn(dir).map((path) => describeDatabase(path, include.map((root) => ({ dir: root })))));
	const coverage = describeDatabase(ensured.path, include.map((dir) => ({ dir })));
	const notes: string[] = [
		`target ${target} (${hostPlatform()})`,
		`scope: ${ensured.scope.join(", ")}`,
		ensured.reused ? `reused ${ensured.path}` : `generated in ${ensured.seconds.toFixed(1)}s (raw ${ensured.rawPath ? baseName(ensured.rawPath) : "?"})`,
		`normalized: ${ensured.stats.kept} entries (dropped ${ensured.stats.droppedPch} PCH units, ${ensured.stats.droppedHeaders} headers, ${ensured.stats.droppedSwitches} switches, expanded ${ensured.stats.expandedRsp} response files)`,
		// The wiring the report asked for (field-findings 2026-10-28 §6): name the directory clangd
		// actually reads, not a third location the session never opens.
		`clangd reads (from ${config.path ?? "no .clangd"}${config.compilationDatabase ? `, CompilationDatabase: ${config.compilationDatabase}` : ", no CompilationDatabase setting"}): ${search.dirs.length ? search.dirs.join(" | ") : "(no existing candidate directory)"}`,
		`live database: ${live.length ? live.map((db) => `${db.path} (${db.entries} entries, ${db.entries ? `${db.coveredTus}/${db.tuCount} of the scope's translation units on disk${(db.tuCount ?? 0) - (db.coveredTus ?? 0) > 0 ? `, ${formatMissingTus(db.missingTus)}` : ""}${db.entryFilesWithoutCommands?.length ? `, ${db.entryFilesWithoutCommands.length} entr${db.entryFilesWithoutCommands.length === 1 ? "y" : "ies"} naming a file that no longer exists: ${db.entryFilesWithoutCommands.slice(0, 4).map(baseName).join(", ")}` : ""}, ` : ""}${humanAge(db.ageMs)} old)`).join(" · ") : "NONE — clangd has no compile database for this project, so get_diagnostics can only guess flags"}`,
		`this database covers ${coverage.coveredTus}/${coverage.tuCount} translation units of its scope on disk${(coverage.tuCount ?? 0) - (coverage.coveredTus ?? 0) > 0 ? `; not in it: ${formatMissingTus(coverage.missingTus)}${(coverage.tuCount ?? 0) - (coverage.coveredTus ?? 0) > 6 ? " …" : ""}` : ""}${coverage.entryFilesWithoutCommands?.length ? `; ${coverage.entryFilesWithoutCommands.length} entr${coverage.entryFilesWithoutCommands.length === 1 ? "y" : "ies"} name a file that no longer exists on disk (deleted sources clangd still reports hits in: ${coverage.entryFilesWithoutCommands.slice(0, 4).map(baseName).join(", ")})` : ""}`,
		"the database encodes this machine's absolute paths, so keep it out of git; pi-unreal does not write .clangd (it carries your flag removals and forces clang-cl) — install with installTo and merge the printed lines",
	];
	for (const dir of search.dirs) {
		const rsp = responseFileStatus(dir, live.find((db) => db.path.startsWith(dir))?.ageMs ?? Number.MAX_SAFE_INTEGER);
		if (rsp.note) notes.push(`rsp freshness: ${rsp.note}`);
	}
	let check: { ok: boolean; clangd?: string; summary: string[]; notes: string[]; file?: string; compileCommand?: "found" | "none"; liveCompileCommand?: "found" | "none" } | undefined;
	if (input.check) {
		const file = input.check.includes(":") || input.check.startsWith("/") || /^[a-z]:/i.test(input.check) ? input.check : normalizePath(joinPath(input.cwd, input.check));
		const ran = await clangdCheck({ file, dbDir, timeoutMs: input.timeoutMs });
		const inGenerated = compileCommandFor(ensured.path, file).found ? "found" as const : "none" as const;
		const inLive = live.some((db) => compileCommandFor(db.path, file).found) ? "found" as const : "none" as const;
		check = { ok: ran.ok, clangd: ran.clangd, summary: ran.summary, notes: ran.notes, file, compileCommand: inGenerated, liveCompileCommand: inLive };
		notes.push(`check: ${baseName(file)} — compile command in the generated database: ${inGenerated}; in the database clangd reads: ${inLive}`);
		notes.push(...ran.notes.map((note) => `check: ${note}`));
		// Honest boundary (field-findings 2026-10-28 §3): a `published: 0` payload from get_diagnostics is
		// not proof that clangd scanned anything. pi-unreal cannot see what the MCP published.
		notes.push("publishObserved: not observable from pi-unreal — get_diagnostics' published:0 cannot distinguish 'looked, found nothing' from 'never looked'. The scan proof is this standalone clangd --check; for the IDE session, compare publication counts for a file you know has a compile command (this probe prints that gate per file)");
	}
	if (input.installTo) {
		const installed = installCompileDb({ sourcePath: ensured.path, destDir: input.installTo });
		notes.push(...installed.notes.map((note) => `install: ${note}`));
		notes.push(`install: .clangd lines to merge:\n${installed.clangdSnippet}`);
		if (installed.warnings.length) notes.push(...installed.warnings.map((warning) => `install: ${warning}`));
		install = installed;
	}
	return { ok: ensured.entries > 0, target, platform: input.platform ?? hostPlatform(), configuration: input.configuration ?? "Development", path: ensured.path, rawPath: ensured.rawPath, entries: ensured.entries, seconds: ensured.seconds, reused: ensured.reused, stats: ensured.stats, scope, check, clangd: { configPath: config.path, compilationDatabase: config.compilationDatabase, searchDirs: search.dirs, databases: live, coverage }, install, notes: [...workspace.notes, ...notes], warnings: ensured.warnings };
}

/* ────────────────────────────────────────────────────── prune / clangd health */

/** `Name.cpp [Module]` list for the "not in this database" lines. */
function formatMissingTus(missing: { file: string; module?: string }[] | undefined): string {
	return (missing ?? []).slice(0, 8).map((unit) => `${baseName(unit.file)} [${unit.module ?? moduleFromSourcePath(unit.file) ?? "?"}]`).join(", ");
}

/**
 * Reclaim the cache bytes no lookup can reach.
 *
 * The 2026-10-28 session measured 481 MB with 177 MB (37%) unreachable and no way to reclaim it:
 * `status` listed the issues, the files stayed. This deletes exactly what `auditCache` marks
 * reclaimable — dead formats, superseded keys, pre-1.2 root-set engine keys — and never a healthy
 * entry. `query/` and `compiledb/` need explicit flags: Query costs ~12 s per target and
 * GenerateClangDatabase costs minutes.
 */
export function pruneReport(opts: { query?: boolean; compileDb?: boolean } = {}) {
	// Audit BEFORE the delete: the same audit re-run afterwards no longer sees the entries it removed,
	// so a `before` measured after the prune is byte-for-byte the `after` number.
	const before = auditCache();
	const result = pruneCache(opts);
	const megabytes = (bytes: number) => `${(Math.round((bytes / 1024 / 1024) * 10) / 10).toFixed(1)} MB`;
	const audit = auditCache();
	const kept = audit.entries.filter((entry) => !entry.reclaimable);
	const keptBytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
	return {
		removed: result.removed.map((entry) => ({ ...entry, mb: megabytes(entry.bytes) })),
		kept: kept.map((entry) => ({ kind: entry.kind, key: entry.key, bytes: entry.bytes, mb: megabytes(entry.bytes), reclaimable: entry.reclaimable })),
		beforeBytes: before.keptBytes + before.reclaimableBytes,
		afterBytes: keptBytes,
		freedBytes: result.freedBytes,
		freedMb: megabytes(result.freedBytes),
		notes: result.notes,
		warnings: result.warnings,
	};
}

export interface ClangdHealthInput {
	cwd: string;
	/** Probe this file's compile command (and optionally run `clangd --check` on it). */
	file?: string;
	check?: boolean;
	scope?: "project" | "project+engine";
	timeoutMs?: number;
	onProgress?: (message: string) => void;
	fs?: FsAdapter;
	deps?: ResolverDeps;
}

/**
 * Is the compile database clangd reads current? The question the 2026-10-28 session could not answer.
 *
 * `get_diagnostics` returning `published: 0` proves nothing: a definitions index makes absence
 * provable (whole file scanned, every declaration recorded), a diagnostics publication is only
 * evidence when a compile ran. This probe reads the project's own `.clangd`, lists the directories
 * clangd therefore searches, counts the database entries it finds there against the translation units
 * on disk, and names the deleted files clangd can still report hits in. It never claims to know what
 * the clangd MCP published — that payload is the MCP's record, not this tool's.
 */
export async function clangdHealthReport(input: ClangdHealthInput) {
	const fs = input.fs ?? realFs;
	const workspace = await resolveWorkspace(input.cwd, fs, input.deps);
	const notes: string[] = [...workspace.notes];
	const warnings: string[] = [];
	const root = cacheDir(fs);

	const config = readClangdConfig(workspace.projectDir ?? workspace.cwd, fs);
	notes.push(...config.notes);
	const search = clangdSearchDirs(workspace.projectDir ?? workspace.cwd, config);
	notes.push(`clangd searches: ${search.dirs.length ? search.dirs.join(" | ") : "(no existing candidate directory — clangd has no compile database here)"}`);
	notes.push(...search.notes);

	const live = search.dirs.flatMap((dir) => databasesIn(dir).map((path) => describeDatabase(path)));
	const scopeRoots = compileDbScope({ projectDir: workspace.projectDir, pluginDirs: workspace.pluginDirs, engineRoot: workspace.engineRoot, scope: input.scope ?? "project" });
	for (const db of live) {
		const scoped = describeDatabase(db.path, scopeRoots.map((dir) => ({ dir })));
		notes.push(`live database ${db.path}: ${db.entries} entries, ${(Math.round((db.bytes / 1024) * 10) / 10).toFixed(1)} KB, ${humanAge(db.ageMs)} old`);
		if (db.entries) {
			notes.push(`  covers ${scoped.coveredTus}/${scoped.tuCount} translation units of the project scope on disk`);
			const missingCount = (scoped.tuCount ?? 0) - (scoped.coveredTus ?? 0);
			if (missingCount > 0) notes.push(`  ${missingCount} current TU(s) have NO compile command${scoped.missingTus?.length ? `: ${formatMissingTus(scoped.missingTus)}${missingCount > 8 ? ` … (${missingCount} total)` : ""}` : ""}`);
		}
		if (scoped.entryFilesWithoutCommands?.length) notes.push(`  ${scoped.entryFilesWithoutCommands.length} ${scoped.entryFilesWithoutCommands.length === 1 ? "entry names" : "entries name"} a file that no longer exists on disk (clangd reports hits in deleted sources: ${scoped.entryFilesWithoutCommands.slice(0, 6).map(baseName).join(", ")})`);
		for (const file of responseFileStatus(dirnameOf(db.path), db.ageMs).files) notes.push(`  response file ${baseName(file.path)}: ${file.lines} lines, ${humanAge(file.ageMs)} old`);
		const rsp = responseFileStatus(dirnameOf(db.path), db.ageMs).note;
		if (rsp) notes.push(`  diagnosis: ${rsp}`);
	}
	if (!live.length) notes.push("no live database: clangd is reading nothing this project can compile with — that is why diagnostics publish nothing");

	const generated = listCompileDbs(root);
	for (const db of generated) {
		const scoped = describeDatabase(db.path, scopeRoots.map((dir) => ({ dir })));
		notes.push(`pi-unreal generated ${db.key}: ${db.entries} entries, ${humanAge(db.ageMs)} old → ${db.path} (a location clangd does NOT read${live.length ? "" : "; no live database exists"})`);
		if (db.entries) notes.push(`  covers ${scoped.coveredTus}/${scoped.tuCount} translation units of the project scope on disk`);
	}
	const clangdBins = discoverClangd();
	notes.push(clangdBins.length ? `clangd binaries: ${clangdBins.join(", ")}` : "no clangd binary found (CLANGD_PATH, VS LLVM toolset)");

	let file: { path: string; generated: "found" | "none"; live: "found" | "none"; check?: { ok: boolean; summary: string[] } } | undefined;
	if (input.file) {
		const path = /^([a-z]:)?[\/]/i.test(input.file) ? normalizePath(input.file) : normalizePath(joinPath(input.cwd, input.file));
		const inGenerated = generated.some((db) => compileCommandFor(db.path, path).found) ? "found" as const : "none" as const;
		const inLive = live.some((db) => compileCommandFor(db.path, path).found) ? "found" as const : "none" as const;
		file = { path, generated: inGenerated, live: inLive };
		notes.push(`file ${baseName(path)}: compile command in the database clangd reads → ${inLive}; in the generated database → ${inGenerated}`);
		if (input.check) {
			const dbDir = live.length ? dirnameOf(live[0]!.path) : generated.length ? dirnameOf(generated[0]!.path) : undefined;
			if (!dbDir) warnings.push("clangd --check needs a compile database directory; none exists");
			else {
				const ran = await clangdCheck({ file: path, dbDir, timeoutMs: input.timeoutMs });
				file.check = { ok: ran.ok, summary: ran.summary };
				notes.push(`clangd --check with ${dbDir}: ${ran.ok ? "clean (preamble built, 0 errors)" : "failed"}`);
				for (const line of ran.summary.slice(0, 8)) notes.push(`  ${line}`);
			}
		}
	}

	notes.push("publishObserved: published:0 cannot distinguish 'looked, found nothing' from 'never looked', and pi-unreal cannot observe what get_diagnostics published — a published:0 payload is not proof of a scan. Definitions absence IS provable (the symbol index scans whole files); diagnostics publication is only evidence when a compile ran. Compare publication counts for a file this probe reports as having a compile command");
	notes.push("no link check: a clean clangd --check proves this file parses with these flags. It proves nothing about linking, and nothing about the rest of the target — UnrealEngine-BuildProjectEditor is the link check");
	notes.push("fix: unreal_index action \"compiledb\" (UBT GenerateClangDatabase, seconds-to-minutes), then installTo <the directory clangd reads> and merge the printed .clangd lines; close the editor first");

	return { ok: live.length > 0, projectDir: workspace.projectDir, clangdConfig: config, searchDirs: search.dirs, liveDatabases: live, generatedDatabases: generated, clangdBins, file, notes, warnings };
}

function dirnameOf(path: string): string {
	const normalized = normalizePath(path);
	const index = normalized.lastIndexOf("/");
	return index > 0 ? normalized.slice(0, index) : normalized;
}

export interface CallSitesInput {
	cwd: string;
	symbol: string;
	/** Restrict the scan to these module names. Default: the modules that declare the symbol. */
	module?: string[];
	scope?: Exclude<Scope, "all">;
	engineAreas?: string[];
	maxFiles?: number;
	fs?: FsAdapter;
	deps?: ResolverDeps;
}

/**
 * Candidate call sites / override definitions from a bounded text pass.
 *
 * This is NOT a call graph. Reference edges need a language server; what this answers
 * candidates from a text pass, labelled as candidates (field-findings 2026-10-28 §10 item 8).
 */
export async function callSitesReport(input: CallSitesInput) {
	const fs = input.fs ?? realFs;
	const workspace = await resolveWorkspace(input.cwd, fs, input.deps);
	const notes: string[] = [...workspace.notes];
	const scope = input.scope ?? "project";
	const handles = await scopeIndexes({ workspace, mode: "definitions", scope, engineAreas: input.engineAreas, allowEngineBuild: true, fs });
	const roots: ScanRoot[] = [];
	for (const handle of handles) {
		for (const root of handle.roots) {
			if (input.module?.length && !input.module.some((name) => name.toLowerCase() === root.module?.toLowerCase())) continue;
			roots.push(root);
		}
	}
	if (!roots.length) {
		notes.push(`no module roots match ${input.module?.length ? `module(s) ${input.module.join(", ")}` : "the lookup"} — unreal_symbol_list prefix \"${input.symbol.slice(0, 6)}\" names the modules that declare it`);
		return { symbol: input.symbol, filesScanned: 0, rows: [], modules: [], seconds: 0, truncated: false, notes, warnings: [] as string[] };
	}
	const report = await collectCallSites({ roots, symbol: input.symbol, maxFiles: input.maxFiles });
	notes.push(`text pass over ${report.filesScanned} .cpp file(s) in ${report.modules.length} module root(s): ${report.rows.length} row(s) mentioning '${input.symbol}' in ${report.seconds.toFixed(1)}s`);
	notes.push("candidates from a text pass, not call edges: a line shaped `<Type>::<member>(` is the override's definition, every other row is a mention. Reference edges need clangd (find_references) — the index proves declarations, not call sites");
	if (report.truncated) notes.push("truncated at the file/row cap — narrow with module [\"…\"] (one module's Private tree)");
	return { ...report, notes, warnings: [] as string[] };
}

/** MB with one decimal: the unit the cache claims are printed in. */
function formatMb(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
