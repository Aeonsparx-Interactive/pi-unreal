# pi-unreal internals

Design and implementation notes: how the tools derive their answers, and the measured numbers behind
the cost model. Read the README for day-to-day usage; this file is the engine-facing detail that
the README deliberately leaves out.

## Symbol index (no compiler, no IDE)

`unreal_symbol`, `unreal_context`, and `unreal_index` answer navigation questions from two
compiler-free sources:

1. **UnrealBuildTool Query** (`-Mode=Query`: `TargetDetails`, `TargetModuleReferences`) — the
   engine's own record of targets, modules, module dependencies, include paths, and forced
   includes. Measured on UE 5.8: 6.0 s for 1,079 modules, 2.1 s for the dependency graph, and it
   needs no compiler. That is why MSVC-only machines (Visual Studio, Rider) are first class here:
   Visual Studio's `Browse.VC.db` is encrypted with no public API, Rider's resolver is in-process
   through RiderLink, and both derive their context from the same UBT rules this layer reads.
2. **A regex definition scanner** over the project, its enabled plugins, and the engine areas its
   modules actually depend on — `class`/`struct`/`enum`/`union`, `UFUNCTION`, `UPROPERTY`,
   delegates, aliases, with `Owner:Member` qualified names and forward declarations marked. In an
   installed engine "engine areas" is not where the gameplay types are: `Engine/Source/Runtime` is the
   engine's own code, and plugin-shipped types live under `Engine/Plugins/<Category>/<Plugin>/Source/`,
   so an engine-scope index takes its plugin roots from the `.uproject` (plus an explicit
   `engineAreas: ["Plugins"]` dial for the rest).

Artifacts live in `$PI_UNREAL_CACHE_DIR/indexes/<key>/` (`meta.json`, `defs.tsv`, `files.tsv`,
plus `includes.tsv` in `full` mode): plain TSV — greppable, inspectable, shared across sessions
and projects — and never inside the project tree or the engine installation.

Writes and whole-file passes are **streamed**, because the whole-Plugins engine index is 1.24 M rows
(~250 MB of TSV): `buildIndex` sorts rows per 40 000-row shard and k-way merges them into `defs.tsv`
(peak memory is one shard, output is identical to a single sorted pass), and the linear passes
(substring lookup, symbols-in-file, module scope recovery) read the TSV in 4 MB chunks and stop when
the answer is full. An earlier build accumulated every row in an array and died in the allocator at
1.91 GB (`ReachJSValueFormalMemoryCommit Allocation failed: out of memory`) — which is the failure
mode of "just load the index" at engine scale.

Measured on this box (UE 5.8.3 installed engine; Lp project with 25 enabled plugins):

| Scope | Files | Definitions | Cold build |
| --- | --- | --- | --- |
| Project + plugins | 2,405 | 38,901 | 6.7 s |
| Engine `Runtime` (shipped default: 279 module roots) | 18,566 | 436,729 | 57.6 s cold, 5.7 s warm |
| Engine `Runtime` + 62 enabled plugin roots | 20,966 | 476,327 | 122 s cold, 0.4 s warm |
| Engine `Runtime` + every `Engine/Plugins` source | 71,004 | 1,240,246 | ~2 min cold (1,996 roots: 279 engine-source + 1,717 engine-plugin) |
| Engine `Runtime/Core` + `Runtime/CoreUObject` | 3,094 | 70,548 | 16 s |
| Header index (paths only, engine `Runtime` + all `Engine/Plugins`) | 37,788 headers | — | 4.5 s cold, 0.5 s warm |
| Cached lookup | — | — | ~0.3 s |

Cost discipline is the design. A lookup builds the project index (seconds) and uses an engine
index only if one exists; `scope: "engine"` on a cold machine returns
`engine index not built — build it with unreal_index (action: "build", scope: "engine")` instead of
spending minutes on a scan nobody asked for. `unreal_index` is the explicit, paid path.

Ranking inside `unreal_symbol`: exact (0) → qualified member (1) → prefix (2) → substring (3).
Forward declarations rank last, so `unreal_symbol AActor` returns
`Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h:282` (the `UCLASS` declaration), not
the `class AActor;` line in `PhysicsCollision.h`.
`unreal_symbol LpGameModeBase` finds `ALpGameModeBase` (the UE prefix is added for you); `unreal_symbol FLpMovementDirectionThresholds:F` finds a single-letter `UPROPERTY` field; `unreal_context LpCharacterTypes.h` resolves a bare file name through the index. Engine areas are derived from module
dependencies (`.uproject` modules → recursive `PublicDependencyModuleNames` → plugin-supplied
modules → recursive `PublicDependencyModuleNames` → plugin-supplied
modules → `Engine/Source/<area>/*`), so the index contains what this project can compile against,
not the whole engine. An **engine-scope** index is `Engine/Source/<area>` roots *plus the plugin
roots the `.uproject` enables* — in UE 5.8 most gameplay types ship as plugins (`Mover`,
`PoseSearch`, `SmartObjects`, `BlendStack`, `StateTree`, `GameplayAbilities`), and an index of
`Engine/Source/Runtime` alone reports 0 rows for `UMoverComponent` while the project index already
contains it. Engine plugins the project does **not** reference are in no root: `engineAreas:
["Plugins"]` adds every `Engine/Plugins` source tree (~2.8× the `Runtime` scan),
`["Plugins/Animation/PhysicsControl"]` adds one.

Every answer states what it scanned: index key, root kinds (`279 engine-source root(s),
62 engine-plugin root(s)`), and the `engineAreas` it was built with. A 0-row answer is a statement
about those roots, never about the engine, and it prints the exact next call.

## Header index (`unreal_index` action `headers`)

"Does this header exist in this engine version?" is a path question that a definitions index cannot
answer: absence of a symbol row is not absence of a file, and the index roots exclude every plugin
the project does not enable. `buildHeaderIndex` walks file **paths** only — no content read — over
the same root assembly (`Engine/Source/<area>`, `Engine/Plugins/...`, project sources), writes
`headers.tsv` (`file \t module \t kind`) beside the symbol indexes, and answers exists / exact path
/ owning module / owning plugin / `EnabledByDefault` / referenced-in-`.uproject`. Measured: 37,788
header paths in 4.5 s on a UE 5.8 install (`Runtime` + all of `Engine/Plugins`).

It is never built implicitly (a path answer must not cost a scan nobody asked for), its key encodes
its own root set, and when the name does not exist the answer lists the closest real **file** names
labelled as files. That is the discipline behind it: an invented name like `MoverState.h` must not
become a confident type suggestion — the old workflow produced `Mover/Public/InputContainerStruct.h`
(a real file, a bogus answer) for `FCharacterDefaultInputs`, and the types
`FPoseSearchBlendPose(History)` do not exist in 5.8 at all.

One engine fact worth knowing: UBT Query reports `"defines": []` for every module. The effective
preprocessor set lives in a forced include —
`Intermediate/Build/<Platform>/<Config>/<Target>/Development/<Module>/Definitions.<Module>.h` —
and `unreal_context` reads that file instead of guessing `WITH_*` values. Query is also never
run with `-NoIntellisense`: that flag produces a syntactically valid skeleton with an empty
`moduleToCompileSettings`, and `payloadOk()` rejects it.

## clangd enrichment (`unreal_index` action `compiledb`)

The definition index is the compiler-free path. When you want clangd's semantic power (references,
call hierarchy, diagnostics), the database it needs comes from the engine: `UnrealBuildTool
-Modes=GenerateClangDatabase`, normalized in the pi-unreal cache.

The UnrealBuildTool invocation is the part nobody documents, so it is encoded in one place
(`lib/compiledb.ts`):

- The target is **three positional tokens** — `Win64 Development LpEditor`. `TargetDescriptor` only
  inspects arguments that do not start with `-`, and its `+` split requires every token to be the
  same kind, so `-Target=LpEditor` fails with `No platforms specified for target` and
  `Win64+Development+LpEditor` fails with `The platform name Development is not a valid platform
  name`. `-Platform=`/`-Configuration=` set `BuildConfiguration` only and produce a duplicate
  platform error next to the positional tokens.
- `-OutputDir=` must already exist (UnrealBuildTool throws
  `DirectoryNotFoundException: Could not find a part of the path ...\compile_commands.json`), and
  the mode's own `-NoPCH -NoVFS -Compiler=Clang` additions mean the emitted driver is
  `clang-cl.exe`, not `cl.exe`.
- `-Include=` rules match nothing useful (measured: `Source/Lp`, `*/Source/Lp/*`,
  `C:/Users/.../Source/Lp/**` all yield an empty database), so scoping happens after generation.

Normalization is Epic's `stripPostPch.py` recipe, ported: expand the per-module `@file.rsp`
response files, drop `/Yu* /Fm* /Fe* /Fp*` and everything after `/link`, drop PCH translation
units (`SharedPCH.*.h.cpp`, `PCH.*.h.cpp`) and header entries, then keep the requested scope. The
database is written to `$PI_UNREAL_CACHE_DIR/compiledb/<target>.<platform>.<config>/` — it encodes
this machine's absolute paths and toolchain version, so it is a machine artifact, never a repo one.

`check: "<file>"` runs `clangd --check` against the result, which is the acceptance test. Measured
on Lp (UE 5.8.3, installed engine, VS 18 LLVM clangd): UnrealBuildTool 1.5-1.7 s, 4 entries,
4 response files expanded, 0 switches dropped; `clangd --check` built a 62 MB preamble and
reported **`All checks completed, 0 errors`** in ~2.6 s.

The honest limits of that 4-entry number: an installed (precompiled) engine contributes no compile
actions, so the database covers the project's own translation units, not `Engine/Source`. Engine
files still work under clangd because the project's `.clangd` supplies the include paths — exactly
what Epic's Unreal-clangd VS Code extension does (its generated `Lp.0.rsp` contains only `/FI`
plus 523 `/I` lines, and `compile_commands.json` there has 6 project entries and no engine entry).
Re-run with `refresh: true` after changing `Build.cs` files, adding modules, or switching engine
version.

## How engine resolution works

Mirrors `FDesktopPlatformWindows::GetAvailableEngineDescriptions`
(`Engine/Source/Developer/DesktopPlatform/Private/DesktopPlatformBase.cpp:459-511`) and
`VerifyEngineGuid` (`DesktopPlatformWindows.cpp:615-664`):

| `.uproject` association | Source of truth |
| --- | --- |
| engine-root path | used directly, validated |
| `5.8` (Launcher install) | `HKLM:\SOFTWARE\EpicGames\Unreal Engine\<ver>` → `InstalledDirectory`, then `<installDirDefault>\UE_<ver>` |
| `{GUID}` (source build) | `HKCU:\SOFTWARE\Epic Games\Unreal Engine\Builds` |
| empty | walk up 12 levels looking for `Engine/Config/BaseEngine.ini` |

Below the association: `LauncherInstalled.dat`, `HKLM` versions, `UNREAL_ENGINE` / `UE_ROOT` /
`PI_UNREAL_ENGINE_ROOT`, and a scan of `C:/Program Files/Epic Games` for `UE_*`. Explicit
`engineRootHint` outranks every registry source.

Every candidate is validated before use — `Engine/Binaries` + `Engine/Build`
(`DesktopPlatformBase.cpp:401-421`) **and** `Engine/Build/Build.version` matching the
association. Stale registry keys and env pointers are reported as rejected candidates with the
reason, never silently dropped. One survivor → `resolved`; several → `ambiguous`; none →
`unresolved` + remediation. Nothing is ever written back to the registry.

Registry reads run through one memoized `pwsh -NoProfile` snapshot (8 s timeout). If `pwsh` is
missing the snapshot degrades to `available: false` and the resolver continues with
file-based sources — the extension never fails at import time.

## Plugin discovery

Mirrors `UnrealBuildTool.System.ReadAvailablePlugins` (`System/Plugins.cs:322`):
Engine `Engine/Plugins` → Project `Plugins/` → Mod `Mods/` → `AdditionalPluginDirectories`,
with later scans shadowing earlier ones on name collision. `Binaries/`, `Intermediate/`,
`Saved/`, `.git/`, `ThirdParty/` are skipped. Reference semantics mirror `PluginManager`:
`Enabled` / `Optional` / `Activate` (`PluginReferenceDescriptor.cpp:132-172`); an engine-version
mismatch is a warning, not an error (`PluginManager.cpp:2690-2712`).

Indexes are cached on disk keyed by the mtime of every scanned directory plus the engine
changelist, with a 10-minute backstop (`MAX_AGE_MS`) because content-only `.uplugin` edits do
not move the parent directory's mtime.

## Descriptor fidelity

Field names, host types, and loading phases are transcribed from the engine's serializers
(UE 5.8): `ProjectDescriptor.cpp:100-225`, `PluginDescriptor.cpp:263-409`,
`ModuleDescriptor.cpp`, `PluginReferenceDescriptor.cpp:130-180`, cross-checked against 897
`.uplugin` files in UE 5.8 `Engine/Plugins`. Consequences:

- `.uproject` / `.uplugin` are parsed as JSONC (comments and trailing commas are legal in the
  engine's reader).
- `Modules` is an array of objects keyed by `Name`; `Type` is required
  (`Found Module entry 'X' with a missing 'Type' field`), `LoadingPhase` defaults to `Default`.
- A plugin reference without `"Enabled"` is rejected by UE 5.8 — reported, not guessed.
- Unknown keys are reported as `… is not serialized by FPluginDescriptor`, and the known-key
  set is wide enough (including legacy `Whitelist*`/`Blacklist*` and pre-5.x keys) that genuine
  engine files produce no noise.
- `.uplugin` has no `Enabled` key; enablement is `EnabledByDefault` + the project reference.
- `IsBetaVersion` is metadata in UE 5.8 (no engine/UBT beta gate exists).

## Known limits

- Registry access needs `pwsh` (PowerShell 7). Without it, registry sources are unavailable and
  resolution relies on env, directory scans, and inline associations.
- `unreal_resolve_engine` reports what the machine can prove. It does not install, register, or
  migrate engines, and never writes registry keys (the engine's `RegisterEngineInstallation`
  does; this package deliberately does not).
- v1 is inspection only. `.ini` provenance is out of scope.
- The definition index is a scanner, not a parser: it finds declarations (`class`, `struct`,
  `enum`, `union`, `UFUNCTION`/`UPROPERTY`/`UCLASS`-marked members, delegates, aliases) and
  records `Owner:Member` qualified names. It does not resolve types, overloads, call sites, or
  inheritance — that is what clangd is for when it is installed. Macro-heavy code can still be
  misread: the scanner is regex-based, so a definition hidden inside an unusual macro spelling may
  be missed, and `#if` branches are all recorded (a symbol declared in a disabled branch is a
  candidate, not a guarantee).
- `moduleRefs` and `includePaths` come from UnrealBuildTool Query, which needs a buildable
  target for the project; when Query fails the index still builds and says so.
- The engine index is never built implicitly: scans are opt-in through `unreal_index`. The header
  index is never built implicitly either, for the same reason: a path answer must not cost a scan.
- `action: "compiledb"` needs UnrealBuildTool (so an engine installation) and, for the
  `clangd --check` acceptance step, a clangd binary — `CLANGD_PATH`, the Visual Studio LLVM
  toolset, the WinGet LLVM package, or `C:/Program Files/LLVM/bin`. Without clangd the database is
  still produced and reported; only the check is skipped.
- On an installed engine the compile database covers the project's translation units (engine
  modules are precompiled and contribute no compile actions). The engine-wide scope of
  `project+engine` is the source-built case, and there it is a ~1 GB artifact taking minutes.
  `project+engine` now includes `Engine/Plugins` sources as well as `Engine/Source` — that is where
  plugin `.cpp` bodies live, and a database without them silently drops every plugin implementation
  file from clangd.
- An empty clangd answer is **evidence, not a bug to route around**. On an installed engine the
  database has no engine translation units, so "clangd found no references in
  `MoverComponent.cpp`" describes the setup, not a defect pi-unreal fixes: it answers declaration,
  module, include-path and dependency facts by a compiler-free route, and says what it scanned.
- Engine area selection is a cost dial, not a completeness claim. `DEFAULT_ENGINE_AREAS =
  ["Runtime"]` covers the engine's **own** gameplay code (`AActor`, `UAnimInstance`,
  `USceneComponent`, 18,566 files) — in an installed engine that is not every gameplay type, because
  the ones shipped by plugins (`Mover`, `PoseSearch`, `PhysicsControl`, `BlendStack`, `SmartObjects`,
  `StateTree`, `GameplayAbilities`) live under `Engine/Plugins/<Category>/<Plugin>/Source/<module>`.
  Engine-scope indexes add the plugin roots the `.uproject` enables; the rest are opt-in via
  `engineAreas: ["Plugins"]` (~2.8× the `Runtime` scan) or `["Plugins/Animation/PhysicsControl"]`
  for one plugin. `Editor` and `Developer` are opt-in and roughly triple the scan.
- pi-unreal answers C++ **declaration, module, include-path and dependency** facts. It does not
  answer asset questions: UENUM index order (Blueprint enumerators are stored in index order, so
  `4 = OnGround` is an asset fact), UStruct field types, UCLASS/CDO instance values, component
  lists, parent chains, Blueprint graphs. Those need the `unreal-engine` editor MCP with the editor
  running; a C++ scan cannot see them and must not pretend to.
- Index reuse requires the *same root set*: an index built over two modules is never used to answer
  a `Runtime`-wide query. Partial coverage reported as an answer is worse than a rebuild.
