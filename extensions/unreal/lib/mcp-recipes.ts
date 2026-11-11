/**
 * Blueprint recipes: inspection ladders, plus one authoring ladder.
 *
 * A recipe is data, not prose: each step names a toolset + tool that must exist in the catalog, so a
 * renamed tool is a loud error at render time instead of an invented call at run time. The ladders
 * come from field sessions against a live editor (Lp project, UE 5.8) where the ordering — and the
 * dead ends — cost real turns to discover.
 *
 * Posture: inspection steps are read-only. Authoring steps are marked `write: true` and are emitted
 * as call SHAPES only — this package never performs them; the caller runs them through the editor's
 * MCP after reading the effect. `blueprint-graph-author` is the only authoring ladder, and it covers
 * the graph DSL (write_graph_dsl) and nothing else: no create_*, no structural authoring, no apply.
 */

import type { CatalogSnapshot, McpToolEntry } from "./mcp-catalog.ts";
import { callSkeleton, pickToolset } from "./mcp-catalog.ts";

export interface RecipeStep {
	toolset: string;
	tool: string;
	/** Argument values; `${asset}` and `${step1}` style placeholders are substituted at render time. */
	args: Record<string, string | string[]>;
	why: string;
	/** The failure this step exists to prevent — the reason the call is ordered this way. */
	deadEnd?: string;
	/** True when the tool changes editor state. Rendered as `[WRITE]`; never executed by this package. */
	write?: boolean;
	/** What the write actually does to the editor — the sentence a caller must read before running it. */
	effect?: string;
}

export interface Recipe {
	name: string;
	summary: string;
	/** Recipe parameters a caller must supply, e.g. `asset`. */
	params: string[];
	steps: RecipeStep[];
	notes: string[];
	/** `write` recipes contain steps this package will not perform; the renderer states that boundary. */
	posture: "read" | "write";
}

export const RECIPES: Record<string, Recipe> = {
	"blueprint-inspect": {
		name: "blueprint-inspect",
		summary: "Everything readable about one Blueprint: parent class, graphs, functions/events, default values, per-graph DSL.",
		params: ["asset"],
		posture: "read",
		steps: [
			{
				toolset: "AssetTools",
				tool: "load_asset",
				args: { asset_path: "${asset}" },
				why: "Every BlueprintTools call takes a loaded object reference, not an asset path string.",
				deadEnd: "Do not read the .uasset bytes for this. The serialized text is garbled and does not reconstruct the graph; the asset must be loaded by the editor.",
			},
			{
				toolset: "BlueprintTools",
				tool: "get_parent",
				args: { blueprint: "${step1}" },
				why: "Tells you which C++ class or Blueprint this inherits from, which determines which functions and events exist.",
			},
			{
				toolset: "BlueprintTools",
				tool: "list_graphs",
				args: { blueprint: "${step1}" },
				why: "Graph handles are required by find_nodes and read_graph_dsl; graph names alone are not accepted.",
			},
			{
				toolset: "BlueprintTools",
				tool: "list_functions",
				args: { blueprint: "${step1}" },
				why: "Locally defined plus inherited functions — the candidate set for call nodes.",
			},
			{
				toolset: "BlueprintTools",
				tool: "list_events",
				args: { blueprint: "${step1}" },
				why: "Custom events plus inheritable engine events (BeginPlay, Tick, ...) that are actually implemented here.",
			},
			{
				toolset: "BlueprintTools",
				tool: "list_variables",
				args: { blueprint: "${step1}" },
				why: "Member and local variables with types; the names used by default-value reads.",
			},
			{
				toolset: "BlueprintTools",
				tool: "get_default_object",
				args: { blueprint: "${step1}" },
				why: "Returns the Class Default Object, which ObjectTools property reads need.",
				deadEnd: "Property reads on the Blueprint asset itself return class metadata; the CDO is where defaults live.",
			},
			{
				toolset: "ObjectTools",
				tool: "list_properties",
				args: { instance: "${step7}" },
				why: "ObjectTools.get_properties requires an explicit property-name list, so the names must be read first.",
			},
			{
				toolset: "ObjectTools",
				tool: "get_properties",
				args: { instance: "${step7}", properties: "<names from step 8>" },
				why: "Actual default values (and inherited overrides) for the properties you care about.",
			},
			{
				toolset: "BlueprintTools",
				tool: "read_graph_dsl",
				args: { graph: "<graph handle from step 3>" },
				why: "Node-level truth for one graph, in the same DSL that write_graph_dsl consumes; cheaper and more faithful than reading node-by-node.",
				deadEnd: "Do not try to read a graph by node names from list_graphs output — read_graph_dsl needs the graph object. For a targeted question use find_nodes (title/class) then get_node_infos.",
			},
		],
		notes: [
			"Steps 2-7 and 10 are BlueprintTools; steps 8-9 are ObjectTools — they are separate toolsets, so this cannot be one call.",
			"Read only. Nothing in this recipe compiles, saves, or dirties the asset.",
		],
	},
	"blueprint-variables": {
		name: "blueprint-variables",
		summary: "Variable list with types, categories, replication and per-instance flags — the 'what state does this Blueprint own' question.",
		params: ["asset"],
		posture: "read",
		steps: [
			{ toolset: "AssetTools", tool: "load_asset", args: { asset_path: "${asset}" }, why: "Loads the asset object every later call needs." },
			{ toolset: "BlueprintTools", tool: "list_variables", args: { blueprint: "${step1}" }, why: "Names and types of member/local variables." },
			{
				toolset: "BlueprintTools",
				tool: "get_variable_category",
				args: { blueprint: "${step1}", variable_name: "<name from step 2>" },
				why: "Category is user metadata, not a type property, so it is a separate call per variable.",
			},
			{
				toolset: "BlueprintTools",
				tool: "get_variable_replication",
				args: { blueprint: "${step1}", variable_name: "<name from step 2>" },
				why: "Replication and RepNotify state are separate reads; list_variables does not include them.",
			},
			{ toolset: "BlueprintTools", tool: "get_default_object", args: { blueprint: "${step1}" }, why: "Defaults live on the CDO." },
			{
				toolset: "ObjectTools",
				tool: "get_properties",
				args: { instance: "${step5}", properties: "<names from step 2>" },
				why: "Default values for exactly the variables that exist — avoids dumping the whole object.",
			},
		],
		notes: ["One get_variable_* call per variable; batching is not offered by the toolset."],
	},
	"blueprint-behaviour": {
		name: "blueprint-behaviour",
		summary: "What this Blueprint actually does: which events/functions exist, where a node lives, and the node graph for one entry point.",
		params: ["asset", "entry"],
		posture: "read",
		steps: [
			{ toolset: "AssetTools", tool: "load_asset", args: { asset_path: "${asset}" }, why: "Blueprint object handle." },
			{ toolset: "BlueprintTools", tool: "list_graphs", args: { blueprint: "${step1}" }, why: "Graph handle for the entry point you care about." },
			{ toolset: "BlueprintTools", tool: "list_events", args: { blueprint: "${step1}" }, why: "Confirms whether the event is implemented here or inherited." },
			{
				toolset: "BlueprintTools",
				tool: "find_nodes",
				args: { graph: "<graph handle from step 2>", title: "${entry}" },
				why: "Locates the entry node (e.g. 'Event BeginPlay') by title before reading anything else.",
				deadEnd: "find_nodes requires a title filter; it is not a 'list all nodes' call. Use entry_points_only for the event graph's entry nodes.",
			},
			{
				toolset: "BlueprintTools",
				tool: "get_node_infos",
				args: { nodes: "<node handles from step 4>" },
				why: "Class, pins and position for the matched nodes — the compact answer to 'what is this node'.",
			},
			{
				toolset: "BlueprintTools",
				tool: "get_connected_subgraph",
				args: { node: "<node handle from step 4>" },
				why: "Everything reachable from the entry node, when the question is 'what runs after this'.",
				deadEnd: "The full subgraph can be large (the biggest schema in the toolset); prefer read_graph_dsl for a whole graph and get_node_infos when the question is narrow.",
			},
			{ toolset: "BlueprintTools", tool: "read_graph_dsl", args: { graph: "<graph handle from step 2>" }, why: "Complete node-level view of that graph in DSL form." },
		],
		notes: [
			"`entry` is a node title substring (e.g. `BeginPlay`), not a pin or a function signature.",
			"Read only. compile_blueprint is deliberately absent: nothing here changes the asset.",
		],
	},
	"blueprint-graph-author": {
		name: "blueprint-graph-author",
		summary: "Add or change logic in one Blueprint graph with the DSL: capture the old script, resolve type ids and pin names, write, read back.",
		params: ["asset", "intent"],
		posture: "write",
		steps: [
			{
				toolset: "AssetTools",
				tool: "load_asset",
				args: { asset_path: "${asset}" },
				why: "Every BlueprintTools call takes the loaded object, not an asset path string.",
				deadEnd: "Reading the .uasset is not a fallback: the serialized text does not reconstruct the graph, and a stale read is how you overwrite someone's work.",
			},
			{
				toolset: "AssetTools",
				tool: "can_edit_asset",
				args: { asset_path: "${asset}" },
				why: "Gate the write on editability: False means it is checked out or locked by another user.",
			},
			{
				toolset: "BlueprintTools",
				tool: "list_graphs",
				args: { blueprint: "${step1}" },
				why: "write_graph_dsl takes a graph handle, not the Blueprint — this is where that handle comes from.",
			},
			{
				toolset: "BlueprintTools",
				tool: "read_graph_dsl",
				args: { graph: "<graph handle from step 3>" },
				why: "Capture the current script BEFORE writing: it is the only readable 'before' state, and therefore the recovery copy.",
				deadEnd: "write_graph_dsl clears the graph's existing nodes before building the new ones, so an aborted write does not hand the original graph back.",
			},
			{
				toolset: "BlueprintTools",
				tool: "get_graph_dsl_docs",
				args: {},
				why: "The grammar: statements, expressions, if/for/while/switch, multi-exec continuations, quoting rules. Same text as the engine's usage string, so it is the authority.",
				deadEnd: "The reference is 225 lines; read the section you need (STATEMENTS, EXPRESSIONS, NODE CALLS, ...) rather than all of it.",
			},
			{
				toolset: "BlueprintTools",
				tool: "find_node_types",
				args: { graph: "<graph handle from step 3>", type_id_filter: "${intent}", context_pins: [] },
				why: "Resolve the `Type|Id` identifier you are about to write (e.g. `Game|SpawnActorfromClass`). An invented id fails at write time.",
				deadEnd: "Ids are not the node titles shown in the editor, and the filter is a substring over the id — search by the meaningful word, not by your whole sentence.",
			},
			{
				toolset: "BlueprintTools",
				tool: "get_node_type_pins",
				args: { graph: "<graph handle from step 3>", type_id: "<type id from step 6>" },
				why: "Exact pin names and directions: the DSL addresses pins by name.",
			},
			{
				toolset: "BlueprintTools",
				tool: "write_graph_dsl",
				args: { graph: "<graph handle from step 3>", code: "<DSL script>" },
				why: "Replaces the graph's nodes with the script's and compiles the Blueprint (compile_blueprint runs internally — no separate compile step).",
				write: true,
				effect: "Mutates the graph in the open editor and compiles the Blueprint. The asset becomes dirty; nothing reaches disk until save_assets.",
			},
			{
				toolset: "BlueprintTools",
				tool: "read_graph_dsl",
				args: { graph: "<graph handle from step 3>" },
				why: "Read back what actually landed. This round trip is the only proof the write meant what you intended.",
				deadEnd: "Do not trust the write call's own success: the compiler can drop or reshape what you wrote, and re-reading is what makes that visible.",
			},
			{
				toolset: "AssetTools",
				tool: "is_dirty",
				args: { asset_path: "${asset}" },
				why: "Confirms the asset holds unsaved changes — the cheap check that the write reached the asset at all.",
			},
			{
				toolset: "AssetTools",
				tool: "save_assets",
				args: { asset_paths: ["${asset}"] },
				why: "Persist the compiled result: until this runs the edit lives only in the running editor.",
				write: true,
				effect: "Writes the .uasset to disk and touches source-control state if the project is under source control.",
			},
		],
		notes: [
			"Steps 8 and 11 are the only writes; the steps before them are what make those two correct, so run them first.",
			"The package emits these as `call_tool` shapes so the script and the ordering can be reviewed before anything changes; it does not perform writes itself.",
			"Check hand-written DSL for syntactic traps with `unreal_mcp(action: \"dsl\", code: \"...\")` before the write. The editor remains the parser.",
		],
	},
};

export interface RenderedRecipe {
	text: string;
	missing: string[];
}

function substitute(value: string, params: Record<string, string>): string {
	return value.replace(/\$\{(\w+)\}/g, (match, key: string) => {
		if (key in params) return params[key] ?? match;
		if (/^step\d+$/.test(key)) return `<result of step ${key.slice(4)}>`;
		return match;
	});
}

function resolveTool(snapshot: CatalogSnapshot, toolset: string, tool: string): McpToolEntry | undefined {
	return pickToolset(snapshot, toolset)?.tools.find((entry) => entry.short === tool || entry.name === tool);
}

/** Render a recipe against the catalog. Any unresolvable step is reported, never silently dropped. */
export function renderRecipe(recipe: Recipe, snapshot: CatalogSnapshot, params: Record<string, string> = {}): RenderedRecipe {
	const missing: string[] = [];
	const sections: string[] = [`recipe ${recipe.name}`, `  ${recipe.summary}`];
	if (recipe.posture === "write") {
		sections.push(
			"  boundary: steps marked [WRITE] change the open editor. They are emitted as call shapes only — this package does not perform them; run them through the editor's MCP after reading each effect.",
		);
	}
	const supplied = recipe.params.filter((name) => params[name] !== undefined);
	const required = recipe.params.filter((name) => params[name] === undefined);
	if (supplied.length) sections.push(`  given: ${supplied.map((name) => `${name}=${params[name]}`).join(", ")}`);
	if (required.length) sections.push(`  template only — supply: ${required.map((name) => `${name}=<...>`).join(", ")}`);
	sections.push("");

	recipe.steps.forEach((step, index) => {
		const tool = resolveTool(snapshot, step.toolset, step.tool);
		if (!tool) {
			missing.push(`${step.toolset}.${step.tool} (step ${index + 1})`);
			sections.push(`${index + 1}. ${step.toolset}.${step.tool}  — NOT IN CATALOG`);
			return;
		}
		const values: Record<string, string | string[]> = {};
		for (const [name, template] of Object.entries(step.args)) {
			values[name] = Array.isArray(template) ? template.map((item) => substitute(item, params)) : substitute(template, params);
		}
		sections.push(`${index + 1}. ${step.write ? "[WRITE] " : ""}${tool.toolsetShort}.${tool.short}   ${tool.summary}`);
		sections.push(`   call: call_tool(${callSkeleton(tool, values)})`);
		if (tool.args.some((arg) => arg.required && !(arg.name in values))) {
			sections.push(`   ! missing required: ${tool.args.filter((arg) => arg.required && !(arg.name in values)).map((arg) => arg.name).join(", ")}`);
		}
		if (step.effect) sections.push(`   effect: ${step.effect}`);
		sections.push(`   why: ${step.why}`);
		if (step.deadEnd) sections.push(`   dead end avoided: ${step.deadEnd}`);
	});
	sections.push("", ...recipe.notes.map((note) => `· ${note}`));
	return { text: sections.join("\n"), missing };
}

/** Names + summaries, one line each — the recipe index an agent reads before picking one. */
export function recipeIndexText(): string {
	return Object.values(RECIPES)
		.map((recipe) => `${recipe.name.padEnd(22)} ${recipe.posture === "write" ? "[write] " : "        "}${recipe.summary}`)
		.join("\n");
}
