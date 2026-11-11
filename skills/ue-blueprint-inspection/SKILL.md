---
name: ue-blueprint-inspection
description: Read what a Unreal Blueprint actually contains (parent class, graphs, functions, events, variables, default values, node DSL) through the editor's Unreal MCP toolsets, without guessing tool names or reading .uasset bytes. Use for any "what does this Blueprint do / what variable holds X / where is this node" question, and whenever a `.uasset` would otherwise be parsed as text.
compatibility: Requires a running editor with the ModelContextProtocol plugin (UE 5.8 tool surface documented here).
---

# Blueprint inspection over Unreal MCP

## The two rules

1. **Never read a `.uasset` / `.umap` as bytes or text to answer an asset question.** The serialized
   file is garbled and incomplete: names, pins and graph topology do not reconstruct from it. The
   loaded object in the editor is the only real decode. pi-unreal's gate blocks writes, not reads —
   a `strings`/hex dump is still the wrong answer, just an unblocked one.
2. **Resolve the tool before calling it.** Epic's toolsets are Python classes registered at runtime;
   a plausible name (`get_blueprint_info`, `list_nodes`, `get_blueprint_variables`) is almost always a
   fabrication. Run `unreal_mcp` first — `describe` for one tool, `recipe` for a whole ladder.

## Lookup ladder (cheapest first)

```
unreal_mcp action=recipe recipe=blueprint-inspect asset=/Game/Blueprints/BP_Foo
unreal_mcp action=describe tool=get_parent
unreal_mcp action=list toolset=BlueprintTools
unreal_mcp action=search query="event graph"
```

The answer always starts with a source line — read it:

| source line | meaning | what to do |
| --- | --- | --- |
| `[live · …]` | schemas just read from the running editor | trust it |
| `[snapshot · 4m old · editor not reachable]` | cached catalog, editor is down | fine for names/args; any *call* will still fail until the editor is up |
| `no catalog` | neither live nor cached | start the editor, then `/unreal-mcp sync` — do **not** guess |

`refresh: true` (or `/unreal-mcp sync`) re-reads the editor and is the fix when a tool that exists in
the UI is reported missing: the toolsets are mounted per project by plugin, and a stale snapshot
predates a plugin/config change.

## The verified read ladder

`BlueprintTools` handles graphs and members; `ObjectTools` handles property values; `AssetTools` loads
the asset. They are **three separate toolsets**, so this is never one call.

1. `AssetTools.load_asset {asset_path}` → Blueprint object (everything else needs this handle, not a path).
2. `BlueprintTools.get_parent {blueprint}` → C++ parent / parent Blueprint (defines the inherited surface).
3. `BlueprintTools.list_graphs {blueprint}` → graph handles.
4. `BlueprintTools.list_functions`, `list_events`, `list_variables {blueprint}` → the member surface.
5. `BlueprintTools.get_default_object {blueprint}` → CDO.
6. `ObjectTools.list_properties {instance=<CDO>}` → property **names** (required before values).
7. `ObjectTools.get_properties {instance=<CDO>, properties:[…]}` → actual default values.
8. `BlueprintTools.read_graph_dsl {graph}` → node-level DSL for one graph (same DSL `write_graph_dsl` consumes).

Targeted questions skip step 8: `find_nodes {graph, title}` (title substring, plus `entry_points_only`)
then `get_node_infos {nodes}`. `get_connected_subgraph {node}` answers "what runs after this" but is
the largest payload in the toolset — narrow it before calling.

## Dead ends that cost turns

- `read_graph_dsl` takes a **graph object** from `list_graphs`, not a graph name string.
- `find_nodes` requires `title`; it is not a list-all call.
- `get_properties` requires the name list from `list_properties`; it does not enumerate.
- `get_variable_category` / `get_variable_replication` are per-variable calls; `list_variables` omits both.
- Python's `unreal.BlueprintEditorLibrary` names are **not** the toolset names. Do not translate one
  from the other — the toolset wrappers rename and regroup (`compile_blueprint`, `read_graph_dsl`,
  `get_connected_subgraph` have no 1:1 Python counterpart).
- A tool missing from the catalog is a **stop**: report which toolset is not mounted. Do not substitute
  a raw `py` console command, and do not fall back to reading the asset file.

## Read-only boundary

Inspection only: `load_asset`, `get_*`, `list_*`, `find_*`, `read_graph_dsl`. Anything that creates,
sets, compiles, saves or writes (`create_*`, `set_*`, `write_graph_dsl`, `compile_blueprint`,
`save_asset`) changes the asset or the editor state — out of scope here, and never the way to "check"
something. If a question needs authoring, say so and plan it separately.

## Scope of the indexed catalog

Indexed by default: `AssetTools`, `ActorTools`, `BlueprintTools`, `ObjectTools`. A stock 5.8 editor
mounts **52** toolsets / 830 tools — two moves cover the rest:

- one toolsets by name: `unreal_mcp action=list toolset=MaterialTools refresh=true` (live describe, then
  indexed for later calls)
- everything at once: `unreal_mcp action=discover` (≈0.6 s, 1.1 MB, persisted)

With the editor unreachable the honest answer is "not in catalog", not a guess.

## When a tool is not in the catalog

Do not start guessing names — the wrapper names are not engine API names (`create` is `BlueprintTools.create`,
which *is* what the BlueprintTools Python class calls it; `read_graph_dsl` has no C++ counterpart at all).
Two lookups settle it, in this order:

```bash
unreal_mcp action=search query="component"          # mounted tools, name + doc + args matched
unreal_mcp action=python tool=create                # which toolset class owns this name, and where
unreal_mcp action=python toolset=BlueprintTools     # file:line per tool, with the real def signature
```

`action=python` reads the plugin Python that registers the toolsets (`<Plugin>/Content/Python/**`), so it
answers offline and gives a `file:line` you can open with the normal Read tool. Three outcomes:

- **matched** — the toolset is mounted; `unreal_mcp action=describe tool=<name>` gives the schema to obey.
- **on disk, not mounted** — the toolset's plugin is not enabled for this project
  (`MetaHumanToolset`, `SequencerAnimMixerTools` on a typical game project). The tool *cannot* be called;
  say so instead of trying.
- **mounted, no Python class** — C++-registered (`EditorAppToolset`, `LogsToolset`, `SemanticSearchToolset`,
  `SlateInspectorToolset`, `WorldConditionsToolset`). The live schema is the only documentation; there is no
  source line to point at.

The scan never reports argument types. `unreal.*` type names in the `def` signature are Python-side hints;
the `arguments` object the call actually takes comes from `describe` (e.g. an `unreal.EdGraph` parameter is
sent as `{"refPath": "</Script/Engine.EdGraph>"}`).
