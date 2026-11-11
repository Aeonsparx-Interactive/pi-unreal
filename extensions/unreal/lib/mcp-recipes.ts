/**
 * Read-only Blueprint inspection recipes.
 *
 * A recipe is data, not prose: each step names a toolset + tool that must exist in the catalog, so a
 * renamed tool is a loud error at render time instead of an invented call at run time. The ladders
 * come from field sessions against a live editor (Lp project, UE 5.8) where the ordering — and the
 * dead ends — cost real turns to discover.
 *
 * Every step here inspects. Authoring recipes (`create_*`, `set_*`, `write_graph_dsl`) are out of
 * scope until the read path has been validated.
 */

import type { CatalogSnapshot, McpToolEntry } from "./mcp-catalog.ts";
import { callSkeleton, pickToolset } from "./mcp-catalog.ts";

export interface RecipeStep {
	toolset: string;
	tool: string;
	/** Argument values; `${asset}` and `${step1}` style placeholders are substituted at render time. */
	args: Record<string, string>;
	why: string;
	/** The failure this step exists to prevent — the reason the call is ordered this way. */
	deadEnd?: string;
}

export interface Recipe {
	name: string;
	summary: string;
	/** Recipe parameters a caller must supply, e.g. `asset`. */
	params: string[];
	/** Assets a recipe never touches: kept as data so the boundary is visible, not implied. */
	steps: RecipeStep[];
	notes: string[];
}

export const RECIPES: Record<string, Recipe> = {
	"blueprint-inspect": {
		name: "blueprint-inspect",
		summary: "Everything readable about one Blueprint: parent class, graphs, functions/events, default values, per-graph DSL.",
		params: ["asset"],
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
		const values: Record<string, string> = {};
		for (const [name, template] of Object.entries(step.args)) values[name] = substitute(template, params);
		sections.push(`${index + 1}. ${tool.toolsetShort}.${tool.short}   ${tool.summary}`);
		sections.push(`   call: call_tool(${callSkeleton(tool, values)})`);
		if (tool.args.some((arg) => arg.required && !(arg.name in values))) {
			sections.push(`   ! missing required: ${tool.args.filter((arg) => arg.required && !(arg.name in values)).map((arg) => arg.name).join(", ")}`);
		}
		sections.push(`   why: ${step.why}`);
		if (step.deadEnd) sections.push(`   dead end avoided: ${step.deadEnd}`);
	});
	sections.push("", ...recipe.notes.map((note) => `· ${note}`));
	return { text: sections.join("\n"), missing };
}

/** Names + summaries, one line each — the recipe index an agent reads before picking one. */
export function recipeIndexText(): string {
	return Object.values(RECIPES)
		.map((recipe) => `${recipe.name.padEnd(22)} ${recipe.summary}`)
		.join("\n");
}
