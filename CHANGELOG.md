# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Every version bump in `package.json`
adds an entry here; release notes stay auto-generated from commits.

Rule for bump class (repo policy): new tools, new parameters and new answer types are **minor**;
**patch** is fixes with the same surface; **major** is a breaking surface change — a removed tool,
a renamed parameter, or answer text an existing consumer parses.

## [Unreleased]

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
