/**
 * Disk cache for plugin indexes.
 *
 * A cold scan on a real install is expensive (UE 5.8: ~890 `.uplugin` under `Engine/Plugins`,
 * 10k+ engine headers, 2400+ `.Build.cs`), so indexes are persisted under
 * `~/.pi/agent/unreal-cache/`. Entries are keyed by engine root + `Build.version` changelist +
 * the mtime of every scanned directory, so a plugin add/remove (which moves a directory mtime)
 * forces a rebuild. A pure content edit of an existing `.uplugin` does not move the parent
 * directory mtime, which is why `MAX_AGE_MS` exists as the backstop.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { joinPath, normalizePath, realFs, shortHash, type FsAdapter } from "./util.ts";
import type { PluginIndex, PluginSummary } from "./plugin-resolver.ts";
import { comparePluginSource } from "./plugin-resolver.ts";

const SCHEMA_VERSION = 2;
/** Backstop for content-only edits, which do not move a directory mtime. */
export const MAX_AGE_MS = 10 * 60 * 1000;

export interface CacheRootState {
	dir: string;
	mtimeMs: number;
	exists: boolean;
}

export interface CachedIndexFile {
	schema: number;
	key: string;
	builtAtMs: number;
	engineRoot?: string;
	projectDir?: string;
	additionalDirs: string[];
	scannedDirs: string[];
	scannedFiles: number;
	roots: CacheRootState[];
	entries: PluginSummary[];
}

export function cacheDir(fs: FsAdapter = realFs): string {
	const base = process.env.PI_UNREAL_CACHE_DIR ?? joinPath(homedir(), ".pi/agent/unreal-cache");
	const dir = normalizePath(base);
	if (!fs.isDirectory(dir)) {
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			/* best-effort; a cache miss is an acceptable outcome */
		}
	}
	return dir;
}

export function cacheFilePath(key: string, fs: FsAdapter = realFs): string {
	return joinPath(cacheDir(fs), `${key}.json`);
}

function rootState(dir: string, fs: FsAdapter): CacheRootState {
	try {
		return { dir, mtimeMs: statSync(dir).mtimeMs, exists: true };
	} catch {
		return { dir, mtimeMs: 0, exists: false };
	}
}

/**
 * Key that changes when the index must be rebuilt: engine identity + engine version +
 * mtime of each scan root.
 */
/** A scanned directory, given either bare or as the `{ dir, source }` record from `computeScanDirs`. */
export type CacheScanDir = string | { dir: string; source?: string };

export function computeCacheKey(input: {
	engineRoot?: string;
	projectDir?: string;
	scannedDirs: CacheScanDir[];
	versionChangelist?: number | string;
	fs?: FsAdapter;
}): { key: string; roots: CacheRootState[] } {
	const fs = input.fs ?? realFs;
	const roots = input.scannedDirs.map((entry) => rootState(typeof entry === "string" ? entry : entry.dir, fs));
	const parts = [
		`engine=${input.engineRoot ?? "-"}`,
		`project=${input.projectDir ?? "-"}`,
		`changelist=${input.versionChangelist ?? "-"}`,
		...roots.map((root) => `${root.dir}@${root.mtimeMs.toFixed(0)}`),
	];
	return { key: shortHash(parts.join("|")), roots };
}

export function loadCachedIndex(key: string, fs: FsAdapter = realFs): PluginIndex | undefined {
	const path = cacheFilePath(key, fs);
	const text = fs.readText(path);
	if (!text) return undefined;
	let parsed: CachedIndexFile;
	try {
		parsed = JSON.parse(text) as CachedIndexFile;
	} catch {
		return undefined;
	}
	if (parsed.schema !== SCHEMA_VERSION || parsed.key !== key) return undefined;
	if (Date.now() - parsed.builtAtMs > MAX_AGE_MS) return undefined;
	for (const root of parsed.roots) {
		const current = rootState(root.dir, fs);
		if (current.exists !== root.exists) return undefined;
		if (current.exists && current.mtimeMs !== root.mtimeMs) return undefined;
	}
	return rebuildIndex(parsed);
}

function rebuildIndex(parsed: CachedIndexFile): PluginIndex {
	const byName = new Map<string, PluginSummary[]>();
	for (const entry of parsed.entries) {
		const key = entry.name.toLowerCase();
		const bucket = byName.get(key);
		if (bucket) bucket.push(entry);
		else byName.set(key, [entry]);
	}
	// A cached index must sort its buckets exactly like a freshly built one, otherwise the
	// shadow winner changes between a cache miss and a cache hit.
	for (const bucket of byName.values()) {
		bucket.sort(comparePluginSource);
	}
	return {
		engineRoot: parsed.engineRoot,
		projectDir: parsed.projectDir,
		additionalDirs: parsed.additionalDirs,
		scannedDirs: parsed.scannedDirs,
		scannedFiles: parsed.scannedFiles,
		entries: parsed.entries,
		byName,
		builtAtMs: parsed.builtAtMs,
	};
}

export function saveCachedIndex(index: PluginIndex, key: string, roots: CacheRootState[], fs: FsAdapter = realFs): boolean {
	const payload: CachedIndexFile = {
		schema: SCHEMA_VERSION,
		key,
		builtAtMs: index.builtAtMs,
		engineRoot: index.engineRoot,
		projectDir: index.projectDir,
		additionalDirs: index.additionalDirs,
		scannedDirs: index.scannedDirs,
		scannedFiles: index.scannedFiles,
		roots,
		entries: index.entries,
	};
	try {
		writeFileSync(cacheFilePath(key, fs), JSON.stringify(payload), "utf8");
		return true;
	} catch {
		return false;
	}
}

/** Removes every cached index. Exposed as `/unreal-cache clear`. */
export function clearCache(fs: FsAdapter = realFs): { dir: string; removed: number } {
	const dir = cacheDir(fs);
	let removed = 0;
	for (const entry of fs.listDir(dir)) {
		if (!entry.endsWith(".json")) continue;
		try {
			rmSync(joinPath(dir, entry), { force: true });
			removed += 1;
		} catch {
			/* ignore */
		}
	}
	return { dir, removed };
}

export function cacheStats(fs: FsAdapter = realFs): { dir: string; files: number; entries: number; bytes: number } {
	const dir = cacheDir(fs);
	const files = fs.listDir(dir).filter((entry) => entry.endsWith(".json"));
	let entries = 0;
	let bytes = 0;
	for (const file of files) {
		const text = fs.readText(joinPath(dir, file));
		if (!text) continue;
		bytes += text.length;
		try {
			const parsed = JSON.parse(text) as CachedIndexFile;
			entries += parsed.entries?.length ?? 0;
		} catch {
			/* ignore */
		}
	}
	return { dir, files: files.length, entries, bytes };
}
