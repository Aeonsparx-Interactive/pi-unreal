import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { scanText } from "../extensions/unreal/lib/scan.ts";
import { assembleRoots } from "../extensions/unreal/lib/store.ts";
import { buildIndex, indexKeyFor, listModules, lookupSymbol, pickIndex, symbolsInFile } from "../extensions/unreal/lib/store.ts";
import { pickTarget } from "../extensions/unreal/lib/query.ts";
import { memoryFs } from "./helpers.ts";

// The index writes to the machine cache dir; tests must not touch it.
const CACHE = mkdtempSync(join(tmpdir(), "pi-unreal-index-"));
process.env.PI_UNREAL_CACHE_DIR = CACHE;

const ROOT = mkdtempSync(join(tmpdir(), "pi-unreal-src-"));
const MODULE = join(ROOT, "Source", "TestGame").split("\\").join("/");

const HEADER = `// test fixture
#include "CoreMinimal.h"
#include "TestGame.generated.h"

class UBaseSettings;

UCLASS(BlueprintType)
class TESTGAME_API UTestCharacterSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "Test")
	void SetHealth(float Value);

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Test")
	int32 MaxLives = 3;
};

DECLARE_DELEGATE_RetVal_ThreeParams(FTransform, FOnWarpLocal)

union TESTGAME_API FUglyUnion
{
	int32 A;
};

template <typename K, typename V> struct TTestPair
{
	K Key;
	V Value;
};
`;

const SOURCE = `#include "TestGame.h"

void UTestCharacterSettings::SetHealth(float Value)
{
}

static void TestGamePrivateHelper()
{
}
`;

mkdirSync(join(MODULE, "Public"), { recursive: true });
mkdirSync(join(MODULE, "Private"), { recursive: true });
writeFileSync(join(MODULE, "TestGame.Build.cs"), "using UnrealBuildTool; public class TestGameBuild : ModuleRules {}");
writeFileSync(join(MODULE, "Public/TestGame.h"), HEADER);
writeFileSync(join(MODULE, "Private/TestGame.cpp"), SOURCE);

describe("definition scanner", () => {
	const { defs } = scanText(HEADER, `${MODULE}/Public/TestGame.h`, "TestGame", "Project");
	const { defs: sourceDefs } = scanText(SOURCE, `${MODULE}/Private/TestGame.cpp`, "TestGame", "Project");
	const named = (list: typeof defs) => list.map((def) => def.symbol);

	it("captures UCLASS names and qualifies UFUNCTION/UPROPERTY members with their owner", () => {
		expect(named(defs)).toContain("UTestCharacterSettings");
		expect(named(defs)).toContain("UTestCharacterSettings:SetHealth");
		expect(named(defs)).toContain("UTestCharacterSettings:MaxLives");
	});

	it("records the API macro as a marker, never as a symbol", () => {
		expect(named(defs)).not.toContain("TESTGAME_API");
		expect(defs.find((def) => def.symbol === "UTestCharacterSettings")?.marker).toContain("UCLASS");
	});

	it("names delegates by their last parameter, not by the return type", () => {
		expect(named(defs)).toContain("FOnWarpLocal");
		expect(named(defs)).not.toContain("FTransform");
	});

	it("handles unions behind API macros and strips template heads", () => {
		expect(named(defs)).toContain("FUglyUnion");
		expect(named(defs)).toContain("TTestPair");
		expect(named(defs).some((symbol) => symbol.includes("<"))).toBe(false);
	});

	it("keeps one-character member names (FVector2D::X style fields)", () => {
		expect(named(defs)).toContain("UTestCharacterSettings:MaxLives");
		const { defs: tight } = scanText(String.raw`USTRUCT()
struct TESTGAME_API FVec2
{
	UPROPERTY()
	double X = 0.0;
	UPROPERTY()
	double Y = 0.0;
};
`, `${MODULE}/Public/Vec2.h`, "TestGame", "Project");
		expect(tight.map((def) => def.symbol)).toContain("FVec2:X");
		expect(tight.map((def) => def.symbol)).toContain("FVec2:Y");
	});

	it("marks forward declarations so they can rank below real declarations", () => {
		const forward = defs.find((def) => def.symbol === "UBaseSettings");
		expect(forward?.marker).toContain("forward");
	});

	it("qualifies out-of-line definitions written as Owner::Name", () => {
		expect(named(sourceDefs)).toContain("UTestCharacterSettings:SetHealth");
		expect(named(sourceDefs)).toContain("TestGamePrivateHelper");
	});
});

describe("index store", () => {
	const key = indexKeyFor({ mode: "definitions", scope: "Project", roots: [MODULE] });

	it("builds a lookupable index from module roots", async () => {
		const built = await buildIndex({ key, mode: "definitions", roots: [{ dir: MODULE, scope: "Project", module: "TestGame" }], projectName: "TestGame" });
		expect(built.counts.files).toBe(2);
		expect(built.counts.symbols).toBeGreaterThan(6);
		const index = pickIndex({ key }).index;
		expect(index).toBeDefined();
		if (!index) return;

		const modules = listModules(index, { limit: 10 });
		expect(modules.map((module) => module.name)).toContain("TestGame");

		const exact = lookupSymbol(index, "UTestCharacterSettings");
		expect(exact[0]?.rank).toBe(0);
		expect(exact[0]?.module).toBe("TestGame");

		// UE naming convention: the prefix letter is typed by the caller, not present in the query.
		expect(lookupSymbol(index, "TestCharacterSettings").length).toBeGreaterThan(0);

		// Qualified member lookup needs the owner to be named.
		const member = lookupSymbol(index, "UTestCharacterSettings:SetHealth");
		expect(member.length).toBe(2); // header declaration + .cpp definition
		const bareMember = lookupSymbol(index, "SetHealth");
		expect(bareMember.length).toBe(0);
		expect(lookupSymbol(index, "SetHealth", { substring: true }).length).toBeGreaterThan(0);

		expect(lookupSymbol(index, "NothingLikeThis").length).toBe(0);
		expect(symbolsInFile(index, `${MODULE}/Private/TestGame.cpp`, 10).length).toBe(2);
	});

	it("keys indexes by scope, so an engine scan never reuses a project index", () => {
		const project = indexKeyFor({ mode: "definitions", scope: "Project", roots: [MODULE] });
		const engine = indexKeyFor({ mode: "definitions", scope: "Engine", roots: [MODULE] });
		expect(project).not.toBe(engine);
	});
});

describe("target selection", () => {
	const engineRoot = "C:/Engine";
	const projectDir = "C:/Projects/G";

	it("prefers the editor target named by the .uproject Modules section", () => {
		const fs = memoryFs({
			[`${projectDir}/G.uproject`]: JSON.stringify({ EngineAssociation: "5.8", Modules: [{ Name: "G", Type: "Runtime", LoadingPhase: "Default" }] }),
			[`${projectDir}/Source/GEditor/GEditor.Target.cs`]: "ConfigType = Editor;",
			[`${engineRoot}/Engine/Source/Programs/UnrealEditor/UnrealEditor.Target.cs`]: "ConfigType = Editor;",
		});
		const choice = pickTarget({ cwd: projectDir, engineRoot, fs });
		expect(choice.target).toBe("GEditor");
		expect(choice.source).toContain("uproject-modules");
	});

	it("honours an explicit target above every rule", () => {
		const choice = pickTarget({ cwd: projectDir, target: "GClient", platform: "Android", configuration: "Shipping", engineRoot, fs: memoryFs({}) });
		expect([choice.target, choice.platform, choice.configuration]).toEqual(["GClient", "Android", "Shipping"]);
		expect(choice.source).toBe("explicit");
	});

	it("falls back to the engine editor target, never a guessed project target", () => {
		const fs = memoryFs({
			[`${projectDir}/G.uproject`]: JSON.stringify({ EngineAssociation: "5.8" }),
			[`${engineRoot}/Engine/Source/Programs/UnrealEditor/UnrealEditor.Target.cs`]: "ConfigType = Editor;",
		});
		const choice = pickTarget({ cwd: projectDir, engineRoot, fs });
		expect(choice.target).toBe("UnrealEditor");
		expect(choice.source).toBe("engine-editor");
	});
});

describe("root assembly", () => {
	it("finds module roots from their *.Build.cs", () => {
		const { roots, notes } = assembleRoots({ projectRoot: ROOT });
		expect(roots.map((root: { dir: string }) => root.dir)).toContain(MODULE);
		expect(roots[0]?.scope).toBe("Project");
		expect(notes.join(" ")).toContain("module root");
	});
});

/* ── compile database pipeline (clangd enrichment) ─────────────────────── */

import { compileDbScope } from "../extensions/unreal/lib/tools.ts";
import { dropHeaderEntries, expandResponseTokens, filterEntries, normalizeDatabase, stripPostPchTokens, tokenizeCommand, joinTokens, ubtCompileDbPaths } from "../extensions/unreal/lib/compiledb.ts";

it("tokenizeCommand keeps quoted runs, joinTokens re-quotes paths with spaces", () => {
	const tokens = tokenizeCommand('"C:/Program Files/LLVM/bin/clang-cl.exe" "C:/a b/F.cpp" /c /I"C:/x y"');
	expect(tokens).toEqual(["C:/Program Files/LLVM/bin/clang-cl.exe", "C:/a b/F.cpp", "/c", "/IC:/x y"]);
	expect(joinTokens(["C:/a b/clang-cl.exe", "C:/a b/F.cpp", "/c"])).toBe('"C:/a b/clang-cl.exe" "C:/a b/F.cpp" /c');
});

it("stripPostPchTokens drops PCH/link switches and everything after /link", () => {
	const { tokens, dropped } = stripPostPchTokens(["clang-cl.exe", "F.cpp", "/YuSharedPCH.h", "/FpShared.pch", "/FmX.obj", "/c", "/link", "/OUT:X.dll", "/NOLOGO"]);
	expect(tokens).toEqual(["clang-cl.exe", "F.cpp", "/c"]);
	expect(dropped).toEqual(["/YuSharedPCH.h", "/FpShared.pch", "/FmX.obj", "/link", "/OUT:X.dll", "/NOLOGO"]);
});

it("expandResponseTokens inlines an rsp file, reporting a missing one", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-unreal-rsp-"));
	writeFileSync(join(dir, "mod.rsp"), ["/c", '/I"C:/inc"', "/YuFILE"].join("\n"));
	const { tokens, expanded, missing } = expandResponseTokens(["clang-cl.exe", "@mod.rsp", "F.cpp"], { baseDir: dir });
	expect(tokens).toEqual(["clang-cl.exe", "/c", "/IC:/inc", "/YuFILE", "F.cpp"]);
	expect(expanded).toEqual([join(dir, "mod.rsp")]);
	expect(missing).toEqual([]);
	const gap = expandResponseTokens(["clang-cl.exe", "@nope.rsp"], { baseDir: dir });
	expect(gap.missing).toEqual([join(dir, "nope.rsp")]);
	expect(gap.tokens).toEqual(["clang-cl.exe", "@nope.rsp"]);
});

it("normalizeDatabase: rsp expansion + PCH/link stripping + header drop + scope filter", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-unreal-rsp-"));
	writeFileSync(join(dir, "proj.rsp"), ["/c", "/DPLATFORM=1"].join("\n"));
	const entries = [
		{ file: "C:/Proj/Source/Proj/A.cpp", directory: dir, command: "clang-cl.exe @proj.rsp C:/Proj/Source/Proj/A.cpp /link /OUT:x.obj" },
		{ file: "C:/Proj/Source/Proj/B.h", directory: dir, command: "clang-cl.exe @proj.rsp C:/Proj/Source/Proj/B.h" },
		{ file: "C:/E/Engine/Source/Runtime/Core/Private/Core.cpp", directory: dir, command: "clang-cl.exe @proj.rsp C:/E/Engine/Source/Runtime/Core/Private/Core.cpp" },
		{ file: "C:/E/Engine/Source/Runtime/Core/Private/SharedPCH.Core.h.cpp", directory: dir, command: "clang-cl.exe @proj.rsp C:/E/Engine/Source/Runtime/Core/Private/SharedPCH.Core.h.cpp" },
	];
	const { entries: kept, stats } = normalizeDatabase(entries, { baseDir: dir, include: ["C:/Proj/Source"], dropHeaders: true });
	expect(kept.map((e) => e.file)).toEqual(["C:/Proj/Source/Proj/A.cpp"]);
	expect(kept[0]!.command).toContain("/c");
	expect(kept[0]!.command).not.toContain("/link");
	// 4 raw entries -> 1 PCH unit + 1 header dropped -> 1 survives the include filter, expanding its rsp.
	// Stats count what the surviving entries went through, not the raw input size.
	expect(stats).toMatchObject({ droppedPch: 1, droppedHeaders: 1, expandedRsp: 1, droppedSwitches: 2, missingRsp: [], kept: 1 });
});

it("filterEntries keeps prefix matches, ubtCompileDbPaths lists both layout spots", () => {
	const entries = [{ file: "C:/Proj/A.cpp" }, { file: "C:/E/B.cpp" }] as never;
	expect(filterEntries(entries, { include: ["C:/Proj"] }).map((e) => e.file)).toEqual(["C:/Proj/A.cpp"]);
	expect(filterEntries(entries, {}).length).toBe(2);
	const paths = ubtCompileDbPaths({ engineRoot: "C:/E", projectDir: "C:/Proj", platform: "Win64" });
	expect(paths).toContain("C:/Proj/Intermediate/Build/Win64/UnrealBuildTool/compile_commands.json");
	expect(paths).toContain("C:/E/Engine/Intermediate/Build/Win64/UnrealBuildTool/compile_commands.json");
});

it("compileDbScope: project + plugins, engine Source AND Plugins for the engine scope", () => {
	expect(compileDbScope({ projectDir: "C:/Proj", pluginDirs: ["C:/P1", "C:/P2"], engineRoot: "C:/E", scope: "project" })).toEqual(["C:/Proj", "C:/P1", "C:/P2"]);
	// Engine/Plugins is part of the engine scope: an installed engine ships most gameplay types as
	// plugins, and a database without them silently drops every plugin .cpp body from clangd.
	expect(compileDbScope({ projectDir: "C:/Proj", engineRoot: "C:/E", scope: "project+engine" })).toEqual(["C:/Proj", "C:/E/Engine/Source", "C:/E/Engine/Plugins"]);
	expect(compileDbScope({ scope: "project" })).toEqual([]);
});
