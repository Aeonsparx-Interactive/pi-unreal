import { expect, test } from "bun:test";
import extension from "../extensions/unreal/index.ts";

/* Wiring smoke: drive the extension factory with a recording stub, so a broken registration
   (missing schema, typo'd tool name, unregistered handler) fails here instead of in a live
   Pi session. */

type Recorded = {
	tools: string[];
	commands: string[];
	handlers: string[];
};

function stubApi(record: Recorded) {
	const api = {
		registerTool: (tool: { name: string; parameters?: unknown; execute?: unknown }) => {
			if (!tool.name) throw new Error("tool without a name");
			if (!tool.parameters) throw new Error(`tool ${tool.name} has no parameters schema`);
			if (typeof tool.execute !== "function") throw new Error(`tool ${tool.name} has no execute`);
			record.tools.push(tool.name);
		},
		registerCommand: (name: string, options: { handler?: unknown }) => {
			if (name.startsWith("/")) throw new Error(`command ${name} must be registered without the leading slash`);
			if (typeof options?.handler !== "function") throw new Error(`command ${name} has no handler`);
			record.commands.push(`/${name}`);
		},
		on: (event: string, handler: unknown) => {
			if (typeof handler !== "function") throw new Error(`handler for ${event} is not a function`);
			record.handlers.push(event);
		},
	} as never;
	return api;
}

test("registers the three Unreal tools", () => {
	const record: Recorded = { tools: [], commands: [], handlers: [] };
	extension(stubApi(record));
	expect(record.tools.sort()).toEqual([
		"unreal_context",
		"unreal_index",
		"unreal_plugin_inspect",
		"unreal_project_inspect",
		"unreal_resolve_engine",
		"unreal_symbol",
		"unreal_symbol_list",
	]);
});

test("registers the commands and the session/agent/gate handlers", () => {
	const record: Recorded = { tools: [], commands: [], handlers: [] };
	extension(stubApi(record));
	expect(record.commands.sort()).toEqual(["/unreal", "/unreal-cache", "/unreal-engines", "/unreal-module", "/unreal-symbol"]);
	expect(record.handlers).toContain("tool_call");
	expect(record.handlers).toContain("before_agent_start");
	expect(record.handlers).toContain("session_start");
});

test("every tool declares a read-only annotation and an output schema", () => {
	const registered: { name: string; annotations?: Record<string, boolean>; outputSchema?: unknown }[] = [];
	const api = {
		registerTool: (tool: { name: string; annotations?: Record<string, boolean>; outputSchema?: unknown }) => registered.push(tool),
		registerCommand: () => undefined,
		on: () => undefined,
	} as never;
	extension(api);
	expect(registered.length).toBe(7);
	for (const tool of registered) {
		expect(tool.annotations?.readOnlyHint).toBe(true);
		expect(tool.annotations?.destructiveHint).toBe(false);
		expect(tool.outputSchema).toBeTruthy();
	}
});

test("tool prompts steer the agent away from guessing", () => {
	const registered: { name: string; promptSnippet?: string; promptGuidelines?: string[] }[] = [];
	const api = {
		registerTool: (tool: { name: string; promptSnippet?: string; promptGuidelines?: string[] }) => registered.push(tool),
		registerCommand: () => undefined,
		on: () => undefined,
	} as never;
	extension(api);
	const guidelines = registered.map((tool) => `${tool.promptSnippet} ${(tool.promptGuidelines ?? []).join(" ")}`).join("\n");
	expect(guidelines).toContain("guess");
	expect(guidelines).toContain("unresolved");
});
