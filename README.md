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

All three are read-only, idempotent, and accept `project` (file or directory; defaults to the
nearest `.uproject` within 4 levels of the workspace) and `engineRootHint` (disambiguates an
ambiguous association). Each returns `structuredContent` for machine use and a text report for
the model.

### Commands

- `/unreal [project]` — engine resolution + descriptor + plugin-reference report
- `/unreal-engines` — every engine installation this machine can prove, with how it was found
- `/unreal-cache stats|clear` — plugin-index cache inspection (cache dir:
  `$PI_UNREAL_CACHE_DIR` or `~/.pi/agent/unreal-cache`)

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
bun test                      # 41 tests: resolver, descriptors, plugins, cache, gate
bun run typecheck             # tsc --noEmit
bun test/live-check.ts "C:/path/to/Project.uproject"   # live machine smoke
bun test/keys.census.mjs "C:/Program Files/Epic Games/UE_5.8/Engine/Plugins"
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
- v1 is inspection only. `.Build.cs` module graphs, declaration lookup, and `.ini` provenance
  are deliberately out of scope.
