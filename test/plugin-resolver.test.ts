import { afterAll, describe, expect, it } from "bun:test";
import { parseUproject } from "../extensions/unreal/lib/descriptors.ts";
import { readBuildVersion } from "../extensions/unreal/lib/descriptors.ts";
import {
	buildPluginIndex,
	computeScanDirs,
	resolvePluginReference,
	resolveProjectPlugins,
} from "../extensions/unreal/lib/plugin-resolver.ts";
import { realFs } from "../extensions/unreal/lib/util.ts";
import { ENGINE_A, PROJECT_DIR, FIXTURES, materializeFixtures, releaseFixtures } from "./helpers.ts";

// The fixture project's `AdditionalPluginDirectories` entry is an absolute scan root, so it is only
// meaningful inside a materialized copy (CI has no `C:/Users/...` tree). See test/helpers.ts.
const fx = materializeFixtures();
afterAll(() => releaseFixtures(fx));

async function fixtureIndex() {
	const descriptor = parseUproject(fx.project, realFs);
	const version = readBuildVersion(fx.engineA, realFs);
	const index = await buildPluginIndex({
		engineRoot: fx.engineA,
		projectDir: fx.projectDir,
		additionalPluginDirectories: descriptor.additionalPluginDirectories,
		fs: realFs,
	});
	return { descriptor, version, index };
}

describe("plugin-resolver", () => {
	it("scans Engine, Project, Mod, and External roots in build-tool order", () => {
		const dirs = computeScanDirs({
			engineRoot: ENGINE_A,
			projectDir: PROJECT_DIR,
			additionalPluginDirectories: [`${FIXTURES}/ProjDir/Extra`],
		});
		expect(dirs.map((entry) => entry.source)).toEqual(["Engine", "Project", "Mod", "External"]);
		expect(dirs.map((entry) => entry.dir)).toEqual([
			`${ENGINE_A}/Engine/Plugins`,
			`${PROJECT_DIR}/Plugins`,
			`${PROJECT_DIR}/Mods`,
			`${FIXTURES}/ProjDir/Extra`,
		]);
		expect(computeScanDirs({ engineRoot: undefined, projectDir: undefined })).toEqual([]);
	});

	it("indexes every .uplugin under the scan roots and skips build artefacts", async () => {
		const { index } = await fixtureIndex();
		const names = index.entries.map((entry) => `${entry.source}:${entry.name}`).sort();
		expect(names).toEqual([
			"Engine:Alpha",
			"Engine:Beta",
			"Engine:Legacy",
			"Engine:Shared",
			"External:ExtraPlug",
			"Mod:ModOnly",
			"Project:NoModules",
			"Project:Shared",
		]);
		// fast-glob ignore patterns keep Binaries/ and ThirdParty/ out of the index.
		expect(index.entries.some((entry) => entry.name === "Stale")).toBe(false);
		expect(index.entries.some((entry) => entry.name === "TP")).toBe(false);
		expect(index.scannedFiles).toBe(index.entries.length);
	});

	it("resolves each .uproject reference to a real .uplugin, with a status per case", async () => {
		const { descriptor, version, index } = await fixtureIndex();
		const results = resolveProjectPlugins(descriptor, index, version);
		const byName = new Map(results.map((result) => [result.name + (result.status === "disabled" ? ":off" : ""), result]));

		const alpha = byName.get("Alpha");
		expect(alpha?.status).toBe("resolved");
		expect(alpha?.plugin?.source).toBe("Engine");
		expect(alpha?.plugin?.modules[0]?.moduleName).toBe("Alpha");

		// Project plugin shadows the engine plugin of the same name.
		const shared = byName.get("Shared");
		expect(shared?.plugin?.source).toBe("Project");
		expect(shared?.plugin?.semVersion).toBe("2.0.0");
		expect(shared?.shadowed.map((entry) => `${entry.source}:${entry.semVersion}`)).toEqual(["Engine:1.2.0"]);
		expect(shared?.notes.join(" ")).toContain("shadow");

		expect(byName.get("Legacy")?.status).toBe("version-warning");
		expect(byName.get("Legacy")?.versionNote).toContain("5.7");
		expect(byName.get("Beta")?.status).toBe("beta");
		expect(byName.get("NoModules")?.status).toBe("no-modules");
		expect(byName.get("Ghost")?.status).toBe("missing");
		expect(byName.get("Ghost")?.notes.join(" ")).toContain("Optional");
		expect(byName.get("ModOnly")?.plugin?.source).toBe("Mod");
		expect(byName.get("ExtraPlug")?.plugin?.source).toBe("External");
		expect(byName.get("Alpha:off")?.status).toBe("disabled");
	});

	it("reports totals across all references", async () => {
		const { descriptor, version, index } = await fixtureIndex();
		const results = resolveProjectPlugins(descriptor, index, version);
		expect(results).toHaveLength(9);
		const statuses = results.map((result) => result.status);
		expect(statuses.filter((status) => status === "resolved")).toHaveLength(4);
		expect(statuses.filter((status) => status === "missing")).toHaveLength(1);
		expect(statuses.filter((status) => status === "disabled")).toHaveLength(1);
		expect(statuses.filter((status) => status === "version-warning")).toHaveLength(1);
		expect(statuses.filter((status) => status === "beta")).toHaveLength(1);
		expect(statuses.filter((status) => status === "no-modules")).toHaveLength(1);
	});

	it("attaches the plugin's own flags, including CanContainContent and EnabledByDefault", async () => {
		const { index } = await fixtureIndex();
		const alpha = index.byName.get("alpha")?.[0];
		expect(alpha?.enabledByDefault).toBe(true);
		expect(alpha?.canContainContent).toBe(false);
		expect(alpha?.installed).toBe(false);
		expect(alpha?.versionName).toBe("Release");
		expect(alpha?.version).toBe("1.0");

		const legacy = index.byName.get("legacy")?.[0];
		expect(legacy?.engineVersionRaw).toBe("5.7.0-0+UE5");
	});

	it("warns when a reference restricts target platforms", async () => {
		const { index } = await fixtureIndex();
		const result = resolvePluginReference(
			{
				name: "Alpha",
				enabled: true,
				optional: false,
				activate: false,
				semVersion: undefined,
				supportedTargetPlatforms: ["Linux"],
			},
			index,
			undefined,
			{ targetPlatform: "Windows" },
		);
		expect(result.status).toBe("resolved");
		expect(result.notes.join(" ")).toContain("SupportedTargetPlatforms [Linux], not Windows");
	});

	it("tolerates an empty index", async () => {
		const index = await buildPluginIndex({ engineRoot: `${FIXTURES}/Empty`, projectDir: `${FIXTURES}/Empty`, fs: realFs });
		expect(index.entries).toEqual([]);
		expect(resolvePluginReference(
			{ name: "Nothing", enabled: true, optional: true, activate: false, semVersion: undefined, supportedTargetPlatforms: [] },
			index,
			undefined,
		).notes.join(" ")).toContain("no plugin directories found");
	});
});
