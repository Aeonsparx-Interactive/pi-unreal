/**
 * Plugin discovery and reference resolution.
 *
 * Discovery order mirrors `UnrealBuildTool.System.ReadAvailablePlugins()`
 * (`Engine/Source/Programs/UnrealBuildTool/System/Plugins.cs:322`):
 *   1. Engine plugins      — `<EngineRoot>/Engine/Plugins`                     (`EPluginType::Engine`)
 *   2. Project plugins     — `<ProjectDir>/Plugins`                            (`EPluginType::Project`)
 *   3. Mods              — `<ProjectDir>/Mods`                               (`EPluginType::Mod`)
 *   4. Additional dirs     — `.uproject` `AdditionalPluginDirectories`         (`EPluginType::External`)
 * Later scans win on a name collision: a project plugin shadows an engine plugin of the same
 * name, which is exactly what a marketplace copy of an engine plugin does.
 *
 * Reference semantics mirror `PluginManager` (`Engine/Source/Runtime/Projects/Private/…`):
 * a `.uproject` reference is `Enabled` / `Optional` / `Activate` (`PluginReferenceDescriptor.cpp:132-172`),
 * and an engine-version mismatch is a warning, not an error (`FEngineVersion::Parse` +
 * `GetNewest`, `PluginManager.cpp:2690-2712`).
 */

import { parseUplugin, versionToMajorMinor, type EngineVersion, type PluginReference, type UprojectDescriptor, type UpluginDescriptor } from "./descriptors.ts";
import { joinPath, normalizePath, realFs, shortHash, type FsAdapter } from "./util.ts";

export type PluginSource = "Engine" | "Project" | "Mod" | "External";

const SOURCE_RANK: Record<PluginSource, number> = { Engine: 1, Project: 2, Mod: 3, External: 4 };

/**
 * Bucket order for one plugin name: the copy the engine actually loads comes first
 * (Engine < Project < Mod < External), ties broken by path. Shared with the cache layer so a
 * cache hit cannot return a different shadow winner than a cold scan.
 */
export function comparePluginSource(a: { source: PluginSource; path: string }, b: { source: PluginSource; path: string }): number {
	return SOURCE_RANK[b.source] - SOURCE_RANK[a.source] || a.path.localeCompare(b.path);
}

/** Cached, compact view of a `.uplugin`. Full descriptor is re-parsed on demand from disk. */
export interface PluginSummary {
	name: string;
	path: string;
	dir: string;
	source: PluginSource;
	version?: string;
	semVersion?: string;
	versionName?: string;
	engineVersionRaw?: string;
	category?: string;
	friendlyName?: string;
	description?: string;
	enabledByDefault: boolean;
	canContainContent: boolean;
	isBetaVersion: boolean;
	installed: boolean;
	supportedTargetPlatforms: string[];
	modules: { moduleName: string; type?: string; loadingPhase?: string }[];
	plugins: { name: string; enabled: boolean; optional: boolean; activate: boolean }[];
	diagnostics: string[];
}

export interface PluginIndex {
	engineRoot?: string;
	projectDir?: string;
	additionalDirs: string[];
	scannedDirs: string[];
	scannedFiles: number;
	entries: PluginSummary[];
	byName: Map<string, PluginSummary[]>;
	builtAtMs: number;
}

export interface BuildPluginIndexOptions {
	engineRoot?: string;
	projectDir?: string;
	additionalPluginDirectories?: string[];
	/** Extra roots treated as Project-type plugins (`.uproject` AdditionalRootDirectories). */
	additionalRootDirectories?: string[];
	fs?: FsAdapter;
	now?: () => number;
}

/**
 * Scan roots in discovery order. Exported so the cache key and the builder agree on exactly
 * which directories an index covers.
 */
export function computeScanDirs(options: BuildPluginIndexOptions): { dir: string; source: PluginSource }[] {
	const specs: { dir: string; source: PluginSource }[] = [];
	if (options.engineRoot) specs.push({ dir: joinPath(normalizePath(options.engineRoot), "Engine/Plugins"), source: "Engine" });
	if (options.projectDir) {
		specs.push({ dir: joinPath(normalizePath(options.projectDir), "Plugins"), source: "Project" });
		specs.push({ dir: joinPath(normalizePath(options.projectDir), "Mods"), source: "Mod" });
	}
	for (const dir of options.additionalPluginDirectories ?? []) {
		const resolved = normalizePath(dir);
		specs.push({ dir: options.projectDir && dir.startsWith(".") ? joinPath(normalizePath(options.projectDir), dir) : resolved, source: "External" });
	}
	for (const dir of options.additionalRootDirectories ?? []) {
		specs.push({ dir: joinPath(normalizePath(dir), "Plugins"), source: "External" });
	}
	return specs;
}

async function scanUplugins(dir: string, source: PluginSource, fs: FsAdapter): Promise<PluginSummary[]> {
	// fast-glob is imported lazily: an index rebuild is the only caller that needs it.
	const { default: fastGlob } = await import("fast-glob");
	let found: string[] = [];
	try {
		found = await fastGlob(["**/*.uplugin"], {
			cwd: dir,
			absolute: true,
			dot: false,
			followSymbolicLinks: false,
			ignore: ["**/Binaries/**", "**/Intermediate/**", "**/Saved/**", "**/.git/**", "**/ThirdParty/**"],
		});
	} catch {
		return [];
	}
	const out: PluginSummary[] = [];
	for (const raw of found) {
		const path = normalizePath(raw);
		if (!fs.exists(path)) continue;
		out.push(toSummary(parseUplugin(path, fs), source));
	}
	return out;
}

export function toSummary(descriptor: UpluginDescriptor, source: PluginSource): PluginSummary {
	return {
		name: descriptor.name,
		path: descriptor.path,
		dir: descriptor.path.slice(0, descriptor.path.lastIndexOf("/")),
		source,
		version: descriptor.version,
		semVersion: descriptor.semVersion,
		versionName: descriptor.versionName,
		engineVersionRaw: descriptor.engineVersion?.raw,
		category: descriptor.category,
		friendlyName: descriptor.friendlyName,
		description: descriptor.description,
		enabledByDefault: descriptor.enabledByDefault,
		canContainContent: descriptor.canContainContent,
		isBetaVersion: descriptor.isBetaVersion,
		installed: descriptor.installed,
		supportedTargetPlatforms: descriptor.supportedTargetPlatforms,
		modules: descriptor.modules.map((entry) => ({
			moduleName: entry.moduleName,
			type: entry.descriptor.type,
			loadingPhase: entry.descriptor.loadingPhase,
		})),
		plugins: descriptor.plugins.map((ref) => ({ name: ref.name, enabled: ref.enabled, optional: ref.optional, activate: ref.activate })),
		diagnostics: descriptor.diagnostics,
	};
}

/**
 * Build the plugin index for one project.
 *
 * Cold cost on a real install is the engine scan (UE 5.8: 897 `.uplugin` files). The result is
 * cached on disk by `cache.ts`, keyed on engine version + directory mtimes.
 */
export async function buildPluginIndex(options: BuildPluginIndexOptions): Promise<PluginIndex> {
	const fs = options.fs ?? realFs;
	const now = options.now ?? (() => Date.now());
	const scanSpecs = computeScanDirs(options);

	const entries: PluginSummary[] = [];
	const scannedDirs: string[] = [];
	for (const spec of scanSpecs) {
		if (!fs.isDirectory(spec.dir)) continue;
		scannedDirs.push(spec.dir);
		entries.push(...(await scanUplugins(spec.dir, spec.source, fs)));
	}

	const byName = new Map<string, PluginSummary[]>();
	for (const entry of entries) {
		const key = entry.name.toLowerCase();
		const bucket = byName.get(key);
		if (bucket) bucket.push(entry);
		else byName.set(key, [entry]);
	}
	for (const bucket of byName.values()) {
		bucket.sort(comparePluginSource);
	}

	return {
		engineRoot: options.engineRoot ? normalizePath(options.engineRoot) : undefined,
		projectDir: options.projectDir ? normalizePath(options.projectDir) : undefined,
		additionalDirs: (options.additionalPluginDirectories ?? []).map(normalizePath),
		scannedDirs,
		scannedFiles: entries.length,
		entries,
		byName,
		builtAtMs: now(),
	};
}

export interface PluginReferenceResult {
	name: string;
	status: "resolved" | "disabled" | "missing" | "version-warning" | "shadowed" | "no-modules" | "beta";
	/** Winning plugin, when the name resolves. */
	plugin?: PluginSummary;
	/** Same-name entries the winner displaced (`shadowed` lists them for transparency). */
	shadowed: PluginSummary[];
	/** Engine-version note mirroring `PluginManager`'s warning; absent when compatible. */
	versionNote?: string;
	notes: string[];
}

/** Resolve every `Plugins` entry of a `.uproject` against the index. */
export function resolveProjectPlugins(
	descriptor: UprojectDescriptor,
	index: PluginIndex,
	engineVersion: EngineVersion | undefined,
	options: { targetPlatform?: string } = {},
): PluginReferenceResult[] {
	const out: PluginReferenceResult[] = [];
	for (const ref of descriptor.plugins) {
		out.push(resolvePluginReference(ref, index, engineVersion, options));
	}
	return out;
}

export function resolvePluginReference(
	ref: PluginReference,
	index: PluginIndex,
	engineVersion: EngineVersion | undefined,
	options: { targetPlatform?: string } = {},
): PluginReferenceResult {
	const bucket = index.byName.get(ref.name.toLowerCase()) ?? [];
	const base = { name: ref.name, shadowed: bucket.slice(1), notes: [] as string[] } as PluginReferenceResult;

	if (ref.supportedTargetPlatforms.length > 0 && options.targetPlatform && !ref.supportedTargetPlatforms.includes(options.targetPlatform)) {
		base.notes.push(`reference lists SupportedTargetPlatforms [${ref.supportedTargetPlatforms.join(", ")}], not ${options.targetPlatform}`);
	}
	if (!ref.enabled) {
		base.status = "disabled";
		base.plugin = bucket[0];
		base.notes.push("Enabled: false in the .uproject reference");
		return base;
	}
	const winner = bucket[0];
	if (!winner) {
		base.status = "missing";
		base.notes.push(
			`no .uplugin named ${ref.name} under ${index.scannedDirs.join(" | ") || "(no plugin directories found)"}${ref.optional ? "; reference is Optional so the build tolerates it" : ""}`,
		);
		return base;
	}
	base.plugin = winner;
	if (bucket.length > 1) {
		base.notes.push(
			`${winner.source} ${winner.name} shadows ${bucket
				.slice(1)
				.map((entry) => `${entry.source} ${entry.name}`)
				.join(", ")} — the engine loads the first match found (Engine < Project < Mod < External)`,
		);
	}
	if (winner.modules.length === 0) base.notes.push("plugin declares no modules");
	if (winner.isBetaVersion) base.notes.push("IsBetaVersion: true (metadata only in UE 5.8: read at PluginDescriptor.cpp:371 and PluginDescriptor.cs:397, no engine/UBT beta gate found)");
	/* Engine truth: `.uplugin` has no `Enabled` key (PluginDescriptor.cpp never reads it). Default
	   enablement is `EnabledByDefault` -> FPlugin::IsEnabledByDefault (PluginManager.cpp:421-431),
	   and a `"Enabled": true` reference is what loads a plugin that is not enabled by default — so a
	   plugin's own flag is information, never a warning. */
	if (ref.enabled && winner.enabledByDefault && !ref.activate) {
		base.notes.push("plugin is EnabledByDefault: true, so it loads even without this reference");
	}

	const versionNote = comparePluginEngineVersion(winner, engineVersion);
	if (versionNote) base.notes.push(versionNote);

	let status: PluginReferenceResult["status"] = "resolved";
	if (winner.modules.length === 0) status = "no-modules";
	else if (winner.isBetaVersion) status = "beta";
	if (versionNote) status = "version-warning";
	base.status = status;
	if (versionNote) base.versionNote = versionNote;
	return base;
}

/** Mirrors `PluginManager.cpp:2690-2712`: mismatch is a warning naming both sides. */
function comparePluginEngineVersion(plugin: PluginSummary, engineVersion: EngineVersion | undefined): string | undefined {
	if (!plugin.engineVersionRaw || !engineVersion) return undefined;
	const declared = versionToMajorMinor(parseEngineVersionRaw(plugin.engineVersionRaw));
	const current = versionToMajorMinor(engineVersion);
	if (!declared || !current) return undefined;
	if (declared === current) return undefined;
	return `plugin EngineVersion ${plugin.engineVersionRaw} differs from engine ${engineVersion.raw} (PluginManager warns on load)`;
}

function parseEngineVersionRaw(raw: string): EngineVersion | undefined {
	const match = raw.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?(?:\+(.*))?$/);
	if (!match) return undefined;
	const [, major, minor, patch, changelist, branch] = match;
	return {
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		changelist: Number(changelist ?? "0"),
		branchName: branch,
		raw: raw.trim(),
	};
}

/* --------------------------------------------------------------------------
 * Enablement closure.
 *
 * "Is this plugin available?" is not a question about the `.uproject`. The engine loads a plugin
 * that is (a) referenced with `Enabled: true`, (b) `EnabledByDefault: true`, or (c) declared in the
 * `Plugins[]` list of a plugin it already loaded (`PluginManager.cpp`, `PluginDescriptor.cpp`). The
 * field session on UE 5.8 hit exactly this: `PhysicsControl` was mounted (`LogPluginManager: Mounting
 * Engine plugin PhysicsControl`) because `AnimatorKit` (EnabledByDefault) declares it, and
 * `BlendStack` because `Chooser` declares it — while the tooling answered "needs a .uproject
 * reference" and returned 0 symbol rows for types the running editor had loaded.
 *
 * The closure below is the same walk a two-seed BFS produces (seeds: enabled `.uproject` references +
 * every `EnabledByDefault` plugin; edges: each loaded plugin's `Plugins[]`, `Enabled` defaulting to
 * true). It records the shortest enabling chain per plugin, because "enabled somehow" is not an
 * answer a reader can act on.
 * ------------------------------------------------------------------------- */

export type EnablementKind = "reference" | "default" | "dependency";

export interface PluginEnablement {
	/** The winning descriptor — the copy the engine would load. */
	plugin: PluginSummary;
	/** Why it is loaded. */
	kind: EnablementKind;
	/** For `dependency`: the plugin whose `Plugins[]` declares this one. */
	via?: string;
	/** Enabling chain, seed first: `["uproject:Chooser", "Chooser"]`, `["EnabledByDefault:AnimatorKit", "AnimatorKit"]`. */
	chain: string[];
	/** 0 for a seed, 1 for a plugin a seed declares, and so on. */
	depth: number;
}

export interface EnablementClosure {
	/** Lowercased plugin name → how it is enabled. */
	byName: Map<string, PluginEnablement>;
	/** Resolved `.uproject` references with `Enabled: true`. */
	referenced: PluginSummary[];
	/** `EnabledByDefault: true` plugins the `.uproject` does not reference. */
	defaultEnabled: PluginSummary[];
	/** Plugins loaded only because an enabled plugin declares them. */
	dependencies: PluginSummary[];
}

/**
 * Walk the enablement closure for one project. Bounded by the plugin index (one pass per plugin).
 *
 * `edges` are skipped when a declared dependency says `Enabled: false`; a missing dependency
 * (`Optional: true` typically) is skipped silently, exactly as the engine tolerates it.
 */
export function computeEnablementClosure(descriptor: UprojectDescriptor, index: PluginIndex): EnablementClosure {
	const byName = new Map<string, PluginEnablement>();
	const queue: PluginEnablement[] = [];
	const enable = (plugin: PluginSummary, kind: EnablementKind, chain: string[], via?: string): PluginEnablement | undefined => {
		const key = plugin.name.toLowerCase();
		const existing = byName.get(key);
		if (existing) return existing;
		const entry: PluginEnablement = { plugin, kind, chain, depth: chain.length - 1, ...(via ? { via } : {}) };
		byName.set(key, entry);
		queue.push(entry);
		return entry;
	};

	// Seeds 1: enabled `.uproject` references. `Enabled: false` disables the plugin AND its edges.
	for (const ref of descriptor.plugins) {
		if (!ref.enabled) continue;
		const winner = index.byName.get(ref.name.toLowerCase())?.[0];
		if (!winner) continue;
		enable(winner, "reference", [`uproject:${ref.name}`]);
	}
	// Seeds 2: EnabledByDefault. This is the bulk (~300 plugins on a 5.8 install), which is why the
	// index-root policy below only takes their direct dependencies. `DisableEnginePluginsByDefault`
	// turns engine-plugin default enablement off (`FPluginManager::ConfigureEnabledPlugins`), so those
	// seeds disappear while project/mod/external defaults stay.
	for (const plugin of index.entries) {
		if (!plugin.enabledByDefault) continue;
		if (descriptor.disableEnginePluginsByDefault && plugin.source === "Engine") continue;
		enable(plugin, "default", [`EnabledByDefault:${plugin.name}`]);
	}

	for (let cursor = 0; cursor < queue.length; cursor++) {
		const current = queue[cursor]!;
		for (const declared of current.plugin.plugins) {
			if (!declared.enabled) continue;
			const winner = index.byName.get(declared.name.toLowerCase())?.[0];
			if (!winner) continue;
			enable(winner, "dependency", [...current.chain, current.plugin.name], current.plugin.name);
		}
	}

	const all = [...byName.values()];
	return {
		byName,
		referenced: all.filter((entry) => entry.kind === "reference").map((entry) => entry.plugin),
		defaultEnabled: all.filter((entry) => entry.kind === "default").map((entry) => entry.plugin),
		dependencies: all.filter((entry) => entry.kind === "dependency").map((entry) => entry.plugin),
	};
}

/**
 * Plugins a project index should scan by default: the `.uproject` references plus the plugins those
 * (or an `EnabledByDefault` plugin) declare directly.
 *
 * Why not the whole closure: the closure's `EnabledByDefault` bulk is hundreds of plugins and
 * tens of thousands of files — indexing it by default is the `engineAreas ["Plugins"]` cost the
 * tooling exists to avoid. Why the direct dependencies at all: those are the plugins that make a
 * "0 rows" answer wrong for a type the editor has loaded (`BlendStack` via `Chooser`,
 * `PhysicsControl` via `AnimatorKit`). Anything deeper is a deliberate opt-in (`pluginAreas`).
 */
export function enablementIndexRoots(closure: EnablementClosure): PluginSummary[] {
	const roots: PluginSummary[] = [...closure.referenced];
	const seen = new Set(roots.map((plugin) => plugin.name.toLowerCase()));
	for (const entry of closure.byName.values()) {
		if (entry.kind !== "dependency" || entry.chain.length !== 2) continue;
		const key = entry.plugin.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		roots.push(entry.plugin);
	}
	return roots;
}

/** Stable cache key inputs for an index build. */
export function indexSignature(index: PluginIndex): string {
	const parts = [index.engineRoot ?? "-", index.projectDir ?? "-", index.scannedDirs.join(","), String(index.entries.length)];
	return shortHash(parts.join("|"));
}
