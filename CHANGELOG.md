# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Every version bump in `package.json`
adds an entry here; release notes stay auto-generated from commits.

Rule for bump class (repo policy): new tools, new parameters and new answer types are **minor**;
**patch** is fixes with the same surface; **major** is a breaking surface change — a removed tool,
a renamed parameter, or answer text an existing consumer parses.

## [Unreleased]

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
