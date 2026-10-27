import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { normalizePath, type FsAdapter } from "../extensions/unreal/lib/util.ts";

export const FIXTURES = normalizePath(`${import.meta.dirname}/fixtures`);

/** Placeholder for an absolute path inside the fixture tree; see `materializeFixtures`. */
export const FIXTURE_ROOT_PLACEHOLDER = "__FIXTURE_ROOT__";

export const ENGINE_A = `${FIXTURES}/EngineA`;
export const ENGINE_B = `${FIXTURES}/EngineB`;
export const ENGINE_C = `${FIXTURES}/EngineC`;
export const PROJECT_DIR = `${FIXTURES}/ProjDir`;
export const FIXTURE_PROJECT = `${PROJECT_DIR}/Fixture.uproject`;
export const GUID = "{11111111-2222-3333-4444-555555555555}";

export interface FixtureTree {
	readonly root: string;
	readonly engineA: string;
	readonly engineB: string;
	readonly engineC: string;
	readonly projectDir: string;
	readonly project: string;
}

function textFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const child = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...textFiles(child));
		else if (/\.(uproject|uplugin|md|cs|json|editorconfig|ini|txt)$/i.test(entry.name)) out.push(child);
	}
	return out;
}

/**
 * Copies `test/fixtures` into a fresh OS-temp directory and rewrites every
 * `__FIXTURE_ROOT__` placeholder to that copy's absolute path.
 *
 * Fixtures are committed path-agnostic: CI checks the repository out at a runner-specific root
 * (`/home/runner/work/...` on Linux, `D:\a\...` on Windows), so any baked absolute path points at
 * nothing there. Anything that exercises an absolute association — a `.uproject` inline
 * `EngineAssociation`, an `AdditionalPluginDirectories` scan root — must run against this copy.
 */
export function materializeFixtures(): FixtureTree {
	const dir = mkdtempSync(join(tmpdir(), "pi-unreal-fixtures-"));
	cpSync(join(import.meta.dirname, "fixtures"), dir, { recursive: true });
	const root = normalizePath(dir);
	for (const file of textFiles(dir)) {
		const text = readFileSync(file, "utf8");
		if (text.includes(FIXTURE_ROOT_PLACEHOLDER)) writeFileSync(file, text.split(FIXTURE_ROOT_PLACEHOLDER).join(root), "utf8");
	}
	return {
		root,
		engineA: `${root}/EngineA`,
		engineB: `${root}/EngineB`,
		engineC: `${root}/EngineC`,
		projectDir: `${root}/ProjDir`,
		project: `${root}/ProjDir/Fixture.uproject`,
	};
}

/** Remove a directory created by `materializeFixtures`. */
export function releaseFixtures(tree: FixtureTree): void {
	rmSync(tree.root, { recursive: true, force: true });
}

/** In-memory `FsAdapter` — directories are the ancestors of the given file keys. */
export function memoryFs(files: Record<string, string>): FsAdapter {
	const map = new Map(Object.entries(files).map(([key, value]) => [normalizePath(key), value]));
	const dirs = new Set<string>();
	for (const key of map.keys()) {
		let current = dirname(key).split(sep).join("/");
		while (current && current !== "/" && current.length > 2) {
			dirs.add(current);
			const parent = normalizePath(dirname(current));
			if (parent === current) break;
			current = parent;
		}
	}
	return {
		exists(path: string): boolean {
			const key = normalizePath(path);
			return map.has(key) || dirs.has(key);
		},
		isDirectory(path: string): boolean {
			return dirs.has(normalizePath(path));
		},
		readText(path: string): string | undefined {
			return map.get(normalizePath(path));
		},
		listDir(path: string): string[] {
			const dir = normalizePath(path);
			const files = [...map.keys()]
				.filter((key) => normalizePath(dirname(key)) === dir)
				.map((key) => key.slice(dir.length + 1))
				.filter((name) => !name.includes("/"));
			// Directories are derived too: a walker that descends must see them, not only files.
			const children = [...dirs]
				.filter((candidate) => candidate.startsWith(`${dir}/`) && !candidate.slice(dir.length + 1).includes("/"))
				.map((candidate) => candidate.slice(dir.length + 1));
			return [...new Set([...files, ...children])];
		},
	};
}
