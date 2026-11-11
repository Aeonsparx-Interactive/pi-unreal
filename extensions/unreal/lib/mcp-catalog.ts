/**
 * Local catalog of the tools a running editor exposes through Epic's Unreal MCP.
 *
 * The problem this solves: `describe_toolset` for `BlueprintTools` is ~72 KB on one line, which
 * exceeds the MCP adapter's text guard and gets truncated — so an agent cannot read the schema it
 * needs and starts inventing tool names and argument shapes. Here the same payload is normalized
 * once into rows (tool, args, defaults, doc summary), persisted under
 * `~/.pi/agent/unreal-cache/mcp/<key>/`, and answered in fragments of a few hundred bytes.
 *
 * Authority model: live editor first (ground truth for THIS engine build and THIS project's
 * mounted plugins), the on-disk snapshot second, and an explicit refusal when neither exists.
 * Nothing here guesses a tool name; a miss is an error naming what was searched.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cacheDir } from "./cache.ts";
import { findProjectFile } from "./engine-resolver.ts";
import { parseUproject } from "./descriptors.ts";
import { joinPath, normalizePath, realFs, shortHash, truncateLines } from "./util.ts";
import {
	describeToolsetsLive,
	listToolsetsLive,
	mcpUrl,
	probeMcpEndpoint,
	shortToolsetName,
	type McpRawTool,
	type McpRawToolset,
} from "./mcp-live.ts";

export const SNAPSHOT_SCHEMA = 1;
/** Snapshot older than this is refreshed while the editor is reachable (and flagged when not). */
export const SNAPSHOT_TTL_MS = 15 * 60 * 1000;

/** Step-1 scope. Everything else is discoverable via the editor but not indexed yet. */
export const V1_TOOLSETS = [
	"editor_toolset.toolsets.asset.AssetTools",
	"editor_toolset.toolsets.actor.ActorTools",
	"editor_toolset.toolsets.blueprint.BlueprintTools",
	"editor_toolset.toolsets.object.ObjectTools",
];

export interface McpArg {
	name: string;
	/** JSON-schema type, or `object ref` for the engine's `{ refPath }` handle type. */
	type: string;
	required: boolean;
	defaultValue?: string;
	/** The engine's UObject handle type name (`/Script/Engine.Actor`), when the arg is a reference. */
	refType?: string;
	description?: string;
}

export interface McpToolEntry {
	toolset: string;
	toolsetShort: string;
	name: string;
	/** Tool name without the toolset prefix — what `call_tool` takes. */
	short: string;
	/** Whitespace-collapsed docstring (first sentence trimmed to a line). */
	summary: string;
	description: string;
	args: McpArg[];
	returns?: string;
}

export interface ToolsetCatalog {
	name: string;
	short: string;
	capturedAtMs: number;
	tools: McpToolEntry[];
}

export interface CatalogSnapshot {
	schema: number;
	key: string;
	url: string;
	projectDir?: string;
	engineAssociation?: string;
	capturedAtMs: number;
	toolsets: Record<string, ToolsetCatalog>;
}

/* ──────────────────────────────────────────────────────────────────────────── normalization */

function collapse(text: string | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

function firstSentence(text: string, max = 160): string {
	const stop = /^(.*?[.!?])(\s|$)/.exec(text);
	const candidate = stop?.[1] ?? text;
	return candidate.length > max ? `${candidate.slice(0, max - 1)}…` : candidate;
}

function normalizeReturns(outputSchema: unknown): string | undefined {
	const schema = outputSchema as { properties?: Record<string, { type?: string }> } | undefined;
	const value = schema?.properties?.returnValue;
	if (!value) return undefined;
	return value.type ?? "any";
}

function normalizeArg(name: string, prop: Record<string, unknown>, required: string[]): McpArg {
	const title = typeof prop.title === "string" ? prop.title : undefined;
	// The engine represents UObject arguments as `{ refPath }` objects carrying the class in `title`.
	const isRef = Boolean(title) || (prop.type === "object" && Boolean((prop.properties as Record<string, unknown> | undefined)?.refPath));
	const arg: McpArg = {
		name,
		type: isRef ? "object ref" : typeof prop.type === "string" ? prop.type : "any",
		required: required.includes(name),
	};
	if (isRef) arg.refType = title ?? "UObject";
	if (prop.default !== undefined && prop.default !== null) arg.defaultValue = JSON.stringify(prop.default);
	if (typeof prop.description === "string" && !isRef) arg.description = collapse(prop.description);
	return arg;
}

/**
 * Engine class path → the name the same type has in the Unreal Python API.
 *
 * Everything reflected is exposed as `unreal.<ClassName>` regardless of its package, so
 * `/Script/Engine.Blueprint` is `unreal.Blueprint` and `/Script/CoreUObject.Class` is `unreal.Class`.
 * This is the mapping an agent actually needs: the toolset argument is a `refPath` string, but the
 * question in its head ("which unreal.* type is this") is answered by this name.
 */
export function pythonTypeFor(refType: string | undefined): string | undefined {
	if (!refType) return undefined;
	const dot = refType.lastIndexOf(".");
	const className = dot >= 0 ? refType.slice(dot + 1) : refType;
	if (!/^[AUFTIS]?\w+$/.test(className)) return className ? `unreal.${className}` : undefined;
	return `unreal.${className}`;
}

export function normalizeToolset(raw: McpRawToolset, capturedAtMs = Date.now()): ToolsetCatalog {
	const toolset = raw.name;
	const short = shortToolsetName(toolset);
	const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
	const tools: McpToolEntry[] = rawTools.map((tool: McpRawTool) => {
		const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
		const required = schema.required ?? [];
		const args = Object.entries(schema.properties ?? {}).map(([name, prop]) => normalizeArg(name, prop, required));
		const description = collapse(tool.description);
		const shortName = tool.name.includes(".") ? tool.name.slice(tool.name.lastIndexOf(".") + 1) : tool.name;
		return {
			toolset,
			toolsetShort: short,
			name: tool.name,
			short: shortName,
			summary: firstSentence(description),
			description,
			args,
			returns: normalizeReturns(tool.outputSchema),
		};
	});
	return { name: toolset, short, capturedAtMs, tools };
}

/* ──────────────────────────────────────────────────────────────────────────── persistence */

export function catalogRoot(): string {
	return joinPath(cacheDir(), "mcp");
}

export function catalogKey(input: { url: string; projectDir?: string; engineAssociation?: string }): string {
	return shortHash([normalizePath(input.url), input.projectDir ?? "-", input.engineAssociation ?? "-"].join("|"));
}

export function snapshotPath(key: string): string {
	return joinPath(catalogRoot(), key, "snapshot.json");
}

export function rawToolsetPath(key: string, toolset: string): string {
	return joinPath(catalogRoot(), key, "raw", `${shortToolsetName(toolset)}.json`);
}

export function loadSnapshot(key: string): CatalogSnapshot | undefined {
	let text: string;
	try {
		text = readFileSync(snapshotPath(key), "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as CatalogSnapshot;
		return parsed.schema === SNAPSHOT_SCHEMA && parsed.key === key ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function saveSnapshot(snapshot: CatalogSnapshot): void {
	const path = snapshotPath(snapshot.key);
	mkdirSync(joinPath(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(snapshot, null, 1)}\n`, "utf8");
}

function saveRaw(key: string, raw: McpRawToolset): void {
	const path = rawToolsetPath(key, raw.name);
	mkdirSync(joinPath(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 1)}\n`, "utf8");
}

/* ──────────────────────────────────────────────────────────────────────────── orchestration */

export interface CatalogContext {
	key: string;
	url: string;
	projectDir?: string;
	engineAssociation?: string;
}

export function catalogContextFor(cwd: string, urlOverride?: string): CatalogContext {
	const url = mcpUrl(urlOverride);
	let projectDir: string | undefined;
	let engineAssociation: string | undefined;
	try {
		const project = findProjectFile(cwd, realFs, 4);
		if (project) {
			const descriptor = parseUproject(project, realFs);
			projectDir = descriptor.path.slice(0, descriptor.path.lastIndexOf("/"));
			engineAssociation = descriptor.engineAssociation;
		}
	} catch {
		/* an unresolvable project still gets a catalog — keyed on the endpoint alone */
	}
	return { key: catalogKey({ url, projectDir, engineAssociation }), url, projectDir, engineAssociation };
}

export interface EnsureCatalogOptions {
	cwd: string;
	url?: string;
	refresh?: boolean;
	/** Toolsets the caller needs in addition to `V1_TOOLSETS`. */
	extraToolsets?: string[];
	/** Describe every toolset the editor mounts (the discovery path), not just the indexed ones. */
	discoverAll?: boolean;
	probe?: boolean;
}

export interface EnsureCatalogResult {
	ctx: CatalogContext;
	snapshot?: CatalogSnapshot;
	source: "live" | "snapshot" | "none";
	reachable: boolean;
	refreshed: boolean;
	ageMs?: number;
	failures: { name: string; error: string }[];
	notes: string[];
}

/**
 * Live-first catalog resolution.
 *
 * - editor reachable and (no snapshot | stale | `refresh` | a wanted toolset is missing) → describe
 *   live, persist, answer from the fresh snapshot;
 * - editor reachable and snapshot fresh → answer from the snapshot (no 70 KB re-transfer);
 * - editor unreachable → answer from the snapshot and say how old it is;
 * - neither → `source: "none"`, and the tool turns that into instructions.
 */
export async function ensureCatalog(options: EnsureCatalogOptions): Promise<EnsureCatalogResult> {
	const ctx = catalogContextFor(options.cwd, options.url);
	const failures: { name: string; error: string }[] = [];
	const notes: string[] = [];
	let fetchNames: string[] | undefined;
	const cached = loadSnapshot(ctx.key);
	const wanted = [...new Set([...V1_TOOLSETS, ...(options.extraToolsets ?? [])])];

	if (options.probe === false) {
		return { ctx, snapshot: cached, source: cached ? "snapshot" : "none", reachable: false, refreshed: false, ageMs: cached ? Date.now() - cached.capturedAtMs : undefined, failures, notes: ["editor probe skipped"] };
	}

	const reachable = await probeMcpEndpoint(ctx.url);
	if (!reachable) {
		if (cached) {
			return {
				ctx,
				snapshot: cached,
				source: "snapshot",
				reachable: false,
				refreshed: false,
				ageMs: Date.now() - cached.capturedAtMs,
				failures,
				notes: [`editor MCP not reachable at ${ctx.url} — answering from the snapshot (${ageLabel(Date.now() - cached.capturedAtMs)} old)`],
			};
		}
		return { ctx, source: "none", reachable: false, refreshed: false, failures, notes: [`editor MCP not reachable at ${ctx.url} and no snapshot exists`] };
	}

	const missing = wanted.filter((name) => !cached?.toolsets[shortToolsetName(name)]);
	const stale = !cached || Date.now() - cached.capturedAtMs > SNAPSHOT_TTL_MS;
	const fullRefresh = options.refresh === true || options.discoverAll === true || !cached;
	if (cached && !fullRefresh && !stale && missing.length === 0) {
		return { ctx, snapshot: cached, source: "snapshot", reachable: true, refreshed: false, ageMs: Date.now() - cached.capturedAtMs, failures, notes };
	}

	// Discovery asks the editor what it mounts instead of trusting a fixed list: `list_toolsets` costs
	// one call and its names are the exact strings `describe_toolset` accepts.
	if (options.discoverAll) {
		const listed = await listToolsetsLive(ctx.url);
		const names = listed.value?.entries.map((entry) => entry.name) ?? [];
		if (listed.ok && names.length) {
			notes.push(`${names.length} toolset(s) mounted by this editor`);
			fetchNames = [...new Set([...names, ...wanted])];
		} else {
			failures.push({ name: "list_toolsets", error: listed.ok ? "no toolset entries parsed from the payload" : (listed.error ?? "unknown error") });
			notes.push("list_toolsets gave no usable names — falling back to the indexed toolset names");
		}
	}

	// A full refresh re-describes every KNOWN toolset and prunes the rest, so a renamed or removed tool
	// disappears instead of lingering. Known means "wanted now" plus "already in the snapshot": pruning
	// only the four indexed toolsets would delete a discovered catalog on the next refresh.
	if (!fetchNames) {
		const known = [...new Set([...wanted, ...Object.values(cached?.toolsets ?? {}).map((toolset) => toolset.name)])];
		fetchNames = fullRefresh || missing.length === 0 ? known : missing;
	}

	const live = await describeToolsetsLive(ctx.url, fetchNames, options.discoverAll ? 120000 : 30000);
	failures.push(...live.failures);
	if (!live.described.length) {
		// Name the toolsets that failed rather than the internal fetch strategy: a targeted fetch of one
		// unknown toolset is not "the editor refused everything".
		const what = fetchNames.length === 1 ? `describe_toolset('${fetchNames[0]}')` : `every describe_toolset call (${fetchNames.length} requested)`;
		const notes = [`editor is listening but ${what} failed`];
		if (cached) {
			return {
				ctx,
				snapshot: cached,
				source: "snapshot",
				reachable: true,
				refreshed: false,
				ageMs: Date.now() - cached.capturedAtMs,
				failures,
				notes: [...notes, "answering from the snapshot"],
			};
		}
		return { ctx, source: "none", reachable: true, refreshed: false, failures, notes };
	}

	const now = Date.now();
	const toolsets: Record<string, ToolsetCatalog> = { ...(cached?.toolsets ?? {}) };
	if (options.refresh === true || options.discoverAll === true || !cached) {
		// Wholesale replace on a full refresh: a toolset that vanished must not survive in the cache.
		for (const key of Object.keys(toolsets)) if (!live.described.some((raw) => shortToolsetName(raw.name) === key)) delete toolsets[key];
	}
	for (const raw of live.described) {
		saveRaw(ctx.key, raw);
		const normalized = normalizeToolset(raw, now);
		toolsets[normalized.short] = normalized;
	}
	// A targeted fetch must not make the whole catalog look younger: the snapshot's age is the age of
	// its OLDEST toolset, so a partial refresh never hides stale rows behind a fresh timestamp.
	const oldest = Math.min(...Object.values(toolsets).map((toolset) => toolset.capturedAtMs));
	const snapshot: CatalogSnapshot = {
		schema: SNAPSHOT_SCHEMA,
		key: ctx.key,
		url: ctx.url,
		projectDir: ctx.projectDir,
		engineAssociation: ctx.engineAssociation,
		capturedAtMs: oldest,
		toolsets,
	};
	saveSnapshot(snapshot);
	return { ctx, snapshot, source: "live", reachable: true, refreshed: true, ageMs: 0, failures, notes };
}

export function ageLabel(ms: number): string {
	if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 3_600_000)}h`;
}

/* ──────────────────────────────────────────────────────────────────────────── answers */

export function allTools(snapshot: CatalogSnapshot): McpToolEntry[] {
	return Object.values(snapshot.toolsets).flatMap((toolset) => toolset.tools);
}

export function pickToolset(snapshot: CatalogSnapshot, wanted: string): ToolsetCatalog | undefined {
	const lower = wanted.trim().toLowerCase();
	return Object.values(snapshot.toolsets).find((toolset) => toolset.short.toLowerCase() === lower || toolset.name.toLowerCase() === lower);
}

export interface ToolMatch {
	tool: McpToolEntry;
	score: number;
}

export function searchTools(snapshot: CatalogSnapshot, query: string, limit = 12): ToolMatch[] {
	const tokens = query
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter(Boolean);
	if (!tokens.length) return [];
	const matches: ToolMatch[] = [];
	for (const tool of allTools(snapshot)) {
		const name = tool.short.toLowerCase();
		const toolset = tool.toolsetShort.toLowerCase();
		const haystack = `${tool.description.toLowerCase()} ${tool.args.map((arg) => arg.name.toLowerCase()).join(" ")}`;
		let score = 0;
		for (const token of tokens) {
			if (name === token) score += 100;
			else if (name.startsWith(token)) score += 60;
			else if (name.includes(token)) score += 40;
			else if (toolset.includes(token)) score += 20;
			else if (haystack.includes(token)) score += 8;
			else {
				score = 0;
				break;
			}
		}
		if (score > 0) matches.push({ tool, score });
	}
	matches.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
	return matches.slice(0, limit);
}

export function describeToolText(tool: McpToolEntry, options: { full?: boolean; doc?: string } = {}): string {
	const doc = options.full ? tool.description : tool.summary;
	const lines: string[] = [`${tool.toolsetShort}.${tool.short}`, `  ${doc}`];
	if (tool.args.length) {
		lines.push("  args:");
		const width = Math.max(...tool.args.map((arg) => arg.name.length));
		for (const arg of tool.args) {
			const pyType = arg.type === "object ref" ? pythonTypeFor(arg.refType) : undefined;
			const type = arg.type === "object ref" ? `object ref → ${pyType ?? "UObject"}  (${arg.refType})` : arg.type;
			const flags = [arg.required ? "required" : "optional", arg.defaultValue !== undefined ? `default ${arg.defaultValue}` : ""].filter(Boolean).join(", ");
			lines.push(`    ${arg.name.padEnd(width)}  ${type}${flags ? `  (${flags})` : ""}`);
			if (options.full && arg.description) lines.push(`    ${" ".repeat(width)}  ${arg.description}`);
		}
	} else {
		lines.push("  args: none");
	}
	if (tool.returns) lines.push(`  returns: ${tool.returns}`);
	if (options.doc) lines.push("", options.doc);
	return lines.join("\n");
}

/** Exact `call_tool` shape, one line per argument so it can be pasted with edits. */
export function callSkeleton(tool: McpToolEntry, values: Record<string, string> = {}): string {
	const args: Record<string, unknown> = {};
	for (const arg of tool.args) {
		const given = values[arg.name];
		if (given !== undefined) args[arg.name] = given;
		else if (arg.required && arg.type === "object ref") args[arg.name] = { refPath: `<${arg.refType ?? "path"}>` };
		else if (arg.required) args[arg.name] = arg.type === "array" ? ["<value>"] : arg.type === "boolean" ? true : arg.type === "integer" || arg.type === "number" ? 0 : "<value>";
	}
	return JSON.stringify({ toolset_name: tool.toolset, tool_name: tool.short, arguments: args });
}

export function listText(snapshot: CatalogSnapshot): string {
	const lines = Object.values(snapshot.toolsets)
		.sort((a, b) => a.short.localeCompare(b.short))
		.map((toolset) => `${toolset.short.padEnd(18)} ${String(toolset.tools.length).padStart(3)} tools  ${toolset.name}`);
	return lines.join("\n");
}

export function statusText(result: EnsureCatalogResult, snapshot: CatalogSnapshot | undefined): string {
	const lines = [
		`editor: ${result.reachable ? "reachable" : "not reachable"} at ${result.ctx.url}`,
		`catalog: ${snapshot ? `${ageLabel(Date.now() - snapshot.capturedAtMs)} old (${snapshot.toolsets ? Object.keys(snapshot.toolsets).length : 0} toolsets, ${allTools(snapshot).length} tools)` : "none"}`,
		`source: ${result.source}${result.refreshed ? " (refreshed this call)" : ""}`,
		`cache: ${snapshotPath(result.ctx.key)}`,
	];
	if (result.ctx.engineAssociation) lines.push(`engine association: ${result.ctx.engineAssociation}`);
	lines.push(...result.notes.map((note) => `· ${note}`));
	lines.push(...result.failures.map((failure) => `! ${failure.name}: ${failure.error}`));
	return truncateLines(lines.join("\n"), 40).text;
}
