import { describe, expect, it } from "bun:test";
import { buildQueryArgs } from "../extensions/unreal/lib/ubt.ts";

/**
 * 2026-11-11 field failure: `unreal_context` on a real project reported
 * "UnrealBuildTool Query produced no JSON", and UBT's own log said
 * `Couldn't find target rules file for target 'LpEditor' in rules assembly 'UE5Rules'`.
 * Cause: `ensureQueryJson` was called without `projectPath`, so `-Project=` never reached UBT and
 * a project target could not be resolved from the engine-only rule assembly.
 *
 * The args builder was always right; the caller dropped the path. So the regression is pinned on
 * the caller: every `ensureQueryJson` call in lib/ must hand it a project path.
 */
describe("UBT Query plumbing", () => {
	it("puts -Project= into the argument list when a project is known", () => {
		const args = buildQueryArgs({ query: "TargetDetails", target: "LpEditor", engineRoot: "C:/UE", platform: "Win64", configuration: "Development", projectPath: "C:/Lp/Lp.uproject", outputPath: "C:/tmp/out.json" });
		expect(args).toContain("-Project=C:/Lp/Lp.uproject");
		expect(args.indexOf("-Project=C:/Lp/Lp.uproject")).toBeGreaterThan(args.indexOf("-Configuration=Development"));
		expect(args.indexOf("-OutputPath=C:/tmp/out.json")).toBeGreaterThan(args.indexOf("-Project=C:/Lp/Lp.uproject"));
	});

	it("omits -Project= for an engine-only target", () => {
		const args = buildQueryArgs({ query: "TargetDetails", target: "UnrealEditor", engineRoot: "C:/UE", platform: "Win64", configuration: "Development", outputPath: "C:/tmp/out.json" });
		expect(args.some((arg) => arg.startsWith("-Project="))).toBe(false);
	});

	it("every ensureQueryJson caller passes projectPath", async () => {
		const source = await Bun.file(new URL("../extensions/unreal/lib/tools.ts", import.meta.url)).text();
		const calls = source.match(/ensureQueryJson\(\{[^}]*\}\)/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) expect(call).toContain("projectPath: workspace.projectPath");
	});
});
