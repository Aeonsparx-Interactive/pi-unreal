import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	buildHeaderIndex,
	classifyRoot,
	headerKeyFor,
	lookupHeaderPaths,
	listHeaderIndexes,
	moduleFromBuildCs,
	pickHeaderIndex,
	pickModuleName,
	rootKindsNote,
	suggestFileNames,
	suggestHeaderPaths,
	summarizeRootKinds,
	buildIndex,
	indexKeyFor,
	lookupSymbol,
	pickIndex,
	listIndexes,
	HEADER_VERSION,
} from "../extensions/unreal/lib/store.ts";
import { assembleRoots } from "../extensions/unreal/lib/store.ts";
import { moduleAvailability, scopeForPath, zeroResultNotes, type Workspace } from "../extensions/unreal/lib/tools.ts";

// Header and symbol indexes write under the machine cache dir; tests must not touch it.
process.env.PI_UNREAL_CACHE_DIR = mkdtempSync(join(tmpdir(), "pi-unreal-coverage-cache-"));

const TREE = mkdtempSync(join(tmpdir(), "pi-unreal-coverage-src-")).split("\\").join("/");

/**
 * A fake engine + project tree shaped like an installed UE 5.8 layout. The names are the ones the
 * field findings actually failed on: a module directory leaf (`Runtime`) that is not the module name
 * (`PoseSearch`), and plugin-shipped types the project does not reference.
 */
const ENGINE = `${TREE}/engine-install`;
const PROJECT = `${TREE}/projects/FakeGame`;

function file(path: string, text = ""): string {
	mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
	writeFileSync(path, text, "utf8");
	return path;
}

file(`${PROJECT}/Source/FakeGame/FakeGame.Build.cs`, "// project module\n");
file(`${PROJECT}/Source/FakeGame/Public/FakePawn.h`, "UCLASS()\nclass FAKEGAME_API AFakePawn : public AActor\n{\n\tGENERATED_BODY()\n};\n");
file(`${PROJECT}/Source/FakeGame/Private/FakePawn.cpp`, "void FakePawnTick() {}\n");

// Leaf 'Runtime', module 'PoseSearch': the §4.1 attribution failure.
file(`${ENGINE}/Engine/Plugins/Animation/PoseSearch/Source/Runtime/PoseSearch.Build.cs`, "// leaf Runtime, module PoseSearch\n");
file(`${ENGINE}/Engine/Plugins/Animation/PoseSearch/Source/Runtime/Public/PoseSearch/PoseSearchResult.h`, "USTRUCT()\nstruct POSESEARCH_API FSearchResults\n{\n\tGENERATED_BODY()\n};\n");
file(`${ENGINE}/Engine/Plugins/Animation/PoseSearch/Source/Runtime/Private/PoseSearch/PoseSearchResult.cpp`, "void PoseSearchImpl() {}\n");
file(`${ENGINE}/Engine/Plugins/Animation/PoseSearch/PoseSearch.uplugin`, JSON.stringify({ Name: "PoseSearch", Modules: [{ Name: "PoseSearch", Type: "Runtime" }] }));

// A plugin the project does not reference: PhysicsControl.
file(`${ENGINE}/Engine/Plugins/Animation/PhysicsControl/Source/PhysicsControl/PhysicsControl.Build.cs`, "// leaf == module here\n");
file(`${ENGINE}/Engine/Plugins/Animation/PhysicsControl/Source/PhysicsControl/Public/PhysicsControlComponent.h`, "UCLASS()\nclass PHYSICSCONTROL_API UPhysicsControlComponent : public USceneComponent\n{\n\tGENERATED_BODY()\n};\n");

// An engine's own source area.
file(`${ENGINE}/Engine/Source/Runtime/Engine/Engine.Build.cs`, "// engine module Engine\n");
file(`${ENGINE}/Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h`, "UCLASS()\nclass ENGINE_API AActor : public UObject\n{\n\tGENERATED_BODY()\n};\n");

const POSE_MODULE = `${ENGINE}/Engine/Plugins/Animation/PoseSearch/Source/Runtime`;
const PHYSICS_MODULE = `${ENGINE}/Engine/Plugins/Animation/PhysicsControl/Source/PhysicsControl`;
const ENGINE_AREA = `${ENGINE}/Engine/Source/Runtime/Engine`;
const PROJECT_MODULE = `${PROJECT}/Source/FakeGame`;

const workspace: Workspace = {
	cwd: PROJECT,
	projectPath: `${PROJECT}/FakeGame.uproject`,
	projectDir: PROJECT,
	projectName: "FakeGame",
	engineRoot: ENGINE,
	pluginDirs: [`${ENGINE}/Engine/Plugins/Animation/PoseSearch`],
	pluginModuleNames: { [`${ENGINE}/Engine/Plugins/Animation/PoseSearch`]: ["PoseSearch", "PoseSearchEditor"] },
	pluginRefs: [{ name: "PoseSearch", status: "resolved", shadowed: [], notes: [] }],
	plugins: [
		{
			name: "PoseSearch",
			path: `${ENGINE}/Engine/Plugins/Animation/PoseSearch/PoseSearch.uplugin`,
			dir: `${ENGINE}/Engine/Plugins/Animation/PoseSearch`,
			source: "Engine",
			enabledByDefault: false,
			canContainContent: false,
			isBetaVersion: false,
			installed: true,
			supportedTargetPlatforms: [],
			modules: [{ moduleName: "PoseSearch", type: "Runtime" }],
			plugins: [],
			diagnostics: [],
		},
		{
			name: "PhysicsControl",
			path: `${ENGINE}/Engine/Plugins/Animation/PhysicsControl/PhysicsControl.uplugin`,
			dir: `${ENGINE}/Engine/Plugins/Animation/PhysicsControl`,
			source: "Engine",
			enabledByDefault: false,
			canContainContent: true,
			isBetaVersion: false,
			installed: true,
			supportedTargetPlatforms: [],
			modules: [{ moduleName: "PhysicsControl", type: "Runtime" }],
			plugins: [],
			diagnostics: [],
		},
	],
	notes: [],
};

describe("root kinds (what an index actually covers)", () => {
	it("classifies project, engine-source and engine-plugin roots", () => {
		const options = { projectRoot: PROJECT, engineRoot: ENGINE };
		expect(classifyRoot(PROJECT_MODULE, options)).toBe("project");
		expect(classifyRoot(POSE_MODULE, options)).toBe("engine-plugin");
		expect(classifyRoot(ENGINE_AREA, options)).toBe("engine-source");
		expect(classifyRoot(`${TREE}/stranger/Source/X`, options)).toBe("other-plugin");
	});

	it("summarises and phrases the kinds so a 0-row answer can name them", () => {
		const roots = [PROJECT_MODULE, POSE_MODULE, PHYSICS_MODULE, ENGINE_AREA];
		const kinds = summarizeRootKinds(roots, { projectRoot: PROJECT, engineRoot: ENGINE });
		expect(new Map(kinds.map((entry) => [entry.kind, entry.count]))).toEqual(
			new Map([
				["engine-plugin", 2],
				["engine-source", 1],
				["project", 1],
			]),
		);
		const note = rootKindsNote(roots, { projectRoot: PROJECT, engineRoot: ENGINE });
		expect(note).toContain("2 engine-plugin root(s)");
		expect(note).toContain("1 project root(s)");
		expect(rootKindsNote([])).toBe("no roots");
	});
});

describe("module naming (§4.1: leaf is not the module)", () => {
	it("names a module after its *.Build.cs file, not the directory leaf", () => {
		expect(moduleFromBuildCs(`${POSE_MODULE}/Public/PoseSearch/PoseSearchResult.h`)).toBe("PoseSearch");
		expect(moduleFromBuildCs(`${PHYSICS_MODULE}/Public/PhysicsControlComponent.h`)).toBe("PhysicsControl");
		expect(moduleFromBuildCs(`${ENGINE_AREA}/Classes/GameFramework/Actor.h`)).toBe("Engine");
	});

	it("uses the .uplugin module names when a directory holds several Build.cs files", () => {
		expect(pickModuleName(["Runtime"], "Runtime")).toBe("Runtime");
		expect(pickModuleName(["WireInterfaceCore", "WireInterfaceEditor"], "WireInterface", ["WireInterfaceEditor"])).toBe("WireInterfaceEditor");
		expect(pickModuleName(["Foo", "Bar"], "Foo")).toBe("Foo");
		expect(pickModuleName(["Zeta", "Alpha"], "Missing")).toBe("Zeta");
	});

	it("engineAreas address Engine/Plugins subtrees and name roots by Build.cs", () => {
		const engine = assembleRoots({ engineRoot: ENGINE, includeEngine: true, engineAreas: ["Plugins/Animation/PoseSearch", "Runtime/Engine"] });
		const byDir = new Map(engine.roots.map((root) => [root.dir.replace(/\\/g, "/"), root]));
		expect(byDir.get(POSE_MODULE)?.module).toBe("PoseSearch");
		expect(byDir.get(POSE_MODULE)?.scope).toBe("Engine");
		expect(byDir.get(ENGINE_AREA)?.module).toBe("Engine");
		expect(engine.notes.join(" | ")).toContain("engine Plugins/Animation/PoseSearch: 1 module root(s)");
	});

	it("plugin roots take their declared module names", () => {
		const roots = assembleRoots({ projectRoot: PROJECT, pluginDirs: [`${ENGINE}/Engine/Plugins/Animation/PoseSearch`], pluginModuleNames: workspace.pluginModuleNames });
		const dirs = roots.roots.map((root) => ({ dir: root.dir.replace(/\\/g, "/"), module: root.module }));
		expect(dirs).toContainEqual({ dir: POSE_MODULE, module: "PoseSearch" });
		expect(dirs).toContainEqual({ dir: PROJECT_MODULE, module: "FakeGame" });
	});
});

describe("header (path-only) index", () => {
	it("keys by root set and never collides with a symbol key", () => {
		const a = headerKeyFor({ roots: [POSE_MODULE, PHYSICS_MODULE] });
		const b = headerKeyFor({ roots: [PHYSICS_MODULE, POSE_MODULE] });
		expect(a).toBe(b);
		expect(a.startsWith("hdr-")).toBe(true);
		expect(headerKeyFor({ roots: [POSE_MODULE] })).not.toBe(a);
	});

	it("answers exists / exact path / owning module from paths alone", async () => {
		const roots = assembleRoots({ engineRoot: ENGINE, includeEngine: true, engineAreas: ["Plugins", "Runtime/Engine"], pluginModuleNames: workspace.pluginModuleNames });
		const built = await buildHeaderIndex({ roots: roots.roots, engineRoot: ENGINE });
		expect(built.files).toBeGreaterThanOrEqual(3);
		const header = pickHeaderIndex(roots.roots.map((root) => root.dir));
		expect(header?.key).toBe(built.key);
		expect(header?.meta.rootKinds?.["engine-plugin"]).toBeGreaterThan(0);

		const physics = lookupHeaderPaths(header!, "PhysicsControlComponent.h");
		expect(physics[0]?.file).toBe(`${PHYSICS_MODULE}/Public/PhysicsControlComponent.h`);
		expect(physics[0]?.module).toBe("PhysicsControl");
		expect(physics[0]?.match).toBe("exact");

		const byPath = lookupHeaderPaths(header!, "PoseSearch/PoseSearchResult.h");
		expect(byPath.length).toBeGreaterThan(0);
		expect(byPath[0]?.file).toContain("PoseSearchResult.h");

		// An invented header: no exact row, and the answer is labelled as file names.
		const none = lookupHeaderPaths(header!, "MoverState.h");
		expect(none.filter((row) => row.match === "exact").length).toBe(0);
		const suggested = suggestHeaderPaths(header!, "PoseSearchResultTypes.h", { limit: 5 });
		expect(suggested.length).toBeGreaterThan(0);
		expect(suggested[0]?.file).toContain("PoseSearchResult.h");
		expect(lookupHeaderPaths(header!, "NothingLikeThisAtAll.h").length).toBe(0);
	});

	it("is listed with health, and an unknown root set picks nothing", async () => {
		const built = await buildHeaderIndex({ roots: [{ dir: POSE_MODULE, scope: "Engine" }], engineRoot: ENGINE });
		const listed = listHeaderIndexes();
		const entry = listed.find((header) => header.key === built.key);
		expect(entry?.healthy).toBe(true);
		expect(entry?.meta.version).toBe(HEADER_VERSION);
		expect(entry?.issues.length).toBe(0);
		expect(pickHeaderIndex([`${TREE}/does-not-exist`])).toBeUndefined();
	});
});

describe("the answer a 0-row lookup owes the caller", () => {
	it("names the roots scanned, the plugin gap, and the exact next call", () => {
		const notes = zeroResultNotes({
			query: "UMoverComponent",
			scope: "engine",
			workspace,
			coverage: [{ key: "idx-engine-defs-test", scope: "engine", kinds: "1 engine-source root(s), 1 engine-plugin root(s)", areas: ["Runtime"], roots: 2 }],
			indexes: [],
		});
		const text = notes.join("\n");
		expect(text).toContain("no definitions matched 'UMoverComponent' in scope 'engine'");
		expect(text).toContain("scanned engine index idx-engine-defs-test");
		expect(text).toContain("engine plugins on disk: 2, referenced by this .uproject: 1");
		expect(text).toContain('engineAreas ["Plugins"]');
		expect(text).toContain('unreal_index action "headers"');
	});

	it("for a project scope says engine sources were never scanned", () => {
		const notes = zeroResultNotes({ query: "AActor", scope: "project", workspace, coverage: [{ key: "idx-p", scope: "project", kinds: "1 project root(s)", areas: [], roots: 1 }], indexes: [] });
		expect(notes.join("\n")).toContain("engine sources are not scanned");
	});

	it("suggests real FILE names from the index and labels them as files", async () => {
		const built = await buildIndex({ key: "idx-coverage-test", mode: "definitions", roots: [{ dir: PROJECT_MODULE, scope: "Project", module: "FakeGame" }], projectRoot: PROJECT, projectName: "FakeGame" });
		const index = pickIndex({ key: built.key }).index!;
		expect(lookupSymbol(index, "AFakePawn").length).toBeGreaterThan(0);
		const rows = suggestFileNames(index, "FakePawnState.h", { limit: 5 });
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]?.file).toContain("FakePawn.h");
		expect(suggestFileNames(index, "NothingOfThisKind", { limit: 5 }).length).toBe(0);
	});
});

describe("module availability (§4.2: not referenced is not not available)", () => {
	const moduleRefs = new Map([
		["PoseSearch", { shortName: "PoseSearch", moduleDirectory: POSE_MODULE, intermediateDirectory: "", public: [], private: [], publicInclude: [], privateInclude: [], dynamicallyLoaded: [], circular: [], type: "Runtime" }],
		["PhysicsControl", { shortName: "PhysicsControl", moduleDirectory: PHYSICS_MODULE, intermediateDirectory: "", public: [], private: [], publicInclude: [], privateInclude: [], dynamicallyLoaded: [], circular: [], type: "Runtime" }],
	]);

	it("separates 'in the target graph' from 'referenced in .uproject'", () => {
		const pose = moduleAvailability({ workspace, moduleRefs, moduleName: "PoseSearch", target: "FakeGameEditor Win64 Development" });
		expect(pose.inTargetGraph).toBe(true);
		expect(pose.plugin).toBe("PoseSearch");
		expect(pose.referencedInUproject).toBe(true);
		expect(pose.notes.join("\n")).toContain("in FakeGameEditor Win64 Development module graph: yes");

		const physics = moduleAvailability({ workspace, moduleRefs, moduleName: "PhysicsControl", target: "FakeGameEditor Win64 Development" });
		expect(physics.inTargetGraph).toBe(true);
		expect(physics.referencedInUproject).toBe(false);
		expect(physics.notes.join("\n")).toContain("NOT referenced");
		expect(physics.notes.join("\n")).toContain("EnabledByDefault false");
	});

	it("says plainly when the graph has no entry at all", () => {
		const missing = moduleAvailability({ workspace, moduleRefs, moduleName: "StateTree", target: "FakeGameEditor Win64 Development" });
		expect(missing.inTargetGraph).toBe(false);
		expect(missing.notes.join("\n")).toContain("no — TargetModuleReferences has no entry for it");
	});
});

describe("scope by path shape (§4.3)", () => {
	it("treats Engine/Plugins paths as engine sources", () => {
		expect(scopeForPath(`${PHYSICS_MODULE}/Public/PhysicsControlComponent.h`, workspace)).toBe("engine");
		expect(scopeForPath(`${ENGINE}/Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h`, workspace)).toBe("engine");
		expect(scopeForPath(`${PROJECT}/Source/Runtime/Public/FakePawn.h`, workspace)).toBe("project");
		// Engine-shaped path, engine root not resolved: still engine, so the miss says the right thing.
		expect(scopeForPath("/anywhere/Engine/Plugins/X/Source/Y/Public/Z.h", { ...workspace, engineRoot: undefined, cwd: PROJECT })).toBe("engine");
	});
});

describe("sharded index write (the whole-Plugins scan is 1.24 M rows)", () => {
	// A real engine + all-plugin scan spills ~43 shards. Sorting per shard and merging is what keeps
	// peak memory bounded, and a merge that drops a shard is invisible in the row counts alone:
	// counted rows, short file. Assert the file, not the counter.
	const SRC = mkdtempSync(join(tmpdir(), "pi-unreal-shard-src-")).split("\\").join("/");
	mkdirSync(`${SRC}/Source/ShardGame/Public`, { recursive: true });
	writeFileSync(`${SRC}/Source/ShardGame/ShardGame.Build.cs`, "public class ShardGameModule : ModuleRules { }\n");
	const files = ["Alpha.h", "Beta.h", "Gamma.h", "Delta.h"];
	for (const [index, name] of files.entries()) {
		writeFileSync(
			`${SRC}/Source/ShardGame/Public/${name}`,
			[
				`#pragma once`,
				`USTRUCT()`,
				`struct FShard${index}First { int32 A; };`,
				`USTRUCT()`,
				`struct FShard${index}Second { int32 B; };`,
				`UCLASS()`,
				`class UShard${index}Actor { public: void Tick(); };`,
				`UPROPERTY()`,
				`int32 ShardProperty${index};`,
			].join("\n"),
		);
	}

	it("writes every counted row, in probe order, across shard boundaries", async () => {
		const key = indexKeyFor({ mode: "definitions", roots: [`${SRC}/Source/ShardGame`], scope: "Project" });
		const built = await buildIndex({ key, mode: "definitions", roots: [{ dir: `${SRC}/Source/ShardGame`, scope: "Project" }], projectRoot: SRC, projectName: "ShardGame", shardRows: 3 });
		expect(built.counts.symbols).toBeGreaterThan(10);

		const defsPath = built.meta.defsPath;
		const lines = readFileSync(defsPath, "utf8").split("\n").filter((line) => line.length > 0);
		const rows = lines.slice(1); // header
		expect(rows.length).toBe(built.counts.symbols);

		const probes = rows.map((row) => (row.split("\t")[0] ?? "").toLowerCase().replace(/[:\s]/g, ""));
		const sorted = [...probes].sort();
		expect(probes).toEqual(sorted);

		// Every symbol from every file survived the merge, including the alphabetically last one.
		const index = pickIndex({ key });
		expect(index.index).toBeDefined();
		for (const [index2] of files.entries()) {
			expect(lookupSymbol(index.index!, `FShard${index2}First`).length).toBe(1);
		}
		expect(lookupSymbol(index.index!, "UShard3Actor", { prefix: true }).length).toBeGreaterThan(0);
	});
});
