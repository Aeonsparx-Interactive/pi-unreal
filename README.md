# pi-unreal

**Unreal Engine awareness for the Pi coding agent.**

Open a UE project in a `pi` session and the agent stops guessing. It knows which engine
installation that `.uproject` really resolves to, what the `.uproject` / `.uplugin` files actually
say, which plugins exist on disk, and where a C++ symbol is declared — with the file, the line and
the owning module. No compiler, no Visual Studio, no Rider, no clangd required.

It is **read-only**: it never writes to your project, never touches the Windows registry, never
launches the editor, and blocks three kinds of edit that damage Unreal work.

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
| `unreal_context` | "What does this file/module include, define, and depend on?" Include paths, dependency lists, the real `WITH_*` defines |
| `unreal_index` | Builds and reports the source index, and the clangd compile database on request |

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
  MassGameplay: resolved ← Engine
  ModularGameplay: resolved ← Engine
  SomeLocalPlugin: resolved ← Project
  RetiredPlugin: missing
  totals: 22 resolved, 3 missing of 25 references
```

Example — `unreal_symbol` for an engine type (engine index already built):

```text
unreal_symbol 'AActor' scope=engine: 1 definition(s)
  class AActor  C:/Program Files/Epic Games/UE_5.8/Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h:282  [Engine · engine]
```

That is a definition line, not a grep dump: grepping a hot engine class name returns ~176 files of
noise, which is exactly what burns a session's context.

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
  which is enough for gameplay base classes (`AActor`, `UAnimInstance`, `USceneComponent`);
  `Editor` and `Developer` are opt-in and roughly triple the scan.
- Ask for `unreal_index` with `action: "build"`, `scope: "engine"` when you want engine-wide
  navigation, and `action: "compiledb"` when you want clangd's references/call hierarchy.
- After a branch switch, a rebase, adding a plugin, or an engine version change, say "rebuild the
  Unreal index" (that is `refresh: true`).
- Everything lives in `~/.pi/agent/unreal-cache` (override with `$PI_UNREAL_CACHE_DIR`) — never
  inside your project tree or your engine installation. The compile database encodes this
  machine's absolute paths, so it is machine-local by design.

## Requirements

- **Windows**, with **PowerShell 7** (`pwsh`) for registry-based engine discovery. Without it the
  extension still works: resolution falls back to `UNREAL_ENGINE` / `UE_ROOT` /
  `PI_UNREAL_ENGINE_ROOT`, the Launcher's install list, and a scan of
  `C:/Program Files/Epic Games`.
- An Unreal Engine installation the project can resolve to (Launcher install or source build).
  Descriptor field handling is transcribed from UE 5.8.
- Nothing else. No compiler, no IDE language service. clangd is optional enrichment for
  `compiledb` and the `clangd --check` acceptance step.

## Troubleshooting

| Report | What to do |
| --- | --- |
| `engine: AMBIGUOUS — more than one valid installation matches` | Two roots match the association. Pass the one you want as `engineRootHint` (e.g. `engineRootHint: "C:/Program Files/Epic Games/UE_5.8"`). |
| `engine: UNRESOLVED` with rejected candidates | Read the reasons — a stale registry key, a missing `Build.version`, a version mismatch. The report lists remediation steps; the extension never writes registry keys for you. |
| `no .uproject within 4 levels above …` | The search walks up from the working directory. Pass the project explicitly: `project: "C:/Work/Lp/Lp.uproject"` (a directory containing one works too). |
| `unreal_symbol` finds nothing in scope `engine` | Build the engine index first (`unreal_index` → `action: "build"`, `scope: "engine"`). |
| Results look stale after a rebase or engine update | Re-run with `refresh: true`, or `/unreal-cache clear`. |
| `no plugin named "X" in the index` | That reference is genuinely not on disk. `/unreal` shows which roots were scanned. |

## What it deliberately does not do

- It does not install, register, migrate, or "fix" an engine, and never writes registry keys.
- It does not build, cook, package, launch the editor, or edit `.ini` files.
- It does not hand-edit assets, and blocks attempts to.
- Symbol lookup reports **declarations**. Type resolution, overloads, call sites, inheritance and
  diagnostics are clangd's job when clangd is installed.
- `.ini` provenance, live-coding state, and asset metadata are out of scope for v1.

## Install

Published as **`@aeonsparx/pi-unreal`** on npmjs.

```bash
pi install npm:@aeonsparx/pi-unreal@1.0.0                        # pinned version, reproducible
pi install git:github.com/Aeonsparx-Interactive/pi-unreal@v1.0   # follows patch releases on the v1.0 line
```

The `npm:` route installs from the registry and pins an exact version. The `git:` route clones the
repository and checks out the ref: a line alias (`@v1.0`) is a moving tag that patch releases
force-move, so `pi` picks up patches on update; pin `@v1.0.2` for a fixed snapshot. Loading straight
from a clone still works and needs no install: `pi -e ./extensions/unreal/index.ts`.

## Releasing (maintainers)

| `package.json` bump | GitHub Release | npmjs |
| --- | --- | --- |
| `major` / `minor` | **new** release `v<major>.<minor>` | staged `<major>.<minor>.<patch>` |
| `patch` | **updates** the existing `v<major>.<minor>` release | staged `<major>.<minor>.<patch>` |

Merge a PR that bumps `version` into `master`. `.github/workflows/release.yml` runs `bun test` on
Linux and Windows, pushes the immutable tag `v<major>.<minor>.<patch>`, moves the `v<major>.<minor>`
alias, creates or updates that release, then stages the tarball with `npm stage publish`. **Nothing
is public until a human approves it** (2FA, from any machine):

```bash
npm stage list @aeonsparx/pi-unreal     # stage ids (no 2FA)
npm stage view <stage-id>              # metadata
npm stage download <stage-id>          # inspect the exact tarball that will publish
npm stage approve <stage-id>           # 2FA - this is the publish act
npm stage reject <stage-id>            # 2FA - frees the staged version number
```

The same queue is on npmjs.com (Staged Packages tab). `npm stage` requires npm >= 11.15.0
(`npm install -g npm@12`) and Node >= 22.14.0. `NPM_TOKEN` (repository secret) is a Granular Access
Token with Read+Write and **no** 2FA bypass: CI can stage, only you can publish. Staged versions
occupy their version number, so a rejected stage burns `x.y.z` until `npm stage reject` frees it.
Provenance is deliberately off in v1 (`--provenance` needs a Provenance-scope token, and the
attestation path through stage-then-approve is unverified).

## Developers

```bash
bun test                      # 64 tests: resolver, descriptors, plugins, cache, gate, scanner, index, compile-db pipeline
bun run typecheck             # tsc --noEmit
bun test/live-check.ts "C:/path/to/Project.uproject"   # live machine smoke
bun test/keys.census.mjs "C:/Program Files/Epic Games/UE_5.8/Engine/Plugins"
bun run tmp/smoke.mjs project "C:/path/to/Project"     # symbol index against a real project
bun run tmp/smoke.mjs query "C:/path/to/Project"       # UnrealBuildTool Query round trip
bun run tmp/smoke.mjs engine "C:/path/to/Project"      # Engine/Source index (minutes, opt-in)
bun run tmp/smoke.mjs compiledb "C:/path/to/Project"   # clangd database + `clangd --check` acceptance
```

From a clone, load the extension into a session without installing it:

```bash
pi -e ./extensions/unreal/index.ts
```

Layout: `extensions/unreal/index.ts` (tools, commands, context card, convention gate),
`extensions/unreal/lib/` (resolver, descriptors, plugin index, symbol index, UBT Query, compile
database), `prompts/unreal-context.md`, `skills/ue-engine-resolution/`, `test/`.

Design notes and measured internals — engine resolution algorithm, descriptor fidelity, plugin
discovery, the index and compile-database pipeline — are in [docs/internals.md](docs/internals.md).
