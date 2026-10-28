---
description: Ground the task in verified Unreal Engine facts before touching anything
argument-hint: "[project path] [task]"
---

Task: ${@:-inspect the project}

Before any edit, build, or engine-version claim, establish the facts with the Unreal tools
(do not infer from directory names, `UNREAL_ENGINE`, or memory):

1. `unreal_resolve_engine` on ${1:-the project in this workspace} — engine root, `Build.version`
   and its path, installed-vs-source, association kind. If the status is `ambiguous` or
   `unresolved`, report every candidate and stop; do not pick a root silently.
2. `unreal_project_inspect` — modules with `Type`/`LoadingPhase`, plugin references and where
   each one resolves (Engine / Project / Mod / External), JSONC diagnostics, `TargetPlatforms`,
   `AdditionalPluginDirectories`.
3. For a plugin-centric task, `unreal_plugin_inspect` on the plugin name or `.uplugin` path.
4. Before writing or editing C++ that names engine types, ground the names — do not type an
   include from memory:
   - `unreal_index` with `action: "headers"` and `name: "ThatHeader.h"` answers *does this file
     exist in this engine version*, with the owning plugin, its `EnabledByDefault`, and whether the
     `.uproject` references it. An invented name must be caught here, not written into an `#include`.
   - `unreal_symbol` with `scope: "engine"` (add `engineAreas: ["Plugins"]` for plugins the project
     does not reference) confirms the type and its module. A 0 answer names the roots it scanned —
     it is not "the engine has no such type".
   - `unreal_context` with `module: "X"` says whether X is in the target's module graph, which tells
     you whether a `*.Build.cs` needs the dependency at all.

Then state the constraints that follow from those facts:

- the editor must be closed for C++ edits, and the build/verify step is
  `UnrealEngine-BuildProjectEditor`;
- `.uasset` / `.umap` are authored in the editor, never hand-edited;
- `clang-format` must never touch `*.cs` (UBT C#); C++ is formatted with `Script/Dev/Format-Cpp.ps1`.

${2:-Proceed with the task.}
