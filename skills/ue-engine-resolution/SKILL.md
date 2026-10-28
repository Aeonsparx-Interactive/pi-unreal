---
name: ue-engine-resolution
description: Resolve which Unreal Engine installation a .uproject actually uses, and read .uproject/.uplugin facts from engine-authored schemas. Use when an engine path, version, plugin availability, or descriptor field must be established as fact, before UE builds, plugin edits, or any "which engine version is this?" question.
compatibility: Windows-first (registry via pwsh); resolver core is platform-neutral.
---

# Unreal Engine resolution

Never infer an engine root from a directory name, a `UE_*` folder, or an environment variable alone.
Resolve it, then quote the resolved value.

## Order of truth

1. Run `unreal_resolve_engine` (or `/unreal`) first. It reports `engineRoot`, `identifier`,
   `Build.version`, source rank, and — on failure — the rejected candidates with reasons.
2. Only after a resolution exists should a build command, a `.Build.cs` read, or an
   engine-source lookup name a concrete engine path.

Resolution mirrors the engine's own algorithm
(`Engine/Source/Developer/DesktopPlatform/Private/DesktopPlatformBase.cpp:459-511`, UE 5.8):

| Association in `.uproject` | Meaning | Engine source of truth |
| --- | --- | --- |
| `5.8` | installed (Launcher) build | `HKLM:\SOFTWARE\EpicGames\Unreal Engine\5.8` → `InstalledDirectory`, plus `<installDirDefault>\UE_5.8` |
| `{GUID}` | source build | `HKCU:\SOFTWARE\Epic Games\Unreal Engine\Builds` → root path |
| engine-root **path** | explicit pin, bypasses registration | validated as `<root>/Engine/Binaries` + `<root>/Engine/Build` |
| **empty** | project is inside an engine tree | walk up 12 levels for `Engine/Config/BaseEngine.ini` |

An association that matches more than one valid root is reported **ambiguous** — the engine
refuses to pick, so neither should the agent. Pass `engineRootHint` to disambiguate.

## Machine-local facts that are not inferable

- `HKLM` registers UE 4.0 … 5.7. **UE 5.8 has no registry key**: it is found by scanning
  `C:/Program Files/Epic Games` for `UE_*`, or by `$env:UNREAL_ENGINE`, which points at it.
- 5.5 and 5.6 registry entries point at directories that do not exist. A registry hit is a
  **candidate**, never a conclusion — every candidate is validated
  (`Engine/Binaries` + `Engine/Build` + `Engine/Build/Build.version` major.minor match)
  before it can be reported.
- `D:/UnrealEngine/Source` is a source build (5.7.4) registered under a GUID in `HKCU`.

## Descriptor fields: read them from the parser, not from memory

Field names, host types, and loading phases come from the engine's own serializers, not from
blog posts. `unreal_project_inspect` / `unreal_plugin_inspect` report the engine's names:

- `.uproject` → `Engine/Source/Runtime/Projects/Private/ProjectDescriptor.cpp:100-225`
- `.uplugin` → `Engine/Source/Runtime/Projects/Private/PluginDescriptor.cpp:263-409`
- module entries → `Engine/Source/Runtime/Projects/Private/ModuleDescriptor.cpp`
  (`Type` is **required**; `EHostType::FromString` → `Max` → descriptor load fails)
- plugin references → `Engine/Source/Runtime/Projects/Private/PluginReferenceDescriptor.cpp:130-180`
  (`Enabled` is **required**; a reference without it is rejected)

Host types (`EHostType::ToString`) and phases (`ELoadingPhase`) are enumerated by the parser;
an unrecognized value is reported with the engine's own failure text. Do not "fix" a descriptor
by inventing a key name — fix it to the key the engine reads.

`.uplugin` has **no** `Enabled` key. Enablement is `EnabledByDefault`
(`PluginManager.cpp:421-431`) plus the project's `"Enabled": true` reference.

## Plugin availability

`unreal_project_inspect` resolves every reference against an index built in
UnrealBuildTool's discovery order (`Engine/Source/Programs/UnrealBuildTool/System/Plugins.cs:322`):
Engine → Project (`Plugins/`) → Mod (`Mods/`) → `AdditionalPluginDirectories`, with later scans
shadowing earlier ones on name collision. Use the reported status (`resolved`, `missing`,
`disabled`, `version-warning`, `shadowed`, `no-modules`) instead of assuming a plugin is
available. `Binaries/`, `Intermediate/`, `Saved/`, and `ThirdParty/` are never scanned.

Two facts are separate and both matter, and the report keeps them apart:

- **Reference status**: `Mover: resolved ← Engine · modules Mover(Runtime), MoverCVDData(Runtime),
  MoverEditor(UncookedOnly)`. The modules are what the reference buys; "resolved" alone never said
  which C++ exists.
- **Availability without a reference**: engine plugins with `EnabledByDefault: true` load even when
  the `.uproject` does not list them, and a module can be inside the target's link graph without the
  plugin being referenced. `unreal_context` with `module: "PhysicsControl"` reports the graph check,
  the module directory, the declared `Type`, and the `.uproject` status as separate lines — "the
  project lacks plugin X" is not "module X is unavailable", and not "X does not exist".

## After resolution: where declarations and build context come from

`unreal_resolve_engine` answers *which engine*. The rest of the navigation questions are answered
by the index tools, and they use the resolved root — a wrong engine root means a wrong index:

- `unreal_symbol` — declaration site + owning module for a type, function, `UPROPERTY`, delegate.
  Engine scope is opt-in (`scope: "engine"`). Its roots are `Engine/Source/<area>` **plus the plugin
  roots the `.uproject` enables** — in an installed engine most gameplay types ship as plugins
  (`Mover`, `PoseSearch`, `SmartObjects`, `BlendStack`, `StateTree`, `GameplayAbilities`), so an
  index of `Engine/Source/Runtime` alone reports 0 rows for `UMoverComponent`. Plugins the project
  does not reference are opt-in too: `engineAreas: ["Plugins"]` (every `Engine/Plugins` source,
  ~2.8× the `Runtime` scan) or `engineAreas: ["Plugins/Animation/PhysicsControl"]` (one plugin).
- **A 0-row answer is about the roots scanned, not about the engine.** It prints the index keys, the
  root kinds (`279 engine-source root(s), 62 engine-plugin root(s)`) and the next call. Run
  `unreal_index` with `action: "status"` before trusting a 0: an index key encodes its root set, so
  an index you did not build is not what was searched.
- `unreal_index` with `action: "headers"` — "does this header exist in this engine version?" A
  path-only index (no content read, seconds, ~38 000 header paths on a UE 5.8 install): exact path,
  owning module, owning plugin, `EnabledByDefault`, `.uproject` reference. Invented names return
  *not a file path* plus the closest real **file** names — a file name is not a type, and a token
  match is not proof of existence. Never built implicitly.
- `unreal_context` — include paths, C++ standard, compiler, the real `WITH_*` defines read from
  `Definitions.<Module>.h`, and the module's public/private dependency lists. Scope is derived from
  path shape, so `Engine/Plugins/.../Public/X.h` is searched as engine scope, and a miss answers the
  path question separately from the symbol question.
- `unreal_index` — build/refresh/patch/status, `moduleRefs` for the dependency graph, and the
  UnrealBuildTool `-Mode=Query` cache underneath.

No compiler, no IDE database, nothing written inside the project: the index lives in
`~/.pi/agent/unreal-cache` (`$PI_UNREAL_CACHE_DIR`). clangd stays the authority for references,
overrides, and diagnostics — see `ue-symbol-navigation` in a UE project's `.agents/skills/`. An
empty clangd answer is **evidence**: on an installed engine the compile database has no engine
translation units, so "clangd found nothing in engine code" describes the setup, not a defect to
route around.

The boundary this package does not cross: it answers C++ **declaration, module, include-path and
dependency** facts. Asset questions — UENUM index order, UStruct field types, UCLASS/CDO instance
values, component lists, parent chains, Blueprint graphs — need the `unreal-engine` editor MCP with
the editor running. A C++ scan cannot see them; ask a scan only what a scan can answer.

## Conventions this package enforces

- `.uasset` and `.umap` are cooked binary — author them in the running editor, never by editing
  bytes. The gate blocks such writes.
- Newly compiled C++ does not load into a running editor: close the editor, then build with
  `UnrealEngine-BuildProjectEditor`. The gate warns when `UnrealEditor*` is running during a C++ edit.
- Never run `clang-format` on `*.cs`: it applies the C# language rule and can empty the file
  (verified on `Source/Lp.Target.cs`). The gate blocks such commands. Format C++ with
  `Script/Dev/Format-Cpp.ps1`.
