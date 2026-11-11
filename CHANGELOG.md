# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Every version bump in `package.json`
adds an entry here; release notes stay auto-generated from commits.

Rule for bump class (repo policy): new tools, new parameters and new answer types are **minor**;
**patch** is fixes with the same surface; **major** is a breaking surface change — a removed tool,
a renamed parameter, or answer text an existing consumer parses.

## [Unreleased]

## [1.6.0] - 2026-11-11

1.5.0 made the catalog complete and pointed at the tool's Python source. It still stopped short of the
request that comes after "what does this Blueprint do": *change it*. `write_graph_dsl` takes an
S-expression script and compiles the Blueprint, so the two ways to burn a turn were guessing the tool
and guessing the syntax — and a wrong guess is not a no-op, it replaces the graph's nodes first. This
release answers both: the grammar is read from the engine that will compile it, a script can be
pre-flighted before it is sent, and the write ladder is spelled out step by step. The package still
performs no writes.

### Added

- `unreal_mcp action="dsl"` — the Blueprint graph DSL, read from the resolved engine's own
  `blueprint_dsl.py` (`USAGE` at line 23, 225 lines on 5.8): section index, one section by name, or the
  full text. `action="dsl" code="…"` pre-flights a script. No editor needed; when the engine lacks the
  plugin, the answer says so and points at the live `get_graph_dsl_docs` instead of inventing syntax.
- `lintDsl` (in the new `lib/dsl-grammar.ts`) — a tokenizer plus shallow form tree that reports only
  what is decidable without node semantics: unbalanced parens, unterminated strings, unquoted
  `/Script/…` paths (the "Undefined variable" trap), `elif`/`else` that is not the last form of its
  body, data arguments after an exec continuation, empty forms. Positions are `line:column`, and one
  malformed string no longer cascades into a second "unclosed paren" error.
- `blueprint-graph-author` recipe — the authoring ladder: `load_asset` → `can_edit_asset` → `list_graphs`
  → `read_graph_dsl` (the recovery copy, captured *before* the write) → `get_graph_dsl_docs` →
  `find_node_types` → `get_node_type_pins` → `write_graph_dsl` → `read_graph_dsl` (read-back) →
  `is_dirty` → `save_assets`. Eleven steps, two writes.
- `RecipeStep.write` / `.effect` and `Recipe.posture` — a write step renders as `[WRITE]` with the
  sentence a caller must read first, and a write recipe renders an explicit boundary line: the package
  emits those steps as `call_tool` shapes and performs none of them.
- `skills/ue-blueprint-authoring` — the ladder, the grammar's real headings, the invariants that cost
  turns (bind instead of repeating a call, quote paths, `:Pin` vs `(:Pin …)`, `elif` is the branch), and
  the dead ends (`.uasset` reads, inventing ids from node titles).
- `/unreal-mcp dsl [section]` — the grammar from the shell, with the editor closed.
- Recipe parameters gained array values (`context_pins: []`, `asset_paths: [asset]`), so a skeleton for
  `find_node_types` / `save_assets` is complete rather than half-filled.

### Changed

- `unreal_mcp`'s description, prompt guidelines and the session context card now carry the authoring
  posture: read the graph, resolve id + pins, write, read back — and never read a `.uasset` for it.
- `describeToolText` and the DSL answers cite `file:line` for the grammar, so the reference can be
  opened rather than trusted.

### Notes

- A repeated inline call is **not** linted. `blueprint-graph-edit` is deferred until a real write has
  been tested against a live editor; structural authoring (`create_*`, `set_*`, `apply`) stays out of
  scope.
- The grammar is read, never copied: no Epic text is redistributed by this package.

## [1.5.0] - 2026-11-11

`unreal_mcp` covered four toolsets out of the 52 a real editor mounts, and stopped at the tool name —
when the name was wrong or the toolset was missing, the next step was still a guess. This release makes
the catalog complete and adds the offline half of the answer: where the tool is implemented.

### Added

- `unreal_mcp action="discover"` — `list_toolsets` → `describe_toolset` for **every** mounted toolset in
  one session and persists it (measured: 52 toolsets / 830 tools / 566 ms / 1.15 MB / 0 failures). A
  15-minute refresh now re-describes `wanted ∪ cached toolsets`, so a discovered catalog is not pruned
  back to the default four.
- `unreal_mcp action="python"` — indexes the toolsets' own Python (`<Plugin>/Content/Python/**`,
  `class X(unreal.ToolsetDefinition)` + `@toolset_registry.tool_call`) into 29 toolset classes / 596 tools
  in ≈0.2 s warm (1.6 s cold), cached 24 h. Answers with `file:line` and the real `def` signature, so
  "read the implementation" becomes a direct `read` instead of a search.
- Parity report (`action="python"`, no selector): mounted toolsets split into those with a Python class,
  those registered in C++ only (`EditorAppToolset`, `LogsToolset`, …), and those shipping in this engine
  but unmounted because their plugin is disabled for the project.
- `pythonTypeFor` and a wider `describe` line: UObject arguments now render as
  `object ref → unreal.EdGraph  (/Script/Engine.EdGraph)` — the Python name an agent recalls next to the
  `refPath` string the call must actually contain.
- `skills/ue-blueprint-inspection`: "when a tool is not in the catalog" ladder (search → python → the
  three outcomes), and the read-only boundary restated for the wider catalog.

### Fixed

- `parseToolsetList` no longer invents toolsets from markdown bullets inside descriptions
  (`- Enum value lookups` became a toolset called `Enum`); a line is a toolset only with a colon and a
  dotted name. Continuation lines now fold into the previous description.
- "in this engine but not mounted" was computed from a four-toolset snapshot, so 18 toolsets that the
  editor does mount were reported as disabled. The mounted set now comes from live `list_toolsets`.
- `python tool=<name>` applied the first hit's toolset to every hit when marking what is mounted.
- `describeToolText` no longer fabricates placeholders for optional object arguments (that fix landed
  here after the 1.4.0 note; skeletons carry required arguments only).

## [1.4.0] - 2026-11-10

The blueprint gap: an asset question had no honest route. Reading `.uasset` bytes is not a decode
(the output is garbled and does not reconstruct graphs, pins or defaults), and the only real answer —
Epic's Unreal MCP toolsets inside the editor — costs a guess per call because the tool names are
runtime-registered Python and the live `describe_toolset` payload for BlueprintTools is ~72 KB on a
single line, past the MCP adapter's text guard. This release turns that surface into a local,
queryable catalog and encodes the read-only order that field sessions settled on.

### Added

- **`unreal_mcp`** — the running editor's toolset catalog, live-first: `action: "list"` (toolsets, or
  one toolset's tools), `"search"` (name/args/doc substring), `"describe"` (exact arguments, required
  flags, defaults, the `call_tool` shape), `"recipe"` (read-only inspection ladder), `"sync"` (force a
  live refresh), `"status"`. Answers start with a source line — `live`, `snapshot · <age> old`, or an
  explicit "no catalog" that tells the agent to stop instead of inventing a name. Measured cost for
  the `read_graph_dsl` describe: **326 bytes** against the 72,168-byte full dump, with 0 differences
  across 97 tools when the normalized catalog was compared against the captured payloads
  (`lib/mcp-catalog.ts`, `lib/mcp-live.ts`, `lib/pi-tools.ts` `unrealMcp`).
- **Read-only Blueprint recipes** — `blueprint-inspect` (load_asset → get_parent → list_graphs →
  functions/events/variables → get_default_object → list_properties → get_properties →
  read_graph_dsl), `blueprint-variables`, `blueprint-behaviour`. Each step names a toolset and tool, so
  a renamed or unmounted tool is reported as `NOT IN CATALOG` instead of rendered as a plausible call;
  each also carries the dead end it exists to prevent (`read_graph_dsl` needs a graph *object*,
  `find_nodes` needs a title, `get_properties` needs names from `list_properties`). (`lib/mcp-recipes.ts`)
- **`/unreal-mcp [status|sync]`** — catalog health, or a forced re-read of the editor's schemas.
- **`ue-blueprint-inspection` skill** — the two rules (never read the asset file; resolve the tool
  before calling it), the lookup ladder, the verified read order, and the scope of the indexed catalog.
- The context card now names `unreal_mcp` and warns that a `.uasset`/`.umap` is not a readable document.
- Endpoint override: `PI_UNREAL_MCP_URL` (default `http://127.0.0.1:8000/mcp`) and a per-call `url`
  parameter, for editors started with a non-default `ModelContextProtocol.StartServer <port>`.

### Notes

- Scope is inspection only: no `create_*`/`set_*`/`write_graph_dsl`/`compile_blueprint`. Authoring and
  the static Python toolset scan (`@toolset_registry.tool_call` across
  `Engine/Plugins/Experimental/Toolsets/**/Content/Python`) are deliberately deferred until the read
  path has been used in anger.
- The snapshot lives under `~/.pi/agent/unreal-cache/mcp/<key>/` (15-minute TTL, re-described live
  while the editor is reachable) and never contains Epic's schema dumps in the repository.

## [1.3.0] - 2026-11-10

A correctness release driven by a review of the package against its own published claims: every
number in the docs, every row the scanner emits, and every cached answer was checked against the
live cache on the reporting box (UE 5.8.3 installed engine, Lp project with 28 plugin references).

The headline defect was the cached index. Key equality says *what* was scanned, never whether it
still matches the tree, so after any edit the index kept answering with yesterday's line numbers
and silently hid new symbols — the one failure mode where file and symbol look right and only the
line is wrong. A reused index is now verified (per-file mtimes) and repaired (patch) before it is
trusted.

### Added

- **Freshness gate on every reused index** — `files.tsv` carries a per-file `mtimeMs` (index format
  v7), `meta.json` carries `rootsState` and `freshness.newestMtimeMs`, and `ensureIndex` stats the
  indexed files before answering (~250 ms for the 18.5 k-file engine index, memoized 10 s). Edited
  and deleted files are re-scanned and patched automatically up to 200 files (measured: 150 ms for
  one edited `.cpp`), with one line reporting both the finding and the repair. Past the limit, or
  when only the scan *roots* moved, the answer warns and asks for `refresh: true`; an index from an
  older format says freshness cannot be checked instead of pretending. (`lib/store.ts`
  `indexFreshness`, `freshnessNote`, `patchIndex`, `restampFileRows`, `markIndexUsed`,
  `lib/tools.ts` `keepCurrent`, `AUTO_PATCH_LIMIT`.)
- `unreal_index` `action: "patch"` — the explicit form: no `files` patches whatever the freshness
  diff finds, an explicit `files` list patches exactly those.
- `unreal_index` `action: "status"` reports `last used <age>` and `freshness: N edited / M deleted
  of K checked` per index, and `action: "prune"` gained `olderThanDays` — reachability alone kept an
  index forever (135 MB of this box's cache was an index nothing had asked for in 12 days), so reuse
  writes a `.used` marker and an unused healthy index is now reclaimable on request.
- Symbol rows carry the declaration's own text (`snippet`), so a lookup usually answers "what does
  it look like" without a follow-up read. The snippet cache is keyed by mtime, not by path.
- The project index now defaults to UnrealBuildTool Query module attribution when a Query cache
  exists (`dirToModule`), instead of always using the `*.Build.cs` heuristic.

### Fixed

- **Destructors were never indexed** (0 rows in the whole engine index): the scanner rejected any
  head containing `~`. 1,959 engine rows and 148 project rows appear now.
- **Local declarations in `.cpp` files were indexed as functions** — 18,470 of 37,562 unqualified
  source rows, e.g. `FScopeLock Lock(&CriticalSection);` recorded as a function named `Lock`. A
  source-file signature now requires `Owner::Name` unless it sits inside a type body.
- `pure virtual` was appended twice per qualified row (`decl pure virtual pure virtual`, 5,239
  rows). Engine index: 437,614 → 420,603 symbols, project: 50,440 → 48,645 after both scanner fixes.
- 0-row engine answers did not mention that plugin roots are referenced-only and that the project
  index never scans engine sources; the gap now prints on every path, naming the scope asked for.
- `*.Build.cs` module lookup walked ~100 k directory listings per engine build (uncached
  `readdirSync` per level, per file); it is memoized.
- The `.uasset` edit gate silently did nothing off Windows (`tasklist` threw into a catch); it now
  probes `UnrealEditor` with `pgrep` on POSIX.

### Changed

- Docs corrected against measurements instead of memory: `docs/internals.md` cost table (project
  3,264 files / 48,645 symbols / 20.5 s; engine `Runtime` 18,566 / 420,603 / 112.8 s cold, 0.3-0.6 s
  warm), ranking order (exact → prefix → qualified-member → substring, forward declarations +1), the
  engine-scope "known limit" (project plugin roots belong to the project index), a new freshness
  section, and the scanner-version note that counts move when the scanner changes.
- `skills/ue-engine-resolution` no longer hard-codes one machine (a specific 5.7.4 engine source
  path, "5.8 has no registry key" as a universal fact); the session context card lists every tool
  and command and states which gate probe is active on this platform.
- README states what the package is worth when clangd is already installed (engine-wide
  declarations without a compile database, plus UBT module/include facts) instead of implying clangd
  is absent.

### Known limits

- Blueprint is still the editor's job: the package indexes C++ declarations and reads `.uasset`/
  `.umap` only as opaque files. `docs/internals.md` "Known limits" now says that outright, including
  that "Blueprint awareness" here means only the C++ edge (`UFUNCTION`/`UPROPERTY` markers, asset
  references in descriptors), not Blueprint graph or authoring conventions.

## [1.2.0] - 2026-10-29

Closes the field findings in `tmp/reports/field-findings-2026-10-28.md` (same UE 5.8.3 installed
engine, same Lp project; the session's measurement log). The compiler-free index is now the primary
symbol surface, and clangd is documented as **degraded, not absent**.

### Added

- `unreal_index` `action: "clangd"` — the compiler-free clangd health probe: parses the project's
  `.clangd` `CompilationDatabase:` setting, lists the directories clangd searches, counts the live
  database's entries against the translation units its scope has on disk, names current sources with
  **no compile command** and entries naming **deleted** files, compares the generator's
  `compileCommands_*.rsp` mtime with the database's (the "include paths current, file list stale"
  diagnosis), answers `compileCommand: found|none` for the file a diagnostics request named, and
  prints the honesty lines (`publishObserved: published:0 cannot distinguish "looked, found nothing"
  from "never looked"`; `no link check: … UnrealEngine-BuildProjectEditor is the link check`).
  Measured on the reporting box: 3 of 7 project translation units had a compile command.
  (`lib/compiledb.ts` `readClangdConfig`, `clangdSearchDirs`, `describeDatabase`,
  `responseFileStatus`, `compileCommandFor`; `lib/tools.ts` `clangdHealthReport`.)
- `unreal_index` `action: "compiledb"` gained `installTo: "<dir clangd reads>"` — copies the
  normalized database to the directory the session's clangd actually reads
  (`<project>/.vscode/unreal-clangd`) and prints the exact `CompileFlags: CompilationDatabase:`
  lines to merge. pi-unreal never writes `.clangd` (the file is the developer's, and the Unreal-clangd
  extension owns `.vscode/settings.json`). `check: "<file>"` is now reachable from the tool
  (`lib/compiledb.ts` `installCompileDb`).
- `unreal_index` `action: "prune"` — deletes the cache entries `action: "status"` marks reclaimable
  (format mismatches, superseded entries, root-keyed engine indexes 1.2 no longer produces, indexes
  whose roots are gone). `query/`, `compiledb/` and the plugin cache are listed as bytes only and
  touched with `compileDb: true` explicitly. Measured: 177 MB of 481 MB returned, idempotent.
  (`lib/store.ts` `auditCache`, `pruneCache`; `lib/tools.ts` `pruneReport`.)
- `unreal_index` `action: "callsites"` — the opt-in bounded text pass the field session needed: reads
  text in one module's tree (`Source/<Module>/Private`, a plugin subtree via `engineAreas`, project +
  enabled plugin roots via `scope: "all"`), suffix-matches the owner, caps lines per file, and returns
  rows labelled `candidate` with `match`/`via` and `isCallEdge: false`. Declarations, implementer
  declarations and definitions are named as such; a token mention is a token mention.
  (`lib/store.ts` `collectCallSites`; `lib/tools.ts` `callSitesReport`.)
- `unreal_context` `file:` answers a header miss instead of dead-ending: engine-scope misses fall
  back to the project index, then to the header index, printing the header index key/files/root kinds
  /age, owning plugin + `EnabledByDefault` + `.uproject` reference, the module (`/Source/<Module>/`
  path shape — a file no index has read has no `*.Build.cs` to walk), target availability from the
  **cached** Query with its age, and the paid `engineAreas: ["Plugins/<Category>/<Plugin>"]` route.
  (`lib/tools.ts` `headerPathAnswer`, `cachedTargetModules`; `lib/store.ts` `moduleFromSourcePath`.)
- A qualified 0-row answer whose member ends `_Implementation` now states the UnrealHeaderTool fact:
  the member is the generated thunk of a `BlueprintNativeEvent`/`BlueprintImplementableEvent`, emitted
  on every implementer and never on the declaring interface, so 0 rows is correct; the answer names
  the declared member to query and lists the implementer rows it found
  (`ALpMoverPawn:ProduceInput_Implementation  LpMoverPawn.cpp:353`).
  (`lib/tools.ts` `zeroResultUhtNotes`.)
- Header candidates carry their match `reason` (`same stem`, `stem containment (moverstate ⊂
  moverstatetypes)`, `name tokens 2/3`, `Mover plugin family`,
  `generic name tokens only (state, types) — related to 'moverstate' by name shape, not a lead`), and
  unrelated-plugin rows are capped.

### Changed

- **Engine scope is engine-only, and its key is `(engineRoot, engineAreas)`.** 1.1 fingerprinted the
  engine root list, which included the project's enabled plugin roots — so 8 new plugin module roots
  (25 → 28 `.uproject` references) changed the key and orphaned 335 MB of engine scans
  (`idx-engine-defs-6ee690c3fe45`: 251 MB, 1,240,246 symbols, 1,996 roots; `idx-engine-defs-b8d82464af4a`:
  84 MB, 476,327 symbols), and the next lookup computed a fresh key and missed instantly. The header
  index has always keyed on engine roots alone and stayed valid across the same edits; the symbol
  index now has the same property. Engine keys change once more, so pre-1.2 engine indexes are
  reported as reclaimable and rebuilt per machine (`lib/store.ts` `indexKeyFor`,
  `legacyEngineIndexKeyFor`, `isLegacyEngineIndexKey`).
- `scope: "engine"` and `"all"` answers are the **union** of the project index and the engine index,
  and the answer prints both keys and which is cached. Engine scope no longer returns 0 rows for a
  plugin-shipped type the project index contains (`MoverInputCmdContext`: 105 rows project, 0 engine).
  `unreal_context` `file:` on an engine path searches the project index before declaring a miss
  (`lib/tools.ts` `scopeIndexes`).
- Header ranking (`suggestHeaderPaths`) is name-shape-aware: same stem, then stem containment, then
  distinctive-token count, then the query's plugin family, with generic vocabulary (`State`, `Types`,
  `Table`, `Data`, `Info`, `Log`, …) demoted and capped. Probing `MoverState.h` returned
  `AnimWarpStateTypes.h`, `GameplayExternalTypes.h`, `InterchangeCubeSurfaceData.h` ahead of
  `Mover/Public/MoverStateTypes.h` under 1.1's `+1 public-header / +1 token overlap / +2 all-tokens`
  score; 6 of the ranked rows are now `Mover`-family, and the plugin-family label is printed as a
  heuristic, never as a proof.
- `unreal_index` `action: "status"` prints the root set current lookups ask for beside the keys, the
  near-miss index names with their root delta ("which key did the last lookup search?" was
  unanswerable in the field session), reclaimable cache bytes with the prune hint, and the generated
  compile databases with the path clangd reads.
- `pickIndex` near-miss notes name one index, its root kinds, its `engineAreas`, and the root delta
  (`missing 8 of this call's root(s)` / `covering 1717 root(s) this call does not scan`).
- Docs: clangd is documented as degraded-not-absent with the measured evidence, `clangd --check` is
  labelled a syntax gate and not a link check, the compile-database entry count is quoted as the
  current TU set (9 entries in 1.9 s) instead of the 1.0 snapshot's 4, and the header index's
  .uproject immunity is stated where the engine index's was.

## [1.1.0] - 2026-10-28

Closes the field findings in `docs/field-findings-2026-10-27.md` (measured on a UE 5.8.3 installed
engine against a project with 25 enabled plugin references).

### Added

- `unreal_index` `action: "headers"` — a path-only header index answering "does this header exist in
  this engine version?": exact path, owning module, owning plugin, `EnabledByDefault`, and whether
  the `.uproject` references it. Invented names come back as *not a file path* plus the closest real
  file names, labelled as files and never as types. Never built implicitly; keyed by its own root set
  (`lib/store.ts` `buildHeaderIndex`, `lookupHeaderPaths`, `suggestHeaderPaths`; `lib/tools.ts`
  `headerReport`, `headerLookup`).
- Engine-scope indexes include the project's enabled plugin roots, and `engineAreas` accepts engine
  plugin dials: `["Plugins"]` (every `Engine/Plugins` source tree, ~2.8x the `Runtime` scan) or
  `["Plugins/Animation/PhysicsControl"]` (one plugin).
- Every answer states what it scanned. A 0-row symbol answer names the index keys, the root kinds
  (`279 engine-source root(s), 62 engine-plugin root(s)`), the plugins the project does not reference
  whose names match the query, and the exact next call (`lib/tools.ts` `zeroResultNotes`,
  `indexCoverageNote`, `rootKindsNote`). `unreal_index` `action: "status"` reports the same per index,
  plus the header indexes.
- `unreal_context` `module: "X"` reports per-target availability: whether the target's module graph
  contains it, its module directory, the declared module `Type`, its owning plugin with
  `EnabledByDefault`, and the `.uproject` reference status as separate facts
  (`lib/tools.ts` `moduleAvailability`).
- `unreal_symbol` exposes `substring: true` (the substring pass already existed in `lookupSymbol`;
  it was unreachable from the tool).
- `unreal_project_inspect` / `unreal_plugin_inspect` name the modules a resolved plugin reference
  buys — `Mover: resolved ← Engine · modules Mover(Runtime), MoverCVDData(Runtime),
  MoverEditor(UncookedOnly)` — and list engine plugins available with **no** `.uproject` reference
  (`EnabledByDefault: true`), separated from the references.

### Changed

- Index format v6 (`INDEX_VERSION = 6`): `meta.rootKinds` + `meta.areas`. Engine-scope index keys
  change because engine roots now include enabled plugin roots, so v5 engine indexes are not reused
  (one rebuild per machine; project indexes are unaffected).
- Definitions-mode module attribution names modules after their `*.Build.cs` file, not the directory
  leaf: `Engine/Plugins/Animation/PoseSearch/Source/Runtime` is module `PoseSearch`, not `Runtime`.
  Multi-`Build.cs` directories are disambiguated by the `.uplugin` module names
  (`store.ts` `moduleFromBuildCs`, `buildCsNames`, `pickModuleName`; `assembleRoots` root modules).
  This is what makes `unreal_symbol module: "PoseSearch"` answer in `definitions` mode.
- Index writes and whole-file passes are streamed: `buildIndex` sorts definition rows per 40 000-row
  shard and k-way merges them into `defs.tsv`, and the linear passes (substring lookup,
  symbols-in-file, module-scope recovery) read the TSV in 4 MB chunks. The whole-Plugins engine scope
  is 1.24 M rows / ~250 MB and previously died in the allocator at 1.91 GB
  (`ReachJSValueFormalMemoryCommit Allocation failed: out of memory`).
- `unreal_context` `file:` derives scope from path shape (`Engine/Plugins/...` is engine scope), and
  a miss falls back to the header index: "this file exists, in plugin X, `EnabledByDefault` false,
  not referenced by your `.uproject`, here is the call that indexes it" — instead of "not in index".
- `unreal_index` `action: "compiledb"` with `scope: "project+engine"` now includes `Engine/Plugins`
  sources, where plugin `.cpp` bodies live.

### Fixed

- `engineAreas` schema wording: `["Runtime"]` is the engine's own gameplay code, not every gameplay
  type — plugin-shipped types were unreachable and a 0 read as "the engine has no such type".
- `test/live-check.ts` no longer defaults to a machine-local `.uproject` path (it resolved to
  nothing on CI) and prints a usage line instead.

### Documentation

- `README.md` and `docs/internals.md`: engine/plugin coverage and its measured cost, the header index
  and the path-vs-symbol distinction, "an empty clangd answer is evidence", and the asset boundary —
  pi-unreal answers C++ declaration/module/include/dependency facts and does not answer UENUM index
  order, UStruct field types, UCLASS/CDO values or Blueprint graphs (that needs the `unreal-engine`
  editor MCP with the editor running).

## [1.0.0]

- Initial release: `unreal_resolve_engine`, `unreal_project_inspect`, `unreal_plugin_inspect`,
  `unreal_symbol`, `unreal_symbol_list`, `unreal_context`, `unreal_index` (compiler-free symbol
  index, UnrealBuildTool Query facts, clangd compile-database enrichment).

[Unreleased]: https://github.com/Aeonsparx-Interactive/pi-unreal/commits/main
[1.1.0]: https://github.com/Aeonsparx-Interactive/pi-unreal/releases/tag/v1.1.0
[1.0.0]: https://github.com/Aeonsparx-Interactive/pi-unreal/releases/tag/v1.0.0
