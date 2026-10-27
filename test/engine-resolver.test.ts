import os from "node:os";
import { afterAll, describe, expect, it } from "bun:test";
import {
	enumerateInstallations,
	findProjectFile,
	isValidEngineRoot,
	resolveEngineForProject,
} from "../extensions/unreal/lib/engine-resolver.ts";
import { parseEngineVersion } from "../extensions/unreal/lib/descriptors.ts";
import { createStaticRegistryReader } from "../extensions/unreal/lib/registry.ts";
import { realFs } from "../extensions/unreal/lib/util.ts";
import { ENGINE_A, ENGINE_B, ENGINE_C, FIXTURES, GUID, PROJECT_DIR, materializeFixtures, releaseFixtures } from "./helpers.ts";

const HERMETIC = { ProgramFiles: `${FIXTURES}/Empty/ScanRoot` };
const noScanEnv = HERMETIC;

// `.uproject` inline `EngineAssociation` paths are absolute, so they must be materialized: a
// committed fixture cannot carry a machine-specific root. See test/helpers.ts.
const fx = materializeFixtures();
afterAll(() => releaseFixtures(fx));

describe("engine resolution", () => {
	it("parses a full Build.version string", () => {
		const version = parseEngineVersion("5.8.3-58210709+++UE5+Release-5.8");
		expect(version).toMatchObject({ major: 5, minor: 8, patch: 3, changelist: 58210709, branchName: "++UE5+Release-5.8" });
	});

	it("rejects directories that are not engine roots", () => {
		expect(isValidEngineRoot(ENGINE_A, realFs)).toBe(true);
		expect(isValidEngineRoot(PROJECT_DIR, realFs)).toBe(false);
		expect(isValidEngineRoot(`${FIXTURES}/Nope`, realFs)).toBe(false);
	});

	it("prefers an inline path association (Epic's first step)", async () => {
		const result = await resolveEngineForProject(`${fx.root}/ProjPath.uproject`, { registry: createStaticRegistryReader({ available: false, hklmVersions: [], hkcuBuilds: [], launcherDatPath: "", launcherDatExists: false }), env: HERMETIC });
		expect(result.status).toBe("resolved");
		expect(result.engineRoot).toBe(fx.engineA);
		expect(result.source).toBe("uproject-inline-path");
		expect(result.associationKind).toBe("inline-path");
		expect(result.version).toMatchObject({ major: 5, minor: 8, patch: 3 });
		expect(result.installedBuild).toBe(true);
	});

	it("matches a version association against HKLM registrations", async () => {
		const registry = createStaticRegistryReader({
			available: true,
			hklmVersions: [
				{ version: "5.7", installedDirectory: ENGINE_B },
				{ version: "5.8", installedDirectory: ENGINE_A },
			],
			hkcuBuilds: [],
			launcherDatPath: "",
			launcherDatExists: false,
		});
		const result = await resolveEngineForProject(`${FIXTURES}/ProjUnknown.uproject`, { registry, env: HERMETIC });
		// "FIXED-ASSOC" is not version-shaped: nothing matches, so every candidate is rejected.
		expect(result.status).toBe("unresolved");
		expect(result.associationKind).toBe("unknown");

		const versioned = await resolveEngineForProject(`${fx.root}/ProjPath.uproject`, { registry, env: HERMETIC });
		expect(versioned.engineRoot).toBe(fx.engineA);
	});

	it("resolves a version association to exactly one installation", async () => {
		const registry = createStaticRegistryReader({
			available: true,
			hklmVersions: [
				{ version: "5.7", installedDirectory: ENGINE_B },
				{ version: "5.8", installedDirectory: ENGINE_A },
			],
			hkcuBuilds: [],
			launcherDatPath: "",
			launcherDatExists: false,
		});
		const { parseUproject } = await import("../extensions/unreal/lib/descriptors.ts");
		const descriptor = parseUproject(`${PROJECT_DIR}/Fixture.uproject`, realFs);
		expect(descriptor.engineAssociation).toBe("5.8");
		const result = await resolveEngineForProject(descriptor.path, { registry, env: noScanEnv });
		expect(result.status).toBe("resolved");
		expect(result.engineRoot).toBe(ENGINE_A);
		expect(result.source).toBe("hklm-version");
		expect(result.identifier).toBe("5.8");
	});

	it("rejects a stale registry entry whose directory is gone", async () => {
		const registry = createStaticRegistryReader({
			available: true,
			hklmVersions: [{ version: "9.9", installedDirectory: `${FIXTURES}/UE_9.9_missing` }],
			hkcuBuilds: [],
			launcherDatPath: "",
			launcherDatExists: false,
		});
		const result = await resolveEngineForProject(`${FIXTURES}/ProjBogus.uproject`, { registry, env: HERMETIC });
		expect(result.status).toBe("unresolved");
		expect(result.associationKind).toBe("version");
		expect(result.remediation.join(" ")).toContain("directory does not exist");
	});

	it("accepts a GUID association only from HKCU Builds", async () => {
		const registry = createStaticRegistryReader({
			available: true,
			hklmVersions: [{ version: "5.8", installedDirectory: ENGINE_A }],
			hkcuBuilds: [{ identifier: GUID, root: ENGINE_A }],
			launcherDatPath: "",
			launcherDatExists: false,
		});
		const result = await resolveEngineForProject(`${FIXTURES}/ProjGuid.uproject`, { registry, env: HERMETIC });
		expect(result.status).toBe("resolved");
		expect(result.associationKind).toBe("guid");
		expect(result.source).toBe("hkcu-builds");

		const bare = await resolveEngineForProject(`${FIXTURES}/ProjGuid.uproject`, {
			registry: createStaticRegistryReader({ available: true, hklmVersions: [{ version: "5.8", installedDirectory: ENGINE_A }], hkcuBuilds: [], launcherDatPath: "", launcherDatExists: false }),
			env: HERMETIC,
		});
		expect(bare.status).toBe("unresolved");
		expect(bare.remediation.join(" ")).toContain("HKCU");
	});

	it("falls back to ancestor walk-up for an empty association", async () => {
		const result = await resolveEngineForProject(`${ENGINE_A}/Projects/Walk.uproject`, { registry: createStaticRegistryReader({ available: false, hklmVersions: [], hkcuBuilds: [], launcherDatPath: "", launcherDatExists: false }), env: HERMETIC });
		expect(result.status).toBe("resolved");
		expect(result.engineRoot).toBe(ENGINE_A);
		expect(result.source).toBe("walk-up");
	});

	it("ranks an explicit user hint above every registry source", async () => {
		const registry = createStaticRegistryReader({
			available: true,
			hklmVersions: [{ version: "5.8", installedDirectory: ENGINE_A }],
			hkcuBuilds: [],
			launcherDatPath: "",
			launcherDatExists: false,
		});
		const result = await resolveEngineForProject(`${FIXTURES}/ProjHint.uproject`, { registry, userEngineRoots: [ENGINE_A], env: HERMETIC });
		expect(result.status).toBe("resolved");
		expect(result.source).toBe("user-hint");
	});

	it("reports ambiguity instead of picking silently", async () => {
		const registry = createStaticRegistryReader({
			available: true,
			hklmVersions: [
				{ version: "5.8", installedDirectory: ENGINE_A },
				{ version: "5.8", installedDirectory: ENGINE_C },
			],
			hkcuBuilds: [],
			launcherDatPath: "",
			launcherDatExists: false,
		});
		const result = await resolveEngineForProject(`${FIXTURES}/ProjHint.uproject`, { registry, env: noScanEnv });
		expect(result.status).toBe("ambiguous");
		expect(result.candidates.filter((candidate) => candidate.validRoot && candidate.versionMatches).length).toBe(2);
		expect(result.engineRoot).toBe(result.candidates[0]?.root);
	});

	it("finds a UE_x.y sibling directory with no registry presence", async () => {
		const installs = await enumerateInstallations({
			registry: createStaticRegistryReader({ available: false, hklmVersions: [], hkcuBuilds: [], launcherDatPath: "", launcherDatExists: false }),
			env: { ProgramFiles: `${FIXTURES}/ScanRoot` },
		});
		const scanned = installs.find((install) => install.source === "dir-scan");
		expect(scanned?.identifier).toBe("5.8");
		expect(scanned?.validRoot).toBe(true);
	});

	it("reports an unusable engine root from an env var with its note", async () => {
		const result = await resolveEngineForProject(`${FIXTURES}/ProjBogus.uproject`, {
			registry: createStaticRegistryReader({ available: false, hklmVersions: [], hkcuBuilds: [], launcherDatPath: "", launcherDatExists: false }),
			env: { PI_UNREAL_ENGINE_ROOT: PROJECT_DIR },
		});
		expect(result.status).toBe("unresolved");
		expect(result.candidates.some((candidate) => candidate.notes.join(" ").includes("not an engine root"))).toBe(true);
	});

	it("locates a .uproject by walking up from a subdirectory", async () => {
		const found = await findProjectFile(`${PROJECT_DIR}/Source`, realFs, 4);
		expect(found).toBe(`${PROJECT_DIR}/Fixture.uproject`);
		expect(await findProjectFile(os.tmpdir(), realFs, 1)).toBeUndefined();
	});
});
