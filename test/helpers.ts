import { dirname, sep } from "node:path";
import { normalizePath, type FsAdapter } from "../extensions/unreal/lib/util.ts";

export const FIXTURES = normalizePath(`${import.meta.dirname}/fixtures`);

export const ENGINE_A = `${FIXTURES}/EngineA`;
export const ENGINE_B = `${FIXTURES}/EngineB`;
export const ENGINE_C = `${FIXTURES}/EngineC`;
export const PROJECT_DIR = `${FIXTURES}/ProjDir`;
export const FIXTURE_PROJECT = `${PROJECT_DIR}/Fixture.uproject`;
export const GUID = "{11111111-2222-3333-4444-555555555555}";

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
