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

Then state the constraints that follow from those facts:

- the editor must be closed for C++ edits, and the build/verify step is
  `UnrealEngine-BuildProjectEditor`;
- `.uasset` / `.umap` are authored in the editor, never hand-edited;
- `clang-format` must never touch `*.cs` (UBT C#); C++ is formatted with `Script/Dev/Format-Cpp.ps1`.

${2:-Proceed with the task.}
