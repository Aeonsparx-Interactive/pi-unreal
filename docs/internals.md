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
   engine's own code, and plugin-shipped types live under `Engine/Plugins/<Category>/<Plugin>/Source/`.
   Since 1.2 an engine-scope index covers **engine roots only** (`Engine/Source/<area>`, plus the
   `engineAreas: ["Plugins"]` dial); plugin-shipped types reach an engine-scope answer through the
   **project** index, which is unioned in — see *Engine scope is engine-only* below.

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

Measured on this box (UE 5.8.3 installed engine; Lp project with 28 enabled plugin references).
Counts move when the **scanner** changes, not when the codebase does: the 1.2 numbers
(50,440 project / 437,614 engine symbols) were produced before the 1.3 precision pass, which drops
local declarations (`FScopeLock Lock(&Cs);` was being recorded as a function named `Lock`) and adds
destructors (1,959 in the engine index, 148 in the project index, previously zero). Treat any figure
here as a measurement with a version attached, and read the live one from
`unreal_index action: "status"`.

| Scope | Files | Definitions | Cold build |
| --- | --- | --- | --- |
| Project + enabled plugins (format v7, `source: "ubt"`) | 3,264 | 48,645 | 20.5 s cold, 0.15 s per patched file |
| Engine `Runtime` (default: 279 module roots, format v7) | 18,566 | 420,603 | 112.8 s cold on a cold file cache, 0.3-0.6 s warm |
| Engine `Runtime` + every `Engine/Plugins` source (1.1 engine key) | 71,004 | 1,240,246 | ~2 min cold (1,996 roots: 279 engine-source + 1,717 engine-plugin) |
| Engine `Runtime/Core` + `Runtime/CoreUObject` | 3,094 | 70,548 | 16 s |
| Header index (paths only, engine `Runtime` + all `Engine/Plugins`) | 37,788 headers | — | 4.5 s cold, 0.5 s warm |
| Cached lookup (includes the freshness re-stat, memoized 10 s) | — | — | 0.3 s project, 0.3-0.6 s engine |

Cost discipline is the design. A lookup builds the project index (seconds) and uses an engine
index only if one exists; `scope: "engine"` on a cold machine returns
`engine index not built — build it with unreal_index (action: "build", scope: "engine")` instead of
spending minutes on a scan nobody asked for. `unreal_index` is the explicit, paid path.

Ranking inside `unreal_symbol`: exact (0) → prefix or UE-prefix convention letter (1) → qualified
member fallback (2) → substring (3); a forward declaration adds 1, so it never outranks the real
declaration.
Forward declarations rank last, so `unreal_symbol AActor` returns
`Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h:282` (the `UCLASS` declaration), not
the `class AActor;` line in `PhysicsCollision.h`.
`unreal_symbol LpGameModeBase` finds `ALpGameModeBase` (the UE prefix is added for you); `unreal_symbol FLpMovementDirectionThresholds:F` finds a single-letter `UPROPERTY` field; `unreal_context LpCharacterTypes.h` resolves a bare file name through the index.

Engine areas are derived from module dependencies (`.uproject` modules → recursive
`PublicDependencyModuleNames` → plugin-supplied modules → recursive `PublicDependencyModuleNames` →
`Engine/Source/<area>/*`), so the index contains what this project can compile against, not the
whole engine.

### Freshness: a reused index is checked, then patched (`action: "patch"`)

Key equality only says *what* was scanned, never *whether it still matches the tree*. Between two
sessions the project gets edited, and a cached index that keeps answering with the old line numbers is
the worst failure mode this package can have: the file and symbol are right, the line is wrong, and
nothing in the answer looks stale.

So a reused index is verified before it is trusted:

1. `files.tsv` carries a per-file `mtimeMs` (format v7) and `meta.json` carries `rootsState` (one
   mtime per scan root) plus `freshness.newestMtimeMs`.
2. `indexFreshness(index)` stats every indexed file (`|current - recorded| > 1 ms` counts as edited,
   `ENOENT` as deleted) and re-stats the roots. Cost: ~250 ms for the 18.5 k-file engine index,
   memoized for `FRESHNESS_TTL_MS = 10_000` so a burst of lookups pays once.
3. `keepCurrent` (in `ensureIndex`) patches `changed + missing` through `patchIndex` — re-scan those
   files, replace their rows, restamp their `files.tsv` rows, rewrite `meta.counts` — when the set is
   at most `AUTO_PATCH_LIMIT = 200` files. Measured: 150 ms for one edited `.cpp` in the 3.3 k-file
   project index. The note is one sentence covering both the finding and the repair, because "line
   numbers are wrong" printed immediately after fixing them reads as an unfixed warning.
4. Past the limit, or when only the *roots* moved (a module or directory added — a patch cannot
   express that), the lookup warns and hands the rebuild to `unreal_index action: "build" refresh:
   true`.
5. An index in an older format has no mtime column: `indexFreshness` returns `supported: false` and
   the answer says staleness cannot be checked rather than implying it was.

`action: "patch"` is the explicit form of the same machinery: no `files` patches whatever the
freshness diff finds, an explicit `files` list patches exactly those (the case a mtime cannot express
— a build tool that rewrites timestamps without changing content). `status` prints the same numbers
(`freshness: N edited / M deleted of K checked`) so the cost of a lookup is visible before it runs.

### Engine scope is engine-only (1.2): the union does the plugin work

An **engine-scope** index is `Engine/Source/<area>` roots and, when dialed, `Engine/Plugins` trees.
It no longer contains the project's enabled plugin roots, and its **key is
`(engineRoot, engineAreas)`** — not the root list. A lookup with `scope: "engine"` or `"all"` unions
the project index (which is where `Mover`, `PoseSearch`, `SmartObjects`, `BlendStack`, `StateTree`,
`GameplayAbilities` live, because the `.uproject` enables them) with the engine index, and prints
which index produced the answer. Two field findings drove this:

- `UMoverComponent` in scope `engine` returned **0 rows** on a machine with no engine index, while
  the project index held 105 rows for `MoverInputCmdContext` — a "not in engine" conclusion built on
  an index that was never searched. `ensureIndex` is unchanged (a minutes-scale scan is still never
  implicit); `scopeIndexes` asks for the project handle *and* the engine handle.
- In 1.1 the engine key fingerprinted the root list, and for engine scope that list included the
  project's plugin roots. Adding 8 plugin module roots (25 → 28 `.uproject` references) changed the
  key and orphaned `idx-engine-defs-6ee690c3fe45` (251 MB, 1,240,246 symbols, 1,996 roots) and
  `idx-engine-defs-b8d82464af4a` (84 MB, 476,327 symbols): the next lookup computed
  `idx-engine-defs-a4bf1a3cfe72` and missed instantly. The header index has always keyed on engine
  roots alone (`headerKeyFor`, `hdr-UE58-1a40c1c3d516`, 37,788 paths from 1,934 roots) and stayed
  valid across the same edits; 1.2 gives the symbol index the same property. Legacy root-keyed
  engine entries are reported as reclaimable by `action: "status"` and deleted by `action: "prune"`
  (measured on this box: 481 MB of cache, 177 MB of it unreachable — 251 + 84 MB orphaned engine
  scans, 75 MB of v4-format indexes, superseded project entries).

Engine plugins the project does **not** reference are in no root: `engineAreas: ["Plugins"]` adds
every `Engine/Plugins` source tree (~2.8× the `Runtime` scan),
`["Plugins/Animation/PhysicsControl"]` adds one. `scopeForPath` routes a file to a scope, and an
engine-scope file miss falls back to the project index **before** declaring a miss: plugin headers
live there, and a 1725-root engine scan is not the price of answering a plugin question.

Every answer states what it scanned: index key, root kinds (`279 engine-source root(s),
62 engine-plugin root(s)`), and the `engineAreas` it was built with. A 0-row answer is a statement
about those roots, never about the engine, and it prints the exact next call. When an index exists
over a *different* root set, the answer names it as a near miss — `near miss: index <key> covers 279
engine-source root(s) (engineAreas Runtime) — covering 1717 root(s) this call does not scan; reuse
requires the same root set, so this call does not search it` — and `action: "status"` prints the
current root set next to the keys, because "which key did the last lookup search?" was the question
the 2026-10-28 session could not answer.

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

### Ranking the closest file names (`suggestHeaderPaths`)

The 2026-10-28 session probed `MoverState.h` (not a file in 5.8) and got 8 suggestions in which
`AnimationWarpRuntime/Public/AnimWarpStateTypes.h`, `GameplayStateTree/Public/GameplayExternal
Types.h` and `GeometryCore/Internal/InterchangeCubeSurfaceData.h` matched **before** the plugin's own
`Mover/Public/MoverStateTypes.h`. Cause: the score was
`+1 public-header, +1 token overlap, +2 all-tokens`, so the *number of name tokens* decided the
order, and `State`/`Types`/`Table`/`Data` are engine-wide vocabulary.

Ranking is now: same stem `+64` → stem containment `+24` (with the pair named: `stem containment
(moverstate ⊂ moverstatetypes)`) → `+4` per distinctive token → `+16` when the row lives in the
query's plugin family → `+1` public header. A candidate with **no** distinctive token hit is capped
at 2 and labelled `generic name tokens only (state, types) — related to 'moverstate' by name shape,
not a lead`; the family is taken from the query path (`Plugins/<Category>/<Plugin>/Source`) or its
directory leaf (`Mover`), and unrelated-plugin rows are capped at 3. Every row carries its
`reason`, so the answer is auditable: 6 of the 8 `MoverState.h` rows are named `Mover` family
(`MoverState.h`, `MoverStateTypes.h`, `MoverStateTreeSupport.h`, …), the token-only rows sink.

The family is a **heuristic label, not a proof** — `GeometryCore/Internal/InterchangeCubeSurface
Data.h` shares `Data` with `MoverSurfaceData.h` and is a different plugin's internal header. It is
labelled, never deleted.

### The header index as a context fallback

`unreal_context file: "<header>"` on a file no symbol index covers used to dead-end:
the engine-scope early return (`no index available for engine sources`) never reached the header
fallback that exists in the index-exists-but-file-missing branch. Now a miss answers, in order:

1. the header index (`file exists in header index hdr-UE58-1a40c1c3d516 (public-header, module
   PhysicsControl) but is not in any symbol-index root`); the index key, path count, root kinds and
   age are printed because "the index exists" was the question the session kept asking;
2. owning plugin + `EnabledByDefault` + `.uproject` reference as separate facts;
3. module — `PhysicsControl` resolved from the `/Source/<Module>/` path shape, because
   `moduleFromBuildCs` needs a `*.Build.cs` on disk and a file no index has read has never been read;
4. target availability from the **Query cache only** (`in LpEditor module graph: yes (…)`,
   `.uproject reference: NOT referenced`, `EnabledByDefault: true loads at runtime even without a
   .uproject reference`), with its age (`query cache read: TargetDetails 126 KB, 1d old`). A miss
   path never starts the ~7 s-per-section Query;
5. the paid route: `unreal_index action build scope engine engineAreas
   ["Plugins/Runtime/PhysicsControl"]` (the plugin's own sources, not the whole engine), then re-run.

Engine-scope misses try the **project** index first — plugin headers live there, and a 1,725-root
engine scan is not the price of a plugin question.

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
on Lp (UE 5.8.3, installed engine, VS 18 LLVM clangd): UnrealBuildTool 1.5-1.9 s, the **current TU
set of the project scope — 9 entries in 1.9 s** (the 1.0/1.1 snapshot printed 4: two sources had
been deleted and the database had not been regenerated since), 4 response files expanded, 0 switches
dropped; `clangd --check` built a 62 MB preamble and reported **`All checks completed, 0 errors`** in
~2.6 s.

The honest limits of that number: an installed (precompiled) engine contributes no compile actions,
so the database covers the project's own translation units, not `Engine/Source`. Engine files still
work under clangd because the project's `.clangd` supplies the include paths — exactly what Epic's
Unreal-clangd VS Code extension does (its generated `Lp.0.rsp` contains only `/FI` plus 523 `/I`
lines, and `compile_commands.json` there has 6 project entries and no engine entry).
Re-run with `refresh: true` after changing `Build.cs` files, adding modules, or switching engine
version.

### Where the database must land (`installTo`)

Writing a database the session never reads is not an improvement. `ensureCompileDb` puts its output
in `$PI_UNREAL_CACHE_DIR/compiledb/<target>.<platform>.<config>/`; the database the clangd MCP on
this box reads is `<project>/.vscode/unreal-clangd/compile_commands.json`, written by Epic's
Unreal-clangd VS Code extension with `-OutputDir=<project>/.vscode/unreal-clangd` (measured: 999-byte
jsonc file, 5 entries, `--compile-commands-dir=<project>/.vscode/unreal-clangd`, `compilationDatabase
Exists true`, 2,693 files in its background index, clangd 22.1.3). `compiledb installTo:
"<project>/.vscode/unreal-clangd"` copies the normalized database there and prints the exact lines to
merge:

```text
CompileFlags:
  CompilationDatabase: C:/Users/…/Lp/.vscode/unreal-clangd
```

pi-unreal **never writes `.clangd`**: the file carries the developer's flag removals (`/Yu* /Fm* /FI*
/Fp*`) and clang-cl forcing, and the Unreal-clangd extension owns `.vscode/settings.json`. The
answer prints the snippet and leaves the merge to the developer.

### clangd health (`unreal_index` action `clangd`)

The compiler-free probe for "is the clangd on this box usable?", because the MCP payload cannot
answer it. `get_diagnostics` returned `published: 0` with all-zero counts for
`Source/Lp/Private/Lp.cpp` — a file that HAS a compile command in the database — and for a file with
no command: identical payloads. `published: 0` does not distinguish "looked, found nothing" from
"never looked". The probe prints what is observable:

| Line | Field meaning |
| --- | --- |
| `clangd searches: <dirs>` | the `CompilationDatabase:` setting parsed from `.clangd`, plus Epic's `.vscode/unreal-clangd` and the Intermediate UBT directories |
| `live database <path>: N entries, covers X/Y translation units of the project scope on disk` | entries measured against the TU set the scope generates — the "is clangd blind?" line |
| `N current TU(s) have NO compile command: LpMoverPawn.cpp [Lp], …` | the root cause of a diagnostics answer that is empty for a real file |
| `N entries name a file that no longer exists on disk (…DeletedPawn.cpp)` | why `find_references` reports ghost hits — on this box the database was written 2026-10-19, the sources were reorganized 2026-10-21, and clangd's warm `.idx` is newest 2026-10-20 |
| `diagnosis: compileCommands_Lp.0.rsp (0.0 days, 523 lines) are NEWER than the compile database (9.x days): the include paths are current, the file list is not` | separates "include paths are fine" from "file list is stale" — the measured 5-of-7 / 4-deleted state, so "3 of 6" is corrected by measurement, not quoted |
| `file <x>: compile command in the database clangd reads → found\|none` | the per-file gate, for the comparison experiment |
| `publishObserved: published:0 cannot distinguish …` | the honesty line: pi-unreal cannot observe what the MCP published |
| `no link check: a clean clangd --check proves this file parses with these flags … UnrealEngine-BuildProjectEditor is the link check` | the AGENTS.md pointer |

Measured on this box: **3 of 7** project translation units had a compile command in the database
clangd reads; the 9-entry regeneration covers the current set. `unreal_index action "status"` prints
the same coverage line cheaply (the probe is the file-level detail).

## Cache reclaim (`unreal_index` action `prune`) and bounded call sites (`callsites`)

Cache growth was the 2026-10-28 finding: 481 MB in `~/.pi/agent/unreal-cache`, 177 MB of it (37 %)
unreachable. `status` now reports an `index cache: N MB live, M MB reclaimable (K entry(ies))` line,
labels every reclaimable entry with a reason (`superseded (… roots)`, `keyed by its root set`,
`format v<N>, current v7`, `root no longer present: <path>`, `project root has no .uproject: <path>`),
prints the root set current lookups ask for and names orphaned keys with the key the next lookup
computes. `prune` deletes exactly the entries `status` marks reclaimable — index and header
directories only, never `query/`, `compiledb/` or the plugin cache, and `prune compileDb: true` is
required to touch those. Measured: 177 MB returned from the five dead entries; the audit is
idempotent (a second `prune` finds nothing).

**Unused, not just unreachable.** Reachability alone keeps an index forever: a key is "live" as long
as the tree it was built from still exists, and a 135 MB cache on this box carried a second project
index nothing had asked for in 12 days. Every reuse path now writes a `.used` marker in the index
directory (`markIndexUsed`), `status` reports `lastUsedMs` per entry and warns past 30 days, and
`prune olderThanDays: 30` deletes healthy-but-unselected indexes. That is a separate opt-in from the
reclaimable sweep: bytes are cheap to rebuild, a wrong line number is not, but 135 MB of never-opened
indexes is not evidence of anything either.

`callsites` is the deliberate exception to "declarations only", and it is bounded and labelled. The
field session needed `ALpMoverPawn::ProduceInput` callers; the compile database has no engine TUs and
the clangd index is stale, so `find_implementations` returned 2 rows, 4 engine-header overrides, and
zero `Lp` implementers. `callsites` reads text **only** in the scope the question is about: a module's
`.cpp` tree (`Source/<Module>/Private` for a project module, `engineAreas:
["Plugins/Animation/Mover"]` for a plugin, `scope: "all"` for the project ∪ plugin roots it enables),
suffix-matching the owner (so `"ProduceInput"` matches `IMoverInputProducerInterface.h`, not a
`ProduceInput_Implementation` method in an unrelated plugin), with a per-file cap and a hard module
list — never a whole-engine grep. Its rows are `candidate` lines (declaration / implementer
declaration / definition / token mention), each with `match` + `via` naming the kind, and
`isCallEdge: false`: a text match is not a call edge, and `FindTestVisibilityComponent`-style
false positives are expected and labelled. clangd `find_call_hierarchy` remains the authority the
moment a current compile database exists.

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
  Engine-scope indexes cover the engine's own sources plus the `engineAreas` dial of
  `Engine/Plugins` trees only — the plugin roots the `.uproject` enables belong to the **project**
  index, so a `scope: "engine"` or `"all"` answer is the union of both (1.2 changed this: 1.1
  folded project plugin roots into the engine key, which made the key depend on the `.uproject`).
  Plugin-shipped types are opt-in via `engineAreas: ["Plugins"]` (~2.8× the `Runtime` scan) or
  `["Plugins/Animation/PhysicsControl"]` for one plugin. `Editor` and `Developer` are opt-in and
  roughly triple the scan.
- pi-unreal answers C++ **declaration, module, include-path and dependency** facts. It does not
  answer asset questions: UENUM index order (Blueprint enumerators are stored in index order, so
  `4 = OnGround` is an asset fact), UStruct field types, UCLASS/CDO instance values, component
  lists, parent chains, Blueprint graphs or Blueprint authoring conventions. Those need the
  `unreal-engine` editor MCP with the editor running; a C++ scan cannot see them and must not
  pretend to. This is the boundary the tool list encodes: the package name promises UE awareness,
  and "Blueprint awareness" is only ever an edge to C++ (`UFUNCTION`/`UPROPERTY` markers, the
  `_Implementation` thunk rule, `UCLASS` specifiers) — never graph content.
- Index reuse requires the *same root set*: an index built over two modules is never used to answer
  a `Runtime`-wide query. Partial coverage reported as an answer is worse than a rebuild.
- A reused index is checked against the tree (`indexFreshness`): per-file mtimes are stored in
  `files.tsv`, so an edited or deleted file is detected and re-scanned before the answer (up to
  `AUTO_PATCH_LIMIT = 200` files per lookup — 150 ms for one file on the 3.3 k-file project index).
  Past that, or when only the scan roots moved, the lookup warns and hands the rebuild back to
  `unreal_index`. An index written before v7 has no mtime column and says so (`supported: false`)
  instead of claiming freshness it cannot prove.
