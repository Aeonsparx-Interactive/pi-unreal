import { describe, expect, test } from "bun:test";
import { parseToolsetList, shortToolsetName } from "../extensions/unreal/lib/mcp-live.ts";
import { pythonTypeFor } from "../extensions/unreal/lib/mcp-catalog.ts";
import { findPyTool, findPyToolset, parseToolsetModule, reconcileWithLive, type PyIndex, type PyToolset } from "../extensions/unreal/lib/toolset-scan.ts";

/* ─────────────────────────────────────────── list_toolsets parsing (markdown, not a table) */

const LIVE_SHAPED_LIST = [
	"# Available Toolsets",
	"",
	"- editor_toolset.toolsets.blueprint.BlueprintTools: Provides tools for working with Blueprints.",
	"  Includes:",
	"  - Enum value lookups",
	"  - General usage information",
	"- AutomationTestToolset.AutomationTestToolset: Tools for running automation tests.",
	"- EditorToolset.EditorAppToolset: Introspection and control of the editor application itself.",
	"  Runtime state and console behaviour.",
]
	.join("\n");

describe("parseToolsetList", () => {
	test("only `- dotted.name: …` lines are toolsets; the description's own bullets are not", () => {
		const entries = parseToolsetList(LIVE_SHAPED_LIST);
		expect(entries.map((entry) => entry.name)).toEqual([
			"editor_toolset.toolsets.blueprint.BlueprintTools",
			"AutomationTestToolset.AutomationTestToolset",
			"EditorToolset.EditorAppToolset",
		]);
		// `- Enum value lookups` must not become a toolset called "Enum"
		expect(entries.some((entry) => entry.name === "Enum")).toBe(false);
		expect(shortToolsetName(entries[0]!.name)).toBe("BlueprintTools");
	});

	test("continuation lines are folded into the previous description", () => {
		const app = parseToolsetList(LIVE_SHAPED_LIST).find((entry) => entry.short === "EditorAppToolset")!;
		expect(app.description).toContain("Introspection");
		expect(app.description).toContain("Runtime state and console behaviour.");
	});

	test("falls back to a colon-anchored identifier when no toolset name is dotted", () => {
		const entries = parseToolsetList("- BlueprintTools: Blueprint things\n- Enum: not a toolset line? it is here");
		expect(entries.map((entry) => entry.name)).toEqual(["BlueprintTools", "Enum"]);
	});

	test("a payload without a colon produces no toolsets instead of noise", () => {
		expect(parseToolsetList("- just a bullet\n- another bullet")).toEqual([]);
	});
});

/* ─────────────────────────────────────────────── engine class path → Unreal Python type */

describe("pythonTypeFor", () => {
	test("every reflected class is unreal.<ClassName>", () => {
		expect(pythonTypeFor("/Script/Engine.Blueprint")).toBe("unreal.Blueprint");
		expect(pythonTypeFor("/Script/CoreUObject.Class")).toBe("unreal.Class");
		expect(pythonTypeFor("/Script/CoreUObject.Object")).toBe("unreal.Object");
		expect(pythonTypeFor("/Script/UMG.UserWidget")).toBe("unreal.UserWidget");
	});

	test("no ref type means no name", () => {
		expect(pythonTypeFor(undefined)).toBeUndefined();
	});
});

/* ─────────────────────────────────────────── the toolset plugin's Python, as source of record */

const MODULE = `import unreal
from toolset_registry import toolset_registry


@unreal.uclass()
class BlueprintTools(unreal.ToolsetDefinition):
    """Provides tools for working with Blueprints."""

    @toolset_registry.tool_call
    @staticmethod
    def get_parent(blueprint: unreal.Blueprint) -> unreal.Class:
        """Returns the parent class of a Blueprint.

        Args:
            blueprint: The blueprint to inspect.
        """
        return blueprint.get_editor_property("parent_class")

    @toolset_registry.tool_call
    @staticmethod
    def find_nodes(
        graph: unreal.EdGraph,
        title: str,
        entry_points_only: bool = False,
    ) -> list[unreal.EdGraphNode]:
        """Finds nodes in a graph by title."""
        return []

    def helper(self):
        """Not a tool: no decorator."""


class NotAToolset(unreal.Object):
    @toolset_registry.tool_call
    @staticmethod
    def still_not_a_tool() -> None:
        """A decorated method outside a ToolsetDefinition class."""
`;

describe("parseToolsetModule", () => {
	const toolsets = parseToolsetModule(MODULE, { module: "editor_toolset.toolsets.blueprint", plugin: "EditorToolset", file: "/engine/blueprint.py" });

	test("one entry per ToolsetDefinition class, named module.ClassName", () => {
		expect(toolsets.map((toolset) => toolset.name)).toEqual(["editor_toolset.toolsets.blueprint.BlueprintTools"]);
		expect(toolsets[0]!.className).toBe("BlueprintTools");
		expect(toolsets[0]!.plugin).toBe("EditorToolset");
		expect(toolsets[0]!.doc).toBe("Provides tools for working with Blueprints.");
	});

	test("tool methods are the decorated ones only", () => {
		expect(toolsets[0]!.tools.map((tool) => tool.name)).toEqual(["get_parent", "find_nodes"]);
	});

	test("a multi-line signature is joined into one readable Python line", () => {
		const findNodes = toolsets[0]!.tools[1]!;
		expect(findNodes.signature).toBe("def find_nodes(graph: unreal.EdGraph, title: str, entry_points_only: bool = False) -> list[unreal.EdGraphNode]:");
		expect(findNodes.signature).not.toContain("\n");
		expect(findNodes.signature).toContain("entry_points_only: bool = False");
	});

	test("locations are 1-based source lines of the `def`", () => {
		expect(toolsets[0]!.tools[0]!.line).toBe(11);
		expect(toolsets[0]!.line).toBe(6);
	});

	test("docstring first line becomes the summary", () => {
		expect(toolsets[0]!.tools[0]!.summary).toBe("Returns the parent class of a Blueprint.");
		expect(toolsets[0]!.tools[1]!.summary).toBe("Finds nodes in a graph by title.");
	});
});

/* ────────────────────────────────────────────────────────── name lookup inside the index */

const fakeIndex: PyIndex = {
	schema: 1,
	key: "k",
	scannedAtMs: 0,
	elapsedMs: 1,
	roots: [],
	files: 1,
	warnings: [],
	toolsets: [
		{ name: "editor_toolset.toolsets.blueprint.BlueprintTools", module: "editor_toolset.toolsets.blueprint", className: "BlueprintTools", plugin: "EditorToolset", file: "/e/blueprint.py", line: 172, doc: "", tools: [{ name: "get_parent", line: 180, signature: "def get_parent(blueprint: unreal.Blueprint) -> unreal.Class:", summary: "" }] },
		{ name: "editor_toolset.toolsets.material.MaterialTools", module: "editor_toolset.toolsets.material", className: "MaterialTools", plugin: "EditorToolset", file: "/e/material.py", line: 9, doc: "", tools: [{ name: "create", line: 20, signature: "def create(...)", summary: "" }] },
	],
};

describe("python index lookup", () => {
	test("a toolset is found by class, full name, or without the Tools suffix", () => {
		expect(findPyToolset(fakeIndex, "BlueprintTools")?.className).toBe("BlueprintTools");
		expect(findPyToolset(fakeIndex, "editor_toolset.toolsets.blueprint.BlueprintTools")?.className).toBe("BlueprintTools");
		expect(findPyToolset(fakeIndex, "blueprint")?.className).toBe("BlueprintTools");
		expect(findPyToolset(fakeIndex, "NiagaraTools")).toBeUndefined();
	});

	test("a tool name is found across toolsets, with its definition", () => {
		const hits = findPyTool(fakeIndex, "create");
		expect(hits.map((hit) => hit.toolset.className)).toEqual(["MaterialTools"]);
		expect(hits[0]!.tool.line).toBe(20);
		expect(findPyTool(fakeIndex, "BlueprintTools.get_parent")[0]!.tool.line).toBe(180);
	});
});

/* ──────────────────────────────────────── on disk vs mounted: the claim this tool must not fake */

describe("reconcileWithLive", () => {
	const mounted = [
		{ name: "editor_toolset.toolsets.blueprint.BlueprintTools", tools: ["get_parent"] },
		{ name: "EditorToolset.LogsToolset" },
	];

	test("splits on-disk-only from mounted-only and matches the rest", () => {
		const parity = reconcileWithLive(fakeIndex, mounted);
		expect(parity.matched.map((entry) => entry.toolset.className)).toEqual(["BlueprintTools"]);
		expect(parity.onDiskOnly.map((toolset) => toolset.className)).toEqual(["MaterialTools"]);
		expect(parity.mountedOnly).toEqual(["EditorToolset.LogsToolset"]);
		expect(parity.matched[0]!.missingTools).toEqual([]);
	});

	test("a mounted name with no tool list claims no drift", () => {
		const parity = reconcileWithLive(fakeIndex, [{ name: "editor_toolset.toolsets.blueprint.BlueprintTools" }]);
		expect(parity.matched[0]!.missingTools).toEqual([]);
	});

	test("a real drift is reported by name", () => {
		const parity = reconcileWithLive(fakeIndex, [{ name: "editor_toolset.toolsets.blueprint.BlueprintTools", tools: ["create"] }]);
		expect(parity.matched[0]!.missingTools).toEqual(["get_parent"]);
	});
});

describe("pyToolsetText", () => {
	test("renders file:line rows the Read tool can open", async () => {
		const { pyToolsetText } = await import("../extensions/unreal/lib/toolset-scan.ts");
		const toolset: PyToolset = fakeIndex.toolsets[0]!;
		const text = pyToolsetText(toolset);
		expect(text).toContain("BlueprintTools  (EditorToolset)  /e/blueprint.py:172");
		expect(text).toContain("def get_parent(blueprint: unreal.Blueprint) -> unreal.Class:");
		expect(text).toContain("line 180");
	});
});
