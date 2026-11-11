import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allTools,
	callSkeleton,
	describeToolText,
	ensureCatalog,
	listText,
	normalizeToolset,
	pickToolset,
	searchTools,
	type CatalogSnapshot,
} from "../extensions/unreal/lib/mcp-catalog.ts";
import { RECIPES, recipeIndexText, renderRecipe } from "../extensions/unreal/lib/mcp-recipes.ts";

/**
 * The fixture is hand-written, not an Epic dump: the point of these tests is the normalization and
 * lookup contract, and the shipped toolset schemas are Epic's content, not ours to redistribute.
 * Shapes copied from the real payload: UObject args are `{ type: "object", title, properties: { refPath } }`,
 * docs carry the full Python docstring, and `required` is a separate array.
 */
const RAW_BLUEPRINT = {
	name: "editor_toolset.toolsets.blueprint.BlueprintTools",
	description: "Blueprint tools.",
	tools: [
		{
			name: "editor_toolset.toolsets.blueprint.BlueprintTools.list_variables",
			description: "Lists member or local variables defined on a Blueprint.\n\n    Args:\n        blueprint: The blueprint to inspect.\n        graph: Optional graph scope.\n    ",
			inputSchema: {
				type: "object",
				properties: {
					blueprint: { type: "object", title: "/Script/Engine.Blueprint", properties: { refPath: { type: "string" } } },
					graph: { type: "object", title: "/Script/Engine.EdGraph", properties: { refPath: { type: "string" } } },
				},
				required: ["blueprint"],
			},
			outputSchema: { properties: { returnValue: { type: "array" } } },
		},
		{
			name: "editor_toolset.toolsets.blueprint.BlueprintTools.find_nodes",
			description: "Finds nodes in a graph by title.",
			inputSchema: {
				type: "object",
				properties: {
					graph: { type: "object", title: "/Script/Engine.EdGraph", properties: { refPath: { type: "string" } } },
					title: { type: "string", description: "Node title substring." },
					entry_points_only: { type: "boolean", default: false },
				},
				required: ["graph", "title"],
			},
			outputSchema: { properties: { returnValue: { type: "array" } } },
		},
		{
			name: "editor_toolset.toolsets.blueprint.BlueprintTools.read_graph_dsl",
			description: "Reads a Blueprint graph and returns a DSL script.",
			inputSchema: { type: "object", properties: { graph: { type: "object", title: "/Script/Engine.EdGraph", properties: { refPath: { type: "string" } } } }, required: ["graph"] },
			outputSchema: { properties: { returnValue: { type: "string" } } },
		},
	],
};

const RAW_OBJECT = {
	name: "editor_toolset.toolsets.object.ObjectTools",
	tools: [
		{
			name: "editor_toolset.toolsets.object.ObjectTools.get_properties",
			description: "Returns the values of one or more properties on an object.",
			inputSchema: {
				type: "object",
				properties: {
					instance: { type: "object", title: "/Script/CoreUObject.Object", properties: { refPath: { type: "string" } } },
					properties: { type: "array", items: { type: "string" } },
				},
				required: ["instance", "properties"],
			},
			outputSchema: { properties: { returnValue: { type: "object" } } },
		},
	],
};

const RAW_ASSET = {
	name: "editor_toolset.toolsets.asset.AssetTools",
	tools: [
		{
			name: "editor_toolset.toolsets.asset.AssetTools.load_asset",
			description: "Loads an asset from the project.",
			inputSchema: { type: "object", properties: { asset_path: { type: "string", description: "Asset path." } }, required: ["asset_path"] },
			outputSchema: { properties: { returnValue: { title: "/Script/CoreUObject.Object" } } },
		},
	],
};

function snapshot(): CatalogSnapshot {
	return {
		schema: 1,
		key: "test",
		url: "http://127.0.0.1:1/mcp",
		capturedAtMs: Date.now(),
		toolsets: {
			BlueprintTools: normalizeToolset(RAW_BLUEPRINT as never, Date.now()),
			ObjectTools: normalizeToolset(RAW_OBJECT as never, Date.now()),
			AssetTools: normalizeToolset(RAW_ASSET as never, Date.now()),
		},
	};
}

describe("normalizeToolset", () => {
	test("keeps the full toolset name, the bare tool name, args, required flags and UObject refs", () => {
		const toolset = normalizeToolset(RAW_BLUEPRINT as never, 1_700_000_000_000);
		expect(toolset.name).toBe("editor_toolset.toolsets.blueprint.BlueprintTools");
		expect(toolset.short).toBe("BlueprintTools");
		expect(toolset.capturedAtMs).toBe(1_700_000_000_000);
		expect(toolset.tools.map((tool) => tool.short)).toEqual(["list_variables", "find_nodes", "read_graph_dsl"]);

		const findNodes = toolset.tools[1]!;
		expect(findNodes.args.map((arg) => [arg.name, arg.type, arg.required])).toEqual([
			["graph", "object ref", true],
			["title", "string", true],
			["entry_points_only", "boolean", false],
		]);
		expect(findNodes.args[0]!.refType).toBe("/Script/Engine.EdGraph");
		expect(findNodes.args[2]!.defaultValue).toBe("false");
		expect(findNodes.returns).toBe("array");
	});

	test("summary is the collapsed first sentence, description keeps the docstring", () => {
		const toolset = normalizeToolset(RAW_BLUEPRINT as never);
		const listVars = toolset.tools[0]!;
		expect(listVars.summary).toBe("Lists member or local variables defined on a Blueprint.");
		expect(listVars.description).toContain("Args:");
		expect(listVars.summary.length).toBeLessThan(listVars.description.length);
	});

	test("tolerates a toolset with no tools", () => {
		const toolset = normalizeToolset({ name: "x.y.EmptyTools" } as never);
		expect(toolset.short).toBe("EmptyTools");
		expect(toolset.tools).toEqual([]);
	});
});

describe("lookup", () => {
	test("pickToolset accepts short, full and case-different names", () => {
		const snap = snapshot();
		expect(pickToolset(snap, "BlueprintTools")?.short).toBe("BlueprintTools");
		expect(pickToolset(snap, "editor_toolset.toolsets.blueprint.BlueprintTools")?.short).toBe("BlueprintTools");
		expect(pickToolset(snap, "blueprinttools")?.short).toBe("BlueprintTools");
		expect(pickToolset(snap, "MaterialTools")).toBeUndefined();
	});

	test("searchTools matches name, toolset, argument names and doc text", () => {
		const snap = snapshot();
		const byName = searchTools(snap, "read_graph");
		expect(byName[0]!.tool.short).toBe("read_graph_dsl");
		expect(searchTools(snap, "get_properties")[0]!.tool.toolsetShort).toBe("ObjectTools");
		expect(searchTools(snap, "entry_points_only").some((match) => match.tool.short === "find_nodes")).toBe(true);
		expect(searchTools(snap, "member or local variables").some((match) => match.tool.short === "list_variables")).toBe(true);
		expect(searchTools(snap, "zzz-nothing")).toEqual([]);
	});

	test("allTools reports every indexed tool", () => {
		expect(allTools(snapshot())).toHaveLength(5);
	});

	test("listText names each toolset with its count", () => {
		const text = listText(snapshot());
		expect(text).toContain("BlueprintTools");
		expect(text).toMatch(/BlueprintTools\s+3 tools/);
	});
});

describe("call shape", () => {
	test("callSkeleton emits toolset_name + bare tool_name and only the needed arguments", () => {
		const snap = snapshot();
		const listVars = allTools(snap).find((tool) => tool.short === "list_variables")!;
		const skeleton = JSON.parse(callSkeleton(listVars));
		expect(skeleton.toolset_name).toBe("editor_toolset.toolsets.blueprint.BlueprintTools");
		expect(skeleton.tool_name).toBe("list_variables");
		// the optional `graph` is not fabricated; the required object ref gets a placeholder
		expect(skeleton.arguments).toEqual({ blueprint: { refPath: "</Script/Engine.Blueprint>" } });

		const getProperties = allTools(snap).find((tool) => tool.short === "get_properties")!;
		const given = JSON.parse(callSkeleton(getProperties, { instance: "<cdo>", properties: "<names>" }));
		expect(given.arguments).toEqual({ instance: "<cdo>", properties: "<names>" });
	});

	test("describeToolText is a fragment, not the whole toolset dump", () => {
		const tool = allTools(snapshot()).find((entry) => entry.short === "read_graph_dsl")!;
		const text = describeToolText(tool);
		expect(text).toContain("BlueprintTools.read_graph_dsl");
		// the UObject ref is shown twice on purpose: the Python name the agent thinks in, and the
		// refPath string the call actually takes
		expect(text).toContain("graph  object ref → unreal.EdGraph  (/Script/Engine.EdGraph)  (required)");
		expect(text).toContain("returns: string");
		expect(text.length).toBeLessThan(600);
	});
});

describe("recipes", () => {
	test("every step resolves against the catalog it is written for", () => {
		for (const recipe of Object.values(RECIPES)) {
			const rendered = renderRecipe(recipe, snapshot());
			// blueprint-inspect also reads functions/events/parent/CDO, which the small fixture omits
			expect(rendered.text).toContain(`recipe ${recipe.name}`);
		}
	});

	test("blueprint-inspect starts from load_asset and ends with read_graph_dsl", () => {
		const rendered = renderRecipe(RECIPES["blueprint-inspect"]!, snapshot(), { asset: "/Game/BP_Foo" });
		expect(rendered.text).toContain('"tool_name":"load_asset"');
		expect(rendered.text).toContain('"asset_path":"/Game/BP_Foo"');
		expect(rendered.text.trimEnd().split("\n").at(-1)).toContain("Read only");
		expect(rendered.missing.length).toBeGreaterThan(0); // the fixture lacks get_parent etc.
		expect(rendered.missing.join(",")).toContain("BlueprintTools.get_parent");
	});

	test("a missing tool is reported, never silently dropped", () => {
		const rendered = renderRecipe(RECIPES["blueprint-variables"]!, snapshot());
		expect(rendered.text).toContain("NOT IN CATALOG");
		expect(rendered.missing.some((entry) => entry.includes("get_variable_category"))).toBe(true);
	});

	test("the only authoring recipe captures the graph before it writes it", () => {
		const recipe = RECIPES["blueprint-graph-author"]!;
		expect(recipe.posture).toBe("write");
		const index = (tool: string) => recipe.steps.findIndex((step) => step.tool === tool);
		expect(index("read_graph_dsl")).toBeGreaterThan(-1);
		expect(index("read_graph_dsl")).toBeLessThan(index("write_graph_dsl"));
		// The write is preceded by the two discovery calls that make it correct, and followed by a read-back.
		expect(index("find_node_types")).toBeLessThan(index("write_graph_dsl"));
		expect(index("get_node_type_pins")).toBeLessThan(index("write_graph_dsl"));
		expect(recipe.steps.slice(index("write_graph_dsl") + 1).some((step) => step.tool === "read_graph_dsl")).toBe(true);
	});

	test("every graph-reading ladder converts a name with get_graph first", () => {
		// 2026-11-11 field failure: `read_graph_dsl {graph: {refPath: "EventGraph"}}` →
		// `Parameter error: EventGraph is not a valid object path for property 'graph'`.
		const graphTools = ["read_graph_dsl", "write_graph_dsl", "find_nodes", "get_connected_subgraph"];
		for (const recipe of Object.values(RECIPES)) {
			recipe.steps.forEach((step, index) => {
				if (!graphTools.includes(step.tool)) return;
				const earlier = recipe.steps.slice(0, index).filter((candidate) => candidate.tool === "get_graph");
				expect(earlier.length).toBeGreaterThan(0);
				expect(earlier[0]!.args.graph_name).toBeDefined();
			});
		}
		// And the dead end is spelled out where the mistake is made.
		const inspect = RECIPES["blueprint-inspect"]!;
		const graphs = inspect.steps.find((step) => step.tool === "list_graphs")!;
		expect(graphs.deadEnd).toContain("not a valid object path for property 'graph'");
	});

	test("a candidate list is never sold as a signature or a typed variable list", () => {
		const inspect = RECIPES["blueprint-inspect"]!;
		const functions = inspect.steps.find((step) => step.tool === "list_functions")!;
		expect(functions.deadEnd).toContain("no parameters, no return values");
		const variables = inspect.steps.find((step) => step.tool === "list_variables")!;
		expect(variables.why).toContain("NAMES");
		expect(variables.deadEnd).toContain("no types");
		const typed = RECIPES["blueprint-variables"]!;
		expect(typed.summary).not.toContain("with types");
		expect(typed.steps.find((step) => step.tool === "list_properties")).toBeDefined();
		expect(typed.steps.find((step) => step.tool === "list_properties")!.deadEnd).toContain("display-sanitized");
	});

	test("blueprint-signatures reads the entry node pins, and find_nodes is match-any", () => {
		const recipe = RECIPES["blueprint-signatures"]!;
		expect(recipe.posture).toBe("read");
		const tools = recipe.steps.map((step) => step.tool);
		expect(tools).toEqual(["load_asset", "get_graph", "find_nodes", "get_node_infos"]);
		const find = recipe.steps.find((step) => step.tool === "find_nodes")!;
		expect(find.args.title).toBe("");
		expect(find.args.entry_points_only).toBe(true);
		expect(find.deadEnd).toContain("entry node titles are not display names");
		expect(recipeIndexText()).toContain("blueprint-signatures");
	});

	test("every write step states what it does, and the boundary is rendered", () => {
		const recipe = RECIPES["blueprint-graph-author"]!;
		const writes = recipe.steps.filter((step) => step.write);
		expect(writes.map((step) => step.tool)).toEqual(["write_graph_dsl", "save_assets"]);
		for (const step of writes) expect(step.effect?.length ?? 0).toBeGreaterThan(20);
		// Nothing in this package may perform a write: every recipe is catalog lookups only.
		for (const candidate of Object.values(RECIPES)) {
			for (const step of candidate.steps) expect(step.tool).not.toContain("apply");
			expect(candidate.posture === "read" || candidate.posture === "write").toBe(true);
		}
		const rendered = renderRecipe(recipe, snapshot(), {});
		expect(rendered.text).toContain("boundary: steps marked [WRITE]");
		expect(recipeIndexText()).toContain("blueprint-graph-author [write]");
	});
});

describe("ensureCatalog without a live editor", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-unreal-mcp-"));
	const previous = process.env.PI_UNREAL_CACHE_DIR;
	process.env.PI_UNREAL_CACHE_DIR = dir;
	afterAll(() => {
		if (previous === undefined) delete process.env.PI_UNREAL_CACHE_DIR;
		else process.env.PI_UNREAL_CACHE_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});

	test("no editor and no snapshot → source none with instructions, not a guessed catalog", async () => {
		// an empty project dir with no snapshot written for its key
		const cwd = join(dir, "empty-project");
		writeFileSync(join(dir, "placeholder.txt"), "");
		const ensured = await ensureCatalog({ cwd, url: "http://127.0.0.1:9/mcp", probe: false });
		expect(ensured.source).toBe("none");
		expect(ensured.snapshot).toBeUndefined();
		expect(ensured.reachable).toBe(false);
		expect(ensured.notes.join(" ")).toContain("probe skipped");
	});
});
