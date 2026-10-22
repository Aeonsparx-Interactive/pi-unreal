import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseUproject, readBuildVersion } from "../extensions/unreal/lib/descriptors.ts";
import { buildPluginIndex, computeScanDirs } from "../extensions/unreal/lib/plugin-resolver.ts";
import { realFs } from "../extensions/unreal/lib/util.ts";
import { normalizePath } from "../extensions/unreal/lib/util.ts";
import { MAX_AGE_MS, cacheDir, cacheFilePath, cacheStats, clearCache, computeCacheKey, loadCachedIndex, saveCachedIndex } from "../extensions/unreal/lib/cache.ts";
import { ENGINE_A, PROJECT_DIR, memoryFs } from "./helpers.ts";

const CACHE = join(process.env.TEMP ?? "/tmp", "pi-unreal-cache-test");
const SCRATCH = join(process.env.TEMP ?? "/tmp", "pi-unreal-cache-scratch");

function withCacheDir<T>(body: () => T | Promise<T>): Promise<T> {
	process.env.PI_UNREAL_CACHE_DIR = CACHE;
	rmSync(CACHE, { recursive: true, force: true });
	rmSync(SCRATCH, { recursive: true, force: true });
	mkdirSync(SCRATCH, { recursive: true });
	return Promise.resolve(body()).finally(() => {
		delete process.env.PI_UNREAL_CACHE_DIR;
	});
}

async function fixtureIndex() {
	const descriptor = parseUproject(`${PROJECT_DIR}/Fixture.uproject`, realFs);
	const index = await buildPluginIndex({
		engineRoot: ENGINE_A,
		projectDir: PROJECT_DIR,
		additionalPluginDirectories: descriptor.additionalPluginDirectories,
		fs: realFs,
	});
	const scannedDirs = computeScanDirs({
		engineRoot: ENGINE_A,
		projectDir: PROJECT_DIR,
		additionalPluginDirectories: descriptor.additionalPluginDirectories,
	});
	const key = computeCacheKey({
		engineRoot: ENGINE_A,
		projectDir: PROJECT_DIR,
		scannedDirs,
		versionChangelist: readBuildVersion(ENGINE_A, realFs)?.raw,
		fs: realFs,
	});
	return { index, key };
}

describe("plugin index cache", () => {
	it("uses PI_UNREAL_CACHE_DIR when set", async () => {
		await withCacheDir(() => {
			expect(cacheDir()).toBe(normalizePath(CACHE));
			delete process.env.PI_UNREAL_CACHE_DIR;
			expect(cacheDir().endsWith("unreal-cache")).toBe(true);
			process.env.PI_UNREAL_CACHE_DIR = CACHE;
		});
	});

	it("round-trips an index through disk and rebuilds the byName map", async () => {
		await withCacheDir(async () => {
			const { index, key } = await fixtureIndex();
			expect(saveCachedIndex(index, key.key, key.roots, realFs)).toBe(true);
			expect(statSync(cacheFilePath(key.key)).isFile()).toBe(true);

			const restored = loadCachedIndex(key.key, realFs);
			expect(restored?.entries.length).toBe(index.entries.length);
			expect(restored?.byName.get("shared")?.map((entry) => entry.source)).toEqual(["Project", "Engine"]);
			expect(restored?.engineRoot).toBe(ENGINE_A);
		});
	});

	it("invalidates when a scanned directory changes, and on a missing file", async () => {
		await withCacheDir(async () => {
			const { index, key } = await fixtureIndex();
			saveCachedIndex(index, key.key, key.roots, realFs);

			const probeDir = join(SCRATCH, "probe");
			mkdirSync(probeDir, { recursive: true });
			writeFileSync(join(probeDir, "Probe.uplugin"), '{ "FileVersion": 3, "Modules": [] }');
			const probeKey = computeCacheKey({ projectDir: SCRATCH, scannedDirs: [{ dir: probeDir, source: "Project" }], fs: realFs });
			saveCachedIndex(index, probeKey.key, probeKey.roots, realFs);

			// A content-only change inside the scanned directory must not be served from cache.
			utimesSync(probeDir, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
			expect(loadCachedIndex(probeKey.key, realFs)).toBeUndefined();

			// A deleted scanned directory must not be served from cache either.
			rmSync(probeDir, { recursive: true, force: true });
			expect(loadCachedIndex(probeKey.key, realFs)).toBeUndefined();
		});
	});

	it("refuses a foreign key and an expired entry", async () => {
		await withCacheDir(async () => {
			const { index, key } = await fixtureIndex();
			saveCachedIndex(index, key.key, key.roots, realFs);
			expect(loadCachedIndex("deadbeefdead")).toBeUndefined();

			const file = cacheFilePath(key.key);
			const stale = { builtAtMs: Date.now() - MAX_AGE_MS - 60_000 };
			writeFileSync(file, JSON.stringify(stale));
			expect(loadCachedIndex(key.key, realFs)).toBeUndefined();
		});
	});

	it("clears and reports the cache directory", async () => {
		await withCacheDir(async () => {
			const { index, key } = await fixtureIndex();
			saveCachedIndex(index, key.key, key.roots, realFs);
			saveCachedIndex(index, "secondkey", key.roots, realFs);

			const stats = cacheStats();
			expect(stats.files).toBe(2);
			expect(stats.entries).toBe(2 * index.entries.length);
			expect(stats.bytes).toBeGreaterThan(0);

			const cleared = clearCache();
			expect(cleared.removed).toBe(2);
			expect(cacheStats().files).toBe(0);
		});
	});

	it("computes keys that are stable, hermetic, and sensitive to the engine root", async () => {
		const scannedDirs = [{ dir: PROJECT_DIR, source: "Project" as const }];
		const a = computeCacheKey({ projectDir: PROJECT_DIR, scannedDirs, fs: memoryFs({}) });
		const b = computeCacheKey({ projectDir: PROJECT_DIR, scannedDirs, fs: memoryFs({}) });
		expect(a.key).toBe(b.key);
		expect(a.key).toHaveLength(12);

		const withEngine = computeCacheKey({ engineRoot: ENGINE_A, projectDir: PROJECT_DIR, scannedDirs, fs: memoryFs({}) });
		expect(withEngine.key).not.toBe(a.key);

		// Missing directories are recorded so a later appearance invalidates the entry.
		const missing = computeCacheKey({ projectDir: PROJECT_DIR, scannedDirs: [{ dir: `${PROJECT_DIR}/Nope`, source: "Mod" }], fs: memoryFs({}) });
		expect(missing.roots[0]?.exists).toBe(false);
		expect(missing.roots[0]?.mtimeMs).toBe(0);
	});
});
