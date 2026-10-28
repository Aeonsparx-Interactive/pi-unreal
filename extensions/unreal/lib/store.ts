/**
 * The on-disk symbol index and the queries that run against it.
 *
 * Layout (under `cacheDir()/indexes/<key>/`, i.e. `~/.pi/agent/unreal-cache` by default — not the
 * project tree, which is 1.5 GB, and not git):
 *
 *   meta.json      build metadata: roots, mode, source (ubt|heuristic), counts, warnings, engine and
 *                  target identity, paths to the UnrealBuildTool Query JSON it was built from
 *   defs.tsv       symbol \t kind \t file \t line \t module \t scope \t marker — sorted by
 *                  lowercased symbol, so exact lookup is a binary search over byte ranges
 *   includes.tsv   file \t module \t includes \t symbols — per-file `#include` set and declared
 *                  symbols, the base of the compile unit in `unreal_context` (full indexes)
 *   files.tsv      file \t module \t kind \t symbols — file inventory (module filter, file listing)
 *
 * Text, not SQLite: this box has no build toolchain for native modules, bun is an optional runtime,
 * and a TSV is inspectable with `rg`. Two facts make that cheap enough at engine scale:
 *   - 696,237 definitions (Lp + 5.8 engine) produce a 69 MB defs.tsv in 17 s;
 *   - a sorted TSV answers exact and prefix lookup by binary search over byte ranges, which is what
 *     agents actually ask for (clangd is the tool for position-sensitive questions, not this one).
 *
 * Every query takes an explicit `IndexState` and the tools echo `index: {key, mode, source, roots}`
 * on every result, because a workspace can hold several indexes (definitions for the engine, full
 * for the project, one per target) and the answer depends on which one was read.
 */

import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
import { cacheDir } from "./cache.ts";
import { normalizePath, joinPath, shortHash, baseName, realFs, type FsAdapter } from "./util.ts";
import { collectSourceFiles, scanText, type IncludeRef, type ScanRoot, type SymbolDef } from "./scan.ts";
import { parseModuleReferences, parseTargetDetails, readQueryJson, type UbtModuleRefs, type UbtModuleSettings } from "./ubt.ts";

/**
 * v6: `meta.rootKinds` (what an index actually covers, by root kind) and `meta.areas`, and engine-scope
 * indexes now include the project's enabled plugin roots, so engine-scope keys change and v5 engine
 * indexes are not reused. v5 was the TSV layout change; older indexes are unreadable by design.
 */
export const INDEX_VERSION = 6;

/**
 * Default engine scan. `Runtime` is where the **engine's own** gameplay types live (AActor,
 * UAnimInstance, UGameModeBase): measured 6,212 files / 126,350 definitions in 34 s on a UE 5.8
 * install. `Editor` and `Developer` roughly triple that, so they are opt-in through `engineAreas`.
 *
 * It is NOT the whole engine: most UE-facing types shipped as engine *plugins* (Mover, PoseSearch,
 * PhysicsControl, BlendStack, SmartObjects, StateTree, GameplayAbilities, GameplayStateTree, …) live
 * under Engine/Plugins/<category>/<plugin>/Source/<module>, which `"Runtime"` does not touch. Engine-scope
 * indexes therefore add the plugin roots the project enables (free — already computed), and
 * `engineAreas: ["Plugins"]` (or `["Plugins/Animation/PhysicsControl"]`) dials in the rest. Measured on
 * UE 5.8: Engine/Source/Runtime is 18,681 scannable files, all plugin sources are 52,568 (~2.8x).
 */
export const DEFAULT_ENGINE_AREAS = ["Runtime"];

export type IndexScope = "Engine" | "Project" | "Plugin" | "";

export interface IndexMeta {
	version: number;
	key: string;
	mode: "definitions" | "full";
	/** `ubt` = module attribution from Query data; `heuristic` = nearest `*.Build.cs`. */
	source: "ubt" | "heuristic";
	/** Provenance of the indexed roots: `Engine` = engine sources only, `Project` = project + plugins. */
	scope: IndexScope;
	generatedAt: string;
	roots: string[];
	engineRoot?: string;
	/** Index that supplied the engine half of a project index. */
	engineIndexKey?: string;
	projectRoot?: string;
	projectName?: string;
	target?: string;
	platform?: string;
	configuration?: string;
	counts: { files: number; symbols: number; includes: number; modules: number };
	defsByKind: Record<string, number>;
	/** Root provenance by kind — the coverage claim a 0-row answer is bounded by (see `classifyRoot`). */
	rootKinds?: Record<string, number>;
	/** `engineAreas` the engine half was scanned with, when an engine half exists. */
	areas?: string[];
	warnings: string[];
	sizeBytes: number;
	defsPath: string;
	filesPath: string;
	includesPath?: string;
	queryFiles?: { targetDetails: string; moduleReferences: string };
	queryDurationsMs?: { targetDetails: number; moduleReferences: number };
}

export interface IndexState {
	key: string;
	dir: string;
	meta: IndexMeta;
	fs: FsAdapter;
	ageMs: number;
	healthy: boolean;
	issues: string[];
	/** `meta.scope`, derived from the roots when an older meta.json has none. */
	scope: IndexScope;
}

export interface IndexBuild {
	key: string;
	dir: string;
	mode: IndexMeta["mode"];
	source: IndexMeta["source"];
	scope: IndexMeta["scope"];
	roots: string[];
	counts: IndexMeta["counts"];
	defsByKind: Record<string, number>;
	warnings: string[];
	durationMs: number;
	meta: IndexMeta;
}

export type DefRow = { symbol: string; kind: string; file: string; line: number; module: string; scope: string; marker: string };

/* ──────────────────────────────────────────────────────────────────── root kinds */

/**
 * What kind of source a scan root is. This is the vocabulary every coverage claim is written in:
 * `unreal_symbol scope: "engine"` answers for `engine-source` + `engine-plugin` roots, and nothing
 * else — a 0-row answer is only a statement about the roots that were scanned.
 */
export type RootKind = "project" | "engine-plugin" | "engine-source" | "other-plugin";

export function classifyRoot(root: string, options: { projectRoot?: string; engineRoot?: string } = {}): RootKind {
	const r = normalizePath(root).toLowerCase();
	const project = options.projectRoot ? normalizePath(options.projectRoot).toLowerCase() : undefined;
	const engine = options.engineRoot ? normalizePath(options.engineRoot).toLowerCase() : undefined;
	if (project && (r === project || r.startsWith(`${project}/`))) return "project";
	if (engine && r.startsWith(`${engine}/`)) {
		if (r.includes("/engine/plugins/")) return "engine-plugin";
		if (r.includes("/engine/source/")) return "engine-source";
		return "other-plugin";
	}
	return "other-plugin";
}

/** Root counts by kind, most numerous first. Drives index-status coverage lines and 0-row caveats. */
export function summarizeRootKinds(roots: string[], options: { projectRoot?: string; engineRoot?: string } = {}): { kind: RootKind; count: number }[] {
	const counts = new Map<RootKind, number>();
	for (const root of roots) {
		const kind = classifyRoot(root, options);
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count }));
}

/** One-line coverage phrase, e.g. `1 project root, 62 engine-plugin roots`. */
export function rootKindsNote(roots: string[], options: { projectRoot?: string; engineRoot?: string } = {}): string {
	const parts = summarizeRootKinds(roots, options).map((entry) => `${entry.count} ${entry.kind} root(s)`);
	return parts.length ? parts.join(", ") : "no roots";
}

/**
 * Provenance of a set of scan roots. Plugin module directories inside an installed engine tree count as
 * project-side (`.../Engine/Plugins/...`), so a project + plugins index classifies as `Project` and an
 * Engine/Source index classifies as `Engine`. Mixed roots give "" — the index is not scoped.
 */
export function deriveScope(roots: string[], options: { projectRoot?: string; engineRoot?: string } = {}): IndexScope {
	const project = options.projectRoot ? normalizePath(options.projectRoot).toLowerCase() : undefined;
	const engine = options.engineRoot ? normalizePath(options.engineRoot).toLowerCase() : undefined;
	let engineSide = 0;
	let projectSide = 0;
	let pluginSide = 0;
	for (const root of roots) {
		const r = normalizePath(root).toLowerCase();
		if (project && (r === project || r.startsWith(`${project}/`))) {
			projectSide++;
			continue;
		}
		if (engine && r.startsWith(`${engine}/`)) {
			if (r.includes("/engine/plugins/")) pluginSide++;
			else engineSide++;
			continue;
		}
		if (r.includes("/engine/plugins/")) pluginSide++;
	}
	if (engineSide && (projectSide || pluginSide)) return "";
	if (engineSide) return "Engine";
	if (projectSide) return "Project";
	if (pluginSide) return "Plugin";
	return "";
}

export interface LookupResult extends DefRow {
	/** 0 = exact, 1 = prefix, 2 = qualified-member fallback. */
	rank: number;
}

const TSV_HEADER = ["symbol", "kind", "file", "line", "module", "scope", "marker"];

/* ──────────────────────────────────────────────────────────────────────── build */

const esc = (value: string) => (value.includes("\t") || value.includes("\n") ? JSON.stringify(value) : value);

/**
 * Build an index from scan roots.
 *
 * `resolveModule` is the module attribution: with Query data it is UBT's `dirToModule` (authoritative,
 * deepest-prefix match); without it, the nearest `*.Build.cs` above the file. The result records which
 * one ran, so a heuristic index never pretends to be UBT-accurate.
 */
/** Rows are sorted by the probe key (see `probe`): that is the order `lowerBound` binary-searches. */
function byProbe(a: DefRow, b: DefRow): number {
	const x = probe(a.symbol);
	const y = probe(b.symbol);
	if (x !== y) return x < y ? -1 : 1;
	if (a.file !== b.file) return a.file < b.file ? -1 : 1;
	return a.line - b.line;
}

/** Rows per sorted shard. 40 000 rows ≈ 5 MB of live objects; a whole-Plugins scan spills ~43. */
const SHARD_ROWS = 40_000;

/** One def row in `defs.tsv` cell order (shared by the shard writer and the merge). */
function defLine(row: DefRow): string {
	return [esc(row.symbol), row.kind, esc(row.file), row.line, esc(row.module), esc(row.scope), esc(row.marker)].join("\t");
}

/** Plain-string key that reproduces `byProbe` order: probe(symbol), file, then line (zero-padded). */
function defSortKey(line: string): string {
	const cells = line.split("\t");
	return `${probe(unesc(cells[0] ?? ""))}\t${unesc(cells[2] ?? "")}\t${String(Number(cells[3]) || 0).padStart(12, "0")}`;
}

/** Buffered append-only TSV writer (a whole file is never built as one string). */
class TsvStreamWriter {
	private fd: number;
	private lines: string[] = [];
	bytes = 0;

	constructor(readonly path: string) {
		mkdirSync(baseDirOf(path), { recursive: true });
		this.fd = openSync(path, "w");
	}

	write(line: string): void {
		this.lines.push(line);
		if (this.lines.length >= 8192) this.flush();
	}

	private flush(): void {
		if (!this.lines.length) return;
		const buffer = Buffer.from(`${this.lines.join("\n")}\n`, "utf8");
		this.lines = [];
		let offset = 0;
		while (offset < buffer.length) offset += writeSync(this.fd, buffer, offset, buffer.length - offset);
		this.bytes += buffer.length;
	}

	close(): void {
		this.flush();
		closeSync(this.fd);
	}
}

/**
 * K-way merge of sorted shard files into one sorted TSV stream.
 *
 * Each shard is read lazily (one readline iterator per shard, one live line each), so memory is
 * O(shards), and a min-heap over the shard heads keeps the merge at O(rows · log shards).
 */
async function mergeSortedShards(shardPaths: string[], out: TsvStreamWriter): Promise<void> {
	const streams = shardPaths.map((path) => createInterface({ input: createReadStream(path), crlfDelay: Infinity })[Symbol.asyncIterator]());
	const heads: ({ key: string; line: string } | undefined)[] = streams.map(() => undefined);
	const alive: number[] = [];
	const pull = async (shard: number): Promise<void> => {
		const next = await streams[shard]!.next();
		heads[shard] = next.done || !next.value ? undefined : { key: defSortKey(next.value), line: next.value };
	};
	const keyAt = (slot: number) => heads[alive[slot]!]!.key;
	const swap = (a: number, b: number) => {
		const tmp = alive[a]!;
		alive[a] = alive[b]!;
		alive[b] = tmp;
	};
	const siftDown = (from: number) => {
		let i = from;
		for (;;) {
			const left = 2 * i + 1;
			const right = left + 1;
			let best = i;
			if (left < alive.length && keyAt(left) < keyAt(best)) best = left;
			if (right < alive.length && keyAt(right) < keyAt(best)) best = right;
			if (best === i) return;
			swap(i, best);
			i = best;
		}
	};
	for (let shard = 0; shard < streams.length; shard++) {
		await pull(shard);
		if (heads[shard]) alive.push(shard);
	}
	for (let slot = (alive.length >> 1) - 1; slot >= 0; slot--) siftDown(slot);
	while (alive.length) {
		const shard = alive[0]!;
		const head = heads[shard]!;
		out.write(head.line);
		await pull(shard);
		if (!heads[shard]) {
			// This shard is exhausted: move the last live shard to the root slot and shrink the heap.
			alive[0] = alive[alive.length - 1]!;
			alive.pop();
		}
		if (alive.length) siftDown(0);
	}
	for (const stream of streams) await stream.return?.(undefined);
}

function baseDirOf(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut <= 0 ? path : path.slice(0, cut);
}

export async function buildIndex(input: {
	key: string;
	mode: "definitions" | "full";
	roots: ScanRoot[];
	engineRoot?: string;
	engineIndexKey?: string;
	projectRoot?: string;
	projectName?: string;
	target?: string;
	platform?: string;
	configuration?: string;
	queryFiles?: { targetDetails: string; moduleReferences: string };
	/** Recorded verbatim in `meta.areas` so status can state what an engine index scanned. */
	areas?: string[];
	/** Where the ScanRoot provenance comes from; `deriveScope(roots)` when omitted. */
	scope?: IndexScope;
	concurrency?: number;
	/**
	 * Rows per sorted shard (default `SHARD_ROWS`). Exposed for tests: a whole-Plugins scan spills ~43
	 * shards and 1.24 M rows, and a merge bug is invisible at the production size.
	 */
	shardRows?: number;
}): Promise<IndexBuild> {
	const started = Date.now();
	const dir = indexDir(input.key);
	const warnings: string[] = [];
	const query = input.queryFiles && existsSync(input.queryFiles.targetDetails) ? parseTargetDetails(readQueryJson(input.queryFiles.targetDetails)) : undefined;
	const refs = input.queryFiles && existsSync(input.queryFiles.moduleReferences) ? parseModuleReferences(readQueryJson(input.queryFiles.moduleReferences)) : undefined;
	if (input.queryFiles && !query) warnings.push(`Query JSON unreadable at ${input.queryFiles.targetDetails}; module attribution falls back to *.Build.cs locations`);

	const dirToModule = query ? [...query.dirModules].sort((a, b) => b.prefix.length - a.prefix.length) : [];
	const moduleOf = (file: string, root: ScanRoot): string => {
		const hit = dirToModule.find((entry) => file.startsWith(entry.prefix.endsWith("/") ? entry.prefix : `${entry.prefix}/`));
		if (hit) return hit.module;
		if (root.module) return root.module;
		return moduleFromBuildCs(file);
	};

	const rootDirs = input.roots.map((root) => root.dir);
	const rootKinds: Record<string, number> = {};
	for (const entry of summarizeRootKinds(rootDirs, { projectRoot: input.projectRoot, engineRoot: input.engineRoot })) {
		rootKinds[entry.kind] = entry.count;
	}

	const files = await collectSourceFiles(input.roots, { concurrency: input.concurrency });
	// Streaming write: a whole-Plugins engine index is ~1.7 M definition rows (~300 MB of TSV), and
	// accumulating them in an array before one giant sort was the OOM. Rows are sorted per shard and
	// the shards are merged, so peak memory is one shard, and defs.tsv is byte-identical to a sorted
	// single-pass write.
	const shardDir = joinPath(dir, "shards");
	const shardRows = Math.max(1, input.shardRows ?? SHARD_ROWS);
	rmSync(shardDir, { recursive: true, force: true });
	mkdirSync(shardDir, { recursive: true });
	const shardPaths: string[] = [];
	let batch: DefRow[] = [];
	let rowTotal = 0;
	const flushBatch = () => {
		if (!batch.length) return;
		batch.sort(byProbe);
		const shardPath = joinPath(shardDir, `shard-${String(shardPaths.length).padStart(4, "0")}.tsv`);
		const shard = new TsvStreamWriter(shardPath);
		for (const row of batch) shard.write(defLine(row));
		shard.close();
		shardPaths.push(shardPath);
		rowTotal += batch.length;
		batch = [];
	};
	const filesOut = new TsvStreamWriter(joinPath(dir, "files.tsv"));
	filesOut.write("file\tmodule\tkind\tsymbols");
	const includesOut = input.mode === "full" ? new TsvStreamWriter(joinPath(dir, "includes.tsv")) : undefined;
	includesOut?.write("file\tmodule\tincludes\tsymbols");
	let fileTotal = 0;
	let includeTotal = 0;
	const modules = new Set<string>();
	const defsByKind: Record<string, number> = {};

	for (const entry of files) {
		let text: string;
		try {
			text = readFileSync(entry.abs, "utf8");
		} catch {
			continue; // locked by a running editor build: skip the file, do not fail the index
		}
		const module = moduleOf(entry.abs, entry.root);
		const { defs, includes } = scanText(text, entry.abs, module, entry.root.scope);
		modules.add(module);
		for (const def of defs) {
			batch.push({ symbol: def.symbol, kind: def.kind, file: def.file, line: def.line, module: def.module, scope: def.scope, marker: def.marker });
			defsByKind[def.kind] = (defsByKind[def.kind] ?? 0) + 1;
		}
		if (batch.length >= shardRows) flushBatch();
		fileTotal++;
		filesOut.write(`${esc(entry.abs)}\t${esc(module)}\t${fileKindLabel(entry.abs)}\t${defs.length}`);
		if (includesOut) {
			includeTotal++;
			includesOut.write(`${esc(entry.abs)}\t${esc(module)}\t${includes.map((inc) => (inc.angled ? `<${inc.target}>` : `"${inc.target}"`)).join(",")}\t${defs.map((def) => def.symbol).join(",")}`);
		}
	}
	flushBatch();
	filesOut.close();
	includesOut?.close();

	const defsOut = new TsvStreamWriter(joinPath(dir, "defs.tsv"));
	defsOut.write(TSV_HEADER.join("\t"));
	await mergeSortedShards(shardPaths, defsOut);
	defsOut.close();
	rmSync(shardDir, { recursive: true, force: true });

	const meta: IndexMeta = {
		version: INDEX_VERSION,
		key: input.key,
		mode: input.mode,
		source: query && refs ? "ubt" : "heuristic",
		scope: input.scope ?? deriveScope(input.roots.map((root) => root.dir), { projectRoot: input.projectRoot, engineRoot: input.engineRoot }),
		generatedAt: new Date().toISOString(),
		roots: input.roots.map((root) => normalizePath(root.dir)),
		engineRoot: input.engineRoot ? normalizePath(input.engineRoot) : undefined,
		engineIndexKey: input.engineIndexKey,
		projectRoot: input.projectRoot ? normalizePath(input.projectRoot) : undefined,
		projectName: input.projectName,
		target: input.target,
		platform: input.platform,
		configuration: input.configuration,
		counts: { files: fileTotal, symbols: rowTotal, includes: includeTotal, modules: modules.size },
		defsByKind,
		rootKinds,
		areas: input.areas,
		warnings,
		sizeBytes: defsOut.bytes,
		defsPath: normalizePath(joinPath(dir, "defs.tsv")),
		filesPath: normalizePath(joinPath(dir, "files.tsv")),
		includesPath: input.mode === "full" ? normalizePath(joinPath(dir, "includes.tsv")) : undefined,
		queryFiles: input.queryFiles,
	};
	writeJsonAtomic(joinPath(dir, "meta.json"), meta);

	return { key: input.key, dir, mode: input.mode, source: meta.source, scope: meta.scope, roots: meta.roots, counts: meta.counts, defsByKind, warnings, durationMs: Date.now() - started, meta };
}

/**
 * Re-scan only the files a caller names (an agent that just edited three files), merging rows into
 * the existing TSV. Kept as a whole-file rewrite: 69 MB rewritten in ~1 s is cheaper than a
 * patchable index format, and the result is always consistent.
 *
 * Memory-bound by design: `readDefRows` materializes the whole table. Safe for project and
 * engine-area indexes; do not run it against a whole-`Engine/Plugins` index (~1.24 M rows, ~300 MB),
 * which is why no tool exposes it.
 */
export async function patchIndex(index: IndexState, files: string[], resolveModule: (file: string) => { module: string; scope: IndexScope }): Promise<{ updated: number; added: number; removed: number }> {
	const rows = readDefRows(index);
	const byFile = new Map<string, DefRow[]>();
	for (const row of rows) {
		const list = byFile.get(row.file) ?? [];
		list.push(row);
		byFile.set(row.file, list);
	}
	let updated = 0;
	let added = 0;
	let removed = 0;
	for (const file of files.map(normalizePath)) {
		const existing = byFile.get(file);
		if (!existing) added++;
		else removed += existing.length;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const { module, scope } = resolveModule(file);
		const { defs } = scanText(text, file, module, scope);
		byFile.set(file, defs.map((def) => ({ symbol: def.symbol, kind: def.kind, file: def.file, line: def.line, module: def.module, scope: def.scope, marker: def.marker })));
		updated++;
	}
	const merged = [...byFile.values()].flat();
	merged.sort(byProbe);
	writeTextAtomic(index.meta.defsPath, `${TSV_HEADER.join("\t")}\n${merged.map((r) => [esc(r.symbol), r.kind, esc(r.file), r.line, esc(r.module), esc(r.scope), esc(r.marker)].join("\t")).join("\n")}\n`);
	lineIndexCache.delete(index.meta.defsPath);
	return { updated, added, removed };
}

/* ──────────────────────────────────────────────────────────────────────── lookup */

/** Byte offset of every line start, cached per file: one read, then every lookup is a seek. */
const lineIndexCache = new Map<string, { offsets: number[]; size: number }>();

function lineOffsets(path: string): { offsets: number[]; size: number } {
	const size = statSync(path).size;
	const cached = lineIndexCache.get(path);
	if (cached && cached.size === size) return cached;
	const fd = openSync(path, "r");
	try {
		// Chunked: a whole-Plugins defs.tsv is ~300 MB, and reading it into one Buffer to count
		// newlines is a 300 MB allocation on the first lookup against it.
		const buffer = Buffer.alloc(1 << 22);
		const offsets: number[] = [0];
		let position = 0;
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, position);
			if (read <= 0) break;
			for (let i = 0; i < read; i++) if (buffer[i] === 0x0a) offsets.push(position + i + 1);
			position += read;
		}
		const entry = { offsets, size };
		lineIndexCache.set(path, entry);
		return entry;
	} finally {
		closeSync(fd);
	}
}

function readRange(path: string, start: number, end: number): string {
	const fd = openSync(path, "r");
	try {
		const length = Math.max(0, Math.min(end, statSync(path).size) - start);
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, start);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** Parse TSV rows (header skipped). `numericColumn` is parsed as a number. */
export function readTsv(text: string, numericColumn = -1): Record<string, string | number>[] {
	const out: Record<string, string | number>[] = [];
	const lines = text.split("\n");
	if (lines.length < 2) return out;
	const header = (lines[0] ?? "").split("\t");
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const cells = line.split("\t");
		const row: Record<string, string | number> = {};
		for (let c = 0; c < header.length; c++) {
			const key = header[c];
			if (!key) continue;
			const raw = cells[c] ?? "";
			row[key] = c === numericColumn ? Number(raw) || 0 : raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
		}
		out.push(row);
	}
	return out;
}

function readDefRows(index: IndexState): DefRow[] {
	return readTsv(readFileSync(index.meta.defsPath, "utf8"), 3) as unknown as DefRow[];
}

/**
 * Stream one TSV file line by line, 4 MB at a time, and stop when a callback returns false.
 *
 * Every whole-file pass used to call `readDefRows`, which materializes a 76 MB index as one string
 * and then as an array of row objects. On the engine + every-plugin scope (~1.7 M rows, ~300 MB)
 * that is what died in the allocator, so the linear passes stream instead: bounded memory, and the
 * file is never fully resident.
 */
export function forEachTsvLine(path: string, onCells: (cells: string[]) => boolean | void): void {
	const decoder = new StringDecoder("utf8");
	const fd = openSync(path, "r");
	const buffer = Buffer.alloc(1 << 22);
	let pending = "";
	let start = 0;
	try {
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			pending += decoder.write(buffer.subarray(0, read));
			let nl = pending.indexOf("\n", start);
			while (nl >= 0) {
				const line = pending.slice(start, nl);
				start = nl + 1;
				if (line.length && onCells(line.split("\t")) === false) return;
				nl = pending.indexOf("\n", start);
			}
			if (start > (1 << 21)) {
				pending = pending.slice(start);
				start = 0;
			}
		}
		pending += decoder.end();
		const tail = pending.slice(start);
		if (tail.length) onCells(tail.split("\t"));
	} finally {
		closeSync(fd);
	}
}

function defRowFromCells(cells: string[]): DefRow | undefined {
	if (cells.length < 7) return undefined;
	return { symbol: unesc(cells[0] ?? ""), kind: cells[1] ?? "", file: unesc(cells[2] ?? ""), line: Number(cells[3]), module: unesc(cells[4] ?? ""), scope: unesc(cells[5] ?? ""), marker: unesc(cells[6] ?? "") };
}

/** Definition rows in index order (header skipped). Return false from the callback to stop early. */
function forEachDefRow(index: IndexState, onRow: (row: DefRow) => boolean | void): void {
	let first = true;
	forEachTsvLine(index.meta.defsPath, (cells) => {
		if (first) {
			first = false;
			return;
		}
		const row = defRowFromCells(cells);
		if (row) return onRow(row);
	});
}

function readFileRows(index: IndexState): { file: string; module: string; kind: string; symbols: number }[] {
	return readTsv(readFileSync(index.meta.filesPath, "utf8"), 3) as unknown as { file: string; module: string; kind: string; symbols: number }[];
}

/** Binary search the sorted defs for the first row whose symbol is >= needle (lowercased, colon-free). */
function lowerBound(path: string, needle: string): number {
	const { offsets } = lineOffsets(path);
	let lo = 1; // skip header
	let hi = Math.max(1, offsets.length - 1);
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const start = offsets[mid] ?? 0;
		const next = offsets[mid + 1] ?? start + 200;
		const slice = readRange(path, start, Math.min(next, start + 200));
		const field = (slice.split("\t")[0] ?? "").toLowerCase();
		if (probe(field) < needle) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Rows starting at a line index, stopping at the first row whose symbol no longer matches. */
function rowsFrom(path: string, fromIndex: number, limit: number, matches: (row: DefRow) => boolean, scanCap?: number): DefRow[] {
	const { offsets } = lineOffsets(path);
	const size = statSync(path).size;
	const out: DefRow[] = [];
	// `limit` caps the answer; `scanCap` caps the work. Popular symbols have hundreds of rows (AActor:
	// 283 in the Runtime index) and a cap tied to the answer size means rows past the cap are never
	// read — the canonical Engine/.../GameFramework/Actor.h declaration lost to a CoreUObject one on
	// path collation order alone.
	const cap = scanCap ?? limit * 4;
	for (let i = fromIndex, scanned = 0; i < offsets.length - 1 && out.length < limit && scanned < cap; i++, scanned++) {
		const cells = readRange(path, offsets[i] ?? 0, offsets[i + 1] ?? size).split("\t");
		if (cells.length < 7) continue;
		const row: DefRow = { symbol: unesc(cells[0] ?? ""), kind: cells[1] ?? "", file: unesc(cells[2] ?? ""), line: Number(cells[3]), module: unesc(cells[4] ?? ""), scope: unesc(cells[5] ?? ""), marker: unesc(cells[6] ?? "") };
		if (!matches(row)) break;
		out.push(row);
	}
	return out;
}

const unesc = (value: string) => (value.startsWith('"') ? (JSON.parse(value) as string) : value);
/** Lookup key: case- and colon-insensitive, so `A:Tick`, `A::Tick` and `a tick` all probe the same. */
const probe = (raw: string) => raw.toLowerCase().replace(/[:\s]/g, "");

const defPath = (index: IndexState) => index.meta.defsPath;

/** `Class` / `Class:Method` / `Class::Method` → the class part and the method part. */
export function splitQualified(symbol: string): { owner: string; member: string } {
	const cleaned = symbol.trim().replace(/::/g, ":");
	const index = cleaned.indexOf(":");
	if (index < 0) return { owner: cleaned, member: "" };
	return { owner: cleaned.slice(0, index), member: cleaned.slice(index + 1).replace(/:/g, "") };
}

/**
 * Exact symbol lookup, no fuzzy guessing: qualified and case-insensitive, and a bare method name
 * resolves through its owner (`Tick` + `AActor`). Prefix matching is opt-in so a typo never turns
 * into a plausible-looking path.
 */
export function lookupSymbol(index: IndexState, query: string, options: { limit?: number; prefix?: boolean; substring?: boolean; module?: string } = {}): LookupResult[] {
	const path = defPath(index);
	const limit = Math.max(1, options.limit ?? 50);
	const { owner, member } = splitQualified(query);
	const needle = probe(member ? `${owner}:${member}` : owner);
	const out: LookupResult[] = [];
	const accept = (row: DefRow, rank: number) => {
		if (options.module && row.module !== options.module) return;
		// A forward declaration is a pointer, not a definition: keep it visible (it is how agents find
		// the type at all) but never ahead of the real declaration.
		const forward = /^forward/.test(row.marker) ? 1 : 0;
		out.push({ ...row, rank: rank + forward });
	};

	// Pass 1: exact symbol match. Rows are sorted by the probe key, so an exact family is one
	// contiguous run: walk the whole run, rank forward declarations last, keep the best `limit`.
	const exact = rowsFrom(path, lowerBound(path, needle), Number.MAX_SAFE_INTEGER, (row) => probe(row.symbol) === needle, Number.MAX_SAFE_INTEGER);
	for (const row of [...exact].sort((a, b) => (/^forward/.test(a.marker) ? 1 : 0) - (/^forward/.test(b.marker) ? 1 : 0)).slice(0, limit)) accept(row, 0);

	// Pass 2: qualified-member fallback — a method row is `Owner:Method`, so `Tick` under `AActor`
	// matches when the row's owner is the requested one.
	if (!out.length && member) {
		const memberNeedle = probe(member);
		const ownerProbe = probe(owner);
		for (const row of rowsFrom(path, lowerBound(path, memberNeedle), limit, (row) => probe(row.symbol) === memberNeedle, 20000)) {
			const rowOwner = splitQualified(row.symbol).owner;
			if (ownerProbe && probe(rowOwner) === ownerProbe) accept(row, 2);
		}
	}

	// Pass 3: prefix, only when asked for.
	if (!out.length && options.prefix) {
		for (const row of rowsFrom(path, lowerBound(path, needle), limit, (row) => probe(row.symbol).startsWith(needle), 50000)) accept(row, 1);
	}

	// Pass 4: UE naming convention. Agents search `GameMode`, the code says `ALpGameModeBase`, and a
	// tool call rarely spells the prefix letter: one exact probe per conventional letter covers the
	// whole family at index speed (7 binary searches, no scan).
	if (!out.length && !member) {
		for (const letter of ["a", "u", "f", "e", "s", "t", "i"]) {
			const typed = letter + needle;
			for (const row of rowsFrom(path, lowerBound(path, typed), limit, (row) => probe(row.symbol) === typed, 4000)) accept(row, 1);
			if (out.length) break;
		}
	}

	// Pass 5: substring, opt-in. A linear pass over the TSV (~0.3 s for the 69 MB engine index) that
	// is only reached when every indexed pass missed, so the cost is paid by misses, not by hits.
	if (!out.length && options.substring) {
		forEachDefRow(index, (row) => {
			if (!probe(row.symbol).includes(needle)) return;
			accept(row, 3);
			return out.length < limit;
		});
	}
	return out.sort((a, b) => a.rank - b.rank || a.scope.localeCompare(b.scope) || a.symbol.localeCompare(b.symbol)).slice(0, limit);
}

/** Symbol names starting with a prefix — the cheap answer to "what is `Lp` in this project". */
export function listSymbols(index: IndexState, prefix: string, options: { limit?: number; kind?: string; module?: string } = {}): { symbol: string; kind: string; file: string; line: number; module: string }[] {
	const path = defPath(index);
	const needle = probe(prefix);
	const limit = Math.max(1, options.limit ?? 100);
	const out: { symbol: string; kind: string; file: string; line: number; module: string }[] = [];
	for (const row of rowsFrom(path, lowerBound(path, needle), limit * 10, (row) => probe(row.symbol).startsWith(needle))) {
		if (options.kind && row.kind !== options.kind) continue;
		if (options.module && row.module !== options.module) continue;
		out.push({ symbol: row.symbol, kind: row.kind, file: row.file, line: row.line, module: row.module });
		if (out.length >= limit) break;
	}
	return out;
}

/** Symbols declared in one file, in file order (a linear pass over a 69 MB TSV: ~0.3 s). */
export function symbolsInFile(index: IndexState, file: string, limit: number): DefRow[] {
	const target = probe(file);
	const path = defPath(index);
	const out: DefRow[] = [];
	forEachDefRow(index, (row) => {
		if (probe(row.file) === target) out.push(row);
		return out.length < limit;
	});
	return out;
}

/* ──────────────────────────────────────────────────────────────────────── modules and files */

export interface ModuleInfo {
	name: string;
	scope: string;
	files: number;
	symbols: number;
	directory: string;
	publicHeaderCount: number;
	sourceCount: number;
}

/** Module inventory, recovered from files.tsv; `directory` is the shallowest directory seen. */
export function listModules(index: IndexState, options: { limit?: number } = {}): ModuleInfo[] {
	const rows = readFileRows(index);
	const scopes = new Map<string, string>();
	forEachDefRow(index, (row) => {
		if (!scopes.has(row.module) && row.scope) scopes.set(row.module, row.scope);
	});
	const map = new Map<string, ModuleInfo>();
	for (const row of rows) {
		const directory = row.file.split("/").slice(0, -1).join("/");
		const info = map.get(row.module) ?? { name: row.module, scope: scopes.get(row.module) ?? "", files: 0, symbols: 0, directory, publicHeaderCount: 0, sourceCount: 0 };
		info.files += 1;
		info.symbols += row.symbols;
		if (directory.length < info.directory.length) info.directory = directory;
		if (/\/public\//i.test(row.file)) info.publicHeaderCount += 1;
		if (/\.(cpp|cc|c|inl|mm)$/i.test(row.file)) info.sourceCount += 1;
		map.set(row.module, info);
	}
	return [...map.values()].sort((a, b) => b.symbols - a.symbols).slice(0, options.limit ?? 1000);
}

/** Files of a module, public headers first — "what does module X expose". */
/**
 * Resolve a partial path (`LpCharacterTypes.h`, `Public/Character/LpCharacterTypes.h`) against the
 * indexed files. Agents pass what they see in an error message, not an absolute path.
 */
export function findFileBySuffix(index: IndexState, suffix: string, limit = 6): string[] {
	const want = normalizePath(suffix).toLowerCase();
	return readFileRows(index)
		.filter((row) => row.file.toLowerCase().endsWith(want) || row.file.toLowerCase().includes("/" + want))
		.slice(0, limit)
		.map((row) => row.file);
}

export function listFiles(index: IndexState, module: string, options: { kind?: string; limit?: number } = {}): { file: string; module: string; kind: string; symbols: number }[] {
	const rows = readFileRows(index);
	const limit = options.limit ?? 300;
	const wanted = module.toLowerCase();
	return rows
		.filter((row) => row.module.toLowerCase() === wanted && (!options.kind || row.kind === options.kind))
		.sort((a, b) => (/\/public\//i.test(a.file) ? -1 : 1) - (/\/public\//i.test(b.file) ? -1 : 1) || a.file.localeCompare(b.file))
		.slice(0, limit);
}

/**
 * Real **file names** whose basename shares a token with `query` — the answer to "this header does not
 * exist, what does" (§3 of the field findings). These are file names, never type names: a 0-row symbol
 * lookup must not turn into a fuzzy type suggestion, so callers label them as files and say so.
 *
 * Tokenisation splits camelCase and separators: `MoverState` → `mover, state`; a candidate scores by
 * how many of the query's tokens it contains, so `MoverTypes.h` and `MoverSimulationTypes.h` outrank
 * `MoverEditor.h`.
 */
export function suggestFileNames(index: IndexState, query: string, options: { limit?: number; module?: string } = {}): { file: string; module: string; score: number; tokens: string[] }[] {
	const tokens = nameTokens(baseName(query).replace(/\.(h|hpp|hxx|inl|cpp|cc|c|md)$/i, ""));
	if (!tokens.length) return [];
	const limit = options.limit ?? 8;
	const module = options.module?.toLowerCase();
	const out: { file: string; module: string; score: number; tokens: string[] }[] = [];
	for (const row of readFileRows(index)) {
		if (module && row.module.toLowerCase() !== module) continue;
		const stem = baseName(row.file).replace(/\.(h|hpp|hxx|inl|cpp|cc|c)$/i, "");
		const mine = nameTokens(stem);
		let score = 0;
		for (const token of tokens) if (mine.includes(token)) score++;
		if (!score) continue;
		/* Two tie-breakers that matter when a name is invented: a row containing *every* query token is
		 * closer than one sharing a single generic token, and the public header of a module is the file
		 * an engineer is meant to include (a Private/Logging.h is not the answer to a question about a
		 * component). */
		if (score === tokens.length) score += 2;
		if (fileKindLabel(row.file) === "public-header") score += 1;
		out.push({ file: row.file, module: row.module, score, tokens: mine });
	}
	out.sort((a, b) => b.score - a.score || baseName(a.file).length - baseName(b.file).length || a.file.localeCompare(b.file));
	return out.slice(0, limit);
}

/** `BlendStackAnimInstance` → `blend, stack, anim, instance` (the vocabulary suggestions are scored with). */
export function nameTokens(value: string): string[] {
	return (
		value
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.split(/[^A-Za-z0-9]+/)
			.map((token) => token.toLowerCase())
			.filter((token) => token.length > 1) as string[]
	);
}

/* ──────────────────────────────────────────────────────────────────────── compile unit */

export interface ContextUnit {
	file: string;
	module: string;
	kind: string;
	defines: string[];
	definesFile: string;
	includePaths: string[];
	standard: string;
	compiler: string;
	compilerArgs: string[];
	forcedIncludes: string[];
	includes: string[];
	declares: string[];
	ownerOf: { symbol: string; file: string; line: number }[];
	moduleRefs: { public: string[]; private: string[]; publicInclude: string[]; privateInclude: string[]; dynamicallyLoaded: string[]; circular: string[] };
	notes: string[];
}

/**
 * The compile unit: what one file is compiled with and what it sees. Answers "why is this symbol
 * invisible here" without opening the build graph. Include paths, defines, the C++ standard and the
 * compiler come from the cached `TargetDetails` JSON; defines are read out of the `Definitions*.h`
 * forced include, because TargetDetails reports `defines: []` for every module.
 */
export function contextFor(index: IndexState, file: string, options: { limit?: number; queryFiles?: { targetDetails: string; moduleReferences: string } } = {}): ContextUnit | undefined {
	const target = normalizePath(file);
	const rows = readFileRows(index);
	const hit = rows.find((row) => row.file === target) ?? rows.find((row) => row.file.toLowerCase() === target.toLowerCase());
	if (!hit) return undefined;

	const notes: string[] = [];
	const limit = options.limit ?? 200;
	const unit: ContextUnit = {
		file: hit.file,
		module: hit.module,
		kind: hit.kind,
		defines: [],
		definesFile: "",
		includePaths: [],
		standard: "",
		compiler: "",
		compilerArgs: [],
		forcedIncludes: [],
		includes: [],
		declares: [],
		ownerOf: [],
		moduleRefs: { public: [], private: [], publicInclude: [], privateInclude: [], dynamicallyLoaded: [], circular: [] },
		notes,
	};

	if (index.meta.includesPath && existsSync(index.meta.includesPath)) {
		for (const line of readFileSync(index.meta.includesPath, "utf8").split("\n").slice(1)) {
			const cells = line.split("\t");
			if (cells[0] && unesc(cells[0]) === hit.file) {
				unit.includes = (cells[2] ?? "").split(",").filter(Boolean).slice(0, limit);
				break;
			}
		}
	} else {
		notes.push("includes.tsv absent (definitions index) — `unreal_index build --full` adds per-file include sets");
	}

	const declared = symbolsInFile(index, hit.file, limit);
	unit.declares = declared.map((row) => row.symbol);
	for (const row of declared.filter((row) => row.kind === "function")) {
		const owner = splitQualified(row.symbol).owner;
		if (!owner) continue;
		const [ownerRow] = lookupSymbol(index, owner, { limit: 1 });
		if (ownerRow) unit.ownerOf.push({ symbol: owner, file: ownerRow.file, line: ownerRow.line });
	}

	const queryFile = options.queryFiles?.targetDetails ?? index.meta.queryFiles?.targetDetails;
	if (queryFile && existsSync(queryFile)) {
		const settings = parseTargetDetails(readQueryJson(queryFile)).settings.get(hit.module);
		if (settings) applySettings(unit, settings, notes);
		else notes.push(`TargetDetails has no compile settings for module ${hit.module} (target identity mismatch, or a module UBT did not build)`);
	} else {
		notes.push("no cached TargetDetails JSON — include paths, defines and the compiler need `unreal_index build --full` (it runs UnrealBuildTool Query)");
	}

	const refsFile = options.queryFiles?.moduleReferences ?? index.meta.queryFiles?.moduleReferences;
	if (refsFile && existsSync(refsFile)) {
		const refs = parseModuleReferences(readQueryJson(refsFile)).get(hit.module);
		if (refs) unit.moduleRefs = { public: refs.public, private: refs.private, publicInclude: refs.publicInclude, privateInclude: refs.privateInclude, dynamicallyLoaded: refs.dynamicallyLoaded, circular: refs.circular };
	}
	return unit;
}

function applySettings(unit: ContextUnit, settings: UbtModuleSettings, notes: string[]): void {
	unit.includePaths = settings.includePaths;
	unit.standard = settings.standard;
	unit.compiler = settings.compilerPath;
	unit.compilerArgs = [...settings.compilerArgs, ...settings.compilerAdditionalArgs.cpp];
	unit.forcedIncludes = settings.forcedIncludes;
	unit.definesFile = settings.definesFile;
	if (settings.defines.length) unit.defines = settings.defines;
	if (settings.definesFile && existsSync(settings.definesFile)) {
		unit.defines = readDefines(settings.definesFile);
		notes.push(`defines read from the forced include ${settings.definesFile} (TargetDetails 'defines' is empty for every module)`);
	} else if (!settings.defines.length) {
		notes.push("defines unavailable: TargetDetails reports none and the Definitions header is not on disk (build the target once to generate it)");
	}
}

/** `#define X` / `#define X Y` from a `Definitions*.h` header. */
export function readDefines(path: string): string[] {
	const out: string[] = [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return out;
	}
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\b(.*)$/.exec(line);
		if (!match?.[1]) continue;
		const value = (match[2] ?? "").trim();
		out.push(value === "1" ? match[1] : value ? `${match[1]}=${value}` : match[1]);
	}
	return out;
}

/** Module dependency lists from cached Query data, without a symbol index (definitions-only mode). */
export function moduleRefsFromQuery(queryFiles: { moduleReferences: string }, module: string): UbtModuleRefs | undefined {
	if (!existsSync(queryFiles.moduleReferences)) return undefined;
	return parseModuleReferences(readQueryJson(queryFiles.moduleReferences)).get(module);
}

/* ──────────────────────────────────────────────────────────────────────── registry */

/** Index key: mode + sorted roots (full adds the target identity, because include sets are target-specific). */
export function indexKeyFor(input: { mode: "definitions" | "full"; roots: string[]; scope?: IndexScope; target?: string; platform?: string; configuration?: string }): string {
	const roots = input.roots.map((root) => normalizePath(root).toLowerCase()).sort();
	const parts = [input.mode, input.scope ?? "", ...roots];
	if (input.mode === "full") parts.push(input.target ?? "", input.platform ?? "", input.configuration ?? "");
	const fingerprint = shortHash(parts.join("|"));
	const label = input.scope === "Engine" ? "engine" : (input.roots[0] ?? roots[0] ?? "index").split("/").filter(Boolean).pop() ?? "index";
	return `idx-${label.replace(/[^a-z0-9]/gi, "")}-${input.mode === "full" ? "full" : "defs"}-${fingerprint}`;
}

export function indexesRoot(): string {
	return normalizePath(joinPath(cacheDir(), "indexes"));
}

export function indexDir(key: string): string {
	const dir = normalizePath(joinPath(indexesRoot(), key));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Every index on disk, newest first, with health (status, `--rebuild`, and the auto path). */
export function listIndexes(): IndexState[] {
	const root = indexesRoot();
	if (!existsSync(root)) return [];
	const out: IndexState[] = [];
	for (const key of readdirSync(root)) {
		const meta = readJson<IndexMeta>(joinPath(root, key, "meta.json"));
		if (!meta || !meta.defsPath) continue;
		const issues: string[] = [];
		if (meta.version !== INDEX_VERSION) issues.push(`format v${meta.version}, current v${INDEX_VERSION}`);
		if (!existsSync(meta.defsPath)) issues.push("defs.tsv missing");
		if (meta.mode === "full" && (!meta.includesPath || !existsSync(meta.includesPath))) issues.push("includes.tsv missing");
		for (const r of meta.roots ?? []) if (!existsSync(r)) issues.push(`root no longer present: ${r}`);
		let ageMs = 0;
		try {
			ageMs = Date.now() - statSync(joinPath(root, key)).mtimeMs;
		} catch {
			/* unreadable directory: report age 0 */
		}
		out.push({ key, dir: normalizePath(joinPath(root, key)), meta, fs: realFs, ageMs, healthy: issues.length === 0, issues, scope: meta.scope ?? deriveScope(meta.roots ?? [], { projectRoot: meta.projectRoot, engineRoot: meta.engineRoot }) });
	}
	return out.sort((a, b) => b.ageMs - a.ageMs);
}

export function loadIndex(key: string): IndexState | undefined {
	const dir = normalizePath(joinPath(indexesRoot(), key));
	const meta = readJson<IndexMeta>(joinPath(dir, "meta.json"));
	if (!meta) return undefined;
	let ageMs = 0;
	try {
		ageMs = Date.now() - statSync(dir).mtimeMs;
	} catch {
		/* caller reports the missing directory */
	}
	return { key, dir, meta, fs: realFs, ageMs, healthy: meta.version === INDEX_VERSION && existsSync(meta.defsPath), issues: meta.version === INDEX_VERSION ? [] : [`format v${meta.version}, current v${INDEX_VERSION}`], scope: meta.scope ?? deriveScope(meta.roots ?? [], { projectRoot: meta.projectRoot, engineRoot: meta.engineRoot }) };
}

/** The index a query should use: explicit key, else the newest healthy index matching the filter. */
/** Same root set, same index. Path-compare is case-insensitive because Windows is. */
export const rootsSignature = (roots: string[]) => roots.map((root) => normalizePath(root).toLowerCase()).sort().join("|");

export function pickIndex(filter: { key?: string; mode?: "definitions" | "full"; projectRoot?: string; engineRoot?: string; scope?: IndexScope; roots?: string[] }): { index?: IndexState; candidates: IndexState[]; notes: string[] } {
	const notes: string[] = [];
	const all = listIndexes();
	if (filter.key) {
		const found = all.find((state) => state.key === filter.key);
		if (found) return { index: found, candidates: all, notes };
		notes.push(`no index named ${filter.key}`);
		return { candidates: all, notes };
	}
	let pool = all.filter((state) => state.healthy);
	if (filter.mode) pool = pool.filter((state) => state.meta.mode === filter.mode);
	if (filter.projectRoot) pool = pool.filter((state) => normalizePath(state.meta.projectRoot ?? "").toLowerCase() === normalizePath(filter.projectRoot ?? "").toLowerCase());
	if (filter.scope) pool = pool.filter((state) => state.scope === filter.scope);
	// Scope alone is not a coverage claim: an index built over Engine/Source/Core answers a
	// Runtime-wide query with a partial list, and a partial list is worse than no list.
	const want = filter.roots ? rootsSignature(filter.roots) : "";
	if (want) {
		pool = pool.filter((state) => rootsSignature(state.meta.roots ?? []) === want);
		if (!pool.length && all.some((state) => state.healthy && (!filter.mode || state.meta.mode === filter.mode) && (!filter.scope || state.scope === filter.scope))) {
			notes.push(`an index exists for the same scope over a different root set (${all.map((state) => state.key).join(", ")}); it is not reused, build for these roots`);
		}
	}
	const engineRoot = filter.engineRoot ? normalizePath(filter.engineRoot).toLowerCase() : "";
	if (!pool.length && engineRoot) pool = all.filter((state) => state.healthy && normalizePath(state.meta.engineRoot ?? "").toLowerCase() === engineRoot && (!filter.scope || state.scope === filter.scope) && (!want || rootsSignature(state.meta.roots ?? []) === want));
	if (!pool.length) notes.push(all.length ? `${all.length} index/indices exist, none healthy and matching this scope` : "no symbol index built yet");
	return { index: pool[0], candidates: pool, notes };
}

/* ────────────────────────────────────────────────────────── header (path-only) index */

/**
 * A second, much cheaper index: **file paths only**, never file contents.
 *
 * It exists because the highest-value question in a UE session is "does this header/type exist in
 * *this engine version*?", and a definitions index cannot answer a no — absence from a partially
 * scanned root set is not absence from the engine. Walking the tree and recording paths is a few
 * seconds (measured: 52,568 plugin sources + 18,681 Runtime files in ~1 s of walking, no reads), so
 * "exists / does not exist, here is the exact path" becomes an answer the tools can actually give.
 *
 * Built only by an explicit `unreal_index action: "headers"` — never implicitly by a lookup, and
 * never as a side effect of a symbol query.
 */
export const HEADER_VERSION = 1;

/** Header extensions the path index records (the things an `#include` line can name). */
const HEADER_SCAN_EXT = [".h", ".hpp", ".hxx", ".inl"];

export interface HeaderIndexMeta {
	version: number;
	key: string;
	generatedAt: string;
	roots: string[];
	engineRoot?: string;
	projectRoot?: string;
	areas?: string[];
	files: number;
	/** Root provenance by kind, same vocabulary as `IndexMeta.rootKinds`. */
	rootKinds?: Record<string, number>;
	path: string;
	sizeBytes: number;
	warnings: string[];
}

export interface HeaderIndex {
	key: string;
	dir: string;
	meta: HeaderIndexMeta;
	ageMs: number;
	healthy: boolean;
	issues: string[];
}

export function headersRoot(): string {
	return normalizePath(joinPath(cacheDir(), "headers"));
}

/** Path-only index key: the root set (engine identity is part of the roots, so it is implied). */
export function headerKeyFor(input: { roots: string[]; label?: string }): string {
	const roots = input.roots.map((root) => normalizePath(root).toLowerCase()).sort();
	const fingerprint = shortHash(["headers", ...roots].join("|"));
	const label = (input.label ?? roots[0] ?? "index").split("/").filter(Boolean).pop() ?? "index";
	return `hdr-${label.replace(/[^a-z0-9]/gi, "")}-${fingerprint}`;
}

export async function buildHeaderIndex(input: {
	key?: string;
	roots: ScanRoot[];
	engineRoot?: string;
	projectRoot?: string;
	areas?: string[];
	concurrency?: number;
}): Promise<{ key: string; dir: string; files: number; durationMs: number; meta: HeaderIndexMeta; built: boolean }> {
	const started = Date.now();
	const dirs = input.roots.map((root) => normalizePath(root.dir));
	const key = input.key ?? headerKeyFor({ roots: dirs });
	const dir = normalizePath(joinPath(headersRoot(), key));
	mkdirSync(dir, { recursive: true });
	const warnings: string[] = [];

	const discovered = await collectSourceFiles(input.roots, { concurrency: input.concurrency });
	const rootKinds: Record<string, number> = {};
	for (const entry of summarizeRootKinds(dirs, { projectRoot: input.projectRoot, engineRoot: input.engineRoot })) {
		rootKinds[entry.kind] = entry.count;
	}

	const seen = new Set<string>();
	const rows: string[] = [];
	for (const entry of discovered) {
		const lower = entry.abs.toLowerCase();
		if (!HEADER_SCAN_EXT.some((ext) => lower.endsWith(ext))) continue;
		if (seen.has(lower)) continue;
		seen.add(lower);
		const module = entry.root.module ?? moduleFromBuildCs(entry.abs);
		rows.push(`${esc(entry.abs)}\t${esc(module)}\t${fileKindLabel(entry.abs)}`);
	}
	rows.sort((a, b) => a.localeCompare(b));

	const tsv = `file\tmodule\tkind\n${rows.join("\n")}\n`;
	const path = normalizePath(joinPath(dir, "headers.tsv"));
	writeTextAtomic(path, tsv);

	const meta: HeaderIndexMeta = {
		version: HEADER_VERSION,
		key,
		generatedAt: new Date().toISOString(),
		roots: dirs,
		engineRoot: input.engineRoot ? normalizePath(input.engineRoot) : undefined,
		projectRoot: input.projectRoot ? normalizePath(input.projectRoot) : undefined,
		areas: input.areas,
		files: rows.length,
		rootKinds,
		path,
		sizeBytes: Buffer.byteLength(tsv, "utf8"),
		warnings,
	};
	writeJsonAtomic(joinPath(dir, "meta.json"), meta);
	return { key, dir, files: rows.length, durationMs: Date.now() - started, meta, built: true };
}

export function listHeaderIndexes(): HeaderIndex[] {
	const root = headersRoot();
	if (!existsSync(root)) return [];
	const out: HeaderIndex[] = [];
	for (const key of readdirSync(root)) {
		const meta = readJson<HeaderIndexMeta>(joinPath(root, key, "meta.json"));
		if (!meta || !meta.path) continue;
		const issues: string[] = [];
		if (meta.version !== HEADER_VERSION) issues.push(`format v${meta.version}, current v${HEADER_VERSION}`);
		if (!existsSync(meta.path)) issues.push("headers.tsv missing");
		for (const r of meta.roots ?? []) if (!existsSync(r)) issues.push(`root no longer present: ${r}`);
		let ageMs = 0;
		try {
			ageMs = Date.now() - statSync(joinPath(root, key)).mtimeMs;
		} catch {
			/* unreadable directory: report age 0 */
		}
		out.push({ key, dir: normalizePath(joinPath(root, key)), meta, ageMs, healthy: issues.length === 0, issues });
	}
	return out.sort((a, b) => b.ageMs - a.ageMs);
}

export function loadHeaderIndex(key: string): HeaderIndex | undefined {
	const dir = normalizePath(joinPath(headersRoot(), key));
	const meta = readJson<HeaderIndexMeta>(joinPath(dir, "meta.json"));
	if (!meta) return undefined;
	let ageMs = 0;
	try {
		ageMs = Date.now() - statSync(dir).mtimeMs;
	} catch {
		/* caller reports the missing directory */
	}
	return { key, dir, meta, ageMs, healthy: meta.version === HEADER_VERSION && existsSync(meta.path), issues: meta.version === HEADER_VERSION ? [] : [`format v${meta.version}, current v${HEADER_VERSION}`] };
}

/** The newest healthy path index over exactly these roots. Never builds anything. */
export function pickHeaderIndex(roots: string[]): HeaderIndex | undefined {
	const want = rootsSignature(roots);
	return listHeaderIndexes().find((state) => state.healthy && rootsSignature(state.meta.roots ?? []) === want);
}

export interface HeaderRow {
	file: string;
	module: string;
	kind: string;
	/** `exact` = that file name exists; `suffix` = a path suffix match; `token` = shares name tokens. */
	match: "exact" | "suffix" | "token";
}

function readHeaderRows(index: HeaderIndex): { file: string; module: string; kind: string }[] {
	const text = readFileSync(index.meta.path, "utf8");
	return readTsv(text) as unknown as { file: string; module: string; kind: string }[];
}

/**
 * "Does this header exist?" — exact file-name match first, then path suffix, then name-token overlap.
 * Token hits are labelled `token`: they are *related files*, not the file asked for, and callers must
 * present them that way (an invented name must not be quietly reinterpreted as a real one).
 */
export function lookupHeaderPaths(index: HeaderIndex, name: string, options: { limit?: number } = {}): HeaderRow[] {
	const raw = normalizePath(name).trim();
	const leafRaw = baseName(raw).replace(/\.(h|hpp|hxx|inl)$/i, "");
	const leaf = baseName(raw).toLowerCase();
	const stem = leaf.replace(/\.(h|hpp|hxx|inl)$/i, "");
	/* Tokenise the cased name: `PoseSearchResultTypes` → pose, search, result, types. A lowered stem
	 * would tokenise as one long token and match nothing. */
	const queryTokens = nameTokens(leafRaw);
	const limit = options.limit ?? 12;
	const out: HeaderRow[] = [];
	for (const row of readHeaderRows(index)) {
		const rowLeaf = baseName(row.file).toLowerCase();
		const rowLower = row.file.toLowerCase();
		let match: HeaderRow["match"] | undefined;
		if (rowLeaf === leaf || rowLeaf === `${stem}.h`) match = "exact";
		else if (raw.includes("/") && rowLower.endsWith(leaf)) match = "suffix";
		else if (queryTokens.length > 1) {
			const rowTokens = nameTokens(rowLeaf.replace(/\.(h|hpp|hxx|inl)$/i, ""));
			let hits = 0;
			for (const token of queryTokens) if (rowTokens.includes(token)) hits++;
			if (hits === queryTokens.length) match = "token";
		}
		if (!match) continue;
		out.push({ file: row.file, module: row.module, kind: row.kind, match });
	}
	const order = { exact: 0, suffix: 1, token: 2 } as const;
	out.sort((a, b) => order[a.match] - order[b.match] || a.file.localeCompare(b.file));
	return out.slice(0, limit);
}

/** Real header names related to `name` (for the "this header does not exist, here is what does" answer). */
export function suggestHeaderPaths(index: HeaderIndex, name: string, options: { limit?: number } = {}): HeaderRow[] {
	const stem = baseName(name).replace(/\.(h|hpp|hxx|inl)$/i, "");
	const queryTokens = nameTokens(stem);
	if (!queryTokens.length) return [];
	const limit = options.limit ?? 8;
	const out: { row: HeaderRow; score: number }[] = [];
	for (const row of readHeaderRows(index)) {
		const rowTokens = nameTokens(baseName(row.file).replace(/\.(h|hpp|hxx|inl)$/i, ""));
		let score = 0;
		for (const token of queryTokens) if (rowTokens.includes(token)) score++;
		if (!score) continue;
		if (score === queryTokens.length) score += 2;
		if (row.kind === "public-header") score += 1;
		out.push({ row: { ...row, match: "token" }, score });
	}
	out.sort((a, b) => b.score - a.score || baseName(a.row.file).length - baseName(b.row.file).length || a.row.file.localeCompare(b.row.file));
	return out.slice(0, limit).map((entry) => entry.row);
}

/* ──────────────────────────────────────────────────────────────────────── helpers */

const fileKindLabel = (file: string) => (/\/public\//i.test(file) ? "public-header" : /\.(cpp|cc|c|mm|cpp20)$/i.test(file) ? "source" : /\/internal\//i.test(file) ? "internal-header" : "header");

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Write-then-rename, so an interrupted build never leaves a half-written TSV behind. */
function writeTextAtomic(path: string, text: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, text, "utf8");
	if (existsSync(path)) {
		try {
			renameSync(tmp, path);
		} catch {
			writeFileSync(path, text, "utf8");
			try {
				renameSync(tmp, path);
			} catch {
				/* Windows locking (an open reader): the first writeFileSync already landed */
			}
		}
		return;
	}
	renameSync(tmp, path);
}

function writeJsonAtomic(path: string, value: unknown): void {
	writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Module attribution without Query data: the nearest `*.Build.cs` above the file.
 *
 * The **module file name is the module name** — UBT names a module after its `X.Build.cs`, not after
 * the directory. `Engine/Plugins/Animation/PoseSearch/Source/Runtime/PoseSearch.Build.cs` is module
 * `PoseSearch` in a directory leaf-named `Runtime`, and `Runtime` is a leaf reused by 10 other modules
 * in the 5.8 tree (`Source` 20x, `Runtime` 10x, `Editor` 9x, `Module` 5x out of 1,079). Naming the
 * leaf is what made `unreal_symbol module: "PoseSearch"` return 0 rows in a definitions index while
 * `unreal_context module: "PoseSearch"` (UBT data) returned the truth.
 *
 * `moduleNames` (from a `.uplugin`'s Modules[].Name) breaks ties when one directory owns several
 * `*.Build.cs` files: prefer the declared name, then the leaf, then the shortest.
 */
export function moduleFromBuildCs(file: string, moduleNames?: string[]): string {
	const parts = normalizePath(file).split("/");
	for (let i = parts.length - 2; i >= 0; i--) {
		const dir = parts.slice(0, i + 1).join("/");
		const leaf = parts[i] ?? "";
		const names = buildCsNames(dir);
		if (!names.length) continue;
		return pickModuleName(names, leaf, moduleNames);
	}
	const marker = parts.indexOf("Source");
	const candidate = marker >= 0 ? parts[marker + 1] : undefined;
	if (candidate) return candidate;
	return parts[parts.length - 2] ?? "root";
}

/** Module names owned by `dir`: basenames of its `*.Build.cs` files (empty when it owns none). */
export function buildCsNames(dir: string): string[] {
	const here = normalizePath(dir);
	let names: string[];
	try {
		names = readdirSync(here);
	} catch {
		return [];
	}
	return names.filter((entry) => entry.endsWith(".Build.cs")).map((entry) => entry.slice(0, -".Build.cs".length));
}

/** Choose the module name a directory's `*.Build.cs` files imply (see `moduleFromBuildCs`). */
export function pickModuleName(names: string[], leaf: string, moduleNames?: string[]): string {
	if (names.length === 0) return leaf;
	if (names.length === 1) return names[0]!;
	if (moduleNames?.length) {
		const declared = names.filter((name) => moduleNames.includes(name)).sort((a, b) => a.length - b.length);
		if (declared.length) return declared[0]!;
	}
	if (names.includes(leaf)) return leaf;
	return [...names].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
}

/**
 * Scan roots for an index build. A "root" is one module directory (the directory holding a
 * `*.Build.cs`), because that is the unit UBT compiles and the unit a symbol's module belongs to.
 *
 * Engine roots are limited to the areas that carry game-facing C++ (`Runtime`, `Editor`,
 * `Developer`) by default: `Engine/Source/Programs` (UnrealLightmass, ShaderCompileTool, ...) is
 * tens of thousands of files of build-tool code that a gameplay symbol lookup will never want.
 */
export interface RootOptions {
	projectRoot?: string;
	engineRoot?: string;
	/** Plugin directories (absolute), e.g. from `PluginSummary.dir`. */
	pluginDirs?: string[];
	includeEngine?: boolean;
	/**
	 * What to scan on the engine side. Two shapes, both rooted at the engine install:
	 * - an `Engine/Source` area: `"Runtime"`, `"Editor"`, `"Runtime/Core"`, `"Runtime/CoreUObject"`;
	 * - an engine-plugin area, prefixed `Plugins`: `"Plugins"` (every plugin under `Engine/Plugins`,
	 *   ~2.8x the Runtime scan) or a subtree `"Plugins/Animation/PhysicsControl"`.
	 * Default `DEFAULT_ENGINE_AREAS` (`["Runtime"]`).
	 */
	engineAreas?: string[];
	/** Declared module names per plugin root dir (from its `.uplugin`), used to name modules correctly. */
	pluginModuleNames?: Record<string, string[]>;
	fs?: FsAdapter;
}

/** Module directories (each contains a `*.Build.cs`) directly under `dir`. */
/**
* Module roots under `dir`: each immediate child that contains a `*.Build.cs`.
* If `dir` itself is a module directory (`Engine/Source/Runtime/CoreUObject`) it is the root.
*/
const SKIP_DIR_NAMES = new Set(["Intermediate", "Binaries", "Saved", ".git", ".vs", "ThirdParty", "Programs", "Shaders", "Config", "Content", "Build"]);

/**
 * A module directory is any directory under `dir` that owns a `*.Build.cs`, at any depth. UE puts
 * modules at `Runtime/Core`, `Runtime/Engine/Classes`... and areas are addressable as
 * `engineAreas: ["Runtime/Core"]`, so the search must recurse (depth-capped, build-system dirs skipped).
 */
function moduleDirsUnder(dir: string, scope: ScanRoot["scope"], fs: FsAdapter, maxDepth = 3, depth = 0, moduleNames?: string[]): ScanRoot[] {
	const roots: ScanRoot[] = [];
	const here = normalizePath(dir);
	const names = buildCsNames(here);
	if (names.length) {
		roots.push({ dir: here, scope, module: pickModuleName(names, baseName(here), moduleNames) });
		return roots; // a module's own tree never contains another module
	}
	if (depth >= maxDepth) return roots;
	for (const child of fs.listDir(here)) {
		const abs = joinPath(here, child);
		if (!fs.isDirectory(abs)) continue;
		if (SKIP_DIR_NAMES.has(child)) continue;
		roots.push(...moduleDirsUnder(abs, scope, fs, maxDepth, depth + 1, moduleNames));
	}
	return roots;
}

export function assembleRoots(options: RootOptions): { roots: ScanRoot[]; notes: string[] } {
	const fs = options.fs ?? realFs;
	const notes: string[] = [];
	const roots: ScanRoot[] = [];

	if (options.projectRoot) {
		const projectRoot = normalizePath(options.projectRoot);
		const found = moduleDirsUnder(joinPath(projectRoot, "Source"), "Project", fs);
		roots.push(...found);
		notes.push(found.length ? `project: ${found.length} module root(s) under ${projectRoot}/Source` : `no module roots under ${projectRoot}/Source`);
	}

	for (const pluginDir of options.pluginDirs ?? []) {
		const abs = normalizePath(pluginDir);
		const moduleNames = options.pluginModuleNames?.[abs];
		const found = moduleDirsUnder(joinPath(abs, "Source"), "Plugin", fs, 3, 0, moduleNames);
		roots.push(...found);
		if (!found.length) notes.push(`plugin ${baseName(abs)}: no C++ module roots`);
	}

	if (options.includeEngine && options.engineRoot) {
		const engineRoot = normalizePath(options.engineRoot);
		const areas = options.engineAreas?.length ? options.engineAreas : DEFAULT_ENGINE_AREAS;
		for (const area of areas) {
			// "Plugins/..." addresses Engine/Plugins; anything else is an Engine/Source area.
			const pluginArea = /^plugins(\/|$)/i.test(area);
			const found = moduleDirsUnder(joinPath(engineRoot, pluginArea ? "Engine" : "Engine/Source", area), "Engine", fs, pluginArea ? 6 : 4);
			roots.push(...found);
			notes.push(`engine ${area}: ${found.length} module root(s)`);
		}
	}

	return { roots, notes };
}

export type { IncludeRef, ScanRoot, SymbolDef };
