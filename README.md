# pi-unreal

**Unreal Engine awareness for the Pi coding agent.**

Open a UE project in a `pi` session and the agent stops guessing. It knows which engine
installation that `.uproject` really resolves to, what the `.uproject` / `.uplugin` files actually
say, which plugins exist on disk, and where a C++ symbol is declared — with the file, the line and
the owning module. No compiler, no Visual Studio, no Rider, no clangd required.

It is **read-only**: it never writes to your project, never touches the Windows registry, never
launches the editor, and blocks three kinds of edit that damage Unreal work.

## Usage

### Requirements

- **Windows**, with **PowerShell 7** (`pwsh`) for registry-based engine discovery. Without it the
  extension still works: resolution falls back to `UNREAL_ENGINE` / `UE_ROOT` /
  `PI_UNREAL_ENGINE_ROOT`, the Launcher's install list, and a scan of
  `C:/Program Files/Epic Games`.
- An Unreal Engine installation the project can resolve to (Launcher install or source build).
  Descriptor field handling is transcribed from UE 5.8.
- Nothing else. No compiler, no IDE language service. clangd is optional enrichment for
  `compiledb` and the `clangd --check` acceptance step.


### Installation

```bash
pi install npm:@aeonsparx/pi-unreal                              # optionally pin to a specific version, reproducible
pi install git:github.com/Aeonsparx-Interactive/pi-unreal@v1.1   # follows patch releases on the v1.1 line
```

The `npm:` route installs from the registry and pins an exact version. The `git:` route clones the
repository and checks out the ref: a line alias (`@v1.1`) is a moving tag that patch releases
force-move, so `pi` picks up patches on update; pin `@v1.1.0` for a fixed snapshot. Loading straight
from a clone still works and needs no install: `pi -e ./extensions/unreal/index.ts`.

## What you get in a session

**Context is detected for you.** When the session starts in a directory that contains a
`.uproject` — the working directory itself, or any of up to 3 parent directories — one note is
shown before the first answer: the resolved engine root and version, installed vs source build,
the project's modules, the number of declared plugin references, and the conventions below. Ask
for a re-check any time with `/unreal`.

**Ask in plain English.** "Which engine is this project on?", "Is MassGameplay available to this
project?", "Where is `FLpMovementDirectionThresholds` defined?", "What do I need to link to use
`UAnimInstance`?" The agent picks the matching tool:

| Tool | Question it answers |
| --- | --- |
| `unreal_resolve_engine` | "Which engine does this `.uproject` use — and how do you know?" |
| `unreal_project_inspect` | Modules, target platforms, and every plugin reference resolved against the plugins that exist on disk |
| `unreal_plugin_inspect` | One `.uplugin` as the engine parses it: modules, loading phases, version fields, plugin dependencies |
| `unreal_symbol` | "Where is this class / struct / function / `UPROPERTY` / delegate declared?" One line per hit: kind, file:line, module |
| `unreal_symbol_list` | "What does this project define?" Names by prefix — `ULp`, `ANiMy`, `UAnim` |
| `unreal_context` | "What does this file/module include, define, and depend on?" Include paths, dependency lists, the real `WITH_*` defines; for a module, also whether the target's module graph contains it and how the `.uproject` treats its plugin |
| `unreal_index` | Builds and reports the source index, the path-only **header index** ("does this header exist in this engine version?"), and the clangd compile database on request |

**Slash commands you can type yourself:**

| Command | Result |
| --- | --- |
| `/unreal [project]` | Engine, modules and plugin-reference report for this directory |
| `/unreal-engines` | Every engine installation this machine can prove, and how each was found |
| `/unreal-symbol <symbol>` | Definition lookup, project + plugins, then engine if an engine index exists |
| `/unreal-module <Module>` | Module directory, public/private dependency lists, defines file, C++ standard, SDK |
| `/unreal-cache stats\|clear` | Inspect or clear the cached indexes |

Example — `/unreal`:

```text
project  C:/Work/Lp/Lp.uproject
engine: C:/Program Files/Epic Games/UE_5.8
  version 5.8.3 | installed build | association "5.8" (version) via dir-scan
  Build.version: C:/Program Files/Epic Games/UE_5.8/Engine/Build/Build.version
modules: Lp (Runtime), LpEditor (Editor)
plugins declared: 25
plugin index: 897 .uplugin (cache hit)
plugin references:
  Mover: resolved ← Engine · modules Mover(Runtime), MoverCVDData(Runtime), MoverEditor(UncookedOnly)
  MassGameplay: resolved ← Engine · modules MassEntity(Runtime), MassCore(Runtime), MassSimulation(Runtime), …
  SomeLocalPlugin: resolved ← Project · modules SomeLocalPlugin(Runtime)
  RetiredPlugin: missing
  totals: 22 resolved, 3 missing of 25 references
  engine plugins available with NO .uproject reference (EnabledByDefault true): GameplayCameras, IKRig
```

Example — `unreal_symbol` for an engine type (engine index already built):

```text
unreal_symbol 'AActor' scope=engine: 1 definition(s)
  class AActor  C:/Program Files/Epic Games/UE_5.8/Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h:282  [Engine · engine]
```

That is a definition line, not a grep dump: grepping a hot engine class name returns ~176 files of
noise, which is exactly what burns a session's context.

Example — `unreal_index` `action: "headers"`, the question a symbol index cannot answer:

```text
unreal_index headers → hdr-UE_5.8-1a40c1c3d516
  37,788 header paths from 1,934 roots (1,655 engine-plugin root(s), 279 engine-source root(s))
  'MoverState.h': does NOT exist as a file path in this engine version
  closest real file names (files, not types):
    Engine/Plugins/Experimental/Mover/Source/Mover/Public/MoverTypes.h   [Mover]
    Engine/Plugins/Experimental/Mover/Source/Mover/Public/MoverSimulationTypes.h   [Mover]
    Engine/Plugins/Experimental/Mover/Source/Mover/Public/MovementMode.h   [Mover]
    Engine/Plugins/Experimental/Mover/Source/Mover/Public/MovementModeStateMachine.h   [Mover]
```

`MoverState.h` is the kind of name an agent invents. The answer says it is not a file, lists real
files, and never presents a file name as a type. The same call on
`PhysicsControlComponent.h` returns the path plus `plugin PhysicsControl [Engine] · EnabledByDefault
false · .uproject reference NO` — the file exists, the project does not reference the plugin, and
those are different facts.

Example — the coverage lines a 0-row answer prints (nothing here says "the engine has no such type"):

```text
unreal_symbol 'PhysicsControlComponent' scope=engine: 0 definition(s)
  · no definitions matched 'PhysicsControlComponent' in scope 'engine'
  · scanned engine index idx-engine-defs-b8d82464af4a: 279 engine-source root(s), 62 engine-plugin root(s)
  · engine plugins on disk: 897, referenced by this .uproject: 25; the engine index scans referenced plugins only
  · a plugin the project does not reference is not in any index root: pass engineAreas ["Plugins"] (…2.8× the Runtime scan) or ["Plugins/Animation/PhysicsControl"]
  · next: unreal_symbol query 'PhysicsControlComponent' scope "all" prefix true, or unreal_index action "headers" name "PhysicsControlComponent.h"
```

## Guardrails (automatic, nothing to enable)

| Situation | What happens |
| --- | --- |
| An edit targeting `*.uasset` / `*.umap` | **Blocked** — those are cooked binary assets; author them in the running editor |
| A C++ edit while `UnrealEditor` is running | **Warning** — freshly compiled C++ will not load into a running editor; close it, then build |
| `clang-format` aimed at a `*.cs` file | **Blocked** — clang-format applies the C# rule and can empty the file |

## Costs: what is fast, and what is opt-in

| Operation | Time |
| --- | --- |
| Cached lookup (symbol, project facts) | ~0.3 s |
| First project/plugin index (≈2,400 files) | seconds |
| Engine `Runtime` index — cold | ~1 minute |
| Engine `Runtime` index — warm | ~6 s |
| UnrealBuildTool Query facts | ~7 s, then cached |
| clangd compile database (`unreal_index` → `compiledb`) | minutes, ~1 GB for the engine scope |

Because of that model:

- Symbol lookups never stall. If a question needs engine sources and no engine index exists, the
  agent reports the cost and how to pay it, and asks you. Say **yes** once per machine —
  `/unreal-cache stats` shows what you have. Engine scans default to `engineAreas: ["Runtime"]`,
  which is the engine's **own** gameplay code (`AActor`, `UAnimInstance`, `USceneComponent`);
  `Editor` and `Developer` are opt-in and roughly triple the scan. An engine-scope index always
  includes the plugin roots your `.uproject` enables, so `UMoverComponent` and the PoseSearch types
  are in it. Types shipped by plugins you do **not** reference (`PhysicsControl`, `BlendStack`,
  `StateTree`, `GameplayAbilities`) need `engineAreas: ["Plugins"]` — every `Engine/Plugins`
  source tree, ~2.8× the `Runtime` scan — or `engineAreas: ["Plugins/Animation/PhysicsControl"]`
  for one plugin.
- "Does this header exist in this engine version?" is a path question, not a symbol question:
  `unreal_index` with `action: "headers"` (and `name: "MoverState.h"`) answers it in seconds from a
  path walk, and says which plugin owns a header it finds, whether that plugin is
  `EnabledByDefault`, and whether your `.uproject` references it. Invented names come back as
  *not a file path* plus the closest real **file** names — never as types.
- Ask for `unreal_index` with `action: "build"`, `scope: "engine"` when you want engine-wide
  navigation, and `action: "compiledb"` when you want clangd's references/call hierarchy.
- After a branch switch, a rebase, adding a plugin, or an engine version change, say "rebuild the
  Unreal index" (that is `refresh: true`).
- Everything lives in `~/.pi/agent/unreal-cache` (override with `$PI_UNREAL_CACHE_DIR`) — never
  inside your project tree or your engine installation. The compile database encodes this
  machine's absolute paths, so it is machine-local by design.

## Troubleshooting

| Report | What to do |
| --- | --- |
| `engine: AMBIGUOUS — more than one valid installation matches` | Two roots match the association. Pass the one you want as `engineRootHint` (e.g. `engineRootHint: "C:/Program Files/Epic Games/UE_5.8"`). |
| `engine: UNRESOLVED` with rejected candidates | Read the reasons — a stale registry key, a missing `Build.version`, a version mismatch. The report lists remediation steps; the extension never writes registry keys for you. |
| `no .uproject within 4 levels above …` | The search walks up from the working directory. Pass the project explicitly: `project: "C:/Work/Lp/Lp.uproject"` (a directory containing one works too). |
| `unreal_symbol` finds nothing in scope `engine` | Read the coverage lines the answer prints: they name the root kinds that were scanned. A plugin your `.uproject` does not reference is in no index root — `engineAreas: ["Plugins"]` (or one plugin subtree), then rebuild. |
| `unreal_symbol` finds nothing and you are not sure the name exists | `unreal_index` → `action: "headers"`, `name: "ThatName.h"`: a seconds-long path answer with the closest real file names. |
| Results look stale after a rebase or engine update | Re-run with `refresh: true`, or `/unreal-cache clear`. |
| `no plugin named "X" in the index` | That reference is genuinely not on disk. `/unreal` shows which roots were scanned. |

### What it deliberately does not do

- It does not install, register, migrate, or "fix" an engine, and never writes registry keys.
- It does not build, cook, package, launch the editor, or edit `.ini` files.
- It does not hand-edit assets, and blocks attempts to.
- Symbol lookup reports **declarations**. Type resolution, overloads, call sites, inheritance and
  diagnostics are clangd's job when clangd is installed. An empty clangd answer is evidence: on an
  installed engine the compile database has no engine translation units, so "clangd found nothing"
  in engine code is a property of the setup, not a bug this package fixes.
- A 0-row answer is a statement about **the roots that were scanned**, never about the engine. The
  answer names its index keys and root kinds; `unreal_index` → `action: "status"` prints the same.
- pi-unreal answers C++ **declaration, module, include-path and dependency** facts. It does not
  answer asset questions — UENUM index order, UStruct field types, UCLASS/CDO instance values,
  Blueprint graphs. Those need the `unreal-engine` editor MCP with the editor running.
- `.ini` provenance, live-coding state, and asset metadata are out of scope for v1.
