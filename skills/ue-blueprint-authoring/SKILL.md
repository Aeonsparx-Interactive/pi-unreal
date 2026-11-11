---
name: ue-blueprint-authoring
description: Add or change logic in a Unreal Blueprint graph through the editor's BlueprintTools — resolve the node type id and pin names, write the graph DSL, read it back — without inventing tool names, DSL syntax, or node ids. Use for "add X to this Blueprint graph", "wire this up", or any request that would end in write_graph_dsl.
compatibility: Requires a running editor with the ModelContextProtocol plugin (UE 5.8 tool surface documented here). Writes are performed by the caller, not by this package.
---

# Blueprint graph authoring over Unreal MCP

## The three rules

1. **Resolve every name before it is used**: tool names from the catalog, `Type|Id` node ids from
   `find_node_types`, pin names from `get_node_type_pins`, grammar from the engine's own usage string.
   A plausible-looking id (`Game|SpawnActor`, `K2Node_Event`) is a fabrication that fails — or worse,
   silently drops a value.
2. **Capture the graph before writing it.** `write_graph_dsl` clears the graph's existing nodes before
   it builds the new ones. The `read_graph_dsl` output is the only readable "before" state, and
   therefore the recovery copy.
3. **The write compiles.** `write_graph_dsl` calls `compile_blueprint` internally. A syntax error is not
   a no-op — the graph has already been replaced. Read back afterwards; the read-back is the proof.

## The ladder

```
unreal_mcp action=recipe recipe=blueprint-graph-author asset=/Game/Blueprints/BP_Foo intent="spawn actor"
```

Eleven steps, of which two are writes:

| # | call | what it settles |
|---|---|---|
| 1 | `AssetTools.load_asset` | the Blueprint object every later call takes |
| 2 | `AssetTools.can_edit_asset` | whether anyone else holds it |
| 3 | `BlueprintTools.get_graph {graph_name}` | the graph object (`write_graph_dsl` takes a graph object, not the asset and not a name — `list_graphs` only prints names) |
| 4 | `BlueprintTools.read_graph_dsl` | the current script = the recovery copy |
| 5 | `BlueprintTools.get_graph_dsl_docs` | the grammar, from the engine |
| 6 | `BlueprintTools.find_node_types(graph, type_id_filter, context_pins)` | the `Type\|Id` ids |
| 7 | `BlueprintTools.get_node_type_pins(graph, type_id)` | exact pin names and directions |
| 8 | **[WRITE]** `BlueprintTools.write_graph_dsl(graph, code)` | replaces the graph's nodes, compiles |
| 9 | `BlueprintTools.read_graph_dsl` | what actually landed |
| 10 | `AssetTools.is_dirty` | that the asset changed at all |
| 11 | **[WRITE]** `AssetTools.save_assets(asset_paths)` | persistence |

Skipping 4, 6 or 7 is how a write destroys work or produces a graph that compiles into nothing. Step 11
is not optional either: until it runs the edit only exists in the running editor.

## The grammar, without guessing

```
unreal_mcp action=dsl                            # section index
unreal_mcp action=dsl section=NODE CALLS         # one section
unreal_mcp action=dsl code="(event BeginPlay ...)"   # pre-flight a script
unreal_mcp action=describe tool=get_graph_dsl_docs
```

`action=dsl` reads the editor plugin's own usage string, so it matches the engine doing the compiling.
With a live editor, `BlueprintTools.get_graph_dsl_docs` returns the same text. Sections: `GRAMMAR
OVERVIEW`, `STATEMENTS`, `MULTI-EXEC (latent/task nodes)`, `EXPRESSIONS`, `NODE CALLS`, `OPERATORS`,
`SWITCH ALIASES`, `SELF REFERENCE`, `COMMENTS`, `IMPORTANT — REUSE VALUES WITH BIND`, `EXAMPLES`.

The invariants that cost the most turns:

- One call per node. Repeating `(Type|Id …)` creates a second node and runs it twice: `(bind x …)` then
  reuse `x`.
- Unquoted words are variable references. Class paths, enum values and asset paths must be quoted, or
  you get "Undefined variable".
- `(if c A (elif c2 B (else C)))` — `elif`/`else` is the last form in the body, not a statement after it.
- `(Node :Pin value)` is a keyword *data* argument; `(Node (:Pin stmts…))` is an *exec* continuation.
  The parenthesis decides. Continuations come after the data arguments.
- Pin names with spaces use `(:"Is Valid" …)`.
- `self` is pre-bound in every event/fn body.

The pre-flight check is syntactic only. It finds unbalanced parens, unquoted paths, misplaced
`elif`/`else` and mis-ordered continuations. It does **not** know whether a type id or pin name exists —
steps 6 and 7 do that, and the editor has the final word.

## Dead ends

- Reading the `.uasset` to "see the current graph": the bytes are garbled and do not reconstruct
  topology. Use step 4.
- Reading a graph node-by-node with `find_nodes` + `get_node_infos` when a whole script is wanted:
  `read_graph_dsl` is one call and round-trips into `write_graph_dsl`.
- Inventing a `Type|Id` from the editor's node title: titles and ids differ. `find_node_types` filters on
  the id, so search by the meaningful word.
- Asking for `apply` / a "dirty but unsaved" batch: no multi-asset transaction exists here. Write, read
  back, then save.

## Boundary

These steps are emitted as `call_tool` shapes; this package never performs them. The caller runs each
`call_tool` through the editor's MCP and reads the effect first. Nothing here creates Blueprints,
sets class defaults, or edits C++/ini — those are separate toolsets with their own ladders.
