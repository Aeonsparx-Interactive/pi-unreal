import { describe, expect, it } from "bun:test";
import { gateCall } from "../extensions/unreal/index.ts";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

const notices: { message: string; level: string | undefined }[] = [];

const ctx = {
	ui: {
		notify: (message: string, type?: string) => {
			notices.push({ message, level: type });
		},
	},
	cwd: "C:/proj",
} as unknown as ExtensionContext;

function editEvent(path: string): ToolCallEvent {
	return { type: "tool_call", toolCallId: "t", toolName: "edit", input: { path, edits: [{ oldText: "a", newText: "b" }] } } as unknown as ToolCallEvent;
}

function bashEvent(command: string): ToolCallEvent {
	return { type: "tool_call", toolCallId: "t", toolName: "bash", input: { command } } as unknown as ToolCallEvent;
}

describe("convention gate", () => {
	it("blocks text writes to cooked binary assets", () => {
		for (const path of ["C:/proj/Content/Foo/BAR.uasset", "C:/proj/Content/Maps/Main.umap"]) {
			const outcome = gateCall(editEvent(path), ctx);
			expect(outcome?.block).toBe(true);
			expect(outcome?.reason).toContain("cooked binary asset");
		}
		const writeEvent = { type: "tool_call", toolCallId: "t", toolName: "write", input: { path: "C:/proj/Content/X/U.uasset", content: "" } } as unknown as ToolCallEvent;
		expect(gateCall(writeEvent, ctx)?.block).toBe(true);
	});

	it("lets source and config edits through", () => {
		for (const path of ["C:/proj/Source/Lp/Lp.cpp", "C:/proj/Source/Lp.Target.cs", "C:/proj/Config/DefaultEngine.ini", "C:/proj/Plugins/X/X.uplugin"]) {
			expect(gateCall(editEvent(path), ctx, { editorRunning: true })).toBeUndefined();
		}
	});

	it("warns (does not block) when the editor is running and C++ is edited", () => {
		notices.length = 0;
		expect(gateCall(editEvent("C:/proj/Source/Lp/Private/Lp.cpp"), ctx, { editorRunning: true })).toBeUndefined();
		expect(notices).toHaveLength(1);
		expect(notices[0]?.level).toBe("warning");
		expect(notices[0]?.message).toContain("UnrealEngine-BuildProjectEditor");

		notices.length = 0;
		expect(gateCall(editEvent("C:/proj/Source/Lp/Private/Lp.cpp"), ctx, { editorRunning: false })).toBeUndefined();
		expect(notices).toHaveLength(0);

		// The header-only edit is also covered: UE live-coding cares about headers.
		notices.length = 0;
		gateCall(editEvent("C:/proj/Source/Lp/Public/Lp.h"), ctx, { editorRunning: true });
		expect(notices).toHaveLength(1);
	});

	it("blocks clang-format when it targets a C# build file", () => {
		const blocked = [
			"clang-format -i Source/Lp.Target.cs",
			"clang-format --style=file -i 'Source/Lp/Lp.Build.cs'",
			"pwsh -Command \"clang-format -i C:/proj/Source/Lp.Target.cs\"",
			"npx clang-format -i ../Lp.Target.cs",
		];
		for (const command of blocked) {
			const outcome = gateCall(bashEvent(command), ctx);
			expect(outcome?.block).toBe(true);
			expect(outcome?.reason).toContain("Lp.Target.cs");
		}
	});

	it("leaves legitimate clang-format and unrelated commands alone", () => {
		const allowed = [
			"clang-format -i Source/Lp/Private/Lp.cpp",
			"clang-format --style=file Source/Lp/Public/Lp.h",
			"pwsh -NoProfile -File Script/Dev/Format-Cpp.ps1 -All -Check",
			"git status",
			"grep -n clang-format README.md",
		];
		for (const command of allowed) {
			expect(gateCall(bashEvent(command), ctx)).toBeUndefined();
		}
	});

	it("ignores tools with no path or command input", () => {
		for (const toolName of ["read", "grep", "find", "ls"]) {
			const event = { type: "tool_call", toolCallId: "t", toolName, input: { path: "C:/proj/Content/Foo/BAR.uasset" } } as unknown as ToolCallEvent;
			expect(gateCall(event, ctx)).toBeUndefined();
		}
		expect(gateCall(bashEvent("echo hi"), ctx)).toBeUndefined();
	});
});
