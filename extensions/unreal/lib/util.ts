/**
 * Small filesystem / text helpers shared by every lib module.
 *
 * All FS access goes through `FsAdapter` so the resolver, descriptor parsers, and plugin
 * resolver run against synthetic fixture trees in tests without touching the real disk.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";

/** Filesystem surface used by this extension. Everything is read-only by construction. */
export interface FsAdapter {
	exists(path: string): boolean;
	isDirectory(path: string): boolean;
	readText(path: string): string | undefined;
	listDir(path: string): string[];
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Replace `\\` with `/`, drop `\\?\` and `\\.\` prefixes, collapse repeats, drop trailing `/`. */
export function normalizePath(path: string): string {
	let out = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	out = out.replace(/^\/\/[?.]\//, "/");
	while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
	return out;
}

/** Absolute on this platform (Windows drive letter, UNC, POSIX `/`). */
export function isAbsolutePath(path: string): boolean {
	return /^[a-z]:\//i.test(path) || path.startsWith("//");
}

export function joinPath(base: string, ...parts: string[]): string {
	let out = normalizePath(base);
	for (const part of parts) {
		if (!part) continue;
		if (isAbsolutePath(part)) {
			out = normalizePath(part);
			continue;
		}
		out = normalizePath(`${out}/${part.replace(/^\/+/, "")}`);
	}
	return out;
}

export function parentDir(path: string): string | undefined {
	const normalized = normalizePath(path);
	const idx = normalized.lastIndexOf("/");
	if (idx <= 0) return undefined;
	return normalized.slice(0, idx);
}

export function baseName(path: string): string {
	const normalized = normalizePath(path);
	const idx = normalized.lastIndexOf("/");
	return idx < 0 ? normalized : normalized.slice(idx + 1);
}

export function extName(path: string): string {
	const name = baseName(path);
	const idx = name.lastIndexOf(".");
	return idx <= 0 ? "" : name.slice(idx).toLowerCase();
}

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Default adapter: real filesystem, read-only operations only. */
export const realFs: FsAdapter = {
	exists(path) {
		try {
			return existsSync(path);
		} catch {
			return false;
		}
	},
	isDirectory(path) {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
	readText(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	listDir(path) {
		try {
			return readdirSync(path);
		} catch {
			return [];
		}
	},
};

export function readFileSafe(path: string, fs: FsAdapter = realFs): string | undefined {
	if (!fs.exists(path) || fs.isDirectory(path)) return undefined;
	return fs.readText(path);
}

/**
 * `.uproject` and `.uplugin` files are hand-edited in practice: UTF-8 BOM, trailing commas,
 * and `//` comments all appear in the wild, so strict `JSON.parse` is the wrong tool.
 */
export interface JsonParseResult<T> {
	value?: T;
	/** Human-readable jsonc diagnostics, e.g. `UnexpectedEndOfComment`. */
	errors: string[];
}

/**
 * `jsonc-parser.ParseErrorCode` is a const enum, which `verbatimModuleSyntax` forbids accessing,
 * so the codes are transcribed from jsonc-parser's `syntax-tree.d.ts`.
 */
const PARSE_ERROR_NAMES = new Map<number, string>([
	[0, "None"],
	[1, "Empty"],
	[2, "UnexpectedEndOfComment"],
	[3, "UnexpectedEndOfString"],
	[4, "UnexpectedEndOfNumber"],
	[5, "InvalidUnicode"],
	[6, "InvalidEscapeCharacter"],
	[7, "InvalidCharacter"],
]);

export function parseJsoncLenient<T = JsonValue>(text: string): JsonParseResult<T> {
	const errors: ParseErrorLike[] = [];
	let value: T | undefined;
	/* `jsonc-parser`'s `parse` THROWS on malformed input (verified against real engine `.uplugin`
	   files, which include malformed numbers and unquoted keys). Descriptor parsing must degrade
	   to a diagnostic, never crash an inspection tool. */
	try {
		value = parseJsonc(stripBom(text), errors as never, {
			disallowComments: false,
			allowTrailingComma: true,
		}) as T;
	} catch (error) {
		return {
			value: undefined as T,
			errors: [`parse threw: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	return {
		value: value as T,
		errors: errors.map((code) => PARSE_ERROR_NAMES.get(code) ?? `ParseErrorCode(${code})`),
	};
}

type ParseErrorLike = number;

/** Walk up from `start`, calling `visit(dir)` for each ancestor including `start`. Stop when visit returns true. */
export function walkUp(start: string, visit: (dir: string, depth: number) => boolean | void, maxDepth = 12): void {
	let current = normalizePath(start);
	for (let depth = 0; depth < maxDepth; depth++) {
		if (visit(current, depth) === true) return;
		const next = parentDir(current);
		if (!next || next === current) return;
		current = next;
	}
}

/** Ancestor list from `start` upward, `start` first. */
export function ancestors(start: string, maxDepth = 12): string[] {
	const out: string[] = [];
	walkUp(start, (dir) => {
		out.push(dir);
	});
	return out;
}

export function truncateLines(text: string, maxLines: number): { text: string; omitted: number } {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return { text, omitted: 0 };
	return { text: lines.slice(0, maxLines).join("\n"), omitted: lines.length - maxLines };
}

/** Deterministic short id for cache keys and candidate ids. */
export function shortHash(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const k = key(item);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(item);
	}
	return out;
}

/** `5.7` < `5.7.4` < `5.8`; missing sorts lowest. */
export function compareVersionish(a: string | undefined, b: string | undefined): number {
	const pa = (a ?? "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
	const pb = (b ?? "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
