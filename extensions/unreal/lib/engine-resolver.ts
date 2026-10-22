/**
 * Engine association resolution for a `.uproject`.
 *
 * The algorithm mirrors the engine's own so a tool answer matches what UnrealVersionSelector
 * and UnrealBuildTool will do:
 *
 *   Engine/Source/Developer/DesktopPlatform/Private/DesktopPlatformBase.cpp:459-511
 *     FDesktopPlatformBase::GetEngineIdentifierForProject()
 *       - `EngineAssociation` containing `/` or `\` is a *path to the engine root*, resolved
 *         against the project directory (source builds, per-project engine checkouts).
 *       - empty `EngineAssociation` (the normal state for source builds; the engine blanks it
 *         in `SetEngineIdentifierForProject`) means "walk up from the project directory".
 *   Engine/Source/Developer/DesktopPlatform/Private/DesktopPlatformBase.cpp:401-421
 *     FDesktopPlatformBase::IsValidRootDirectory() — a directory is an engine root iff it has
 *     both `Engine/Binaries` and `Engine/Build`.
 *   Engine/Source/Developer/DesktopPlatform/Private/DesktopPlatformWindows.cpp:335-380,503
 *     install enumeration from `HKLM\SOFTWARE\EpicGames\Unreal Engine\<version>`,
 *     `HKLM\SOFTWARE\EpicGames\Unreal Engine` default value, and
 *     `HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds` (GUID -> engine root).
 *   Engine/Source/Developer/DesktopPlatform/Private/DesktopPlatformBase.cpp:72-86,1573-1615
 *     `%PROGRAMDATA%\UnrealEngineLauncher\LauncherInstalled.dat` (`InstallationList[].AppName`
 *     `UE_5.8` maps to association `5.8` by stripping the `UE_` prefix).
 *
 * Two deliberate deviations from Epic's code:
 *   1. `GetEngineIdentifierFromRootDir()` falls back to `RegisterEngineInstallation()`, which
 *      *writes* `HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds`. This module is read-only.
 *   2. A registry hit is never trusted on its own: the directory must exist, pass
 *      `IsValidRootDirectory`, and agree with `Engine/Build/Build.version`. Stale keys are a
 *      real failure mode (this machine has `HKLM` entries for 5.5/5.6 whose directories do not
 *      exist, and a `UE_5.8` directory with no registry entry at all).
 */

import { readBuildVersion, parseUproject, versionToMajorMinor, type EngineVersion } from "./descriptors.ts";
import { noRegistry, type RegistryReader, type RegistrySnapshot } from "./registry.ts";
import { ancestors, isAbsolutePath, joinPath, normalizePath, parentDir, realFs, walkUp, type FsAdapter } from "./util.ts";

export type SourceKind =
	| "user-hint"
	| "uproject-inline-path"
	| "launcher-dat"
	| "hklm-version"
	| "hkcu-builds"
	| "hklm-installdir"
	| "env"
	| "dir-scan"
	| "walk-up";

export type AssociationKind = "inline-path" | "guid" | "version" | "empty" | "legacy" | "unknown";

export type ResolutionStatus = "resolved" | "ambiguous" | "unresolved";

export interface EngineCandidate {
	identifier: string;
	root: string;
	source: SourceKind;
	rank: number;
	directoryExists: boolean;
	/** `IsValidRootDirectory`: `Engine/Binaries` and `Engine/Build` both present. */
	validRoot: boolean;
	version?: EngineVersion;
	/** MajorMinor of `version`, when the root is readable. */
	versionMajorMinor?: string;
	/** False when the association is version-shaped and disagrees with `Build.version`. */
	versionMatches: boolean;
	notes: string[];
}

export interface EngineResolution {
	status: ResolutionStatus;
	projectPath?: string;
	projectDir?: string;
	engineAssociation?: string;
	associationKind: AssociationKind;
	/** Set when `status === "resolved"`, and the top-ranked candidate when ambiguous. */
	engineRoot?: string;
	identifier?: string;
	version?: EngineVersion;
	source?: SourceKind;
	buildVersionPath?: string;
	/** `Engine/Build/InstalledBuild.txt` present → launcher/installed build, else source build. */
	installedBuild?: boolean;
	candidates: EngineCandidate[];
	diagnostics: string[];
	remediation: string[];
}

export interface EngineInstall {
	identifier: string;
	root: string;
	source: SourceKind;
	directoryExists: boolean;
	validRoot: boolean;
	version?: EngineVersion;
	versionMajorMinor?: string;
}

export interface ResolverDeps {
	fs?: FsAdapter;
	registry?: RegistryReader;
	/** Extra engine roots to trust, ranked above registry sources (user-supplied overrides). */
	userEngineRoots?: string[];
	/** Environment map, for tests. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

const SOURCE_RANK: Record<SourceKind, number> = {
	"user-hint": 0,
	"uproject-inline-path": 1,
	"launcher-dat": 2,
	"hklm-version": 3,
	"hkcu-builds": 4,
	"hklm-installdir": 5,
	env: 6,
	"dir-scan": 7,
	"walk-up": 8,
};

/** Environment variables this machine convention uses for the engine root. */
const ENGINE_ROOT_ENV_VARS = ["PI_UNREAL_ENGINE_ROOT", "UNREAL_ENGINE", "UE_ROOT"];

/**
 * `IsValidRootDirectory` equivalent, plus a version read. Cheap: two `stat` calls and one
 * small file read, so it is safe to call per candidate.
 */
export function isValidEngineRoot(root: string, fs: FsAdapter = realFs): boolean {
	if (!root || !fs.isDirectory(root)) return false;
	return fs.exists(joinPath(root, "Engine/Binaries")) && fs.exists(joinPath(root, "Engine/Build"));
}

function isGuidLike(identifier: string): boolean {
	return /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/.test(identifier.trim());
}

function classifyAssociation(association: string | undefined): AssociationKind {
	if (!association || association.trim() === "") return "empty";
	const trimmed = association.trim();
	if (trimmed.includes("/") || trimmed.includes("\\")) return "inline-path";
	if (isGuidLike(trimmed)) return "guid";
	if (/^\d+\.\d+\.\d+$/.test(trimmed)) return "legacy";
	if (/^\d+\.\d+$/.test(trimmed)) return "version";
	// 4.0-era bare "EngineVersion" strings and typos land here; they are matched verbatim.
	return "unknown";
}

/** `UE_5.8` -> `5.8`, `5.8.4` -> `5.8`, anything else unchanged. */
function normalizeAssociation(identifier: string): string {
	const trimmed = identifier.trim();
	const launcherMatch = trimmed.match(/^UE_(\d+\.\d+)/i);
	if (launcherMatch?.[1]) return launcherMatch[1];
	const threePart = trimmed.match(/^(\d+\.\d+)\.\d+$/);
	if (threePart?.[1]) return threePart[1];
	return trimmed;
}

async function readSnapshot(registry: RegistryReader): Promise<RegistrySnapshot> {
	try {
		return await registry();
	} catch (error) {
		return {
			available: false,
			hklmVersions: [],
			hkcuBuilds: [],
			launcherDatPath: "",
			launcherDatExists: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Candidate engine roots known to this machine, ranked, each validated. */
export async function enumerateInstallations(deps: ResolverDeps = {}): Promise<EngineInstall[]> {
	const fs = deps.fs ?? realFs;
	const snapshot = await readSnapshot(deps.registry ?? noRegistry);
	const out: EngineInstall[] = [];
	const seen = new Set<string>();

	const add = (identifierHint: string, rawRoot: string | undefined, source: SourceKind): void => {
		if (!rawRoot) return;
		const root = normalizePath(rawRoot);
		const directoryExists = fs.isDirectory(root);
		const validRoot = isValidEngineRoot(root, fs);
		const version = validRoot ? readBuildVersion(root, fs) : undefined;
		const versionMajorMinor = versionToMajorMinor(version);
		// Registry and launcher entries carry a usable identifier; env and user overrides do not, so
		// their identifier is derived from the engine's own Build.version.
		const derived = isGuidLike(identifierHint)
			? identifierHint
			: /^\d+\.\d+/.test(identifierHint) ? normalizeAssociation(identifierHint) : versionMajorMinor ?? identifierHint;
		const key = `${derived.toLowerCase()}|${root.toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({
			identifier: derived,
			root,
			source,
			directoryExists,
			validRoot,
			version,
			versionMajorMinor,
		});
	};

	for (const root of deps.userEngineRoots ?? []) add("", root, "user-hint");
	for (const entry of snapshot.launcherDat ?? []) {
		if (!entry.appName || !entry.installLocation) continue;
		add(entry.appName, entry.installLocation, "launcher-dat");
	}
	for (const key of snapshot.hklmVersions) add(key.version, key.installedDirectory ?? key.installDirDefault, "hklm-version");
	for (const build of snapshot.hkcuBuilds) add(build.identifier, build.root, "hkcu-builds");
	if (snapshot.installDirDefault) add("installdir", snapshot.installDirDefault, "hklm-installdir");

	const env = deps.env ?? process.env;
	for (const name of ENGINE_ROOT_ENV_VARS) {
		const value = env[name];
		if (value) add(`env:${name}`, value, "env");
	}

	// Supplemental heuristic (not part of Epic's algorithm): the launcher installs engines as
	// siblings under `%ProgramFiles%\Epic Games`, which is how an engine with no registry
	// presence (this machine's UE_5.8) is found at all.
	for (const parent of candidateScanRoots(env, snapshot)) {
		for (const child of fs.listDir(parent)) {
			const candidate = joinPath(parent, child);
			if (fs.isDirectory(candidate) && /^UE_\d+\.\d+$/i.test(child)) add(child.replace(/^UE_/i, ""), candidate, "dir-scan");
		}
	}

	out.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.identifier.localeCompare(b.identifier));
	return out;
}

function candidateScanRoots(env: Record<string, string | undefined>, snapshot: RegistrySnapshot): string[] {
	const roots = new Set<string>();
	const programFiles = env["ProgramFiles"] ?? env["PROGRAMFILES"] ?? "C:/Program Files";
	roots.add(joinPath(normalizePath(programFiles), "Epic Games"));
	// An engine install recorded anywhere gives its parent directory as a scan root.
	const dirs = [
		...(snapshot.launcherDat ?? []).map((entry) => entry.installLocation),
		...snapshot.hklmVersions.map((entry) => entry.installedDirectory),
		snapshot.installDirDefault,
		...(snapshot.hkcuBuilds ?? []).map((entry) => entry.root),
	];
	for (const dir of dirs) {
		if (!dir) continue;
		const parent = parentDir(normalizePath(dir));
		if (parent) roots.add(parent);
	}
	return [...roots];
}

function makeCandidate(
	identifier: string,
	root: string,
	source: SourceKind,
	fs: FsAdapter,
	targetMajorMinor: string | undefined,
	notes: string[],
): EngineCandidate {
	const directoryExists = fs.isDirectory(root);
	const validRoot = isValidEngineRoot(root, fs);
	const version = validRoot ? readBuildVersion(root, fs) : undefined;
	const versionMajorMinor = versionToMajorMinor(version);
	const versionMatches = !targetMajorMinor || !versionMajorMinor || versionMajorMinor === targetMajorMinor;
	if (!directoryExists) notes.push("directory does not exist");
	else if (!validRoot) notes.push("missing Engine/Binaries or Engine/Build (not an engine root)");
	else if (!version) notes.push("Engine/Build/Build.version unreadable");
	else if (!versionMatches) notes.push(`Build.version ${versionMajorMinor} does not match association ${targetMajorMinor}`);
	return {
		identifier: normalizeAssociation(identifier),
		root,
		source,
		rank: SOURCE_RANK[source],
		directoryExists,
		validRoot,
		version,
		versionMajorMinor,
		versionMatches,
		notes,
	};
}

/**
 * Resolve the engine a project belongs to.
 *
 * Never returns a silent guess: `status` is `resolved` only when exactly one candidate is a
 * valid engine root that matches the association. `ambiguous` ranks every survivor and names
 * the top one; `unresolved` lists the dead candidates with the reason each one died.
 */
export async function resolveEngineForProject(
	projectPath: string,
	deps: ResolverDeps = {},
): Promise<EngineResolution> {
	const fs = deps.fs ?? realFs;
	const registry = deps.registry ?? noRegistry;
	const normalizedProject = normalizePath(projectPath);
	const projectDir = parentDir(normalizedProject) ?? normalizedProject;
	const diagnostics: string[] = [];
	const remediation: string[] = [];

	const descriptor = normalizedProject.toLowerCase().endsWith(".uproject")
		? parseUproject(normalizedProject, fs)
		: undefined;
	if (descriptor) {
		for (const line of descriptor.diagnostics) diagnostics.push(line);
	}
	const association = descriptor?.engineAssociation;
	const associationKind = classifyAssociation(association);
	const trimmedAssociation = association?.trim() ?? "";
	const targetMajorMinor =
		associationKind === "version" || associationKind === "legacy" || associationKind === "unknown" ? normalizeAssociation(trimmedAssociation) : undefined;

	const candidates: EngineCandidate[] = [];

	// (1) `EngineAssociation` as an inline engine-root path.
	if (associationKind === "inline-path") {
		const raw = trimmedAssociation.replace(/\\/g, "/");
		const root = isAbsolutePath(raw) ? normalizePath(raw) : normalizePath(joinPath(projectDir, raw));
		candidates.push(makeCandidate(root, root, "uproject-inline-path", fs, targetMajorMinor, []));
	}

	// (2) `EngineAssociation` empty → walk up from the project directory (source builds).
	if (associationKind === "empty") {
		walkUp(projectDir, (dir) => {
			if (isValidEngineRoot(dir, fs)) {
				candidates.push(makeCandidate(dir, dir, "walk-up", fs, undefined, ["EngineAssociation is empty; matched the enclosing source tree"]));
				return true;
			}
			return undefined;
		}, 12);
	}

	const versionish = associationKind === "version" || associationKind === "legacy" || associationKind === "unknown";
	const guid = associationKind === "guid";

	if (versionish || guid) {
		const installs = await enumerateInstallations({ fs, registry, userEngineRoots: deps.userEngineRoots, env: deps.env });
		for (const install of installs) {
			if (guid) {
				// A GUID association is only ever resolvable through `HKCU\...\Builds`, where the
				// value name is the identifier the project carries.
				if (install.source !== "hkcu-builds" || !sameGuid(install.identifier, trimmedAssociation)) continue;
			} else if (targetMajorMinor && install.identifier.toLowerCase() !== targetMajorMinor.toLowerCase()) {
				// A pointer that exists but is not an engine root stays in the list: "your UNREAL_ENGINE
				// points at a directory that is not an engine root" is the diagnostic the agent needs.
				if (install.validRoot) continue;
			}
			candidates.push(makeCandidate(install.identifier, install.root, install.source, fs, targetMajorMinor, []));
		}
		const snapshot = await readSnapshot(registry);
		if (!snapshot.available && snapshot.error) diagnostics.push(`registry sources unavailable: ${snapshot.error}`);
	}

	// Deduplicate by root, keeping the best-ranked entry per root.
	const byRoot = new Map<string, EngineCandidate>();
	for (const candidate of candidates) {
		const key = candidate.root.toLowerCase();
		const existing = byRoot.get(key);
		if (!existing || candidate.rank < existing.rank) byRoot.set(key, candidate);
	}
	const ranked = [...byRoot.values()].sort(
		(a, b) => Number(b.validRoot) - Number(a.validRoot) || Number(b.versionMatches) - Number(a.versionMatches) || a.rank - b.rank,
	);

	const base = {
		projectPath: normalizedProject,
		projectDir,
		engineAssociation: association,
		associationKind,
		candidates: ranked,
		diagnostics,
		remediation,
	} satisfies Omit<EngineResolution, "status">;

	const survivors = ranked.filter((candidate) => candidate.validRoot && candidate.versionMatches);

	if (survivors.length === 1) {
		const winner = survivors[0];
		if (!winner) return { ...base, status: "unresolved" };
		return {
			...base,
			status: "resolved",
			engineRoot: winner.root,
			identifier: winner.identifier,
			version: winner.version,
			source: winner.source,
			buildVersionPath: joinPath(winner.root, "Engine/Build/Build.version"),
			installedBuild: fs.exists(joinPath(winner.root, "Engine/Build/InstalledBuild.txt")),
		};
	}

	if (survivors.length > 1) {
		const winner = survivors[0];
		remediation.push(
			`more than one valid engine root matches (${survivors.map((c) => `${c.identifier} via ${c.source} → ${c.root}`).join("; ")}); pass the intended root explicitly`,
		);
		return {
			...base,
			status: "ambiguous",
			engineRoot: winner?.root,
			identifier: winner?.identifier,
			version: winner?.version,
			source: winner?.source,
			buildVersionPath: winner ? joinPath(winner.root, "Engine/Build/Build.version") : undefined,
			installedBuild: winner ? fs.exists(joinPath(winner.root, "Engine/Build/InstalledBuild.txt")) : undefined,
		};
	}

	// Nothing survived. Explain why, and give the engine-side fix.
	if (associationKind === "inline-path") {
		remediation.push(`EngineAssociation names a path (${trimmedAssociation}) that is not a valid engine root for ${normalizedProject}`);
	} else if (associationKind === "guid") {
		remediation.push(
			`EngineAssociation ${trimmedAssociation} has no entry under HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds; open the project with the matching source build (its GeneratedProjectFiles / UBT run registers the key)`,
		);
	} else if (associationKind === "empty") {
		remediation.push(`no enclosing engine root found above ${projectDir}; set EngineAssociation or run from inside the source tree`);
	} else {
		remediation.push(
			targetMajorMinor
				? `no readable engine root for association ${targetMajorMinor}; set EngineAssociation to a UE_${targetMajorMinor} install directory, a source-build GUID, or an engine-root path`
				: `cannot interpret EngineAssociation "${trimmedAssociation}"`,
		);
	}
	if (ranked.length > 0) {
		remediation.push(`candidates considered: ${ranked.map((c) => `${c.root} (${c.source}; ${c.notes.join("; ") || "ok"})`).join(" | ")}`);
	}
	return { ...base, status: "unresolved" };
}

function sameGuid(a: string, b: string): boolean {
	const strip = (value: string) => value.trim().replace(/[{}]/g, "").toLowerCase();
	return strip(a) === strip(b);
}

/** Ancestor directories of `cwd`, shallowest last — used to find a project to talk about. */
export function findProjectFile(startDir: string, fs: FsAdapter = realFs, maxDepth = 4): string | undefined {
	for (const dir of ancestors(startDir, maxDepth)) {
		for (const entry of fs.listDir(dir)) {
			if (entry.toLowerCase().endsWith(".uproject")) return joinPath(dir, entry);
		}
	}
	return undefined;
}
