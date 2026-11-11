/**
 * Read-only client for Epic's official Unreal MCP server (the `ModelContextProtocol` plugin that
 * starts with the editor, `http://127.0.0.1:8000/mcp` by default).
 *
 * Deliberately narrow: the handshake, `list_toolsets`, and `describe_toolset`. `call_tool` is not
 * implemented — this module answers "what is the exact tool name and argument shape", it never
 * mutates the editor. Every call is time-boxed and every failure is an answer ("editor not
 * reachable"), not a retry loop: the tool that consumes this turns a dead endpoint into
 * instructions for a human, not into a guess.
 *
 * Transport is MCP streamable HTTP (JSON-RPC 2.0 over POST, JSON or SSE in the response body).
 * `mcp-session-id` is captured from the `initialize` response and replayed on later requests.
 */

export interface McpLiveResult<T> {
	ok: boolean;
	value?: T;
	/** Human-readable failure, already phrased as a fact about the endpoint. */
	error?: string;
	/** Wall time of the request, for cost reporting. */
	elapsedMs: number;
}

export interface McpToolsetListEntry {
	name: string;
	short: string;
	description: string;
}

/** Raw `describe_toolset` payload is engine-shaped; the catalog normalizes it. */
export interface McpRawTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
}

export interface McpRawToolset {
	name: string;
	/** Some engine versions nest the list; the normalizer accepts either shape. */
	tools?: McpRawTool[];
	[key: string]: unknown;
}

export const DEFAULT_MCP_URL = "http://127.0.0.1:8000/mcp";

export function mcpUrl(override?: string): string {
	const url = (override ?? process.env.PI_UNREAL_MCP_URL ?? DEFAULT_MCP_URL).trim();
	return url || DEFAULT_MCP_URL;
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "pi-unreal", version: "0" };

/** Short name of a fully qualified toolset (`editor_toolset.toolsets.blueprint.BlueprintTools` → `BlueprintTools`). */
export function shortToolsetName(name: string): string {
	const idx = name.lastIndexOf(".");
	return idx < 0 ? name : name.slice(idx + 1);
}

/** TCP probe — cheaper than a JSON-RPC handshake when all we need is "is anything listening". */
export async function probeMcpEndpoint(url: string, timeoutMs = 1500): Promise<boolean> {
	let host = "127.0.0.1";
	let port = 80;
	try {
		const parsed = new URL(url);
		host = parsed.hostname || host;
		port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
	} catch {
		return false;
	}
	const net = await import("node:net");
	return new Promise<boolean>((resolve) => {
		const socket = net.connect({ host, port });
		const done = (ok: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

interface RpcResponse {
	status: number;
	sessionId?: string;
	body?: { result?: unknown; error?: { code?: number; message?: string } };
	text?: string;
}

async function parseRpcResponse(response: Response): Promise<{ body?: RpcResponse["body"]; text?: string }> {
	const text = await response.text();
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/event-stream")) {
		try {
			return { body: JSON.parse(text) };
		} catch {
			return { text };
		}
	}
	// SSE: the JSON-RPC reply is the payload of the last `data:` frame.
	const frames = text
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter(Boolean);
	for (let i = frames.length - 1; i >= 0; i -= 1) {
		const frame = frames[i];
		if (!frame) continue;
		try {
			return { body: JSON.parse(frame) };
		} catch {
			/* keep looking at earlier frames */
		}
	}
	return { text };
}

class McpSession {
	private sessionId?: string;
	private nextId = 1;

	constructor(
		private readonly url: string,
		private readonly timeoutMs: number,
	) {}

	private async post(payload: Record<string, unknown>, signalTimeoutMs = this.timeoutMs): Promise<Response> {
		return fetch(this.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(signalTimeoutMs),
		});
	}

	async initialize(): Promise<void> {
		const response = await this.post({
			jsonrpc: "2.0",
			id: this.nextId++,
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
		});
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.sessionId = sessionId;
		if (!response.ok) {
			throw new Error(`initialize failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
		}
		// Drain the body so the connection can be reused; the payload itself is not needed.
		await parseRpcResponse(response);
		const note = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
		await note.text().catch(() => "");
	}

	async toolsCall(name: string, args: Record<string, unknown>): Promise<string> {
		const response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
		const parsed = await parseRpcResponse(response);
		if (!response.ok) throw new Error(`tools/call ${name} failed: HTTP ${response.status}`);
		const body = parsed.body as
			| { result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } }
			| undefined;
		if (body?.error) throw new Error(`tools/call ${name}: ${body.error.message ?? "unknown JSON-RPC error"}`);
		const result = body?.result;
		if (!result?.content?.length) throw new Error(`tools/call ${name}: empty result`);
		const text = result.content.map((part) => part.text ?? "").join("\n");
		if (result.isError) throw new Error(`tools/call ${name}: ${text.slice(0, 300)}`);
		return text;
	}
}

async function withSession<T>(url: string, timeoutMs: number, run: (session: McpSession) => Promise<T>): Promise<McpLiveResult<T>> {
	const started = Date.now();
	try {
		const session = new McpSession(url, timeoutMs);
		await session.initialize();
		const value = await run(session);
		return { ok: true, value, elapsedMs: Date.now() - started };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const timedOut = /timeout|aborted|abort/i.test(detail);
		return {
			ok: false,
			error: timedOut
				? `no answer from ${url} within ${timeoutMs} ms (editor MCP may still be starting)`
				: `${url}: ${detail.slice(0, 300)}`,
			elapsedMs: Date.now() - started,
		};
	}
}

/**
 * `list_toolsets` → parsed `- Name: description` entries.
 *
 * The payload is markdown written by the toolset registry, and toolset descriptions contain their own
 * bullet lists (`- Enum value lookups`) and wrapped prose. Only a `- Name: text` line is an entry:
 * the colon is mandatory and the name must be dotted (`editor_toolset.toolsets.blueprint.BlueprintTools`),
 * which every mounted toolset on a stock 5.8 install satisfies (52/52 measured). Without both rules the
 * Niagara/Automation descriptions invent toolsets called `Enum`, `General`, `Runtime`.
 */
export function parseToolsetList(text: string): McpToolsetListEntry[] {
	const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
	const dotted = lines.some((line) => /^[-*]\s+[A-Za-z_]\w*\.[\w.]+\s*:/.test(line.trimStart()));
	const entryPattern = dotted
		? /^[-*]\s+([A-Za-z_]\w*\.[\w.]+)\s*:\s*(.*)$/
		: /^[-*]\s+([A-Za-z_][\w.]*)\s*:\s*(.*)$/;
	const entries: McpToolsetListEntry[] = [];
	let current: McpToolsetListEntry | undefined;
	for (const line of lines) {
		const trimmed = line.trimStart();
		const start = entryPattern.exec(trimmed);
		const name = start?.[1];
		if (start && name) {
			current = { name, short: shortToolsetName(name), description: (start[2] ?? "").trim() };
			entries.push(current);
			continue;
		}
		// Everything else belongs to the previous toolset: indented prose, bare wrapped lines, and the
		// description's own `- bullet` items (which never carry a dotted name and a colon).
		if (current && line.trim()) current.description = `${current.description} ${line.trim()}`.trim();
	}
	return entries;
}

export async function listToolsetsLive(url: string, timeoutMs = 8000): Promise<McpLiveResult<{ entries: McpToolsetListEntry[]; text: string }>> {
	return withSession(url, timeoutMs, async (session) => {
		const text = await session.toolsCall("list_toolsets", {});
		return { entries: parseToolsetList(text), text };
	});
}

export async function describeToolsetLive(url: string, toolsetName: string, timeoutMs = 20000): Promise<McpLiveResult<McpRawToolset>> {
	return withSession(url, timeoutMs, async (session) => {
		const text = await session.toolsCall("describe_toolset", { toolset_name: toolsetName });
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`describe_toolset returned non-JSON (${text.length} bytes)`);
		}
		const raw = parsed as McpRawToolset;
		return { ...raw, name: typeof raw.name === "string" && raw.name ? raw.name : toolsetName };
	});
}

/**
 * Describe several toolsets over ONE session. Per-toolset failures are collected instead of
 * aborting: a mounted plugin set on this project may legitimately lack one of them.
 */
export async function describeToolsetsLive(
	url: string,
	toolsetNames: string[],
	timeoutMs = 30000,
): Promise<{ described: McpRawToolset[]; failures: { name: string; error: string }[]; elapsedMs: number }> {
	const started = Date.now();
	const described: McpRawToolset[] = [];
	const failures: { name: string; error: string }[] = [];
	const sessionResult = await withSession(url, timeoutMs, async (session) => {
		for (const name of toolsetNames) {
			try {
				const text = await session.toolsCall("describe_toolset", { toolset_name: name });
				const raw = JSON.parse(text) as McpRawToolset;
				described.push({ ...raw, name: typeof raw.name === "string" && raw.name ? raw.name : name });
			} catch (error) {
				failures.push({ name, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return true;
	});
	if (!sessionResult.ok) failures.push({ name: "*", error: sessionResult.error ?? "session failed" });
	return { described, failures, elapsedMs: Date.now() - started };
}
