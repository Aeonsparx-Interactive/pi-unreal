/**
 * Pi tool wrappers for the compiler-free UE source index.
 *
 * Four tools, one idea: an agent asking "where is X" gets one line, not 176 files of grep output.
 * Nothing here needs clangd, clang, Visual Studio, or Rider — the data is (a) a definition scan of
 * `.h`/`.cpp` text and (b) `UnrealBuildTool -Mode=Query` output for compile facts.
 *
 * Cost discipline is the design constraint: project/plugin indexes build in seconds and are built on
 * demand; an Engine/Source index scans tens of thousands of files, so `unreal_index` is the only tool
 * that pays for it. A lookup that wants engine sources reports the cost and how to pay it — it never
 * stalls the agent.
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { normalizePath, realFs, truncateLines, type JsonValue } from "./util.ts";
import { buildContext, compileDbReport, fileContext, headerReport, indexBuild, indexStatus, symbolList, symbolLookup, type Scope } from "./tools.ts";

/* ──────────────────────────────────────────────────────────────────────────── schemas */

const ScopeSchema = Type.Optional(
	Type.Union([Type.Literal("project"), Type.Literal("engine"), Type.Literal("all")], {
		description: "Which sources to search. 'project' (default) = the project's modules plus its enabled plugins. 'engine' = Engine/Source areas + the project's enabled plugin roots (plugin-shipped types like Mover/PoseSearch live there). 'all' = both.",
	}),
);
const EngineAreasSchema = Type.Optional(
	Type.Array(Type.String(), {
			// Must match DEFAULT_ENGINE_AREAS in lib/store.ts — the schema description is what agents read.
		description: 'Engine scan dials, rooted at the engine install. Engine/Source areas: ["Runtime"] (default, DEFAULT_ENGINE_AREAS in lib/store.ts), ["Editor"], ["Runtime/Core"]. Engine-plugin areas: ["Plugins"] = every Engine/Plugins source tree (~2.8x the Runtime scan — this is where Mover, PoseSearch, PhysicsControl, BlendStack, SmartObjects, StateTree and GameplayAbilities live) or one subtree, e.g. ["Plugins/Animation/PhysicsControl"]. Engine-scope indexes always include the plugin roots the .uproject enables; these areas add the rest.',
	}),
);
const LimitSchema = Type.Optional(Type.Number({ description: "Maximum rows to return. Default 25." }));
const TargetSchema = Type.Optional(Type.String({ description: "UBT target whose compile environment to report, e.g. 'LpEditor', 'UnrealEditor'. Default: the project's editor target." }));
const PlatformSchema = Type.Optional(Type.String({ description: "Target platform. Default: this machine's platform (Win64 on Windows)." }));
const ConfigurationSchema = Type.Optional(Type.String({ description: "Target configuration: Development (default), DebugGame, Shipping." }));

/** Every tool takes the workspace directory; the session cwd is the default so agents rarely pass it. */
const CwdSchema = Type.Optional(Type.String({ description: "Workspace directory containing the .uproject. Default: the session cwd." }));

const SymbolParams = Type.Object({
	cwd: CwdSchema,
	query: Type.String({ description: "Symbol name: 'AActor', 'UAnimInstance', 'AActor:Tick' (qualified), or a bare method name together with 'owner'." }),
	owner: Type.Optional(Type.String({ description: "Owner type for a member lookup: query 'Tick' + owner 'AActor'. A bare method name is resolved through its owner." })),
	scope: ScopeSchema,
	engineAreas: EngineAreasSchema,
	module: Type.Optional(Type.String({ description: "Restrict hits to one module, e.g. 'Engine'." })),
	prefix: Type.Optional(Type.Boolean({ description: "Allow prefix matching (name families, typos). Default false: exact + qualified-member only." })),
	substring: Type.Optional(Type.Boolean({ description: "Allow substring matching: a linear scan of the definition table (rank 3, listed after exact/prefix hits). Finds qualified members like 'PhysicsControlBPLibrary:Enable' from a bare 'Enable'. Costs ~0.3s per 76 MB of rows. Default false." })),
	limit: LimitSchema,
});

const ListParams = Type.Object({
	cwd: CwdSchema,
	prefix: Type.String({ description: "Symbol-name prefix, e.g. 'ULp' or 'ANiMy'." }),
	scope: ScopeSchema,
	engineAreas: EngineAreasSchema,
	kind: Type.Optional(
		Type.Union([Type.Literal("class"), Type.Literal("struct"), Type.Literal("enum"), Type.Literal("union"), Type.Literal("function"), Type.Literal("delegate"), Type.Literal("property"), Type.Literal("alias")], {
			description: "Filter by definition kind.",
		}),
	),
	module: Type.Optional(Type.String({ description: "Restrict hits to one module." })),
	limit: Type.Optional(Type.Number({ description: "Maximum names to return. Default 40." })),
});

const ContextParams = Type.Object({
	cwd: CwdSchema,
	file: Type.Optional(Type.String({ description: "Source file to describe (.h/.cpp in the project, a plugin, Engine/Source, or Engine/Plugins): its module, declarations, include paths, defines file." })),
	module: Type.Optional(Type.String({ description: "Module to describe instead of a file, e.g. 'GameplayAbilities' — dependency lists, include paths, defines file, standard, SDK, and whether the target's module graph contains it." })),
	target: TargetSchema,
	platform: PlatformSchema,
	configuration: ConfigurationSchema,
	includeDefines: Type.Optional(Type.Boolean({ description: "Also read the module's preprocessor define list. Needs the UBT Query cache (~7s the first time). Default false." })),
	engineAreas: EngineAreasSchema,
	refresh: Type.Optional(Type.Boolean({ description: "Re-run UnrealBuildTool Query instead of using the cached JSON." })),
	limit: LimitSchema,
});

const IndexParams = Type.Object({
	cwd: CwdSchema,
	action: Type.Union([Type.Literal("build"), Type.Literal("status"), Type.Literal("headers"), Type.Literal("compiledb")], { description: "'build' creates or refreshes a symbol index. 'status' lists what is cached, what each index covers by root kind, and what building will cost. 'headers' builds the path-only header index and answers 'does this header exist in this engine version' (walks file paths, no content read: seconds). 'compiledb' runs UnrealBuildTool -Mode=GenerateClangDatabase and normalizes it for clangd (minutes, ~1 GB for the engine scope)." }),
	scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("engine"), Type.Literal("project+engine")], { description: "Index scope for 'build': 'project' (default, seconds) or 'engine' (Engine/Source areas + the project's enabled plugin roots; minutes the first time). For 'headers': 'engine' (default) = engine sources + every Engine/Plugins tree, 'project' = project + its plugins, 'project+engine' = both. For 'compiledb': 'project' (default) = project + enabled plugin sources, 'project+engine' adds all of Engine/Source and Engine/Plugins." })),
	mode: Type.Optional(Type.Union([Type.Literal("definitions"), Type.Literal("full")], { description: "'definitions' = symbol -> file:line only (default, fast). 'full' also records per-file include sets and needs UnrealBuildTool Query (~7s, no compiler)." })),
	name: Type.Optional(Type.String({ description: "For action 'headers': the header to answer, e.g. 'MoverState.h', 'PhysicsControlComponent.h', or a partial path 'Mover/Public/MoverTypes.h'. Absent = build/report only." })),
	engineAreas: EngineAreasSchema,
	target: TargetSchema,
	platform: PlatformSchema,
	configuration: ConfigurationSchema,
	refresh: Type.Optional(Type.Boolean({ description: "Force a rebuild, and re-run UnrealBuildTool Query in 'full' mode. Default false." })),
});

/* ──────────────────────────────────────────────────────────────────────────── rendering */

const jsonOf = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

const shortPath = (file: string | undefined, cwd: string) => {
	if (!file) return "?";
	const f = normalizePath(file);
	const base = normalizePath(cwd);
	return f.startsWith(`${base}/`) ? f.slice(base.length + 1) : f;
};

const rowLine = (row: { symbol: string; kind: string; file: string; line: number; module: string; scope?: string }, cwd: string) =>
	`  ${row.kind} ${row.symbol}  ${shortPath(row.file, cwd)}:${row.line}  [${row.module}${row.scope ? ` · ${row.scope}` : ""}]`;

function result(text: string, details: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: truncateLines(text, 70).text }],
		details: details as never,
		structuredContent: jsonOf(details),
		...(isError ? { isError: true } : {}),
	};
}

const bullets = (label: string, items: string[]) => (items.length ? items.map((n) => `· ${label}: ${n}`) : []);

/* ────────────────────────────────────────────────────────────────────────── output schemas */

/**
 * The structured payloads nest heterogeneously (`moduleRefs` is a module list for a file and a
 * per-module map for a build), and the point of `structuredContent` is machine consumption —
 * nested objects are declared permissively so a shape change in the library never makes a tool
 * call fail validation.
 */
const Loose = Type.Object({}, { additionalProperties: true });
const LooseList = Type.Array(Loose);
const Strings = Type.Array(Type.String());
const DefRowOut = Type.Object({
	symbol: Type.String(),
	kind: Type.String(),
	file: Type.String(),
	line: Type.Number(),
	module: Type.String(),
	scope: Type.String(),
	marker: Type.String(),
	rank: Type.Number(),
	match: Type.String(),
});
const IndexRefOut = Type.Object({ key: Type.String(), scope: Type.String(), defs: Type.Number(), files: Type.Optional(Type.Number()), generatedAt: Type.Number() });

const SymbolOut = Type.Object({ scope: Type.String(), total: Type.Number(), results: Type.Array(DefRowOut), ranks: LooseList, indexes: Type.Array(IndexRefOut), coverage: Type.Optional(LooseList), notes: Strings, warnings: Type.Optional(Strings) });
const ListOut = Type.Object({ scope: Type.String(), total: Type.Number(), symbols: Type.Array(DefRowOut), indexes: Type.Array(IndexRefOut), notes: Strings, warnings: Type.Optional(Strings) });
const ContextOut = Type.Object({
	unit: Loose,
	counts: Loose,
	source: Type.String(),
	availability: Type.Optional(Loose),
	headerOnly: Type.Optional(Type.Boolean()),
	headerKind: Type.Optional(Type.String()),
	pluginName: Type.Optional(Type.String()),
	pluginSource: Type.Optional(Type.String()),
	enabledByDefault: Type.Optional(Type.Boolean()),
	referencedInUproject: Type.Optional(Type.Boolean()),
	warnings: Type.Optional(Strings),
	notes: Type.Optional(Strings),
});
const IndexOut = Type.Object({
	key: Type.Optional(Type.String()),
	mode: Type.Optional(Type.String()),
	scope: Type.Optional(Type.String()),
	healthy: Type.Optional(Type.Boolean()),
	issues: Type.Optional(Strings),
	ageMs: Type.Optional(Type.Number()),
	counts: Type.Optional(Loose),
	roots: Type.Optional(Type.Union([Strings, LooseList, Type.Number()])),
	source: Type.Optional(Type.String()),
	target: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	platform: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	configuration: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	query: Type.Optional(Loose),
	built: Type.Optional(Type.Boolean()),
	durationMs: Type.Optional(Type.Number()),
	actions: Type.Optional(Strings),
	warnings: Type.Optional(Strings),
	notes: Type.Optional(Strings),
	status: Type.Optional(Loose),
	indexes: Type.Optional(LooseList),
	headers: Type.Optional(LooseList),
	rootKinds: Type.Optional(Type.String()),
	coverage: Type.Optional(LooseList),
	files: Type.Optional(Type.Number()),
	exists: Type.Optional(Type.Boolean()),
	name: Type.Optional(Type.String()),
	found: Type.Optional(LooseList),
	candidates: Type.Optional(LooseList),
});

/* ──────────────────────────────────────────────────────────────────────────── tools */

export const unrealSymbol = defineTool({
	name: "unreal_symbol",
	label: "UE symbol",
	description: "Find where a C++ type, function, USTRUCT, UENUM or UPROPERTY is defined — project and enabled plugins by default, Engine/Source plus enabled plugin roots on request — one line per hit with its owning module.",
	promptSnippet: "Locate a UE C++ symbol definition (project, plugins, engine) with module attribution",
	promptGuidelines: [
		"Use unreal_symbol instead of grepping Engine/Source for a class or function name: grep returns every file that mentions the name (a hot engine class is ~176 files / 150 KB of context); this returns definition lines only.",
		"Default scope is 'project' (project modules + enabled plugins). Engine types (AActor, UAnimInstance, FWorldDelegates) need scope 'engine', which requires an engine index: unreal_index action build scope engine — minutes the first time, cached afterwards, engineAreas [\"Runtime\"] keeps it to the engine's own sources. An engine index covers Engine/Source areas plus the plugin roots the .uproject enables; types shipped by plugins the project does NOT reference (PhysicsControl, BlendStack, StateTree, GameplayAbilities...) need engineAreas [\"Plugins\"].",
		"Qualify member lookups: query 'Tick' with owner 'AActor', or query 'AActor:Tick'. Use prefix: true for name families ('ULp', 'ANiMy') and substring: true for qualified members ('Enable' finds 'UPhysicsControlBPLibrary:Enable'), never to silently accept a typo.",
		"A 0-row answer is a statement about the roots that were scanned, not about the engine: read the coverage lines it prints. Asking whether a header exists in this engine version is a path question — use unreal_index action 'headers' name 'X.h', not a symbol lookup.",
		"A definition line is a starting point, not an answer: read that file at that line. For engine call graphs clangd (MCP) is more precise; for module/link facts use unreal_context.",
	],
	parameters: SymbolParams,
	outputSchema: SymbolOut,
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	executionMode: "parallel",

	async execute(_id, params, _signal, _update, ctx) {
		const query = params.owner ? `${params.owner}:${params.query}` : params.query;
		const out = await symbolLookup({ cwd: params.cwd ?? ctx.cwd, query, scope: params.scope as Scope | undefined, engineAreas: params.engineAreas, module: params.module, prefix: params.prefix, substring: params.substring, limit: params.limit, fs: realFs });
		const rows = out.results.map((row) => rowLine(row, params.cwd ?? ctx.cwd));
		const text = [`unreal_symbol '${query}' scope=${out.scope}: ${out.total} definition(s)`, ...rows, ...out.notes.map((n) => `· ${n}`), ...(out.warnings ?? []).map((w) => `! ${w}`)].join("\n");
		return result(text, out, out.total === 0);
	},
});

export const unrealSymbolList = defineTool({
	name: "unreal_symbol_list",
	label: "UE symbols by prefix",
	description: "List symbol names starting with a prefix — what a project defines (ULp*, FP*) or an engine family (UAnim*, ANiMy*).",
	promptSnippet: "List UE symbol names by prefix (project, plugins, engine)",
	promptGuidelines: [
		"Use unreal_symbol_list to discover names before a lookup: 'ULp' shows the project's own classes; engine scope shows prefix families.",
		"Keep limit small (20-40): a one-letter prefix over an engine index matches thousands of names.",
	],
	parameters: ListParams,
	outputSchema: ListOut,
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	executionMode: "parallel",

	async execute(_id, params, _signal, _update, ctx) {
		const out = await symbolList({ cwd: params.cwd ?? ctx.cwd, prefix: params.prefix, scope: params.scope as Scope | undefined, kind: params.kind, module: params.module, engineAreas: params.engineAreas, limit: params.limit ?? 40, fs: realFs });
		const rows = out.symbols.map((row) => rowLine(row, params.cwd ?? ctx.cwd));
		const text = [`unreal_symbol_list '${params.prefix}' scope=${out.scope}: ${out.total} symbol(s)`, ...rows, ...out.notes.map((n) => `· ${n}`)].join("\n");
		return result(text, out);
	},
});

export const unrealContext = defineTool({
	name: "unreal_context",
	label: "UE compile context",
	description: "Answer 'what do I need to use X': the module directory, the real Definitions.h defines, C++ standard, SDK, include paths, module dependency lists (public/private/circular/dynamic), and what a header declares.",
	promptSnippet: "Report a UE module's or file's real compile context (UBT Query + scan data)",
	promptGuidelines: [
		"Before adding a Build.cs dependency, ask unreal_context for the module: its public/private dependency lists are the authoritative 'use this type, link this module' answer.",
		"Pass 'file' for a header to get its module, its declarations, and the include paths its target compiles with — cheaper than a repo-wide grep for the #include line.",
		"The define list lives in Intermediate/Build/.../Definitions.<Module>.h (UBT generates it). UBT Query reports defines: [] — this tool reads that file, so 'defines' is real, not guessed.",
	],
	parameters: ContextParams,
	outputSchema: ContextOut,
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	executionMode: "parallel",

	async execute(_id, params, _signal, _update, ctx) {
		if (!params.file && !params.module) {
			return result("unreal_context needs 'file' (a .h/.cpp) or 'module' (a module name).", { error: "no file or module" }, true);
		}

		if (params.file) {
			const fc = await fileContext({
				cwd: params.cwd ?? ctx.cwd,
				file: params.file,
				mode: params.includeDefines ? "full" : "definitions",
				includeDefines: params.includeDefines,
				engineAreas: params.engineAreas,
				refresh: params.refresh,
				limit: params.limit,
				fs: realFs,
			});
			const c = fc.compile;
			const lines = [
				`unreal_context ${shortPath(fc.file, params.cwd ?? ctx.cwd)}  mode=${fc.mode}  module=${fc.module ?? "?"}${fc.indexKey ? `  index=${fc.indexKey}` : ""}`,
			];
			if (c) {
				lines.push(
					`  file kind=${c.kind}${c.standard ? `  standard=${c.standard}` : ""}${c.compiler ? `  compiler=${c.compiler}` : ""}`,
					`  include paths: ${c.includePaths.length} · forced includes: ${c.forcedIncludes.length} · declares: ${c.declares.length} · includes: ${c.includes.length}`,
					`  deps: ${c.moduleRefs.public.length} public + ${c.moduleRefs.private.length} private`,
				);
				if (c.moduleRefs.publicInclude.length) lines.push(`  publicInclude: ${c.moduleRefs.publicInclude.join(", ")}`);
				if (c.moduleRefs.circular.length) lines.push(`  circular: ${c.moduleRefs.circular.join(", ")}`);
				if (c.moduleRefs.dynamicallyLoaded.length) lines.push(`  dynamicallyLoaded: ${c.moduleRefs.dynamicallyLoaded.join(", ")}`);
				if (c.declares.length) lines.push(`  declares: ${c.declares.slice(0, 24).join(", ")}`);
				if (c.definesFile) lines.push(`  defines file: ${shortPath(c.definesFile, params.cwd ?? ctx.cwd)}`);
				if (c.forcedIncludes.length) lines.push(`  forced includes: ${c.forcedIncludes.slice(0, 3).map((f) => shortPath(f, params.cwd ?? ctx.cwd)).join(", ")}`);
				lines.push(...c.notes.map((n) => `· ${n}`));
			}
			if (fc.defines?.length) lines.push(`  defines: ${fc.defines.slice(0, 40).join(" ")}`);
			if (fc.symbols?.length) lines.push(`  symbols in file: ${fc.symbols.slice(0, 20).map((s) => `${s.kind} ${s.symbol}@${s.line}`).join(", ")}`);
			const text = [...lines, ...fc.notes.map((n) => `· ${n}`), ...(fc.warnings ?? []).map((w) => `! ${w}`), ...(fc.error ? [`! ${fc.error}`] : [])].join("\n");
			return result(text, fc, !!fc.error);
		}

		const out = await buildContext({
			cwd: params.cwd ?? ctx.cwd,
			module: params.module,
			target: params.target,
			platform: params.platform,
			configuration: params.configuration,
			includeDefines: params.includeDefines,
			engineAreas: params.engineAreas,
			refresh: params.refresh,
			limit: params.limit,
			fs: realFs,
		});
		const m = out.module;
		const lines = [
			`unreal_context module ${m?.name ?? params.module}  target=${out.target?.target} ${out.target?.platform} ${out.target?.configuration} (${out.target?.source ?? "?"})`,
			`  dir: ${shortPath(m?.directory, params.cwd ?? ctx.cwd) ?? "?"}${m?.standard ? `  standard=${m.standard}` : ""}${m?.windowsSdkVersion ? `  sdk=${m.windowsSdkVersion}` : ""}`,
			`  deps: ${m?.dependencies ?? 0} · public headers: ${m?.publicHeaders ?? 0} · private headers: ${m?.privateHeaders ?? 0} · include paths: ${m?.includePaths ?? 0} · total headers: ${out.headerCount}`,
			`  query cache: ${out.queryCache?.source ?? "?"}${out.queryCache?.durationMs ? ` (${JSON.stringify(out.queryCache.durationMs)} ms)` : ""}`,
		];
		lines.push(...bullets("publicInclude", m?.publicInclude ?? []), ...bullets("privateInclude", m?.privateInclude ?? []), ...bullets("circular", m?.circular ?? []), ...bullets("dynamicallyLoaded", m?.dynamicallyLoaded ?? []));
		if (m?.definesFile) lines.push(`  defines file: ${shortPath(m.definesFile, params.cwd ?? ctx.cwd)}`);
		if (out.defines?.length) lines.push(`  defines: ${out.defines.slice(0, 40).join(" ")}`);
		if (m?.compilerPath) lines.push(`  compiler: ${m.compilerPath}`);
		if (out.projectModules?.length) lines.push(`  project modules: ${out.projectModules.map((entry) => entry.name).slice(0, 20).join(", ")}`);
		const text = [...lines, ...out.notes.map((n) => `· ${n}`), ...(out.warnings ?? []).map((w) => `! ${w}`), ...(out.error ? [`! ${out.error}`] : [])].join("\n");
		return result(text, out, !!out.error);
	},
});

export const unrealIndex = defineTool({
	name: "unreal_index",
	label: "UE index",
	description: "Build or report the source index: project/plugins (seconds), Engine/Source plus enabled plugin roots (minutes the first time), the path-only header index that answers 'does this header exist', and the UnrealBuildTool Query cache behind the compile facts.",
	promptSnippet: "Build/report the UE symbol index, header index, and UBT Query cache",
	promptGuidelines: [
		"Run unreal_index action 'status' first: it prints what is cached, how old it is, which root kinds each index covers, and what building will cost. A 0 from a lookup is only meaningful against the index status names — an index key encodes its root set, so an index you did not build is not what was searched.",
		"An engine-scope build is a minutes-long scan the first time. Ask the user before building it, and prefer engineAreas [\"Runtime\"] over the whole tree when the question is about gameplay base classes; engineAreas [\"Plugins\"] is the dial for plugin-shipped types (~2.8x the Runtime scan), [\"Plugins/Animation/PhysicsControl\"] for one plugin.",
		"action 'headers' answers 'does this header exist in this engine version': a path walk only (no content read, seconds, cached), scoped by root kind and reporting the owning plugin, its EnabledByDefault and its .uproject status. Invented header names come back as NOT a file path plus the closest real file names, never as types.",
		"mode 'full' runs UnrealBuildTool -Mode=Query (~7s, needs no compiler, and runs in UBT's own Query environment so it cannot collide with a live build) and records include edges; 'definitions' is a text scan only.",
		"After a rebase, a branch switch, adding a plugin, or an engine version change, rebuild with refresh: true — indexes are keyed by scan-root identity, not by the project name.",
		"action 'compiledb' is the clangd enrichment path: minutes of UnrealBuildTool work, ~1 GB for the engine scope (project+engine now includes Engine/Plugins sources, which is where plugin .cpp bodies live). Ask the user before running it, pass check: '<file>' to prove the result with clangd --check, and treat the database as machine-local (never committed).",
	],
	parameters: IndexParams,
	outputSchema: IndexOut,
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	executionMode: "sequential",

	async execute(_id, params, _signal, _update, ctx) {
		if (params.action === "status") {
			const out = indexStatus(params.cwd ?? ctx.cwd, realFs);
			const lines = [
				`cache: ${out.cacheDir}`,
				`query cache: ${out.query.usable ? `${out.query.target.target} ${out.query.target.platform} ${out.query.target.configuration} (${out.query.target.source})` : "not built"}`,
				`  TargetDetails: ${out.query.targetDetails ? `${Math.round(out.query.targetDetails.bytes / 1024)} KB, ${Math.round(out.query.targetDetails.ageMs / 1000)}s old` : "absent"}`,
				`  TargetModuleReferences: ${out.query.moduleReferences ? `${Math.round(out.query.moduleReferences.bytes / 1024)} KB, ${Math.round(out.query.moduleReferences.ageMs / 1000)}s old` : "absent"}`,
			];
			for (const index of out.indexes) {
				lines.push(`index ${index.key}  ${index.scope || "?"} ${index.mode}  ${index.defs} symbols / ${index.files} files  ${index.source}${index.target ? ` target=${index.target}` : ""}  ${Math.round(index.ageMs / 1000)}s old  ${index.sizeMb}MB${index.issues.length ? `  issues: ${index.issues.join("; ")}` : ""}`);
				lines.push(`  covers ${index.coverage}${index.areas?.length ? `  engineAreas: ${index.areas.join(", ")}` : ""}`);
			}
			if (!out.indexes.length) lines.push("no symbol index yet — unreal_index action build scope project (seconds)");
			for (const header of out.headers) {
				lines.push(`header index ${header.key}  ${header.files} header paths from ${header.roots} roots (${header.coverage})${header.areas?.length ? `  areas: ${header.areas.join(", ")}` : ""}  ${Math.round(header.ageMs / 1000)}s old  ${header.sizeMb}MB${header.issues.length ? `  issues: ${header.issues.join("; ")}` : ""}`);
			}
			if (!out.headers.length) lines.push('no header index yet — unreal_index action headers builds the path-only index (seconds, no content scan) and answers "does this header exist in this engine version"');
			const text = [...lines, ...out.notes.map((n) => `· ${n}`), ...(out.query.notes ?? []).map((n) => `· ${n}`)].join("\n");
			return result(text, out);
		}

		if (params.action === "headers") {
			const out = await headerReport({
				cwd: params.cwd ?? ctx.cwd,
				name: params.name,
				scope: (params.scope === "project" ? "project" : params.scope === "project+engine" ? "all" : "engine") as "project" | "engine" | "all",
				build: true,
				engineAreas: params.engineAreas,
				refresh: params.refresh,
				fs: realFs,
			});
			const lines = [`unreal_index headers${out.key ? ` → ${out.key}` : ""}`, `  ${out.files} header paths from ${out.roots} roots (${out.rootKinds})${out.built ? "" : "  not built"}`];
			if (out.name) {
				lines.push(`  '${out.name}': ${out.exists ? "EXISTS" : "does NOT exist as a file path in this engine version"}`);
				for (const row of out.found) lines.push(`    ${row.file}  [${row.module}${row.plugin ? ` · plugin ${row.plugin} [${row.pluginSource}] EnabledByDefault ${row.enabledByDefault} · .uproject reference ${row.referencedInUproject ? "yes" : "NO"}` : ""}]`);
				if (out.candidates.length) lines.push(`  closest real file names (files, not types):\n${out.candidates.map((row) => `    ${row.file}  [${row.module}]`).join("\n")}`);
			}
			const text = [...lines, ...out.notes.map((n) => `· ${n}`), ...(out.warnings ?? []).map((w) => `! ${w}`)].join("\n");
			return result(text, out as unknown as Record<string, JsonValue>, Boolean(out.name) && !out.exists);
		}

		if (params.action === "compiledb") {
			const db = await compileDbReport({
				cwd: params.cwd ?? ctx.cwd,
				scope: (params.scope === "project+engine" ? "project+engine" : "project") as "project" | "project+engine",
				target: params.target,
				platform: params.platform,
				configuration: params.configuration,
				refresh: params.refresh,
				fs: realFs,
			});
			const text = [
				`unreal_index compiledb → ${db.ok ? "ok" : "FAILED"}`,
				...(db.target ? [`  target ${db.target} ${db.platform ?? ""} ${db.configuration ?? ""}`] : []),
				`  ${db.entries} clangd-ready entries${"path" in db ? ` at ${db.path}` : ""} ${db.reused ? "(reused)" : ""}`,
				...(db.notes ?? []).map((n) => `· ${n}`),
				...(db.warnings ?? []).map((w) => `! ${w}`),
			].join("\n");
			return result(text, db as unknown as Record<string, JsonValue>, !db.ok);
		}

		const out = await indexBuild({
			cwd: params.cwd ?? ctx.cwd,
			scope: (params.scope ?? "project") as "project" | "engine",
			mode: (params.mode ?? "definitions") as "definitions" | "full",
			engineAreas: params.engineAreas,
			target: params.target,
			platform: params.platform,
			configuration: params.configuration,
			refresh: params.refresh,
			fs: realFs,
		});
		const seconds = out.durationMs != null ? (out.durationMs / 1000).toFixed(1) : "?";
		const text = [
			`unreal_index build scope=${out.scope} mode=${out.mode} → ${out.key}`,
			`  ${out.symbols} symbols / ${out.files} files / ${out.modules} modules from ${out.roots} roots ${out.built ? `in ${seconds}s` : "(cached, reused as is)"}`,
			`  areas: ${(out.engineAreas ?? []).join(", ")}`,
			`  dir: ${out.indexDir ?? "not built"}`,
			...out.notes.map((n) => `· ${n}`),
			...(out.warnings ?? []).map((w) => `! ${w}`),
		].join("\n");
		return result(text, out, !out.built && out.symbols === 0);
	},
});

export const indexTools = [unrealSymbol, unrealSymbolList, unrealContext, unrealIndex];

/** `/unreal-symbol <name>` — prefix-tolerant lookup across project and engine indexes. */
export function unrealSymbolCommand(query: string, cwd: string) {
	return symbolLookup({ cwd, query, scope: "all", prefix: true, fs: realFs }).then((out) => {
		const rows = out.results.map((row) => rowLine(row, cwd));
		return [`unreal_symbol '${query}': ${out.total} definition(s)`, ...rows, ...out.notes.map((n) => `· ${n}`)].join("\n");
	});
}

/** `/unreal-module <name>` — module identity + dependency lists; needs the Query cache, not a symbol index. */
export function unrealModuleCommand(name: string, cwd: string) {
	return buildContext({ cwd, module: name, includeDefines: true, fs: realFs }).then((out) => {
		const m = out.module;
		return [
			`module ${m?.name ?? name}`,
			`  dir: ${shortPath(m?.directory, cwd)}  target=${out.target?.target} ${out.target?.platform} ${out.target?.configuration}`,
			`  standard=${m?.standard ?? "?"}  sdk=${m?.windowsSdkVersion ?? "?"}  deps=${m?.dependencies ?? 0}`,
			`  publicInclude: ${(m?.publicInclude ?? []).join(", ") || "?"}`,
			`  privateInclude: ${(m?.privateInclude ?? []).join(", ") || "?"}`,
			`  defines file: ${shortPath(m?.definesFile, cwd)}`,
			...out.notes.map((n) => `· ${n}`),
			...(out.warnings ?? []).map((w) => `! ${w}`),
		].join("\n");
	});
}
