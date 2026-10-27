# pi-unreal

Pi package that replaces Unreal Engine guesswork with facts the engine itself defines: which
engine installation a `.uproject` points at, what its `.uproject` / `.uplugin` descriptors
actually say, and where each plugin reference really resolves.

Read-only by design. It never writes to a project, never touches the registry, and blocks the
three edits that damage Unreal work on this machine.

## Install

```bash
pi install ./pi-unreal      # from this directory
pi -e ./extensions/unreal/index.ts   # dev loop, no install
```

Dependencies (`fast-glob`, `jsonc-parser`) install with the package. The Pi host and `typebox`
are peer dependencies and are never bundled.

## What it gives the agent

### Tools

| Tool | Answers |
| --- | --- |
| `unreal_resolve_engine` | "which engine does this `.uproject` use, and how do you know?" |
| `unreal_project_inspect` | modules, plugin references and their real resolution, JSONC diagnostics, `TargetPlatforms`, `AdditionalPluginDirectories` |
| `unreal_plugin_inspect` | one `.uplugin` as the engine parses it, plus its declared plugin dependencies |
| `unreal_symbol` | "where is this class/function/property/delegate declared?" — file, line, module |
| `unreal_context` | "what does this file/module include, define, and own?" — real `Definitions.*.h` defines |
| `unreal_index` | build, refresh, patch, inspect; `includePaths` and `moduleRefs` from UnrealBuildTool |

All seven are read-only and idempotent. The three inspection tools accept `project` (file or
directory; defaults to the nearest `.uproject` within 4 levels of the workspace) and
`engineRootHint` (disambiguates an ambiguous association); the three index tools accept `cwd`
(defaults to the workspace) plus a scope. Each returns `structuredContent` for machine use and a
text report for the model.

### Commands

- `/unreal [project]` — engine resolution + descriptor + plugin-reference report
- `/unreal-engines` — every engine installation this machine can prove, with how it was found
- `/unreal-cache stats|clear` — plugin-index cache inspection (cache dir:
  `$PI_UNREAL_CACHE_DIR` or `~/.pi/agent/unreal-cache`)
- `/unreal-symbol <query> [scope]` — shorthand for `unreal_symbol` (scope `project` default,
  `engine`/`all` opt-in)

### Context card

On the first user prompt of a session, when a `.uproject` is discoverable from the working
directory, one `unreal:context` message states the resolved engine, modules, plugin-reference
count, and the conventions below. It is injected once per session, is skipped for custom
messages, and never replaces the system prompt (cache stability; the machine-level
`AGENTS.md` stays in charge).

### Convention gate

| Situation | Action |
| --- | --- |
| `edit` / `write` targeting `*.uasset` / `*.umap` | **blocked** — cooked binary, author it in the editor |
| `edit` on C++ (`*.cpp`, `*.h`, …) while `UnrealEditor*` runs | **warning** — freshly compiled C++ will not load into the running editor |
| `bash` / `powershell` running `clang-format` against a `*.cs` file | **blocked** — clang-format applies the C# rule and can empty the file (verified on `Source/Lp.Target.cs`) |

`*.cs` is deliberately excluded from the C++ warning: UBT build scripts are C#, not live-compiled
engine source.

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
   delegates, aliases, with `Owner:Member` qualified names and forward declarations marked.

Artifacts live in `$PI_UNREAL_CACHE_DIR/indexes/<key>/` (`meta.json`, `defs.tsv`, `files.tsv`,
plus `includes.tsv` in `full` mode): plain TSV — greppable, inspectable, shared across sessions
and projects — and never inside the project tree or the engine installation.

Measured on this box (UE 5.8.3 installed engine; Lp project with 25 enabled plugins):

| Scope | Files | Definitions | Cold build |
| --- | --- | --- | --- |
| Project + plugins | 2,405 | 38,901 | 6.7 s |
| Engine `Runtime` (shipped default: 279 module roots) | 18,566 | 436,729 | 57.6 s cold, 5.7 s warm |
| Engine `Runtime/Core` + `Runtime/CoreUObject` | 3,094 | 70,548 | 16 s |
| Cached lookup | — | — | ~0.3 s |

Cost discipline is the design. A lookup builds the project index (seconds) and uses an engine
index only if one exists; `scope: "engine"` on a cold machine returns
`engine index not built — build it with unreal_index (action: "build", scope: "engine")` instead of
spending minutes on a scan nobody asked for. `unreal_index` is the explicit, paid path.

Ranking inside `unreal_symbol`: exact (0) → qualified member (1) → prefix (2) → substring (3).
Forward declarations rank last, so `unreal_symbol AActor` returns
`Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h:282` (the `UCLASS` declaration), not
the `class AActor;` line in `PhysicsCollision.h`. Engine areas are derived from module
dependencies (`.uproject` modules → recursive `PublicDependencyModuleNames` → plugin-supplied
modules → `Engine/Source/<area>/*`), so the index contains what this project can compile against,
not the whole engine.

One engine fact worth knowing: UBT Query reports `"defines": []` for every module. The effective
preprocessor set lives in a forced include —
`Intermediate/Build/<Platform>/<Config>/<Target>/Development/<Module>/Definitions.<Module>.h` —
and `unreal_context` reads that file instead of guessing `WITH_*` values. Query is also never
run with `-NoIntellisense`: that flag produces a syntactically valid skeleton with an empty
`moduleToCompileSettings`, and `payloadOk()` rejects it.

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

## Verify

```bash
bun test                      # 57 tests: resolver, descriptors, plugins, cache, gate, scanner, index
bun run typecheck             # tsc --noEmit
bun test/live-check.ts "C:/path/to/Project.uproject"   # live machine smoke
bun test/keys.census.mjs "C:/Program Files/Epic Games/UE_5.8/Engine/Plugins"
bun run tmp/smoke.mjs project "C:/path/to/Project"     # symbol index against a real project
bun run tmp/smoke.mjs query "C:/path/to/Project"       # UnrealBuildTool Query round trip
bun run tmp/smoke.mjs engine "C:/path/to/Project"      # Engine/Source index (minutes, opt-in)
```

`test/live-check.ts` prints the real resolution for a real project, the installation table, a
plugin-reference report, and cold-vs-warm index timings. `test/keys.census.mjs` counts descriptor
keys in real engine files so diagnostics stay honest.

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
- The engine index is never built implicitly: scans are opt-in through `unreal_index`.
- Engine area selection is a cost dial, not a completeness claim. `DEFAULT_ENGINE_AREAS =
  ["Runtime"]` covers every gameplay type (`AActor`, `UAnimInstance`, `USceneComponent`) at
  18,566 files; `Editor` and `Developer` are opt-in via `engineAreas` and roughly triple the scan.
- Index reuse requires the *same root set*: an index built over two modules is never used to answer
  a `Runtime`-wide query. Partial coverage reported as an answer is worse than a rebuild.
`unreal_symbol LpGameModeBase` finds `ALpGameModeBase` (the UE prefix is added for you), and
`unreal_symbol FLpMovementDirectionThresholds:F` finds a single-letter `UPROPERTY` field.
