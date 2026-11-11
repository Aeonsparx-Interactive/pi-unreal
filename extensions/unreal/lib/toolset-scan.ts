/**
 * Locator index for the Python source behind Epic's MCP toolsets.
 *
 * The toolset plugins ship their Python in `<Plugin>/Content/Python/**`, one class per toolset
 * (`class BlueprintTools(unreal.ToolsetDefinition)`) with one `@toolset_registry.tool_call` method per
 * exposed tool. That file is the ground truth for two questions the live catalog cannot answer:
 *
 * 1. "does this tool exist in this engine install at all" — the editor only describes what it mounts,
 *    so a plugin the project does not enable is invisible over MCP;
 * 2. "what is the Python signature" — the raw `def` line, types included, which is the Unreal Python
 *    API shape an agent is usually reaching for.
 *
 * Deliberate limits: this module never derives an argument SCHEMA. The live `describe_toolset` payload
 * stays the authority for argument names, required flags and defaults (a hand-written parser of Python
 * annotations drifts — multi-line signatures, `X | None`, `list[unreal.Actor]`). Here the signature is
 * carried through as source text, and the index only claims name + location.
 *
 * Cost on an installed UE 5.8: a directories-only glob over `Engine/Plugins` for `**\/Content/Python`
 * (45 ms measured), a `**\/*.py` glob per found directory, and one read per file (~700 files). Built on
 * explicit request and cached, never on a plain lookup.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cacheDir, MAX_AGE_MS } from "./cache.ts";
import { parseUproject } from "./descriptors.ts";
import { findProjectFile, resolveEngineForProject } from "./engine-resolver.ts";
import { joinPath, normalizePath, realFs, shortHash } from "./util.ts";

export const PY_INDEX_SCHEMA = 1;
/** Engine content only changes on an install/upgrade, so a day-old index is still the same engine. */
export const PY_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

export interface PyTool {
	name: string;
	line: number;
	/** Raw `def` line(s) as written, e.g. `def get_parent(blueprint: unreal.Blueprint) -> unreal.Class:`. */
	signature: string;
	summary: string;
}

export interface PyToolset {
	/** Full toolset name as the toolset registry publishes it (`editor_toolset.toolsets.blueprint.BlueprintTools`). */
	name: string;
	module: string;
	className: string;
	/** Owning plugin (the folder holding `.uplugin`), for `enabled` reporting. */
	plugin: string;
	file: string;
	line: number;
	doc: string;
	tools: PyTool[];
}

export interface PyIndex {
	schema: number;
	key: string;
	engineRoot?: string;
	projectDir?: string;
	scannedAtMs: number;
	elapsedMs: number;
	roots: string[];
	files: number;
	toolsets: PyToolset[];
	warnings: string[];
}

export interface BuildPyIndexOptions {
	engineRoot?: string;
	projectDir?: string;
	/** Extra `<dir>/Content/Python` roots (plugin directories outside the project and engine). */
	extraRoots?: string[];
	now?: () => number;
}

export function pyIndexKey(input: { engineRoot?: string; projectDir?: string }): string {
	return shortHash([normalizePath(input.engineRoot ?? "-"), normalizePath(input.projectDir ?? "-")].join("|"));
}

export function pyIndexPath(key: string): string {
	return joinPath(cacheDir(), "mcp", "python", `${key}.json`);
}

export function loadPyIndex(key: string): PyIndex | undefined {
	try {
		const parsed = JSON.parse(readFileSync(pyIndexPath(key), "utf8")) as PyIndex;
		return parsed.schema === PY_INDEX_SCHEMA && parsed.key === key ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function savePyIndex(index: PyIndex): void {
	const path = pyIndexPath(index.key);
	mkdirSync(joinPath(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(index, null, 1)}\n`, "utf8");
}

export function pyIndexAgeMs(index: PyIndex, now = Date.now()): number {
	return now - index.scannedAtMs;
}

/* ──────────────────────────────────────────────────────────────────────────────── extraction */

const TOOL_CALL = "@toolset_registry.tool_call";
const TOOLSET_BASE = /^class\s+(\w+)\s*\(\s*unreal\.ToolsetDefinition\b/;

/** Join a `def …:` line with its continuation lines until the parentheses balance. */
function joinSignature(lines: string[], start: number): string {
	const parts: string[] = [];
	let depth = 0;
	for (let index = start; index < Math.min(lines.length, start + 12); index++) {
		const line = (lines[index] ?? "").trim();
		parts.push(line);
		for (const char of line) {
			if (char === "(" || char === "[" || char === "{") depth += 1;
			else if (char === ")" || char === "]" || char === "}") depth -= 1;
		}
		if (depth <= 0) break;
	}
	const joined = parts
		.join(" ")
		.replace(/\s+/g, " ")
		.replace(/\(\s+/g, "(")
		.replace(/,\s*\)/g, ")")
		.replace(/\s+\)/g, ")");
	return joined.length > 400 ? `${joined.slice(0, 397)}...` : joined;
}

/**
 * First line of the docstring that opens at (or a few lines after) `start`.
 *
 * `start` is the `def` line, which may itself carry no docstring (a multi-line signature puts it after
 * the closing parenthesis), so the search walks forward for the first `"""`. A new `def`/`@` before any
 * docstring means the function has none.
 */
function firstDocLine(lines: string[], start: number): string {
	const limit = Math.min(lines.length, start + 14);
	let at = -1;
	for (let index = start; index < limit; index++) {
		const line = lines[index] ?? "";
		if (line.includes('"""')) {
			at = index;
			break;
		}
		if (index > start && /^\s*(def|class|@)/.test(line)) break;
	}
	if (at < 0) return "";
	const line = lines[at] ?? "";
	const triple = line.indexOf('"""');
	const rest = line.slice(triple + 3).trim();
	if (rest && rest !== '"""') return rest.replace(/"""$/, "").trim();
	for (let index = at + 1; index < Math.min(lines.length, at + 6); index++) {
		const body = (lines[index] ?? "").trim();
		if (body && body !== '"""') return body.replace(/"""$/, "").trim();
	}
	return "";
}

/**
 * Parse one toolset module's source.
 *
 * Line-oriented on purpose: Python indentation is the only structure needed here (a tool method is a
 * `def` after `@toolset_registry.tool_call` inside a `ToolsetDefinition` class), and a line scan never
 * fails on constructs a real parser would have to model.
 */
export function parseToolsetModule(source: string, input: { module: string; plugin: string; file: string }): PyToolset[] {
	const lines = source.split(/\r?\n/);
	const toolsets: PyToolset[] = [];
	let current: PyToolset | undefined;
	let currentClassIndent = -1;
	let pendingToolCall = false;

	for (let index = 0; index < lines.length; index++) {
		const raw = lines[index] ?? "";
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const indent = raw.length - raw.trimStart().length;

		if (indent === 0) {
			const classMatch = TOOLSET_BASE.exec(trimmed);
			currentClassIndent = indent;
			if (classMatch?.[1]) {
				const className = classMatch[1];
				current = {
					name: `${input.module}.${className}`,
					module: input.module,
					className,
					plugin: input.plugin,
					file: input.file,
					line: index + 1,
					doc: firstDocLine(lines, index + 1),
					tools: [],
				};
				toolsets.push(current);
			} else {
				// Any other top-level class ends the toolset scope: its methods are not tools.
				current = undefined;
			}
			pendingToolCall = false;
			continue;
		}

		if (current && indent > currentClassIndent) {
			if (trimmed.startsWith(TOOL_CALL)) {
				pendingToolCall = true;
				continue;
			}
			if (pendingToolCall) {
				const defMatch = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(trimmed);
				if (defMatch?.[1]) {
					current.tools.push({
						name: defMatch[1],
						line: index + 1,
						signature: joinSignature(lines, index),
						summary: firstDocLine(lines, index + 1),
					});
					pendingToolCall = false;
				} else if (!trimmed.startsWith("@") && !trimmed.startsWith("#")) {
					// A decorator belongs to the tool (`@staticmethod`); anything else means the decorator
					// did not introduce a function and must not swallow the next one.
					pendingToolCall = trimmed.startsWith("@") ? pendingToolCall : false;
				}
			}
		}
	}
	return toolsets;
}

function moduleNameFor(relativePath: string): string {
	const withoutExtension = relativePath.replace(/\.py$/i, "").replace(/\\/g, "/");
	const parts = withoutExtension.split("/").filter(Boolean);
	if (parts[parts.length - 1] === "__init__") parts.pop();
	return parts.join(".");
}

/* ──────────────────────────────────────────────────────────────────────────────────── the scan */

async function pythonRoots(dir: string): Promise<string[]> {
	const { default: fastGlob } = await import("fast-glob");
	try {
		const found = await fastGlob(["**/Content/Python"], {
			cwd: dir,
			absolute: true,
			onlyDirectories: true,
			dot: false,
			followSymbolicLinks: false,
			// 6, not 4: the toolset plugins live at `Engine/Plugins/Experimental/Toolsets/<Plugin>/Content/Python`
			// (5 path segments) — depth 4 finds 29 Python roots and misses every toolset, silently.
			deep: 6,
			ignore: ["**/Binaries/**", "**/Intermediate/**", "**/Saved/**", "**/ThirdParty/**"],
		});
		return found.map(normalizePath).sort();
	} catch {
		return [];
	}
}

async function pythonFiles(root: string): Promise<string[]> {
	const { default: fastGlob } = await import("fast-glob");
	try {
		const found = await fastGlob(["**/*.py"], { cwd: root, absolute: true, dot: false, followSymbolicLinks: false, ignore: ["**/__pycache__/**"] });
		return found.map(normalizePath);
	} catch {
		return [];
	}
}

/** Plugin folder name = the ancestor directory holding a `.uplugin`; falls back to the path component above `Content`. */
function pluginFor(file: string, root: string): string {
	let dir = root;
	for (let depth = 0; depth < 4; depth++) {
		const parent = dir.slice(0, Math.max(dir.lastIndexOf("/"), 0));
		if (!parent || parent === dir) break;
		dir = parent;
		const name = dir.slice(dir.lastIndexOf("/") + 1);
		if (existsSync(joinPath(dir, `${name}.uplugin`))) return name;
	}
	const at = root.lastIndexOf("/Content/Python");
	const before = at > 0 ? root.slice(0, at) : root;
	return before.slice(before.lastIndexOf("/") + 1) || "?";
}

/**
 * Walk every `<root>/Content/Python` under the engine plugins and project plugins and index the
 * toolset classes and their tool methods. Never throws: a missing engine or an unreadable file becomes
 * a warning, because this index is enrichment, not the answer.
 */
export async function buildPyIndex(options: BuildPyIndexOptions): Promise<PyIndex> {
	const started = Date.now();
	const now = options.now ?? (() => Date.now());
	const warnings: string[] = [];
	const searchDirs = [
		options.engineRoot ? joinPath(normalizePath(options.engineRoot), "Engine/Plugins") : undefined,
		options.projectDir ? joinPath(normalizePath(options.projectDir), "Plugins") : undefined,
	].filter((dir): dir is string => Boolean(dir));

	const roots: string[] = [];
	for (const dir of searchDirs) {
		if (!realFs.isDirectory(dir)) {
			warnings.push(`not a directory, skipped: ${dir}`);
			continue;
		}
		roots.push(...(await pythonRoots(dir)));
	}
	roots.push(...(options.extraRoots ?? []).map(normalizePath));
	const uniqueRoots = [...new Set(roots)];

	const toolsets: PyToolset[] = [];
	let files = 0;
	for (const root of uniqueRoots) {
		const plugin = pluginFor(root, root);
		for (const file of await pythonFiles(root)) {
			files += 1;
			let source: string;
			try {
				source = readFileSync(file, "utf8");
			} catch (error) {
				warnings.push(`${file}: ${(error as Error).message}`);
				continue;
			}
			if (!source.includes("ToolsetDefinition")) continue;
			// The ToolsetRegistry plugin ships its own test toolsets next to the real ones; they are never mounted.
			if (/\/tests?\//i.test(file)) continue;
			const relative = file.slice(root.length + 1);
			const module = moduleNameFor(relative);
			if (!module) continue;
			toolsets.push(...parseToolsetModule(source, { module, plugin, file }));
		}
	}

	toolsets.sort((a, b) => a.name.localeCompare(b.name));
	if (!uniqueRoots.length) warnings.push("no <Plugin>/Content/Python directory found — the toolset plugins may not be installed");
	return {
		schema: PY_INDEX_SCHEMA,
		key: pyIndexKey({ engineRoot: options.engineRoot, projectDir: options.projectDir }),
		engineRoot: options.engineRoot ? normalizePath(options.engineRoot) : undefined,
		projectDir: options.projectDir ? normalizePath(options.projectDir) : undefined,
		scannedAtMs: now(),
		elapsedMs: Date.now() - started,
		roots: uniqueRoots,
		files,
		toolsets,
		warnings,
	};
}

/* ──────────────────────────────────────────────────────────────────────── reconciliation + text */

export interface PyParity {
	/** Toolset classes on disk that the running editor does not mount (plugin not enabled in this project, or not loaded). */
	onDiskOnly: PyToolset[];
	/** Toolsets the editor mounts that have no Python class (registered from C++, or from another plugin's source). */
	mountedOnly: string[];
	/** Toolset names present in both, with how many of their tools the live schema knows. */
	matched: { toolset: PyToolset; liveTools: string[]; missingTools: string[] }[];
}

export function reconcileWithLive(index: PyIndex, mounted: { name: string; tools?: string[] }[]): PyParity {
	const byName = new Map(mounted.map((entry) => [entry.name.toLowerCase(), entry]));
	const parity: PyParity = { onDiskOnly: [], mountedOnly: [], matched: [] };
	const seen = new Set<string>();
	for (const toolset of index.toolsets) {
		const live = byName.get(toolset.name.toLowerCase());
		if (!live) {
			parity.onDiskOnly.push(toolset);
			continue;
		}
		seen.add(live.name.toLowerCase());
		// A mounted-toolset name without a tool list (discovery via `list_toolsets` only) must not be read
		// as "none of its tools exist": drift is only claimed when the live tool list is actually known.
		const liveTools = live.tools?.map((name) => name.toLowerCase());
		const missingTools = liveTools ? toolset.tools.filter((tool) => !liveTools.includes(tool.name.toLowerCase())).map((tool) => tool.name) : [];
		parity.matched.push({ toolset, liveTools: live.tools ?? [], missingTools });
	}
	parity.mountedOnly = mounted.filter((entry) => !seen.has(entry.name.toLowerCase())).map((entry) => entry.name);
	return parity;
}

export function pyIndexSummary(index: PyIndex): string {
	const tools = index.toolsets.reduce((total, toolset) => total + toolset.tools.length, 0);
	const plugins = new Set(index.toolsets.map((toolset) => toolset.plugin)).size;
	return `${index.toolsets.length} toolset class(es), ${tools} tool(s) across ${plugins} plugin(s), ${index.files} file(s) scanned in ${index.elapsedMs} ms`;
}

/** One toolset: its tools as `file:line` rows, ready to read with the Read tool. */
export function pyToolsetText(toolset: PyToolset): string {
	const lines = [`${toolset.name}  (${toolset.plugin})  ${toolset.file}:${toolset.line}`, ...(toolset.doc ? [`  ${toolset.doc}`] : [])];
	lines.push(`  ${toolset.tools.length} tool(s):`);
	for (const tool of toolset.tools) {
		lines.push(`    ${tool.name.padEnd(28)} ${tool.signature}`);
		lines.push(`    ${" ".repeat(28)} line ${tool.line}`);
	}
	return lines.join("\n");
}

export function findPyToolset(index: PyIndex, name: string): PyToolset | undefined {
	const wanted = name.trim().toLowerCase();
	const short = wanted.includes(".") ? wanted.slice(wanted.lastIndexOf(".") + 1) : wanted;
	return (
		index.toolsets.find((toolset) => toolset.name.toLowerCase() === wanted) ??
		index.toolsets.find((toolset) => toolset.className.toLowerCase() === short) ??
		index.toolsets.find((toolset) => toolset.className.toLowerCase().replace(/tools$/, "") === short.replace(/tools$/, ""))
	);
}

export function findPyTool(index: PyIndex, name: string): { toolset: PyToolset; tool: PyTool }[] {
	const wanted = name.trim().toLowerCase();
	const bare = wanted.includes(".") ? wanted.slice(wanted.lastIndexOf(".") + 1) : wanted;
	const hits: { toolset: PyToolset; tool: PyTool }[] = [];
	for (const toolset of index.toolsets) {
		for (const tool of toolset.tools) if (tool.name.toLowerCase() === bare) hits.push({ toolset, tool });
	}
	return hits;
}

/** Age after which the index is rebuilt on the next `python` lookup (a day: engine content is static). */
export const PY_INDEX_STALE_MS = PY_INDEX_TTL_MS;

export interface PyIndexResolution {
	index?: PyIndex;
	/** `live` = rebuilt now, `cache` = read from disk, `none` = nothing found and nothing built. */
	source: "built" | "cache" | "none";
	engineRoot?: string;
	projectDir?: string;
	notes: string[];
}

/**
 * Load the locator index, building it when it is missing or stale.
 *
 * Explicit-request only: the caller decides to spend the ~1.6 s walk (measured on UE 5.8: 49 Python
 * roots, 662 files), so no ordinary lookup ever pays it.
 */
export async function resolvePyIndex(options: { cwd: string; refresh?: boolean; now?: () => number }): Promise<PyIndexResolution> {
	const notes: string[] = [];
	const projectPath = findProjectFile(options.cwd, realFs, 4);
	let projectDir: string | undefined;
	let engineRoot: string | undefined;
	if (!projectPath) {
		notes.push("no *.uproject found within 4 levels of the working directory — indexing project plugins only");
	} else {
		projectDir = normalizePath(projectPath.slice(0, projectPath.lastIndexOf("/")));
		try {
			parseUproject(projectPath, realFs);
		} catch {
			/* the engine resolution below reports what it could not read */
		}
		const resolution = await resolveEngineForProject(projectPath, { fs: realFs });
		if (resolution.status === "resolved" && resolution.engineRoot) engineRoot = resolution.engineRoot;
		else notes.push(`engine ${resolution.status}: ${resolution.diagnostics[0] ?? "see unreal_resolve_engine"} — engine toolsets are not indexed`);
	}
	const key = pyIndexKey({ engineRoot, projectDir });
	if (!options.refresh) {
		const cached = loadPyIndex(key);
		if (cached && pyIndexAgeMs(cached, options.now?.() ?? Date.now()) < PY_INDEX_STALE_MS) {
			return { index: cached, source: "cache", engineRoot, projectDir, notes };
		}
	}
	if (!engineRoot && !projectDir) return { source: "none", notes };
	const index = await buildPyIndex({ engineRoot, projectDir, now: options.now });
	savePyIndex(index);
	notes.push(...index.warnings);
	return { index, source: "built", engineRoot, projectDir, notes };
}
