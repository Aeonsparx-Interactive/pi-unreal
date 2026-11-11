import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	DEFAULT_ENGINE_AREAS,
	loadIndex,
	areasFromEngineRoots,
	auditCache,
	buildHeaderIndex,
	buildIndex,
	collectCallSites,
	indexKeyFor,
	isLegacyEngineIndexKey,
	legacyEngineIndexKeyFor,
	listHeaderIndexes,
	listIndexes,
	listSymbols,
	findRowsByMember,
	lookupSymbol,
	moduleFromSourcePath,
	pickIndex,
	pruneCache,
	rootDeltaNote,
	suggestHeaderPaths,
	type ScanRoot,
} from "../extensions/unreal/lib/store.ts";
import {
	clangdSearchDirs,
	compileCommandFor,
	databasesIn,
	describeDatabase,
	installCompileDb,
	listCompileDbs,
	readClangdConfig,
	responseFileStatus,
} from "../extensions/unreal/lib/compiledb.ts";
import {
	callSitesReport,
	clangdHealthReport,
	compileDbReport,
	currentRootSets,
	ensureIndex,
	fileContext,
	indexStatus,
	pruneReport,
	resolveWorkspace,
	scopeIndexes,
	symbolLookup,
	zeroResultUhtNotes,
} from "../extensions/unreal/lib/tools.ts";
import { normalizePath, realFs } from "../extensions/unreal/lib/util.ts";
import { hostPlatform } from "../extensions/unreal/lib/ubt.ts";

/**
 * Acceptance tests for the 2026-10-28 session report (`tmp/reports/field-findings-2026-10-28.md`).
 *
 * Each case is the shape of the answer that session needed and did not get: an engine scan keyed by
 * the project's plugin roots, a `published: 0` payload that proves nothing, a header probe that ranked
 * a generic name above the plugin's own family, and 177 MB of cache no lookup could reach. The
 * fixture is a miniature UE install, so no real engine and no machine cache is touched.
 */

process.env.PI_UNREAL_CACHE_DIR = mkdtempSync(join(tmpdir(), "pi-unreal-field1028-cache-"));
const CACHE = normalizePath(process.env.PI_UNREAL_CACHE_DIR);
const TREE = normalizePath(mkdtempSync(join(tmpdir(), "pi-unreal-field1028-src-")));

function file(path: string, text = ""): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf8");
	return path;
}

const ENGINE = `${TREE}/engine`;
const PROJECT = `${TREE}/game`;

file(`${ENGINE}/Engine/Build/Build.version`, JSON.stringify({ MajorVersion: 5, MinorVersion: 8, PatchVersion: 3, Changelist: 0, CompatibleChangelist: 47537391, BuildVersion: 1234, UserVisibleVersion: "1.0.0", BuildConfiguration: "Development", TargetType: "Editor", Platform: "Windows", CommitName: "Fixture", BranchName: "UE5" }));
file(`${ENGINE}/Engine/Build/InstalledBuild.txt`, "installed\n");
file(`${ENGINE}/Engine/Binaries/Win64/UnrealEditor.version`, JSON.stringify({ Changelist: 0, CompatibleChangelist: 47537391 }));

// Engine sources: the declaring interface the report searched for, plus a plain engine type.
file(`${ENGINE}/Engine/Source/Runtime/Engine/Engine.Build.cs`, "// engine module\n");
file(`${ENGINE}/Engine/Source/Runtime/Engine/Classes/GameFramework/CharacterMovementComponent.h`, "UCLASS()\nclass ENGINE_API UCharacterMovementComponent : public UCharacterMovementBase\n{\n\tGENERATED_BODY()\n};\n");
file(`${ENGINE}/Engine/Source/Runtime/Engine/Private/GameFramework/Character.cpp`, "void ACharacterTick() {}\n");
file(`${ENGINE}/Engine/Source/Runtime/Mover/Mover.Build.cs`, "// module Mover\n");
file(`${ENGINE}/Engine/Source/Runtime/Mover/Public/Mover/SimulationTypes/MoverSimulationTypes.h`, "UINTERFACE()\nclass MOVER_API UIMoverInputProducerInterface : public UInterface\n{\n\tGENERATED_BODY()\n};\nclass MOVER_API IMoverInputProducerInterface\n{\n\tGENERATED_BODY()\npublic:\n\tvirtual void ProduceInput(int32 SimTimeMs, int32 Handle) {}\n};\n");

// A plugin the project does NOT reference: a header on disk no symbol-index root covers (§4.2).
file(`${ENGINE}/Engine/Plugins/Animation/PhysicsControl/Source/PhysicsControl/PhysicsControl.Build.cs`, "// module PhysicsControl\n");
file(`${ENGINE}/Engine/Plugins/Animation/PhysicsControl/Source/PhysicsControl/Public/PhysicsControlComponent.h`, "UCLASS()\nclass PHYSICSCONTROL_API UPhysicsControlComponent : public USceneComponent\n{\n\tGENERATED_BODY()\n};\n");
file(`${ENGINE}/Engine/Plugins/Animation/PhysicsControl/PhysicsControl.uplugin`, JSON.stringify({ Name: "PhysicsControl", EnabledByDefault: false, Modules: [{ Name: "PhysicsControl", Type: "Runtime" }] }));

// A referenced plugin carrying the header names §5's ranking test needs: a generic `MoverState.h`
// that used to beat the plugin's own `MoverStateTypes.h` for a `Mover*Types.h` probe.
file(`${ENGINE}/Engine/Plugins/Animation/Mover/Mover.uplugin`, JSON.stringify({ Name: "Mover", EnabledByDefault: true, Modules: [{ Name: "Mover", Type: "Runtime" }] }));
file(`${ENGINE}/Engine/Plugins/Animation/Mover/Source/Mover/Mover.Build.cs`, "// module Mover\n");
file(`${ENGINE}/Engine/Plugins/Animation/Mover/Source/Mover/Public/Mover/MoverState.h`, "USTRUCT()\nstruct MOVER_API FMoverState\n{\n\tGENERATED_BODY()\n};\n");
file(`${ENGINE}/Engine/Plugins/Animation/Mover/Source/Mover/Public/Mover/MoverStateTypes.h`, "USTRUCT()\nstruct MOVER_API FMoverStateTypes\n{\n\tGENERATED_BODY()\n};\n");
file(`${ENGINE}/Engine/Plugins/Animation/Mover/Source/Mover/Public/Mover/MoverStateTreeTypes.h`, "USTRUCT()\nstruct MOVER_API FMoverStateTreeTypes\n{\n\tGENERATED_BODY()\n};\n");
file(`${ENGINE}/Engine/Plugins/Animation/Mover/Source/Mover/Private/MoverState.cpp`, "void MoverStateImpl() {}\nvoid MoverCallSiteProbe() { CallProduceInput_Implementation(); }\n");

// BlendStack declares the member whose UHT thunk the report asked about (§8.1).
file(`${ENGINE}/Engine/Plugins/Animation/BlendStack/Source/BlendStack/BlendStack.Build.cs`, "// module BlendStack\n");
file(`${ENGINE}/Engine/Plugins/Animation/BlendStack/Source/BlendStack/Public/BlendStack/BlendStackTypes.h`, "UINTERFACE()\nclass BLEDSTACK_API UGameCharacterBase : public UInterface\n{\n\tGENERATED_BODY()\n};\nclass BLEDSTACK_API AGameCharacterBase\n{\n\tGENERATED_BODY()\npublic:\n\tvirtual void ProduceInput_Implementation(int32 SimTimeMs, int32 Handle) {}\n};\n");
// A BARE-scope `ProduceInput_Implementation` row, mirroring the live box
// (ChaosMover/…/ChaosPathedMovementControllerComponent.h:71). It is what made the live 0-row answer
// claim 'no implementer': lookupSymbol's exact pass matches this row, and its later passes only run
// when the exact pass is empty, so the qualified implementer rows were never reached.
file(`${ENGINE}/Engine/Plugins/Animation/Mover/Source/Mover/Public/Mover/MoverFreeThunk.h`, "MOVER_API void ProduceInput_Implementation(int32 SimTimeMs, int32 Handle);\n");
file(`${ENGINE}/Engine/Plugins/Animation/BlendStack/BlendStack.uplugin`, JSON.stringify({ Name: "BlendStack", EnabledByDefault: true, Modules: [{ Name: "BlendStack", Type: "Runtime" }] }));

// Unreferenced plugins carrying the §5 cap-test names (matched by generic 'Types' tokens only).
file(`${ENGINE}/Engine/Plugins/Performance/GameplayStateTree/Source/GameplayStateTree/GameplayStateTree.Build.cs`, "// module GameplayStateTree\n");
file(`${ENGINE}/Engine/Plugins/Performance/GameplayStateTree/Source/GameplayStateTree/Public/GameplayStateTreeTypes.h`, "USTRUCT()\nstruct GST_API FGameplayStateTreeTypes\n{\n\tGENERATED_BODY()\n};\n");
file(`${ENGINE}/Engine/Plugins/Performance/GameplayStateTree/GameplayStateTree.uplugin`, JSON.stringify({ Name: "GameplayStateTree", EnabledByDefault: false }));
file(`${ENGINE}/Engine/Plugins/Performance/StateTreeTools/Source/StateTreeTools/StateTreeTools.Build.cs`, "// module StateTreeTools\n");
file(`${ENGINE}/Engine/Plugins/Performance/StateTreeTools/Source/StateTreeTools/Public/StateTreeTypes.h`, "USTRUCT()\nstruct STT_API FStateTreeTypes\n{\n\tGENERATED_BODY()\n};\n");
file(`${ENGINE}/Engine/Plugins/Performance/StateTreeTools/StateTreeTools.uplugin`, JSON.stringify({ Name: "StateTreeTools", EnabledByDefault: false }));
file(`${ENGINE}/Engine/Plugins/Performance/ExtraTypes/Source/ExtraTypes/ExtraTypes.Build.cs`, "// module ExtraTypes\n");
file(`${ENGINE}/Engine/Plugins/Performance/ExtraTypes/Source/ExtraTypes/Public/ExtraTypes.h`, "USTRUCT()\nstruct ET_API FExtraTypes\n{\n\tGENERATED_BODY()\n};\n");
file(`${ENGINE}/Engine/Plugins/Performance/ExtraTypes/ExtraTypes.uplugin`, JSON.stringify({ Name: "ExtraTypes", EnabledByDefault: false }));

// The project: the UHT implementer rows (§8.1) and the TU set a stale database is measured against.
file(`${PROJECT}/Source/Game/Game.Build.cs`, "// project module\n");
file(`${PROJECT}/Source/Game/Public/Character/LpMoverPawn.h`, "UCLASS()\nclass GAME_API ALpMoverPawn : public ACharacter\n{\n\tGENERATED_BODY()\npublic:\n\tvirtual void ProduceInput_Implementation(int32 SimTimeMs, int32 Handle);\n};\n");
file(`${PROJECT}/Source/Game/Private/Character/LpMoverPawn.cpp`, "void ALpMoverPawn::ProduceInput_Implementation(int32 SimTimeMs, int32 Handle) { CallMoverState(); }\n");
file(`${PROJECT}/Source/Game/Private/Character/LpHelpfulFunctions.cpp`, "int32 LpUnusedFunction() { return 0; }\nint32 InvokePawn(int32 t) { return ProduceInput_Implementation(t, 0); }\n");
file(`${PROJECT}/Source/Game.Target.cs`, "// target\n");
file(`${PROJECT}/Source/GameEditor.Target.cs`, "// editor target\n");
file(`${PROJECT}/.clangd`, "CompileFlags:\n  Compiler: clang-cl.exe\n  Add: [\"-std:c++20\"]\n  Remove: [/Yu*, /Fm*, /link]\n  CompilationDatabase: .vscode/unreal-clangd\nDiagnostics:\n  UnusedIncludes: None\n");
file(`${PROJECT}/.vscode/unreal-clangd/compile_commands.json`, JSON.stringify([{ file: `${PROJECT}/Source/Game/Private/Character/DeletedPawn.cpp`, directory: PROJECT, command: "clang-cl.exe /c Character/DeletedPawn.cpp" }], null, "\t"));
file(`${PROJECT}/.vscode/unreal-clangd/compileCommands_Game.0.rsp`, "-I\"Mover/Public\"\n-FI\"SharedPCH.h\"\n");
file(`${PROJECT}/Game.uproject`, JSON.stringify({ FileVersion: 3, EngineAssociation: ENGINE, Modules: [{ Name: "Game", Type: "Runtime", LoadingPhase: "Default" }], Plugins: [{ Name: "Mover", Enabled: true }, { Name: "BlendStack", Enabled: true }] }, null, "\t"));

const DEPS = { userEngineRoots: [ENGINE], env: {} as Record<string, string | undefined> };


function metaFile(key: string, meta: Record<string, unknown>): string {
	const dir = `${CACHE}/indexes/${key}`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/meta.json`, JSON.stringify({ defsPath: `${dir}/defs.tsv`, filesPath: `${dir}/files.tsv`, ...meta }), "utf8");
	writeFileSync(`${dir}/defs.tsv`, "FMock\tstruct\tEngine/Source/Runtime/Mover/Public/MoverSimulationTypes.h\t4\tMover\tEngine\t\n", "utf8");
	return dir;
}

let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
let projectKey = "";
let engineKey = "";

beforeAll(async () => {
	workspace = await resolveWorkspace(PROJECT, realFs, DEPS);
	projectKey = (await ensureIndex({ workspace, mode: "definitions", scope: "project", fs: realFs })).key;
	engineKey = (await ensureIndex({ workspace, mode: "definitions", scope: "engine", engineAreas: ["Runtime"], allowEngineBuild: true, fs: realFs })).key;
}, 120);

afterAll(() => {
	rmSync(TREE, { recursive: true, force: true });
	rmSync(CACHE, { recursive: true, force: true });
});

const ENGINE_SRC: string[] = [`${ENGINE}/Engine/Source/Runtime/Engine`];
const MOVER_PLUGIN_ROOT = `${ENGINE}/Engine/Plugins/Animation/Mover/Source/Mover`;
const PHYSICS_HEADER = `${ENGINE}/Engine/Plugins/Animation/PhysicsControl/Source/PhysicsControl/Public/PhysicsControlComponent.h`;

describe("engine index keys (§2, §10.1)", () => {
	it("is keyed by (engine root, areas): adding plugin roots keeps the key", () => {
		const before = indexKeyFor({ mode: "definitions", roots: ENGINE_SRC, scope: "Engine", engineRoot: ENGINE, areas: ["Runtime", "Plugins"] });
		const after = indexKeyFor({ mode: "definitions", roots: [...ENGINE_SRC, MOVER_PLUGIN_ROOT], scope: "Engine", engineRoot: ENGINE, areas: ["Runtime", "Plugins"] });
		expect(after).toBe(before);
	});

	it("treats a new areas set as a new key, and defaults areas to Runtime", () => {
		const runtime = indexKeyFor({ mode: "definitions", roots: ENGINE_SRC, scope: "Engine", engineRoot: ENGINE, areas: ["Runtime"] });
		const wide = indexKeyFor({ mode: "definitions", roots: ENGINE_SRC, scope: "Engine", engineRoot: ENGINE, areas: ["Runtime", "Plugins"] });
		expect(runtime).not.toBe(wide);
		expect(indexKeyFor({ mode: "definitions", roots: ENGINE_SRC, scope: "Engine", engineRoot: ENGINE })).toBe(runtime);
	});

	it("keeps fingerprinting roots for project scope", () => {
		const a = indexKeyFor({ mode: "definitions", roots: [`${PROJECT}/Source/Game`], scope: "Project" });
		const b = indexKeyFor({ mode: "definitions", roots: [`${PROJECT}/Source/Game`, MOVER_PLUGIN_ROOT], scope: "Project" });
		expect(a).not.toBe(b);
	});

	it("names the pre-1.2 key shape so the audit can reclaim what it orphaned", () => {
		const roots = [...ENGINE_SRC, MOVER_PLUGIN_ROOT];
		const legacy = legacyEngineIndexKeyFor("definitions", roots);
		expect(legacy).toBe(indexKeyFor({ mode: "definitions", roots, scope: "Engine" }));
		expect(isLegacyEngineIndexKey(legacy, { scope: "Engine", roots })).toBe(true);
		expect(isLegacyEngineIndexKey(engineKey, { scope: "Engine", roots })).toBe(false);
	});

	it("reports the root delta of a same-scope index it will not reuse", () => {
		const want = [`${PROJECT}/Source/Game`, `${ENGINE}/Engine/Plugins/Animation/Mover/Source/Mover`];
		const state = { key: "idx-a", dir: "idx-a", ageMs: 0, healthy: true, issues: [], meta: { version: 6, key: "idx-a", mode: "definitions", generatedAt: new Date().toISOString(), roots: [`${PROJECT}/Source/Game`], counts: { files: 0, symbols: 0, includes: 0, modules: 0 }, defsByKind: {}, sizeBytes: 0 } };
		expect(rootDeltaNote(state as never, want)).toContain("missing 1 of this call's root(s)");
		expect(rootDeltaNote(state as never, [`${PROJECT}/Source/Game`])).toContain("same root set");
		const pick = pickIndex({ mode: "definitions", scope: "Project", roots: [`${PROJECT}/Source/Game`], engineRoot: undefined });
		const text = pick.notes.join("\n");
		expect(text).toContain("near miss");
		expect(text).toContain("reuse requires the same root set");
	});

	it("drops project plugin roots from engine-scope root assembly", () => {
		const sets = currentRootSets(workspace);
		expect(sets.project.some((dir) => dir.includes("/Engine/Plugins/"))).toBe(true);
		expect(sets.engine.length).toBeGreaterThan(0);
		expect(sets.engine.some((dir) => dir.includes("/Engine/Plugins/"))).toBe(false);
		expect(sets.engine.every((dir) => dir.startsWith(ENGINE))).toBe(true);
	});

	it("recomputes areas from stored roots so legacy metas still answer", () => {
		expect(areasFromEngineRoots(ENGINE, [`${ENGINE}/Engine/Source/Runtime`, `${ENGINE}/Engine/Source/Runtime/Engine`])).toEqual(["Runtime"]);
		expect(areasFromEngineRoots(ENGINE, [`${ENGINE}/Engine/Plugins/Animation/Mover/Source/Mover`])).toEqual(["Plugins"]);
		expect(areasFromEngineRoots(ENGINE, [`${PROJECT}/Source/Game`])).toBeUndefined();
	});
});

describe("union answers (§2, §10.2)", () => {
	it("answers a plugin-shipped type for scope 'engine' from the project index, naming both halves", async () => {
		const answer = await symbolLookup({ cwd: PROJECT, query: "FMoverStateTypes", scope: "engine", fs: realFs, deps: DEPS });
		expect(answer.results.length).toBeGreaterThan(0);
		const text = answer.notes.join("\n");
		expect(text).toContain("project index");
		expect(text).toContain("engine index");
		expect(answer.indexes.some((row) => row.scope === "project")).toBe(true);
	});

	it("answers scope 'all' from both halves and names each", async () => {
		const answer = await symbolLookup({ cwd: PROJECT, query: "UCharacterMovementComponent", scope: "all", fs: realFs, deps: DEPS });
		expect(answer.results.length).toBeGreaterThan(0);
		expect(answer.coverage.map((row) => row.scope)).toContain("engine");
		expect(answer.coverage.map((row) => row.scope)).toContain("project");
	});

	it("the engine half is the (engineRoot, areas) key, never a roots-derived one", async () => {
		const handles = await scopeIndexes({ workspace, mode: "definitions", scope: "engine", engineAreas: ["Runtime"], allowEngineBuild: true, fs: realFs });
		expect(handles.map((handle) => handle.key)).toEqual([projectKey, engineKey]);
		expect(handles[1]!.roots.every((root) => !root.dir.includes("/Engine/Plugins/"))).toBe(true);
	});
});

describe("header index (§4, §5, §10.4-§10.5)", () => {
	it("resolves a module from a path shape a Build.cs route cannot reach", () => {
		expect(moduleFromSourcePath(PHYSICS_HEADER)).toBe("PhysicsControl");
		expect(moduleFromSourcePath(`${PROJECT}/Source/Game/Private/Character/LpMoverPawn.cpp`)).toBe("Game");
		expect(moduleFromSourcePath(`${ENGINE}/Engine/Source/Runtime/Mover/Public/Mover/SimulationTypes/MoverSimulationTypes.h`)).toBe("Mover");
		expect(moduleFromSourcePath(`${ENGINE}/Engine/Source/Runtime/Mover/Public/Animation.cpp`)).toBe("Mover");
	});

	it("falls back to the header index when no engine index exists, with module, plugin, and target", async () => {
		const built = await buildHeaderIndex({ roots: [{ dir: `${ENGINE}/Engine/Plugins`, module: "", scope: "Engine" }], engineRoot: ENGINE, areas: ["Plugins"] });
		expect(built.files).toBeGreaterThan(0);
		const answer = await fileContext({ cwd: PROJECT, file: PHYSICS_HEADER, fs: realFs, deps: DEPS });
		const text = answer.notes.join("\n");
		expect(answer.headerOnly).toBe(true);
		expect(answer.module).toBe("PhysicsControl");
		expect(answer.pluginName).toBe("PhysicsControl");
		expect(answer.enabledByDefault).toBe(false);
		expect(answer.referencedInUproject).toBe(false);
		expect(text).toContain("is not in any symbol-index root");
		expect(text).toContain(`header index ${built.key}`);
		expect(text).toContain("no engine symbol index for these roots");
		expect(text).toContain("refresh with unreal_index action build scope engine");
		expect(text).toContain(".uproject reference no");
		expect(text).toContain("target availability needs the Query cache");
		expect(answer.warnings.join("\n")).not.toContain("Build.cs");
	});

	it("ranks the plugin's own family above a generic name and says why (§10.5)", async () => {
		const built = await buildHeaderIndex({ roots: [{ dir: `${ENGINE}/Engine/Plugins`, module: "", scope: "Engine" }], engineRoot: ENGINE, areas: ["Plugins"] });
		const index = listHeaderIndexes().find((row) => row.key === built.key)!;
		const ranked = suggestHeaderPaths(index, "MoverStateTypes.h", { family: "Mover", limit: 12 });
		expect(ranked[0]!.file).toContain("MoverStateTypes.h");
		expect(ranked[0]!.reason).toContain("same stem");
		const second = ranked[1]!.file;
		expect(second.includes("MoverStateTreeTypes.h") || second.includes("MoverState.h")).toBe(true);
		expect(ranked.slice(0, 3).every((row) => row.file.includes("/Animation/Mover/"))).toBe(true);
		expect(ranked.some((row) => row.reason?.includes("plugin family"))).toBe(true);
	});

	it("caps unrelated-plugin rows at three and labels generic-token rows", async () => {
		const built = await buildHeaderIndex({ roots: [{ dir: `${ENGINE}/Engine/Plugins`, module: "", scope: "Engine" }], engineRoot: ENGINE, areas: ["Plugins"] });
		const index = listHeaderIndexes().find((row) => row.key === built.key)!;
		const ranked = suggestHeaderPaths(index, "MoverStateTypes.h", { family: "Mover", limit: 20, maxUnrelatedFamilies: 3 });
		const unrelated = ranked.filter((row) => !row.file.includes("/Animation/Mover/"));
		expect(unrelated.length).toBeLessThanOrEqual(3);
		expect(unrelated.length).toBeGreaterThan(0);
		expect(unrelated.every((row) => row.reason?.includes("generic name tokens only"))).toBe(true);
		expect(suggestHeaderPaths(index, "MoverStateTypes.h", { family: "Mover", limit: 20, maxUnrelatedFamilies: 9 }).length).toBeGreaterThan(unrelated.length);
	});
});

describe("UHT zero rows (§8, §10.6)", () => {
	it("names the declared member and the implementer route when a '_Implementation' query returns 0", async () => {
		const roots: ScanRoot[] = [{ dir: `${PROJECT}/Source/Game`, module: "Game", scope: "Project" }, { dir: `${ENGINE}/Engine/Source/Runtime`, module: "Runtime", scope: "Engine" }];
		const built = await buildIndex({ key: "idx-test-uht-defs", mode: "definitions", roots, projectRoot: PROJECT, engineRoot: ENGINE });
		const index = loadIndex(built.key)!;
		const notes = zeroResultUhtNotes("IMoverInputProducerInterface:ProduceInput_Implementation", [index]);
		const text = notes.join("\n");
		expect(notes.length).toBeGreaterThan(0);
		expect(text).toContain("UnrealHeaderTool-generated thunk");
		expect(text).toContain("unreal_symbol query 'IMoverInputProducerInterface:ProduceInput'");
		expect(text).toContain("ProduceInput_Implementation");
		expect(text).toContain("ALpMoverPawn:ProduceInput_Implementation");
	});
	it("scans QUALIFIED member rows even when a bare '_Implementation' row exists (lookupSymbol cannot)", async () => {
		const roots: ScanRoot[] = [{ dir: `${PROJECT}/Source/Game`, module: "Game", scope: "Project" }, { dir: `${ENGINE}/Engine/Plugins/Animation/BlendStack/Source`, module: "BlendStack", scope: "Engine" }, { dir: `${ENGINE}/Engine/Plugins/Animation/Mover/Source`, module: "Mover", scope: "Engine" }];
		const built = await buildIndex({ key: "idx-test-uht-qualified-defs", mode: "definitions", roots, projectRoot: PROJECT, engineRoot: ENGINE });
		const index = loadIndex(built.key)!;
		// In-header declarations are stored BARE (`ProduceInput_Implementation`), out-of-line definitions
		// QUALIFIED (`ALpMoverPawn:ProduceInput_Implementation`). lookupSymbol's exact pass matches the bare
		// run and its later passes only run when the exact pass is empty — so on a box that has a bare row
		// (live: ChaosMover's ChaosPathedMovementControllerComponent.h:71) the implementer rows are never
		// reached. That is the live bug the report measured as 'no implementer found'.
		const bare = lookupSymbol(index, "ProduceInput_Implementation", { limit: 50, substring: true });
		expect(bare.length).toBeGreaterThan(0);
		expect(bare.every((row) => !row.symbol.includes(":"))).toBe(true);
		// The qualified-member scan sees the rows the exact run hides.
		const qualified = findRowsByMember(index, "ProduceInput_Implementation", { limit: 50 });
		expect(qualified.length).toBeGreaterThan(0);
		expect(qualified.map((row) => row.symbol)).toContain("ALpMoverPawn:ProduceInput_Implementation");
		expect(qualified.every((row) => row.symbol.endsWith(":ProduceInput_Implementation"))).toBe(true);
		// And the 0-row answer now prints them.
		const text = zeroResultUhtNotes("IMoverInputProducerInterface:ProduceInput_Implementation", [index]).join("\n");
		expect(text).toContain("implementer rows found");
		expect(text).toContain("ALpMoverPawn:ProduceInput_Implementation");
	});

	it("stays silent for queries that are not a UHT implementation suffix", () => {
		const state = listIndexes().find((row) => row.key === projectKey)!;
		expect(zeroResultUhtNotes("FMoverStateTypes", [state])).toEqual([]);
		expect(zeroResultUhtNotes("ProduceInput_Implementation", [state])).toEqual([]);
	});
});

describe("call sites (§10.8)", () => {
	it("finds a definition and a mention in one module, labelled as candidates", async () => {
		const report = await collectCallSites({ roots: [{ dir: `${PROJECT}/Source/Game`, module: "Game", scope: "Project" }], symbol: "ProduceInput_Implementation" });
		expect(report.filesScanned).toBe(2);
		expect(report.rows.some((row) => row.kind === "definition (likely override)")).toBe(true);
		expect(report.rows.some((row) => row.kind === "call site / mention")).toBe(true);
		expect(report.modules).toEqual(["Game"]);
		expect(report.rows.every((row) => row.file.startsWith(PROJECT) || row.file.startsWith(`${ENGINE}/Engine/Plugins/Animation/Mover`))).toBe(true);
	});

	it("the tool-level report states the cost and the candidate label", async () => {
		const report = await callSitesReport({ cwd: PROJECT, symbol: "ProduceInput_Implementation", module: ["Game"], fs: realFs, deps: DEPS });
		const text = report.notes.join("\n");
		expect(report.rows.length).toBeGreaterThan(0);
		expect(text).toContain("text pass over");
		expect(text).toContain("candidates from a text pass, not call edges");
	});
});

describe("cache audit and prune (§7, §10.7)", () => {
	const DEAD = `${ENGINE}/Engine/Source/Runtime`;

	beforeAll(() => {
		metaFile("idx-engine-defs-deadformat00", { version: 4, key: "idx-engine-defs-deadformat00", mode: "definitions", scope: "Engine", engineRoot: ENGINE, roots: [DEAD], generatedAt: new Date(Date.now() - 90_000).toISOString() });
		metaFile("idx-engine-defs-superseded0000", { version: 6, key: "idx-engine-defs-superseded0000", mode: "definitions", scope: "Engine", engineRoot: ENGINE, roots: [DEAD], generatedAt: new Date(Date.now() - 90_000).toISOString() });
		mkdirSync(`${CACHE}/query/GameEditor`, { recursive: true });
		writeFileSync(`${CACHE}/query/GameEditor/TargetDetails.json`, "{}", "utf8");
		mkdirSync(`${CACHE}/compiledb/GameEditor.Win64.Development`, { recursive: true });
		writeFileSync(`${CACHE}/compiledb/GameEditor.Win64.Development/compile_commands.json`, "[]", "utf8");
	});

	it("classifies dead-format, superseded, and legacy-root-set entries as reclaimable", () => {
		const audit = auditCache();
		const byKey = new Map(audit.entries.map((entry) => [entry.key, entry]));
		expect(byKey.get("idx-engine-defs-deadformat00")!.reclaimable).toContain("format v4");
		const superseded = byKey.get("idx-engine-defs-superseded0000")!.reclaimable ?? "";
		expect(superseded).toContain("no lookup selects this entry");
		expect(byKey.get(projectKey)?.reclaimable).toBeFalsy();
		expect(byKey.get(engineKey)?.reclaimable).toBeFalsy();
		expect(byKey.get(listHeaderIndexes()[0]!.key)?.reclaimable).toBeFalsy();
		expect(audit.reclaimableBytes).toBeGreaterThan(0);
		expect(audit.notes.join("\n")).toContain("reclaimable");
	});

	it("reclaims the dead entries and keeps healthy indexes, headers, and the Query cache", () => {
		const result = pruneCache({});
		const removedKeys = result.removed.map((entry) => entry.key);
		expect(removedKeys).toContain("idx-engine-defs-deadformat00");
		expect(removedKeys).toContain("idx-engine-defs-superseded0000");
		expect(result.removed.every((entry) => entry.bytes > 0)).toBe(true);
		expect(listIndexes().map((row) => row.key)).toContain(projectKey);
		expect(listIndexes().map((row) => row.key)).toContain(engineKey);
		expect(listHeaderIndexes().length).toBeGreaterThan(0);
		expect(listCompileDbs().length).toBe(1);
		expect(result.notes.join("\n")).toContain("freed");
	});

	it("needs explicit flags for query/ and compiledb/, and never touches a header key (§7.4)", () => {
		const before = listHeaderIndexes().map((row) => row.key);
		const report = pruneReport({ query: true, compileDb: true });
		expect(listHeaderIndexes().map((row) => row.key)).toEqual(before);
		expect(listCompileDbs()).toHaveLength(0);
		expect(report.removed.some((entry) => entry.kind === "query")).toBe(true);
		expect(report.afterBytes).toBeLessThan(report.beforeBytes);
	});
});

describe("compile database and clangd wiring (§3, §6, §10.8)", () => {
	const LIVE_DIR = `${PROJECT}/.vscode/unreal-clangd`;
	const LIVE_DB = `${LIVE_DIR}/compile_commands.json`;

// The real box's state (field-findings 2026-10-28 §3): the database clangd reads is days old while
// the response file Epic's generator wrote beside it is current. Set here so every case that
// measures a live database starts from the same, self-contained staleness.
const STALE_DB = new Date(Date.now() - 9 * 86_400_000);
utimesSync(LIVE_DB, STALE_DB, STALE_DB);

	it("measures a database against the scope's real TU set", () => {
		const probe = `${CACHE}/compiledb/probe/compile_commands.json`;
		mkdirSync(`${CACHE}/compiledb/probe`, { recursive: true });
		writeFileSync(probe, JSON.stringify([
			{ file: `${PROJECT}/Source/Game/Private/Character/LpMoverPawn.cpp`, directory: PROJECT, command: "clang-cl.exe /c Character/LpMoverPawn.cpp" },
			{ file: `${PROJECT}/Source/Game/Private/Character/Gone.cpp`, directory: PROJECT, command: "clang-cl.exe /c Character/Gone.cpp" },
		]), "utf8");
		const coverage = describeDatabase(probe, [{ dir: `${PROJECT}/Source/Game`, module: "Game" }]);
		expect(coverage.tuCount).toBe(2);
		expect(coverage.coveredTus).toBe(1);
		expect(coverage.missingTus!.map((unit) => unit.file)).toEqual([`${PROJECT}/Source/Game/Private/Character/LpHelpfulFunctions.cpp`]);
		expect(coverage.entryFilesWithoutCommands).toEqual([`${PROJECT}/Source/Game/Private/Character/Gone.cpp`]);
	});

	it("reports the directory clangd reads, derived from the project's own .clangd", () => {
		const config = readClangdConfig(PROJECT, realFs);
		expect(config.compilationDatabase).toBe(".vscode/unreal-clangd");
		const search = clangdSearchDirs(PROJECT, config);
		expect(search.dirs).toEqual([LIVE_DIR]);
		expect(search.notes.join(" ")).toContain("clangd reads");
		expect(databasesIn(LIVE_DIR)).toEqual([LIVE_DB]);
	});

	it("tells a stale file list from current include paths (the §3 diagnosis)", () => {
		const db = describeDatabase(LIVE_DB);
		const rsp = responseFileStatus(LIVE_DIR, db.ageMs);
		expect(rsp.files).toHaveLength(1);
		expect(rsp.note).toContain("include paths are current");
		expect(rsp.note).toContain("the file list is not");
	});

	it("answers found|none for the file a diagnostics request named", () => {
		expect(compileCommandFor(LIVE_DB, `${PROJECT}/Source/Game/Private/Character/LpMoverPawn.cpp`).found).toBe(false);
		expect(compileCommandFor(LIVE_DB, `${PROJECT}/Source/Game/Private/Character/DeletedPawn.cpp`).found).toBe(true);
	});

	it("copies the generated database where clangd reads and prints the .clangd lines (acceptance 8)", () => {
		const generated = `${CACHE}/compiledb/GameEditor.Win64.Development/compile_commands.json`;
		mkdirSync(`${CACHE}/compiledb/GameEditor.Win64.Development`, { recursive: true });
		writeFileSync(generated, JSON.stringify([{ file: `${PROJECT}/Source/Game/Private/Character/LpMoverPawn.cpp`, directory: PROJECT, command: "clang-cl.exe /c Character/LpMoverPawn.cpp" }]), "utf8");
		// A side directory: installing over the fixture's live database would silently rewrite the
		// starting state the coverage tests below measure.
		const dest = `${PROJECT}/.vscode/clangd-install`;
		const install = installCompileDb({ sourcePath: generated, destDir: dest });
		expect(install.ok).toBe(true);
		expect(install.path).toBe(`${dest}/compile_commands.json`);
		expect(install.clangdSnippet).toContain("CompilationDatabase:");
		expect(install.notes.join("\n")).toContain("does not write that file");
		expect(compileCommandFor(install.path, `${PROJECT}/Source/Game/Private/Character/LpMoverPawn.cpp`).found).toBe(true);
		expect(compileCommandFor(LIVE_DB, `${PROJECT}/Source/Game/Private/Character/LpMoverPawn.cpp`).found).toBe(false);
	});

	it("the compiledb report names the live directory, the TU coverage, and the no-link-check pointer", async () => {
		// The report REUSES a database instead of generating one (generation costs minutes, and a fixture
		// engine ships no UnrealBuildTool). Key it the way ensureCompileDb does — target.platform.config —
		// driven by hostPlatform(), so the reuse holds on every platform instead of only where a sibling
		// test happened to leave a Win64-keyed file behind.
		const key = `GameEditor.${hostPlatform()}.Development`;
		mkdirSync(`${CACHE}/compiledb/${key}`, { recursive: true });
		writeFileSync(`${CACHE}/compiledb/${key}/compile_commands.json`, JSON.stringify([{ file: `${PROJECT}/Source/Game/Private/Character/LpMoverPawn.cpp`, directory: PROJECT, command: "clang-cl.exe /c Character/LpMoverPawn.cpp" }]), "utf8");
		const report = await compileDbReport({ cwd: PROJECT, scope: "project", fs: realFs, deps: DEPS });
		const text = report.notes.join("\n");
		expect(report.target).toBe("GameEditor");
		expect(report.clangd!.searchDirs).toEqual([LIVE_DIR]);
		expect(report.clangd!.databases.length).toBe(1);
		expect(text).toContain("clangd reads");
		expect(text).toContain("covers 1/3 translation units");
		expect(text).toContain("LpHelpfulFunctions.cpp [Game]");
		expect(text).toContain("DeletedPawn.cpp");
		expect(text).toContain("rsp freshness");
		expect(text).toContain("keep it out of git");
	});

	it("answers a report it cannot generate instead of throwing (no launcher under the engine root)", async () => {
		const report = await compileDbReport({ cwd: PROJECT, scope: "project", fs: realFs, deps: DEPS, refresh: true });
		expect(report.ok).toBe(false);
		const text = report.notes.join("\n");
		expect(text).toContain("could not generate a compile database for GameEditor");
		expect(text).toContain("UnrealBuildTool not found under");
		expect(text).toContain('unreal_index action "clangd" reports what it covers');
	});

	it("the clangd health action reports coverage, root cause, and the honest published:0 line", async () => {
		const report = await clangdHealthReport({ cwd: PROJECT, file: `${PROJECT}/Source/Game/Private/Character/LpMoverPawn.cpp`, scope: "project", fs: realFs, deps: DEPS });
		const text = report.notes.join("\n");
		expect(report.ok).toBe(true);
		expect(report.liveDatabases[0]!.entries).toBe(1);
		expect(text).toContain("covers 0/3 translation units of the project scope");
		expect(text).toContain("current TU(s) have NO compile command");
		expect(text).toContain("names a file that no longer exists on disk");
		expect(text).toContain("diagnosis:");
		expect(text).toContain("compile command in the database clangd reads → none");
		expect(text).toContain("published:0 cannot distinguish");
		expect(text).toContain("no link check");
		expect(text).toContain('action "compiledb"');
	});
});

describe("status lines (§2, §6, §7, §10.3)", () => {
	it("prints the current root set, the near-miss index, reclaimable bytes, and the compile database", async () => {
		metaFile("idx-engine-defs-deadformat01", { version: 4, key: "idx-engine-defs-deadformat01", mode: "definitions", scope: "Engine", engineRoot: ENGINE, roots: [`${ENGINE}/Engine/Source/Runtime`], generatedAt: new Date(Date.now() - 10_000).toISOString() });
		const status = indexStatus(PROJECT, realFs, workspace);
		const text = status.notes.join("\n");
		expect(text).toContain("current lookup root sets");
		expect(text).toContain("keyed by engineRoot+areas");
		expect(text).toContain("near miss: index idx-engine-defs-deadformat01");
		expect(text).toContain("reclaimable");
		expect(text).toContain('action "prune"');
		expect(text).toContain("compile database");
		expect(text).toContain("clangd reads");
		expect(text).toContain('clangd health');
		expect(text).toContain("no lookup selects it");
	});

	it("names each header index by engine key and areas (§4.1)", async () => {
		const built = await buildHeaderIndex({ roots: [{ dir: `${ENGINE}/Engine/Plugins`, module: "", scope: "Engine" }], engineRoot: ENGINE, areas: ["Plugins"] });
		const status = indexStatus(PROJECT, realFs, workspace);
		const row = status.headers.find((entry) => entry.key === built.key)!;
		expect(row.areas).toEqual(["Plugins"]);
		expect(row.coverage).toContain("engine-plugin");
		expect(row.rootKinds?.["engine-plugin"]).toBe(1);
	});
});
