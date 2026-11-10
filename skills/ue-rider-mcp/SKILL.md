---
name: ue-rider-mcp
description: Drive a running JetBrains Rider through its MCP server for Unreal Engine work - resolved symbol search, reflected/UHT diagnostics, Rider-driven builds, refactors, live editor and PIE state, Blueprint and asset inspection, gameplay tags, debugger control. Use when the project is open in Rider and a task needs IDE truth (what a symbol resolves to, what the editor is loaded with, what the build said) rather than what grep guesses.
compatibility: JetBrains Rider 2025.2+ (MCP Server plugin bundled, enabled by default). Router mode and per-client tool control are 2026.2. The UE-specific tools (`ue_*`, asset tools) are supplied by JetBrains UnrealLink plus the editor-side RiderLink plugin, so tool names and parameters are Rider/UnrealLink-version dependent. Platform-neutral.
---

# Rider MCP for Unreal Engine

Ground truth is the official documentation:
<https://www.jetbrains.com/help/rider/mcp-server.html> - setup (`#external-client-setup`,
`#project-level-client-setup`, `#manual-client-setup`), Brave mode (`#execute-actions-without-confirmation`),
the tool list with per-tool parameters (`#supported-tools`), router mode (`#router-mode`), and the
per-client tool panel (`#exposed-tools`).
Rider + Unreal Engine: <https://www.jetbrains.com/help/rider/Unreal_Engine__UnrealLink_RiderLink.html>,
<https://www.jetbrains.com/help/rider/Working_with_Unreal_Engine.html>,
<https://www.jetbrains.com/help/rider/Unreal_Engine__Before_You_Start.html>, and the official UE agent
skills page <https://www.jetbrains.com/help/rider/AI_skills_ue.html>.

JetBrains' own agent skills for Rider are the reference set for this skill:
<https://github.com/JetBrains/rider-skills>. `## References` (last section) names every skill and
reference file and says which question each one answers.

Statements below marked **official** come from those pages. Statements marked **measured** are field
experience from a real UE project driven through Rider 2026.3 - the tool surface is version
dependent, so when docs and a live server disagree, the live server's schema wins and the docs are
the citation for what is guaranteed.

## Two rules that survive version drift

1. **Treat the docs' tool list as a floor, not a ceiling.** The documented set is the generic IDE
   surface; the UE toolset (`ue_status`, `ue_play`, `ue_get_logs`, `ue_execute_python`,
   `search_assets`, `search_tags`, `get_class_hierarchy`, `get_asset_properties`,
   `find_default_value_overrides`, `simulate_input`, ...) is contributed by UnrealLink/RiderLink and
   appears only when the matching version is installed. Always resolve the live tool list
   (`tools/list`, or your client's tool-search equivalent) before naming a tool - never
   reconstruct parameters from memory.
2. **A tool call is a submission, not an outcome.** "Accepted", "Build Started",
   "progress will follow", `success: true` on a Hot Reload are receipts. The outcome is a build
   state, a log line, a timestamp, or observed behaviour. Never report a receipt as a result.

## Availability and connection

Setup is a user action in the IDE, not an agent action (official):

- Settings | Tools | MCP Server | **Enable MCP Server**. The plugin ships bundled and enabled by
  default in recent Rider; it is the same plugin published as "MCP Server" on the plugin marketplace.
- Client configuration is offered per client: **Install / Quick Start for <client>** writes the
  client's config file (global or project level), and **Copy SSE Config / Copy Stdio Config /
  Copy HTTP Stream Config** produce JSON to paste. Restart the client after any change here - the
  agent's live tool list is fixed at session start.
- Settings | Tools | MCP Server | Command execution chooses **Brave mode** ("Run shell commands or
  run configurations without confirmation"). Without it, `execute_terminal_command` and run
  configurations need confirmation. Ask before asking the user to enable it.
- Unreal Engine side: the first time a `.uproject` is opened in Rider, a notification offers to
  install the **RiderLink** plugin - to the engine (available for every project) or locally to the
  project; the same page is later on the **Languages & Frameworks | Unreal Engine** settings page,
  and `Force Install RiderLink in Engine` / `Force Install RiderLink in Game` are Find-Action
  commands. RiderLink (editor plugin) and UnrealLink (Rider-side) ship as a pair - the UE toolset
  exists only when both are present and version-matched. Installing them is a user decision; the
  agent's route is the MCP tools, not the editor UI. (Official:
  `Unreal_Engine__Before_You_Start.html#rider_ue_plugins`.)

- A running Rider with the MCP Server plugin is the server. The agent connects to it through the
  agent's own MCP configuration; a registered client is **not** the same as a reachable server, and
  a dead endpoint is reported as connection failure, not as "Rider is not available".
- The server listens on loopback (`127.0.0.1`) on a port that **varies with IDE version, instance,
  and machine** (observed as ephemeral, e.g. `64342`, `64543`). Never hard-code a port. Discover it
  in this order: the project's local MCP config (`.vscode/mcp.json` is read by clients and is a
  checked-in candidate) -> the IDE's MCP settings UI -> a connectivity probe of a known port.
- SSE is the documented default (`/sse`). Stdio and streamable-HTTP configs are offered in the same
  settings dialog. The stdio route bridges into an **already-running** IDE; with the IDE closed it
  fails with "Connection refused", which is a setup step, not a bug.
- Rider version floor: `xdebug_*` debugger tool names exist from 2026.1.3; router mode, per-client
  tool control, and the bundled quality-check hook are 2026.2. `simulate_input` needs a UE
  5.8-compatible UnrealLink build from 2026-05-26 or newer. Check the version before promising any
  of these.
- **Measuring availability is a fact about the workspace, not a verdict about Rider.** Record the
  measured outcome in the project's own notes; this skill stays generic. Do not conclude "no Rider"
  from a stale session, and do not let one session's tool list become a permanent claim.
- Command execution is gated by Rider's **Brave mode** (see above): without it, terminal and run
  configuration calls require confirmation.

## Routing table

| The question | Ask |
| --- | --- |
| What engine version/root is this project | the engine-resolution route (`ue-engine-resolution` skill), not Rider |
| Where is a symbol declared, what are its references, what type is this | Rider `search_symbol` (add `--include_external true` for engine/library symbols), `find_usages`, `get_symbol_info` |
| How does this get called | Rider `analyze_calls` (semantic call hierarchy; `INCOMING_CALLS` / `OUTGOING_CALLS`) |
| Does my code compile | the project's normal UE build route; Rider `get_file_problems` / `lint_files` as the fast gate |
| How does the engine implement this | grep the engine source - Rider indexes declarations, engine `.cpp` bodies are text work |
| How am I using this type | Rider `analyze_calls` / `find_usages` |
| Find this text / file | your own file tools; Rider `search_text` / `search_file` when the IDE index matters (generated/reflected code, unsaved editor state) |
| Rename safely, change a signature, move a type, safe-delete | Rider refactoring tools (`rename_refactoring`, `change_api_signature`, `move_type_to_namespace`, `safe_delete`) |
| Is the editor running, what is loaded, asset data, editor logs | Rider `ue_status`, `ue_get_logs`, asset tools |
| Drive PIE, simulate input | `ue_play` / `simulate_input` are *capable* - **hand them to a human** (see "Editor session") |
| Debugger control | `xdebug_*` (2026.1.3+) - the official route, and a shell-launched editor is invisible to it |
| What are the docs for this API | `fetch_content` on the docs site; Rider answers "what is in **this** project" |

Each row has an owner in the official skills: symbol/usage/implementation questions ->
`navigating-code`; refactors -> `refactoring-code`; stepping, breakpoints, frame values ->
`debugging-code` (a UE crash or runtime bug -> `ue-live-debugging`); the C++ fix-loop ->
`ue-code-authoring`; UE test frameworks -> `ue-test-authoring`; locating existing C# tests ->
`finding-tests`. Exact file paths in `## References`.

Rider is not a file editor for the agent. Source edits go through your own Read/Write/Edit tools;
Rider supplies resolution, diagnostics, refactors, formatting, and builds. After an edit there is
nothing to save - Rider refreshes each file from disk before analysing, formatting, or refactoring
it, so no save/sync step is needed.

## Invocation shape (router mode)

In router mode every tool is reached through one entry point:
`execute_tool(command="<tool> --flag value ...")`. Where the client exposes tools directly, prefer
the direct typed call over hand-serializing flags.

- Every `--flag` takes a value; bare flags are rejected. Booleans are explicit (`--errorsOnly false`).
- Lists are single-quoted JSON arrays, even for one element: `--files '["Source/Module/Foo.cpp"]'`.
- Paths are solution-root-relative with forward slashes; `../` reaches outside the root, which is how
  engine and SDK sources are read.
- Quote any value containing spaces. Omit an optional parameter rather than passing an empty string.
- Flag casing is **per tool**: path flags are camelCase (`--filePath`) *except* `read_file`, which
  takes snake_case `--file_path`. Do not carry a flag name over from a neighbouring tool.
- The four search tools take `--q`, not `--query`.
- `Missing required parameters: ...` and `Tool '<name>' not found` are input errors: fix the flag or
  the name and retry once. They are not evidence the tool is unavailable.
- Canonical wording of all of the above (plus the `mcp__<server key>__<tool>` prefix resolution) is
  `skills/ue-code-authoring/reference/rider-mcp-tools.md#argument-rules` in
  <https://github.com/JetBrains/rider-skills>; `skills/ue-live-debugging/reference/rider-mcp-tools.md`
  adds detection for configurations that expose only `execute_tool`.
- Many configurations also take an implicit `projectPath`; pass it when known.

## Gates: what needs the editor, what does not

Call `ue_status` (or `ue_health`) before any live-state tool. It answers "is the editor connected at
all", PIE state, and recent logs. A "not connected" answer is a **stop condition** for live-state
work: report it, do not retry, do not hand-run the engine binary, do not fall back to
`Get-Process`/`ps` checks.

| Editor running | Editor closed |
| --- | --- |
| all tools available | symbol search, diagnostics, formatting, refactors, build |
| live PIE, viewport, input simulation | `ue_get_logs` (last session's log) |
| `get_class_hierarchy` (Blueprints inheriting a C++ class) | `get_asset_properties`, `find_default_value_overrides` (measured: asset metadata reads answer **without** the editor; verify against the live schema - the official docs guarantee `find_default_value_overrides` as the editor-free one) |
| `ue_execute_python` (asset generation, bulk property writes) | `search_assets` / `search_tags` depend on the asset registry - **measured**: empty results with the editor closed usually mean an unindexed registry, not "no such asset/tag" |

| Task | Route |
| --- | --- |
| "Create a Blueprint asset", "modify an existing asset" | editor Python via `ue_execute_python`; report the created path and verify by reading the asset back - **measured**: a reported asset path is not proof the asset exists |
| "Change a UPROPERTY default" | C++ + build |
| "Find all actors using class X" | C++ source analysis (`find_usages` / grep) + `ue_status` to learn what is loaded |
| "List gameplay tags" | `search_tags` (prefix); `ue_get_logs` for registration failures |
| "Add a C++ class / subsystem" | Write files + `.Build.cs` + `build_solution_start` |
| "Fix compile errors" | `get_file_problems` on each changed file + UBT build |
| "Read properties from a `.uasset`" | `get_asset_properties` (editor closed is fine) |
| "Where is symbol X used?" | `find_usages` (Rider answers this; grep struggles with generated/reflected code) |
| PIE, input, viewport | human drives (see "Editor session") |

Source editing and formatting stay with the agent. Prefer your own Write/Edit over Rider's
file-creation/patch tools. Reformat with the **project's** formatter (project conventions can
override Rider's `reformat_file`); note that `reformat_file` rewrites files on disk - run it last,
and re-Read a file before editing it further.

## Build - the long pole, and where it lies

`build_solution_start` returns a `sessionId` immediately and fails if a build is already running;
`build_solution_state` returns `state` (`Running` / `Completed` / `Cancelled` / `NotFound`) plus
accumulated problems and `buildIsSuccess` once complete. For Unreal, Rider compiles with **Hot
Reload when the editor is connected and Live Coding is available, otherwise with UnrealBuildTool**
against the primary Editor target (official).

- `build_project` is the docs-level name for the same operation, with `rebuild`, `filesToRebuild`,
  `timeout`. Omit `filesToRebuild` to build the whole project.
- Poll on a slow cadence, not in a tight loop: a UE module build takes **minutes**, and every poll
  is a full turn. Poll once to confirm the build took, then space polls ~60s apart
  (`sleep 60` is the correct wait tool); expect under ~10 polls, and stop *watching* around ~20.
  Stopping the poll loop is not stopping work: a compile error in a file you touched is never an
  acceptable end state - fix, rebuild, poll, repeat.
- **Measured - Hot Reload reports success for header changes that never reach the editor.** UE
  compiles a header through the TU that includes it; a header-only edit can produce zero TU work,
  so Hot Reload answers success for a change that was never delivered. Pair header changes with a
  `.cpp` edit in the same build to force a real compile, and treat "header edit + Hot Reload
  success" as unverified.
- **Measured - a successful Hot Reload does not prove the editor loaded the change.** When a header
  adds a reflected member, verify it landed:
  `get_asset_properties` on an asset that reads that property, and/or `ue_get_logs` for the new
  property's `Cannot find link tag for 'Z_...'` line (the engine emits that line per property that
  is missing its link section, and it recurs in `NotifyGameObjectCreated` dumps - it is
  observable). A property that produces no new log line did not land.
- **Measured - the build tool can report success on a UBT failure.** If a build reports
  `Result: Failed` / `OtherCompilerExecutablesFailed` / exit code 1, the tool's answer is a false
  positive. Read the UnrealBuildTool log - the exact file name varies per OS; resolve it from the
  command that ran (`-log=<path>` overrides the default) and grep the last lines for
  `Result: Succeeded` / `Result: Failed`. `EXIT:0` on the build command line means nothing.
- **Measured - MCP build success can be a false positive.** Verify the artifact, not the message:
  check the timestamp of `<Project>/Binaries/<Platform>/UnrealEditor-<Module>.<dll|dylib|so>` after
  a successful MCP build. If the timestamp is old, the build did not deliver.
- **Measured - a Live Coding compile during session start is not an error.** If the first build
  attempt fails with "Live Coding is active" (or similar), that is the editor compiling on
  startup: wait, then retry.
- Rider writes no UBT log of its own when it routes through Hot Reload; the Hot Reload output is
  the log, and UE console commands are available through `ue_execute_python`.
- The terminal state result **is** the build evidence. If it fails for an unrelated project or
  environment error, report that blocker and stop; do not dig through `Intermediate/`, `Binaries/`,
  generated/UHT files, or unrelated source to prove a changed file compiled. Only investigate
  diagnostics that name a changed file.
- `get_project_problems` reads the IDE Problems View - it does **not** trigger analysis. Run a
  build first if you need current build diagnostics.

## Diagnostics

- One or two changed files: `get_file_problems` per file, in parallel. Three or more, or any
  reflected-API change: one `lint_files` call.
- `get_file_problems` returns errors by default; `--errorsOnly false` when warnings matter.
  `lint_files` defaults to `--min_severity warning` (includes style suggestions/hints);
  `--min_severity error` is the strict gate. A `timedOut: true` entry with empty problems means the
  budget ran out, not that the file is clean; `notAnalyzedReason` means the file is not part of any
  project or is an unsupported type.
- **Measured - expect index-level false positives on UE sources.** The C++ resolver does not expand
  every UE macro and reports `severity: ERROR` on code that compiles cleanly (recurring shapes:
  `Cannot resolve user-defined 'operator ""_...'` on an attribute-accessor macro line,
  `Cannot resolve symbol 'PLATFORM_BREAK'` on a `check(...)` line). Calibrate with exactly **one**
  comparison against a single untouched neighbour file of the same kind. Identical diagnostic there
  -> resolver noise for the whole project: record the signature once and ignore it for the rest of
  the session. Do not sweep further files to re-confirm, and never edit working code to satisfy it.
- Start a build only once changed-file diagnostics are clean of *real* errors.
- `read_file` defaults to a 2000-line window (max 5000). On a large engine header that exceeds the
  client's per-result budget and the call is spent for nothing. Locate the symbol first, then read a
  narrow window (`--offset <hit line> --limit 60`). Never recover an oversized result by reading the
  agent's own session/transcript files.

## Editor session

- **Start the editor through an IDE launch route (a debugger launch configuration), not from a
  shell.** Measured: a shell-launched editor on Windows can exit immediately with no log written;
  an editor started outside the debugger is invisible to debugger control and its process is a
  zombie after the session ends.
- **Measured - readiness gates in order:**
  1. the log file appears,
  2. a clean `Log file open` line,
  3. `Engine pre-init: done`, then `Engine init: done`,
  4. **`Running <Project>.uproject (Development) Editor` (the project banner) - this is the gate
     that matters.** The engine binary starts with `-run=Startup` for a few seconds first: the
     `Engine init: done` line exists **before** the project loads, so it is not a readiness gate
     for project state.
  5. Rider MCP `ue_status` connected.
  Startup takes 1-4 minutes. Poll with `sleep 10`/`sleep 15` (measured: 14 polls in one session);
  each poll is a full turn, so poll a file-existence/log-tail check, not the editor.
- **Measured - the editor can hang at `LogScript: Starting Dev-Python scripts.`, which is the last
  log line.** Do not assume it is ready. Read the log tail; a session that ends with
  `Shutting down engine` is a **crash**, not a clean exit - look for the `Assertion failed` line
  (it names the source file and expression) and report it as a crash.
- `ue_status` answers "is the editor connected at all"; the log answers project state;
  `ue_get_logs` answers engine events. Each has exactly one job - do not infer one from the other.
  In the log, startup lines come in fixed order: engine binary line, `Engine pre-init: done`,
  `Engine init: done`, then the project banner, then plugin lines. The last log lines are the most
  informative and the log order lies about causality.
- **Live Coding compile is never triggered automatically.** The MCP bridge does not trigger it.
  Trigger it explicitly: `LiveCoding.CompileSync` (synchronous - blocks the editor thread until the
  compile is done) or `LiveCoding.Compile` (queues, returns immediately, no completion answer) from
  the editor console, whose exact spelling is the source name in
  `Engine/Source/Developer/Windows/LiveCoding/Private/LiveCodingModule.cpp` (`cmd LiveCoding` is
  console-command help output, not the command). Live Coding is a Windows-only engine feature - on
  other platforms the route is a full UBT compile. In a debugger-driven session the IDE's own
  Live Coding UI is the normal route. **Hand the console command to the human.**
- **PIE is never driven by the agent.** `ue_play` and `simulate_input` are capable; the human drives.
  Hand over the exact command lines, the expected result, and the log to read:
  `py <one-line code>`, `LiveCoding.CompileSync`, `ModelContextProtocol.RefreshTools`,
  `ShowDebug GAME <ComponentClassName>`.
  **Measured:** `ue_execute_python` accepts **multiple statements and a `script` array**; each entry
  must be one line (no `\n`), joined with `;` and comprehensions. `import` needs editor-init
  phase (not `PostInitMap` - the engine's Python import registry is not available there). The
  Python name of a UE enum is its **raw C++ name** (`EGameplayAbilityNetExecutionPolicy`) and enum
  members are plain attributes, not `getattr`-style lookups.
- **Measured - `ue_execute_python` parameter names are not documented consistently; probe and
  read.** Call with `{"script": "..."}`; on a parameter error, read the reported schema in the
  error text and adapt.
- **Measured - `ue_get_logs` filters**: use `verbosity: "Warning"` (the engine writes
  warning-or-higher) and pass a bare substring pattern - a regex-style pattern over a line that
  contains a path matches nothing.
- Toolset refresh after a plugin change is a human action: `ModelContextProtocol.RefreshTools` from
  the editor console.

## Debugging

- `xdebug_*` names are the official ones. Two families appear in the docs and both are version
  dependent, so resolve the live list before naming one:
  - session/inspection: `xdebug_start_debugger_session`, `xdebug_get_debugger_status`,
    `xdebug_control_session`, `xdebug_run_to_line`, `xdebug_get_stack`, `xdebug_get_frame_values`,
    `xdebug_get_value_by_path`, `xdebug_get_threads`, `xdebug_get_registers`, `xdebug_read_memory`,
    `xdebug_disassemble`, `xdebug_evaluate_expression`, `xdebug_set_variable`,
    `xdebug_get_fault_status`, `xdebug_get_process_output`, `xdebug_ignore_exception`,
    `xdebug_get_async_tasks`, `xdebug_get_async_task_stack`, `xdebug_attach_to_process`.
    Names marked **docs-only for Rider**: `xdebug_get_registers`, `xdebug_read_memory`,
    `xdebug_disassemble`, `xdebug_get_fault_status` appear on the shared docs page but are absent
    from the Rider contract files in `rider-skills`, so do not name them until the live list shows
    them.
  - breakpoints: the docs list `xdebug_list_breakpoints`, `xdebug_set_breakpoint`,
    `xdebug_remove_breakpoint`; the official skills' contracts are the batch forms
    `xdebug_set_breakpoints`, `xdebug_remove_breakpoints`, `xdebug_set_breakpoints_muted`
    (`breakpoints` array, 1..50 items). Treat the docs' singular names as a floor.
    **References:** `skills/debugging-code/reference/tools/` in
    <https://github.com/JetBrains/rider-skills> (per-tool Parameters/Output tables).
  **Official** docs: <https://www.jetbrains.com/help/rider/Agentic_debugging_with_Rider_and_CLion.html>.
- Contract facts worth knowing from `xdebug_start_debugger_session.md` (official reference): start
  from **either** `configurationName` **or** `filePath` + 1-based `line` (mutually exclusive, and the
  line must be a runnable entry point); set at least one breakpoint first or the debuggee runs to
  completion; `timeout` (ms, default 60000) and `graceWaitMs` (default 2000); a failed launch returns
  `state: failed_to_start` with **no** `sessionId`, so the absence of a session id is the result;
  launch overrides (`programArguments`, `workingDirectory`, `envs`) are accepted only when
  `get_run_configurations` reports `supportsDynamicLaunchOverrides=true`, missing/empty keeps the
  configured value and a whitespace-only string clears it; next call is
  `xdebug_control_session(action=WAIT_FOR_PAUSE)`, then `xdebug_get_stack` + `xdebug_get_frame_values`.
- From `xdebug_set_breakpoints.md`: location mode is `filePath` + 1-based `line` with `breakpointId`
  omitted; ID mode uses the id returned by `xdebug_list_breakpoints`/this tool; a *new* breakpoint is
  owned by `agent`, so remove it (and clear `isCaptureThreadDump`) before the session ends;
  `suspendPolicy: ALL|THREAD|NONE`; `success: true` per item means the settings were applied - it does
  not validate a `condition`/`logExpression` and does not mean the line was reached.
- Official limits: breakpoint errors and logging-breakpoint output are reported only by JVM-based
  debuggers (C/C++ debug streams can stay empty); `constexpr` evaluation is not supported through
  MCP; `isCaptureThreadDump` is JVM-only.
- Official limits: breakpoint errors and logging-breakpoint output are reported only by JVM-based
  debuggers (C/C++ debug streams can stay empty); `constexpr` evaluation is not supported through
  MCP.
- Attach to a live editor session: start a debugger session against the running editor process, set
  a breakpoint in a source file (path plus line, project-scoped), let the human drive PIE until it
  hits, then control the session (resume/step). Read the exact argument names off the live schema
  before the first call.
- **Measured - a zombie UnrealEditor process is a tell that the editor was started from a shell**,
  not through a debugger launch.
- Debugger control over a live editor requires the session to have been started under the debugger;
  a shell-launched editor is not attachable in practice.

## Assets and editor state

- **Never edit `.uasset` / `.umap` as text, and never touch a binary asset for a C++-side
  question.** Reflected-property serialization carries the name/metadata the engine needs; the
  official "Unreal Engine file types" documentation is the authority (via the docs site index -
  deep links to that page are not stable).
- `get_class_hierarchy` - "Blueprint assets inheriting from this C++ class" - **requires the editor
  running.**
- **Measured - `get_asset_properties` works with the editor closed** via
  `/Engine/EditorBlueprintResources/...` asset paths: it is asset-registry work, not live-editor
  work. Verify against the live schema; the official editor-free guarantee is
  `find_default_value_overrides` ("every asset overriding a reflected field's default - works
  without the editor").
- **Measured - `search_assets` / `search_tags` return empty results with the editor closed.**
  Empty is not absence: say the registry is not indexed, never "no such asset/tag".
- `take_screenshot` / viewport capture is not a verification tool here - the log and the asset data
  are the evidence.
- Skill boundary: `ue-code-authoring` owns C++ authoring depth, `ue-live-debugging` owns runtime
  debugging depth, `ue-test-authoring` owns test frameworks. This skill owns the
  editor-state/gate/build-evidence/connection questions those skills do not cover. When the
  user's task is authoring, debugging, or test work, load the official skill and keep this one
  for its gates and evidence rules.

## Known failure modes (measured)

- **Measured - an async task-result call hangs when the task id is omitted.** Always pass the id
  returned by the call that started the work; there is no "most recent" default. (The builder/status
  pair has the same shape: `build_solution_state` accepts an omitted `sessionId`, a long-lived
  result poller generally does not.)
- **Measured - a long-running editor is the root cause of most MCP trouble.** Stale connections and
  toolset drift are symptoms of editor lifetime, not of the MCP server.
- **Measured - an MCP session survives a Live Coding compile, and Hot Reload works on a
  debugger-launched editor.**
- **Measured - the 2025.x "Unreal Engine integration cannot work with MCP" warning is obsolete.**
  Treat it as version noise.

## Known Rider MCP quirks

- Router mode is the 2026.2 default: tools come from one entry point. Per-tool availability is a
  UI setting (Exposed Tools), and router-only mode lowers token usage. Tool names and flags change
  with the IDE version - the docs list and a live `tools/list` can differ.
- Tool names and parameters are **source-verified** in <https://github.com/JetBrains/UnrealLink>
  (`protocol/src/main/kotlin/.../EditorPluginTool*.kt`, `EditorPluginUnrealTools.kt`) - the
  authoritative tool list, ahead of any documentation. Rider-side code is public; RiderLink's
  implementation is in the engine plugin.
- Tool naming for the router is environment-specific: each tool is namespaced
  `mcp__<server key>__<tool>` and the key varies per machine/config (`rider`, `ide`, `jetbrains`,
  a headless key), hyphens included. Resolve the prefix once with a bare-name tool search and reuse
  it - never type a prefix from memory. **Reference:**
  `skills/ue-code-authoring/reference/rider-mcp-tools.md#argument-rules` - the argument rules
  (every `--flag` needs a value; booleans explicit; arrays are single-quoted JSON, always an array
  even for one element; quote values containing spaces; paths forward-slash and project-root
  relative with `../` reaching engine/SDK sources; omit an optional parameter instead of passing
  `""`; per-tool flag casing - `read_file` takes `--file_path` snake_case).
- The project-root parameter is called `rootFolder` in the official skills' contracts ("pass this
  value ALWAYS if you are aware of it") and `projectPath` in the docs' prose. Same meaning, different
  spelling per toolset - copy it from the live schema, not from memory.
- Rider **disables** the generic platform `search_symbol`, `lint_files`, `get_file_problems`,
  `build_project`, and `reformat_file` and replaces them with Rider-specific implementations, so a
  generic contract found in IntelliJ/CLion documentation is not the Rider contract.
- JetBrains' own skills for Rider are published at <https://github.com/JetBrains/rider-skills>
  (UE authoring, live debugging, UE test authoring, navigation, refactoring, debugging, C# test
  discovery) and are installable from Rider's **Tools | AI Assistant | Skills** page. They are the
  canonical tool reference and the naming conventions this skill follows - see `## References`.

## References

JetBrains' official Rider skills: <https://github.com/JetBrains/rider-skills> (Apache-2.0).
Every skill folder has `metadata.json` with its `version` and a `sha256` hash of its files - quote a
contract with that version, and re-check it after an update. Docs page for the bundled UE skills:
<https://www.jetbrains.com/help/rider/AI_skills_ue.html>.

Snapshot used for the versions and file names below: `master` at commit `eddf751236d0` (2026-10-12).
The repo bumps `version` + `hash` on every skill change, so re-check `metadata.json` before quoting a
contract as current.

Install routes (official README): **Rider UI** Tools | AI Assistant | Skills -> search -> Install;
**Claude Code** `/plugin marketplace add JetBrains/rider-skills`, then
`/plugin install rider-skills@rider-skills`, then `/reload-plugins`; **Codex**
`codex plugin marketplace add JetBrains/rider-skills`, then `/plugins`; **manual** copy or symlink
individual folders from `skills/` into the agent's skills directory (user-level for all projects,
project-level for one).

| Skill | Version | Authoritative for | Prefer it when |
| --- | --- | --- | --- |
| [`ue-code-authoring`](https://github.com/JetBrains/rider-skills/blob/master/skills/ue-code-authoring/SKILL.md) | 1.0.0 | UE C++ authoring workflow, fix-loops, the argument rules, UE conventions | writing/editing classes, components, subsystems |
| [`ue-live-debugging`](https://github.com/JetBrains/rider-skills/blob/master/skills/ue-live-debugging/SKILL.md) | 1.0.1 | crash triage, call-hierarchy tracing, breakpoints, live PIE state via Python | a crash, a runtime bug, unexpected behaviour |
| [`ue-test-authoring`](https://github.com/JetBrains/rider-skills/blob/master/skills/ue-test-authoring/SKILL.md) | 1.0.0 | Automation / DEFINE_SPEC / CQTest / Functional / Gauntlet / LowLevel patterns and registration errors | authoring UE tests |
| [`navigating-code`](https://github.com/JetBrains/rider-skills/blob/master/skills/navigating-code/SKILL.md) | 1.1.1 | `find_usages`, `find_implementations` contracts | usages/implementations through the IDE index |
| [`refactoring-code`](https://github.com/JetBrains/rider-skills/blob/master/skills/refactoring-code/SKILL.md) | 1.0.4 | rename, signature change, move type, safe delete, extract-* + conflicts/limits | any semantic refactor |
| [`debugging-code`](https://github.com/JetBrains/rider-skills/blob/master/skills/debugging-code/SKILL.md) | 2.0.10 | the whole `xdebug_*` family and run configurations, per-tool parameters | stepping, breakpoints, frame values |
| [`finding-tests`](https://github.com/JetBrains/rider-skills/blob/master/skills/finding-tests/SKILL.md) | 1.0.0 | locating existing C# tests via coverage data | C#/.NET test work (not UE) |

Per-tool contract files (Parameters + Output tables - use these instead of guessing a parameter
name; paths are `skills/<skill>/reference/...` in the repo):

- `debugging-code/reference/tools/` - 21 files, one per debugger/run tool:
  `xdebug_start_debugger_session.md`, `xdebug_set_breakpoints.md`, `xdebug_remove_breakpoints.md`,
  `xdebug_set_breakpoints_muted.md`, `xdebug_list_breakpoints.md`, `xdebug_control_session.md`,
  `xdebug_run_to_line.md`, `xdebug_get_debugger_status.md`, `xdebug_get_stack.md`,
  `xdebug_get_frame_values.md`, `xdebug_get_value_by_path.md`, `xdebug_get_threads.md`,
  `xdebug_evaluate_expression.md`, `xdebug_set_variable.md`, `xdebug_get_async_tasks.md`,
  `xdebug_get_async_task_stack.md`, `xdebug_attach_to_process.md`, `xdebug_get_process_output.md`,
  `xdebug_ignore_exception.md`, `execute_run_configuration.md`, `get_run_configurations.md`.
- `navigating-code/reference/tools/find_usages.md`, `find_implementations.md`.
- `refactoring-code/reference/tools/` - `rename_refactoring.md`, `change_api_signature.md`,
  `safe_delete.md`, `move_type_to_namespace.md`, `reorganize_namespaces.md`, `extract_method.md`,
  `extract_interface.md`, `extract_base_class.md`; plus `refactoring-code/reference/conflicts.md`
  (conflicts, ambiguity, known limitations).
- Tool indexes per skill: `ue-code-authoring/reference/rider-mcp-tools.md` (the **argument rules**
  section is the invocation contract for router mode), `ue-code-authoring/reference/rider-tools.md`,
  `ue-live-debugging/reference/rider-mcp-tools.md` (includes the `execute_tool`-only detection),
  `ue-live-debugging/reference/rider-debug-tools.md`, `ue-test-authoring/reference/rider-mcp-tools.md`,
  `ue-test-authoring/reference/rider-tools.md`, and the short indexes
  `debugging-code/reference/tools.md`, `navigating-code/reference/tools.md`,
  `refactoring-code/reference/tools.md`.
- UE-specific patterns: `ue-code-authoring/reference/ue-cpp-conventions.md` (naming, header/source
  skeleton, reflection macros, object pointers), `ue-live-debugging/reference/crash-patterns.md`,
  `ue-live-debugging/reference/ue-debug-patterns.md`,
  `ue-live-debugging/reference/ue-python-inspection.md` (single-line rules, world/player/component
  queries), `ue-test-authoring/reference/ue-test-patterns.md`,
  `ue-test-authoring/reference/attribute-set-tests.md`.

**Where the references and this skill agree** (measured here, stated officially there):
`ue_status` first before any live-state tool; `get_class_hierarchy` and `get_asset_properties` need
the editor running; `find_default_value_overrides` works without the editor; `simulate_input` modes
each carry their own named parameters; UE Python is single-line (`;`, no `\n`) and the `GameplayTag`
constructor is positional (`unreal.GameplayTag("Tag.Name")`).

**Where they disagree** - resolve on the machine, and say which side you used:
official `ue-live-debugging/reference/rider-mcp-tools.md` states `get_asset_properties` "Requires
editor running"; **measured** here, asset-registry paths (for example
`/Engine/EditorBlueprintResources/...`) read with the editor closed. Official docs list singular
`xdebug_set_breakpoint`/`xdebug_remove_breakpoint`, the official contracts use the batch plural
forms. Both cases: the live schema wins, the docs are the citation.

## Never

- **Never hand-run the editor binary from a shell** to inspect a project - use the asset tools.
- **Never call `ue_play` / `simulate_input` from an agent run.** Hand over the commands with
  expected results.
- **Never hard-code a port.** Discover it.
- **Never claim a tool exists without resolving it**, and never invent parameter names - resolve the
  live schema, and read the docs for parameter *meaning*.
- **Never conclude "no such asset / tag / property" from an empty result.** Name what was searched
  and state the gate that was unmet.
- **Never report a submission receipt as an outcome.**
- **Never use Rider MCP as the only way to learn the engine version** - use the engine-resolution
  route.
- **Never edit `.uasset` / `.umap`.**
- **Never launch a build while real errors remain in changed files**, and never claim a change is
  complete while a changed file still fails to compile.
