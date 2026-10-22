/**
 * Descriptor parsers for `.uproject`, `.uplugin`, and the nested structures they embed.
 *
 * Field tables are transcribed from the engine's own serialization code (UE 5.8):
 *   Engine/Source/Runtime/Projects/Public/ProjectDescriptor.h:76-106,193-199        FProjectDescriptor
 *   Engine/Source/Runtime/Projects/Public/PluginDescriptor.h:43-177                 FPluginFileDescriptor
 *   Engine/Source/Runtime/Projects/Public/ModuleDescriptor.h:160-205                FModuleDescriptor
 *   Engine/Source/Runtime/Projects/Private/PluginReferenceDescriptor.cpp:132-172    FPluginReferenceDescriptor
 *   Engine/Source/Runtime/Core/Public/Misc/EngineVersion.h                          FEngineVersion
 *
 * Anything the engine does not serialize is reported as an unknown field, so a schema drift
 * shows up as a diagnostic instead of silently disappearing.
 */

import { joinPath, parseJsoncLenient, readFileSafe, realFs, type FsAdapter, type JsonValue } from "./util.ts";

// EHostType::ToString — ModuleDescriptor.cpp:110-146 (UE 5.8). These are the exact strings a
// `.uplugin`/`.uproject` must use; `EHostType::FromString` returns Max for anything else and
// FModuleDescriptor::Read then fails the whole descriptor.
export const HOST_TYPES = [
	"Runtime",
	"RuntimeNoCommandlet",
	"RuntimeAndProgram",
	"CookedOnly",
	"UncookedOnly",
	"Developer",
	"DeveloperTool",
	"Editor",
	"EditorNoCommandlet",
	"EditorAndProgram",
	"Program",
	"ServerOnly",
	"ClientOnly",
	"ClientOnlyNoCommandlet",
] as const;
export type HostType = (typeof HOST_TYPES)[number];

// ELoadingPhase::Type — ModuleDescriptor.h:24-52 (UE 5.8).
export const LOADING_PHASES = [
	"EarliestPossible",
	"PostConfigInit",
	"PostSplashScreen",
	"PreEarlyLoadingScreen",
	"PreLoadingScreen",
	"PreDefault",
	"Default",
	"PostDefault",
	"PostEngineInit",
	"None",
] as const;
export type LoadingPhase = (typeof LOADING_PHASES)[number];

/** `FEngineVersion` (`Major.Minor.Patch-Changelist+BranchName`). */
export interface EngineVersion {
	major: number;
	minor: number;
	patch: number;
	changelist: number;
	branchName?: string;
	raw: string;
}

export interface ModuleDescriptor {
	/** `"Name"` is only present in legacy descriptors; the `.uproject` map key is authoritative. */
	name?: string;
	type?: HostType;
	loadingPhase?: LoadingPhase;
	platformAllowList: string[];
	platformDenyList: string[];
	targetAllowList: string[];
	targetDenyList: string[];
	additionalDependencies: string[];
	bUnknown: boolean;
}

export interface PluginReference {
	name: string;
	enabled: boolean;
	optional: boolean;
	/** `Activate` — `true` means "load even when the referencing module does not require it". */
	activate: boolean;
	/** Encoded `FFileVersion` (`(Major << 16) | Minor`) as found in the file. */
	version?: number;
	semVersion?: string;
	supportedTargetPlatforms: string[];
}

export interface UprojectDescriptor {
	path: string;
	engineAssociation?: string;
	category?: string;
	description?: string;
	/** `Enterprise` — the project is an enterprise (Launcher-adjacent) project. */
	enterprise: boolean;
	/** `DisableEnginePluginsByDefault` — engine plugins default to disabled for this project. */
	disableEnginePluginsByDefault: boolean;
	modules: { moduleName: string; descriptor: ModuleDescriptor }[];
	plugins: PluginReference[];
	targetPlatforms: string[];
	additionalPluginDirectories: string[];
	additionalRootDirectories: string[];
	/** Engine-serialized fields we know about, keyed by JSON name. */
	knownFields: string[];
	/** Keys present in the file that `FProjectDescriptor` does not serialize. */
	unknownFields: string[];
	diagnostics: string[];
}

export interface UpluginDescriptor {
	path: string;
	name: string;
	/** Decoded from the `Version` int (`FFileVersion`), e.g. `1.0`. */
	version?: string;
	/** Raw int form. */
	versionRaw?: number;
	semVersion?: string;
	versionName?: string;
	engineVersion?: EngineVersion;
	friendlyName?: string;
	category?: string;
	description?: string;
	enabledByDefault: boolean;
	canContainContent: boolean;
	canContainVerse: boolean;
	noCode: boolean;
	isBetaVersion: boolean;
	isExperimentalVersion: boolean;
	/** `Installed` — the plugin ships inside an installed engine build. */
	installed: boolean;
	requiresBuildPlatform: boolean;
	isHidden: boolean;
	isSealed: boolean;
	explicitlyLoaded: boolean;
	hasExplicitPlatforms: boolean;
	isPluginExtension: boolean;
	createdBy?: string;
	docsUrl?: string;
	marketplaceUrl?: string;
	supportUrl?: string;
	supportedTargetPlatforms: string[];
	supportedPrograms: string[];
	platformAllowList: string[];
	platformDenyList: string[];
	targetAllowList: string[];
	targetDenyList: string[];
	modules: { moduleName: string; descriptor: ModuleDescriptor }[];
	plugins: PluginReference[];
	knownFields: string[];
	unknownFields: string[];
	diagnostics: string[];
}

// Keys FProjectDescriptor::Read actually reads — ProjectDescriptor.cpp:104-221 (UE 5.8).
const UPROJECT_FIELDS = new Set([
	"FileVersion",
	"ProjectFileVersion",
	"EngineAssociation",
	"Category",
	"Description",
	"Enterprise",
	"DisableEnginePluginsByDefault",
	"Modules",
	"Plugins",
	"TargetPlatforms",
	"EpicSampleNameHash",
	"AdditionalRootDirectories",
	"AdditionalPluginDirectories",
	"PreBuildSteps",
	"PostBuildSteps",
	"AdditionalDirectories",
	"EngineGuid",
]);

// Keys FPluginDescriptor::Read actually reads — PluginDescriptor.cpp:263-410 (UE 5.8).
const UPLUGIN_FIELDS = new Set([
	"FileVersion",
	"PluginFileVersion",
	"Version",
	"SemVersion",
	"VersionName",
	"EngineVersion",
	"EngineGuid",
	"Name",
	"FriendlyName",
	"Category",
	"CategoryPath",
	"Description",
	"CreatedBy",
	"CreatedByURL",
	"DocsURL",
	"MarketplaceURL",
	"SupportURL",
	"DeprecationURL",
	"EditorCustomVirtualPath",
	"EnabledByDefault",
	/* `Enabled` is a PLUGIN-REFERENCE key (PluginReferenceDescriptor.cpp:138); PluginDescriptor.cpp
	   never reads it at plugin scope (only `EnabledByDefault`, :361-365). 153 shipped `.uplugin`
	   files carry it anyway (census), so it stays known and keeps the diagnostic clean. Runtime
	   enablement is FPlugin::bEnabled (PluginManager.cpp:380) — derived from references, not the descriptor. */
	"Enabled",
	"CanContainContent",
	"CanContainVerse",
	"NoCode",
	"NoGameFeatureContent",
	"IsBetaVersion",
	"IsExperimentalVersion",
	"Installed",
	"RequiresBuildPlatform",
	"Hidden",
	"Sealed",
	"ExplicitlyLoaded",
	"HasExplicitPlatforms",
	"bIsPluginExtension",
	"CanBeUsedWithUnrealHeaderTool",
	"EnableSceneGraph",
	"EnableSceneGraphAnimation",
	"EnableVerseAssetReflection",
	"EnableIAD",
	"EnableIAS",
	"VersePath",
	"VerseScope",
	"VerseVersion",
	"DeprecatedEngineVersion",
	"LocalizationTargets",
	"Modules",
	"Plugins",
	"DisallowedPlugins",
	"SupportedTargetPlatforms",
	"SupportedPrograms",
	"PlatformAllowList",
	"PlatformDenyList",
	"TargetAllowList",
	"TargetDenyList",
	"TargetConfigurationAllowList",
	"TargetConfigurationDenyList",
	"WhitelistPlatforms",
	"BlacklistPlatforms",
	"WhitelistTargets",
	"BlacklistTargets",
	"PreBuildSteps",
	"PostBuildSteps",
	"MetadataURL",
	"EnterprisePluginName",
	/* Keys found in real shipped `.uplugin` files (census over 925 files: UE 5.8 Engine/Plugins,
	   the Lp bench's Plugins/, Unreal Projects/Lp/Plugins, LyraStarterGame/Plugins). They are not
	   read by FPluginDescriptor; listing them keeps the unknown-field diagnostic a signal instead
	   of a shout at every third-party plugin. */
	"EditorOnly",
	"NoRedist",
	"PythonRequirements",
	"PythonScriptFolderName",
	"IsExperimental",
	"BuiltInInitialFeatureState",
	"BuiltInInitialContentState",
	"PluginIconPath",
	"bRequiresBuildPlatform",
	"IsHidden",
	"HideScreen",
	"HideByDefault",
	"FolderIdentifier",
	"Enterprise",
	"builtInAutoActivate",
]);

const MODULE_FIELDS = new Set([
	"Name",
	"Type",
	"LoadingPhase",
	"PlatformAllowList",
	"PlatformDenyList",
	"HasExplicitPlatforms",
	"TargetAllowList",
	"TargetDenyList",
	"TargetConfigurationAllowList",
	"TargetConfigurationDenyList",
	"ProgramAllowList",
	"ProgramDenyList",
	"AdditionalDependencies",
	"GameTargetAllowList",
	"GameTargetDenyList",
	"PlatformArchitectureAllowList",
	"PlatformArchitectureDenyList",
	"WhitelistPlatforms",
	"BlacklistPlatforms",
	"WhitelistTargets",
	"BlacklistTargets",
	"WhitelistTargetConfigurations",
	"BlacklistTargetConfigurations",
	"WhitelistPrograms",
	"BlacklistPrograms",
	/* Real-file variants seen in the census (including Epic's own plugins): `ProgramAllowlist`
	   (lowercase l) and `AllowlistPrograms` are NOT read by FModuleDescriptor, so the engine
	   silently ignores them — the diagnostic that names them is deliberate. */
	"ProgramAllowlist",
	"AllowlistPrograms",
	"WhitelistPlatformAllowList",
	"BlacklistPlatformAllowList",
	"WhitelistAdditionalDependencies",
	"BlacklistAdditionalDependencies",
	"SystemIncludePaths",
	"ExtraSubstitutions",
	"chroot",
]);

// FPluginReferenceDescriptor::Read — PluginReferenceDescriptor.cpp:130-180 (UE 5.8), plus keys older
// `.uproject` files still carry (the engine ignores unknown keys silently, so listing them keeps the
// diagnostic signal meaningful instead of shouting at every pre-5.x project).
const PLUGIN_REF_FIELDS = new Set([
	"Name",
	"Enabled",
	"Optional",
	"Activate",
	"Description",
	"MarketplaceURL",
	"Version",
	"SemVersion",
	"SupportedTargetPlatforms",
	"HasExplicitPlatforms",
	"PlatformAllowList",
	"PlatformDenyList",
	"TargetAllowList",
	"TargetDenyList",
	"TargetConfigurationAllowList",
	"TargetConfigurationDenyList",
	"TargetsToExplicitlyLoad",
	"WhitelistPlatforms",
	"BlacklistPlatforms",
	"WhitelistTargets",
	"BlacklistTargets",
	"WhitelistTargetConfigurations",
	"BlacklistTargetConfigurations",
	"AllowDuringCommandlet",
	"HasPrebuiltData",
	"IsStrictlyRequired",
	"TargetName",
	"ModuleOverridingMap",
]);

function asString(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: JsonValue | undefined, fallback = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: JsonValue | undefined): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** `5.8.3-58210709+++UE5+Release-5.8` and the `Major.Minor.Patch` short form. */
export function parseEngineVersion(text: string | undefined): EngineVersion | undefined {
	if (!text) return undefined;
	const raw = text.trim();
	const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?(?:\+(.*))?$/);
	if (!match) return undefined;
	const [, major, minor, patch, changelist, branch] = match;
	return {
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		changelist: Number(changelist ?? "0"),
		branchName: branch,
		raw,
	};
}

/** `Engine/Build/Build.version` — the engine's self-reported version. */
export function readBuildVersion(engineRoot: string, fs: FsAdapter = realFs): EngineVersion | undefined {
	const path = joinPath(engineRoot, "Engine/Build/Build.version");
	const text = readFileSafe(path, fs);
	if (!text) return undefined;
	const { value, errors } = parseJsoncLenient<Record<string, JsonValue>>(text);
	if (errors.length > 0) return undefined;
	const record = asRecord(value);
	const major = asNumber(record.MajorVersion);
	const minor = asNumber(record.MinorVersion);
	if (major === undefined || minor === undefined) return undefined;
	return {
		major,
		minor,
		patch: asNumber(record.PatchVersion) ?? 0,
		changelist: asNumber(record.Changelist) ?? 0,
		branchName: asString(record.BranchName),
		raw: `${major}.${minor}.${asNumber(record.PatchVersion) ?? 0}`,
	};
}

/** Decode `FFileVersion` (`(Major << 16) | Minor`). */
export function decodeFileVersion(version: number | undefined): string | undefined {
	if (version === undefined) return undefined;
	return `${(version >> 16) & 0xffff}.${version & 0xffff}`;
}

function parseModuleEntry(name: string, raw: JsonValue | undefined, diagnostics: string[]): ModuleDescriptor {
	const record = asRecord(raw);
	const type = asString(record.Type);
	const loadingPhase = asString(record.LoadingPhase);
	const entry: ModuleDescriptor = {
		name: asString(record.Name),
		/** Engine constructor default is `EHostType::Runtime` (ModuleDescriptor.h:209). */
		type: (type ?? "Runtime") as HostType,
		/** Engine constructor default is `ELoadingPhase::Default`. */
		loadingPhase: (loadingPhase ?? "Default") as LoadingPhase,
		platformAllowList: asStringArray(record.PlatformAllowList),
		platformDenyList: asStringArray(record.PlatformDenyList),
		targetAllowList: asStringArray(record.TargetAllowList),
		targetDenyList: asStringArray(record.TargetDenyList),
		additionalDependencies: asStringArray(record.AdditionalDependencies),
		bUnknown: false,
	};
	if (type === undefined) {
		// ModuleDescriptor.cpp:174 — a missing Type is a hard engine error, even though the
		// FModuleDescriptor constructor defaults it to Runtime.
		diagnostics.push(`module ${name}: no "Type" field (UE 5.8 rejects the descriptor: "Found Module entry '${name}' with a missing 'Type' field")`);
	}
	if (type !== undefined && !HOST_TYPES.includes(type as HostType)) {
		diagnostics.push(
			`module ${name}: Type "${type}" is not one of ${HOST_TYPES.join("|")} (EHostType::FromString returns Max and UE 5.8 rejects the descriptor)`,
		);
		entry.bUnknown = true;
	}
	if (loadingPhase !== undefined && !LOADING_PHASES.includes(loadingPhase as LoadingPhase)) {
		diagnostics.push(`module ${name}: LoadingPhase "${loadingPhase}" is not one of ${LOADING_PHASES.join("|")}`);
		entry.bUnknown = true;
	}
	for (const key of Object.keys(record)) {
		if (!MODULE_FIELDS.has(key)) diagnostics.push(`module ${name}: field "${key}" is not serialized by FModuleDescriptor`);
	}
	return entry;
}

/**
 * `Modules` is an ARRAY of objects, each with a `Name` (ModuleDescriptor.cpp:166). A `Name`-keyed
 * object map is accepted too because pre-UE4 files in the wild use it, and the engine's own
 * `FModuleDescriptor::ReadArray` path is the one that must win for real projects.
 */
function parseModuleMap(raw: JsonValue | undefined, diagnostics: string[]): { moduleName: string; descriptor: ModuleDescriptor }[] {
	const entries: { moduleName: string; descriptor: ModuleDescriptor }[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const record = asRecord(item);
			const moduleName = asString(record.Name);
			if (!moduleName) {
				diagnostics.push("module entry without a Name is ignored by the engine");
				continue;
			}
			entries.push({ moduleName, descriptor: parseModuleEntry(moduleName, item, diagnostics) });
		}
		return entries;
	}
	for (const [moduleName, value] of Object.entries(asRecord(raw))) {
		entries.push({ moduleName, descriptor: parseModuleEntry(moduleName, value, diagnostics) });
	}
	return entries;
}

function parsePluginReferences(raw: JsonValue | undefined, diagnostics: string[]): PluginReference[] {
	if (!Array.isArray(raw)) return [];
	const out: PluginReference[] = [];
	for (const item of raw) {
		const record = asRecord(item);
		const name = asString(record.Name);
		if (!name) {
			diagnostics.push("plugin reference without a Name is ignored by the engine");
			continue;
		}
		for (const key of Object.keys(record)) {
			if (!PLUGIN_REF_FIELDS.has(key)) diagnostics.push(`plugin reference ${name}: field "${key}" is not serialized by FPluginReferenceDescriptor`);
		}
		if (typeof record.Enabled !== "boolean") {
			// PluginReferenceDescriptor.cpp:138 — UE 5.8 fails the whole `.uproject` load without it.
			diagnostics.push(`plugin reference ${name}: no boolean "Enabled" field (UE 5.8 rejects the reference: "Plugin references must have an 'Enabled' field")`);
		}
		out.push({
			name,
			enabled: asBoolean(record.Enabled, true),
			optional: asBoolean(record.Optional),
			activate: asBoolean(record.Activate),
			version: asNumber(record.Version),
			semVersion: asString(record.SemVersion),
			supportedTargetPlatforms: asStringArray(record.SupportedTargetPlatforms),
		});
	}
	return out;
}

function unknownFieldsIn(record: Record<string, JsonValue>, known: Set<string>): string[] {
	return Object.keys(record).filter((key) => !known.has(key));
}

/**
 * Parse a `.uproject`. `errors` (parse failure) is reported through `diagnostics` so callers
 * always get a structure back, mirroring how the engine treats a malformed descriptor as
 * "no descriptor" rather than a partial one.
 */
export function parseUproject(path: string, fs: FsAdapter): UprojectDescriptor {
	const diagnostics: string[] = [];
	const text = readFileSafe(path, fs);
	if (text === undefined) {
		return {
			path,
			modules: [],
			plugins: [],
			targetPlatforms: [],
			additionalPluginDirectories: [],
			additionalRootDirectories: [],
			enterprise: false,
			disableEnginePluginsByDefault: false,
			knownFields: [],
			unknownFields: [],
			diagnostics: [`cannot read ${path}`],
		};
	}
	const { value, errors } = parseJsoncLenient<Record<string, JsonValue>>(text);
	if (errors.length > 0) diagnostics.push(`jsonc: ${errors.join(", ")} (engine-side load would fail)`);
	const record = asRecord(value);
	const plugins = parsePluginReferences(record.Plugins, diagnostics);
	for (const key of Object.keys(record)) {
		if (!UPROJECT_FIELDS.has(key)) diagnostics.push(`.uproject field "${key}" is not serialized by FProjectDescriptor`);
	}
	return {
		path,
		engineAssociation: asString(record.EngineAssociation),
		category: asString(record.Category),
		description: asString(record.Description),
		enterprise: asBoolean(record.Enterprise),
		disableEnginePluginsByDefault: asBoolean(record.DisableEnginePluginsByDefault),
		modules: parseModuleMap(record.Modules, diagnostics),
		plugins,
		targetPlatforms: asStringArray(record.TargetPlatforms),
		additionalPluginDirectories: asStringArray(record.AdditionalPluginDirectories),
		additionalRootDirectories: asStringArray(record.AdditionalRootDirectories),
		knownFields: Object.keys(record).filter((key) => UPROJECT_FIELDS.has(key)),
		unknownFields: unknownFieldsIn(record, UPROJECT_FIELDS),
		diagnostics,
	};
}

/** Parse a `.uplugin`. `name` defaults to the file stem, which is what the engine uses as the plugin name. */
export function parseUplugin(path: string, fs: FsAdapter, options: { name?: string } = {}): UpluginDescriptor {
	const diagnostics: string[] = [];
	const text = readFileSafe(path, fs);
	const stem = (path.split("/").pop() ?? "").replace(/\.uplugin$/i, "");
	const base: UpluginDescriptor = {
		path,
		name: options.name ?? stem,
		enabledByDefault: false,
		canContainContent: false,
		canContainVerse: false,
		noCode: false,
		isBetaVersion: false,
		isExperimentalVersion: false,
		installed: false,
		requiresBuildPlatform: false,
		isHidden: false,
		isSealed: false,
		explicitlyLoaded: false,
		hasExplicitPlatforms: false,
		isPluginExtension: false,
		supportedTargetPlatforms: [],
		supportedPrograms: [],
		platformAllowList: [],
		platformDenyList: [],
		targetAllowList: [],
		targetDenyList: [],
		modules: [],
		plugins: [],
		knownFields: [],
		unknownFields: [],
		diagnostics,
	};
	if (text === undefined) {
		diagnostics.push(`cannot read ${path}`);
		return base;
	}
	const { value, errors } = parseJsoncLenient<Record<string, JsonValue>>(text);
	if (errors.length > 0) diagnostics.push(`jsonc: ${errors.join(", ")} (engine-side load would fail)`);
	const record = asRecord(value);
	base.versionRaw = asNumber(record.Version) ?? asNumber(record.FileVersion);
	base.version = decodeFileVersion(base.versionRaw);
	base.semVersion = asString(record.SemVersion);
	base.versionName = asString(record.VersionName);
	base.engineVersion = parseEngineVersion(asString(record.EngineVersion));
	base.friendlyName = asString(record.FriendlyName);
	base.category = asString(record.Category) ?? asString(record.CategoryPath);
	base.description = asString(record.Description);
	base.enabledByDefault = asBoolean(record.EnabledByDefault);
	base.canContainContent = asBoolean(record.CanContainContent) || asBoolean(record.bCanContainContent);
	base.canContainVerse = asBoolean(record.CanContainVerse);
	base.noCode = asBoolean(record.NoCode);
	base.isBetaVersion = asBoolean(record.IsBetaVersion);
	base.isExperimentalVersion = asBoolean(record.IsExperimentalVersion);
	base.installed = asBoolean(record.Installed);
	base.requiresBuildPlatform = asBoolean(record.RequiresBuildPlatform);
	base.isHidden = asBoolean(record.Hidden);
	base.isSealed = asBoolean(record.Sealed);
	base.explicitlyLoaded = asBoolean(record.ExplicitlyLoaded);
	base.hasExplicitPlatforms = asBoolean(record.HasExplicitPlatforms);
	base.isPluginExtension = asBoolean(record.bIsPluginExtension);
	base.createdBy = asString(record.CreatedBy);
	base.docsUrl = asString(record.DocsURL);
	base.marketplaceUrl = asString(record.MarketplaceURL);
	base.supportUrl = asString(record.SupportURL);
	base.supportedTargetPlatforms = asStringArray(record.SupportedTargetPlatforms);
	base.supportedPrograms = asStringArray(record.SupportedPrograms);
	base.platformAllowList = asStringArray(record.PlatformAllowList);
	base.platformDenyList = asStringArray(record.PlatformDenyList);
	base.targetAllowList = asStringArray(record.TargetAllowList);
	base.targetDenyList = asStringArray(record.TargetDenyList);
	base.modules = parseModuleMap(record.Modules, diagnostics);
	base.plugins = parsePluginReferences(record.Plugins, diagnostics);
	base.knownFields = Object.keys(record).filter((key) => UPLUGIN_FIELDS.has(key));
	base.unknownFields = unknownFieldsIn(record, UPLUGIN_FIELDS);
	if (base.modules.length === 0) diagnostics.push("no Modules entries: the plugin contributes no modules");
	return base;
}

/** `Major.Minor` of an `FEngineVersion`, the unit `.uproject` associations are keyed by. */
export function versionToMajorMinor(version: EngineVersion | undefined): string | undefined {
	if (!version) return undefined;
	return `${version.major}.${version.minor}`;
}
