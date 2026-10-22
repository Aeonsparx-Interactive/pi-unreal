import { describe, expect, it } from "bun:test";
import { parseUplugin, parseUproject, readBuildVersion, versionToMajorMinor } from "../extensions/unreal/lib/descriptors.ts";
import { realFs } from "../extensions/unreal/lib/util.ts";
import { ENGINE_A, FIXTURES, PROJECT_DIR, memoryFs } from "./helpers.ts";

describe("descriptors", () => {
	it("parses a .uproject with comments, trailing commas, and unknown keys", () => {
		const descriptor = parseUproject(`${PROJECT_DIR}/Fixture.uproject`, realFs);
		expect(descriptor.engineAssociation).toBe("5.8");
		expect(descriptor.category).toBe("Testing");
		expect(descriptor.modules.map((module) => module.moduleName)).toEqual(["Fixture", "FixtureEditor"]);
		expect(descriptor.modules[1]?.descriptor.additionalDependencies).toEqual(["UnrealEd"]);
		expect(descriptor.targetPlatforms).toEqual(["Windows", "Android"]);
		expect(descriptor.plugins).toHaveLength(9);
		// `Enabled` defaults to true when a reference omits it; the engine-side failure is reported separately.
		expect(descriptor.plugins[0]?.enabled).toBe(true);
		expect(descriptor.plugins[5]?.optional).toBe(true);
		expect(descriptor.plugins[8]?.enabled).toBe(false);
		expect(descriptor.enterprise).toBe(false);
		expect(descriptor.disableEnginePluginsByDefault).toBe(false);
		expect(descriptor.unknownFields).toContain("NotAnEngineField");
		expect(descriptor.knownFields).toContain("EngineAssociation");
		expect(descriptor.diagnostics.join(" ")).toContain("NotAnEngineField");
		expect(descriptor.diagnostics.join(" ")).not.toContain("Enabled");
		expect(descriptor.additionalPluginDirectories).toHaveLength(1);
	});

	it("flags a plugin reference without the mandatory Enabled field", () => {
		const descriptor = parseUproject(`${FIXTURES}/ProjNoEnabled.uproject`, realFs);
		expect(descriptor.plugins[0]?.name).toBe("Alpha");
		expect(descriptor.plugins[0]?.enabled).toBe(true);
		expect(descriptor.diagnostics.join(" ")).toContain(
			`plugin reference Alpha: no boolean "Enabled" field (UE 5.8 rejects the reference: "Plugin references must have an 'Enabled' field")`,
		);
	});

	it("validates module Type and LoadingPhase against the engine enums", () => {
		const fs = memoryFs({
			"/p/uplugin/Bad/Bad.uplugin": JSON.stringify(
				{
					FileVersion: 3,
					Modules: [
						{ Name: "Good", Type: "Runtime" },
						{ Name: "NoType", LoadingPhase: "Default" },
						{ Name: "BadType", Type: "External", LoadingPhase: "Startup" },
						{ LoadingPhase: "Default" },
					],
				},
				null,
				"\t",
			),
		});
		const plugin = parseUplugin("/p/uplugin/Bad/Bad.uplugin", fs);
		expect(plugin.modules.map((entry) => entry.moduleName)).toEqual(["Good", "NoType", "BadType"]);
		// Engine constructor defaults (ModuleDescriptor.h:209): Runtime, Default.
		expect(plugin.modules[0]?.descriptor).toMatchObject({ type: "Runtime", loadingPhase: "Default" });
		const joined = plugin.diagnostics.join(" ");
		expect(joined).toContain('module NoType: no "Type" field');
		expect(joined).toContain('module BadType: Type "External" is not one of');
		expect(joined).toContain('module BadType: LoadingPhase "Startup" is not one of');
		expect(joined).toContain("module entry without a Name is ignored by the engine");
		expect(plugin.modules[2]?.descriptor.bUnknown).toBe(true);
	});

	it("strips a BOM before parsing", () => {
		const descriptor = parseUproject(`${FIXTURES}/Bom.uproject`, realFs);
		expect(descriptor.modules[0]?.descriptor.loadingPhase).toBe("PostEngineInit");
		expect(descriptor.diagnostics.filter((line) => line.includes("jsonc"))).toEqual([]);
	});

	it("reports unreadable and malformed descriptors instead of throwing", () => {
		expect(parseUproject(`${FIXTURES}/DoesNotExist.uproject`, realFs).diagnostics[0]).toContain("cannot read");

		const fs = memoryFs({ "/tmp/Broken.uproject": "{ this is not json" });
		const broken = parseUproject("/tmp/Broken.uproject", fs);
		expect(broken.engineAssociation).toBeUndefined();
		expect(broken.diagnostics.join(" ")).toContain("jsonc");
	});

	it("reads Build.version and reports the installed-build marker", () => {
		const version = readBuildVersion(ENGINE_A, realFs);
		expect(version).toMatchObject({ major: 5, minor: 8, patch: 3, branchName: "UE5" });
		expect(versionToMajorMinor(version)).toBe("5.8");
		expect(readBuildVersion(`${FIXTURES}/ProjDir`, realFs)).toBeUndefined();
	});

	it("decodes .uplugin fields, including Version and EngineVersion", () => {
		const plugin = parseUplugin(`${ENGINE_A}/Engine/Plugins/Runtime/Alpha/Alpha.uplugin`, realFs);
		expect(plugin.name).toBe("Alpha");
		expect(plugin.versionRaw).toBe(65536);
		expect(plugin.version).toBe("1.0");
		expect(plugin.semVersion).toBe("1.0.0");
		expect(plugin.enabledByDefault).toBe(true);
		expect(plugin.installed).toBe(false);
		expect(plugin.modules[0]).toMatchObject({
			moduleName: "Alpha",
			descriptor: { type: "Runtime", loadingPhase: "Default" },
		});
		expect(plugin.unknownFields).toEqual([]);

		const shared = parseUplugin(`${ENGINE_A}/Engine/Plugins/Performance/Shared/Shared.uplugin`, realFs);
		expect(shared.engineVersion).toMatchObject({ major: 5, minor: 7 });
		expect(shared.category).toBe("Performance");
		// "LoadingPhase" omitted → engine default; host type comes from the module entry.
		expect(shared.modules[0]?.descriptor.loadingPhase).toBe("Default");
		expect(shared.modules[0]?.descriptor.type).toBe("Runtime");
	});

	it("reads the UE 5.8 plugin flags, including CanContainContent", () => {
		const fs = memoryFs({
			"/p/X/X.uplugin": JSON.stringify(
				{
					FileVersion: 3,
					Modules: [{ Name: "X", Type: "Editor" }],
					CanContainContent: true,
					CanContainVerse: true,
					NoCode: true,
					IsBetaVersion: true,
					IsExperimentalVersion: true,
					Installed: true,
					RequiresBuildPlatform: true,
					Hidden: true,
					Sealed: true,
					ExplicitlyLoaded: true,
					HasExplicitPlatforms: true,
					bIsPluginExtension: true,
					CategoryPath: "Runtime/Path",
					SupportedPrograms: ["UnrealEditor"],
					CreatedBy: "Author",
					DocsURL: "https://example.invalid",
				},
				null,
				"\t",
			),
		});
		const plugin = parseUplugin("/p/X/X.uplugin", fs);
		expect(plugin.canContainContent).toBe(true);
		expect(plugin.canContainVerse).toBe(true);
		expect(plugin.noCode).toBe(true);
		expect(plugin.isBetaVersion).toBe(true);
		expect(plugin.isExperimentalVersion).toBe(true);
		expect(plugin.installed).toBe(true);
		expect(plugin.requiresBuildPlatform).toBe(true);
		expect(plugin.isHidden).toBe(true);
		expect(plugin.isSealed).toBe(true);
		expect(plugin.explicitlyLoaded).toBe(true);
		expect(plugin.hasExplicitPlatforms).toBe(true);
		expect(plugin.isPluginExtension).toBe(true);
		expect(plugin.category).toBe("Runtime/Path");
		expect(plugin.supportedPrograms).toEqual(["UnrealEditor"]);
		expect(plugin.createdBy).toBe("Author");
		expect(plugin.docsUrl).toBe("https://example.invalid");
		expect(plugin.unknownFields).toEqual([]);
	});

	it("uses the supplied plugin name for the identity of a descriptor", () => {
		const plugin = parseUplugin(`${PROJECT_DIR}/Plugins/Binaries/Stale.uplugin`, realFs, { name: "Stale" });
		expect(plugin?.modules).toEqual([]);
		expect(plugin?.diagnostics.join(" ")).toContain("no Modules entries");
	});
});
