/**
 * The Blueprint graph DSL: where its grammar lives, and a pre-flight check for hand-written scripts.
 *
 * `write_graph_dsl` takes an S-expression script and **compiles** the Blueprint, so a malformed script
 * is not a cheap failure — it is a document rewrite followed by a compile. The grammar itself is not
 * ours to invent: the toolset plugin ships it as the `USAGE` constant of
 * `editor_toolset/toolsets/blueprint_dsl.py`, and the same text is what `BlueprintTools.get_graph_dsl_docs`
 * returns. This module reads that file from the engine we already resolved (works with the editor
 * closed, per engine version) and never carries a copy of it.
 *
 * `lintDsl` is a tokenizer, not a transpiler: it reports the syntactic traps the DSL raises on, in the
 * order they are cheap to detect. It never claims a script is valid — the editor is the parser.
 */

import { joinPath, normalizePath, realFs, type FsAdapter } from "./util.ts";

/** Plugin-relative location of the DSL module, from the engine root. */
const DSL_MODULE_RELATIVE = "Engine/Plugins/Experimental/Toolsets/EditorToolset/Content/Python/editor_toolset/toolsets/blueprint_dsl.py";

export interface DslUsage {
	file: string;
	/** 1-based line of `USAGE = """`. */
	line: number;
	text: string;
}

export interface DslSection {
	title: string;
	body: string;
}

/** Read the `USAGE` triple-quoted constant out of the DSL module's source lines. */
export function extractUsage(source: string): { line: number; text: string } | undefined {
	const lines = source.split(/\r?\n/);
	const start = lines.findIndex((line) => /^USAGE\s*=\s*"""/.test(line));
	if (start < 0) return undefined;
	const opened = (lines[start] ?? "").replace(/^USAGE\s*=\s*"""/, "");
	// `USAGE = """\` continues on the next line; a same-line close means a one-liner.
	const rest = opened.replace(/\\$/, "");
	if (rest.trimEnd().endsWith('"""')) return { line: start + 1, text: rest.trimEnd().slice(0, -3).trim() };
	const body: string[] = rest ? [rest] : [];
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const close = line.indexOf('"""');
		if (close >= 0) {
			body.push(line.slice(0, close));
			return { line: start + 1, text: body.join("\n").replace(/^\n+/, "").replace(/\s+$/, "") };
		}
		body.push(line);
	}
	return undefined;
}

/**
 * Locate the DSL grammar for an engine. Returns `undefined` when that engine does not ship the module
 * (older installs, or an install without the EditorToolset plugin) — the caller then falls back to the
 * live `get_graph_dsl_docs` tool rather than to a stale local copy.
 */
export function locateDslUsage(options: { engineRoot?: string; fs?: FsAdapter } = {}): DslUsage | undefined {
	const fs = options.fs ?? realFs;
	const root = options.engineRoot ? normalizePath(options.engineRoot) : undefined;
	if (!root) return undefined;
	const file = joinPath(root, DSL_MODULE_RELATIVE);
	if (!fs.exists(file)) return undefined;
	const source = fs.readText(file);
	if (source === undefined) return undefined;
	const usage = extractUsage(source);
	if (!usage) return undefined;
	return { file, line: usage.line, text: usage.text };
}

/** A section heading: unindented, all-caps up to any parenthesised gloss, e.g. `MULTI-EXEC (latent nodes)`. */
function isHeading(line: string): boolean {
	if (!line || line !== line.trimEnd()) return false;
	const prefix = (line.split("(")[0] ?? "").trimEnd();
	if (line !== line.trimStart()) return false;
	if (prefix.length < 4 || prefix !== prefix.toUpperCase()) return false;
	return /^[A-Z][A-Z0-9 .,:;\-—–]+$/.test(prefix) && /[A-Z]{2}/.test(prefix);
}

/** Split the grammar text at its all-caps headings (`GRAMMAR OVERVIEW`, `STATEMENTS`, …). */
export function dslUsageSections(text: string): DslSection[] {
	const sections: DslSection[] = [];
	let current: DslSection | undefined;
	for (const line of text.split("\n")) {
		if (isHeading(line)) {
			if (current) sections.push(current);
			current = { title: line.trim(), body: "" };
			continue;
		}
		if (!current) continue;
		current.body = `${current.body}${current.body ? "\n" : ""}${line}`;
	}
	if (current) sections.push(current);
	return sections.map((section) => ({ title: section.title, body: section.body.replace(/^\n+|\s+$/g, "") }));
}

/** The invariants worth repeating on every authoring turn, distilled — not copied — from the grammar. */
export const DSL_FACTS: string[] = [
	"One call per node: a repeated (Type|Id …) creates a second node and runs it again — `(bind x …)` then reuse `x`.",
	"Unquoted words are variable references. Class paths, enum values and asset paths must be quoted strings.",
	"`(if c A (elif c B (else C)))` — `elif`/`else` are the LAST form in the body, not statements after it.",
	"`(Node :Pin val)` is a keyword data argument; `(Node (:Pin stmts…))` is an exec continuation. The parenthesis decides.",
	"Pin names with spaces use the quoted form `(:\"Is Valid\" …)`.",
	"`self` is pre-bound inside every event/fn body; it needs no node of its own.",
	"`write_graph_dsl` compiles the Blueprint and replaces the nodes it rewrites — read the graph first with `read_graph_dsl`.",
];

export interface DslIssue {
	line: number;
	column: number;
	message: string;
}

export interface DslLint {
	errors: DslIssue[];
	warnings: DslIssue[];
	/** Node-ish count: top-level forms found. Useful as a "did you paste the whole script" signal. */
	forms: number;
}

type Token =
	| { kind: "open"; line: number; column: number }
	| { kind: "close"; line: number; column: number }
	| { kind: "atom"; line: number; column: number; value: string }
	| { kind: "string"; line: number; column: number; value: string; terminated: boolean };

const BLOCK_HEADS = new Set(["event", "fn", "if", "elif", "else", "for", "while", "def", "then"]);

function tokenize(code: string): { tokens: Token[]; issues: DslIssue[] } {
	const tokens: Token[] = [];
	const issues: DslIssue[] = [];
	let line = 1;
	let column = 1;
	let index = 0;
	const push = (token: Token) => tokens.push(token);

	while (index < code.length) {
		const char = code[index] ?? "";
		if (char === "\n") {
			line++;
			column = 1;
			index++;
			continue;
		}
		if (char === ";") {
			while (index < code.length && code[index] !== "\n") {
				index++;
				column++;
			}
			continue;
		}
		if (char === "(" || char === ")") {
			push({ kind: char === "(" ? "open" : "close", line, column });
			index++;
			column++;
			continue;
		}
		if (char === '"') {
			const startLine = line;
			const startColumn = column;
			let value = "";
			let terminated = false;
			index++;
			column++;
			while (index < code.length) {
				const inner = code[index] ?? "";
				if (inner === "\\") {
					value += code[index + 1] ?? "";
					if (code[index + 1] === "\n") {
						line++;
						column = 1;
					} else {
						column += 2;
					}
					index += 2;
					continue;
				}
				if (inner === '"') {
					terminated = true;
					index++;
					column++;
					break;
				}
				if (inner === "\n") {
					line++;
					column = 1;
					value += inner;
					index++;
					continue;
				}
				value += inner;
				index++;
				column++;
			}
			push({ kind: "string", line: startLine, column: startColumn, value, terminated });
			if (!terminated) issues.push({ line: startLine, column: startColumn, message: 'unterminated string (a `"` opened here is never closed)' });
			continue;
		}
		if (/\s/.test(char)) {
			index++;
			column++;
			continue;
		}
		// Bare word: everything up to whitespace, a paren, a quote or a comment.
		const startColumn = column;
		let value = "";
		while (index < code.length) {
			const inner = code[index] ?? "";
			if (/\s/.test(inner) || inner === "(" || inner === ")" || inner === '"' || inner === ";") break;
			value += inner;
			index++;
			column++;
		}
		if (value) push({ kind: "atom", line, column: startColumn, value });
	}
	return { tokens, issues };
}

interface Form {
	kind: "list" | "atom" | "string";
	line: number;
	column: number;
	value: string;
	items: Form[];
}

function parseForms(tokens: Token[], issues: DslIssue[]): Form[] {
	const root: Form[] = [];
	const stack: { form: Form }[] = [];
	const current = () => (stack.length ? stack[stack.length - 1]!.form.items : root);

	for (const token of tokens) {
		if (token.kind === "open") {
			const form: Form = { kind: "list", line: token.line, column: token.column, value: "(", items: [] };
			current().push(form);
			stack.push({ form });
			continue;
		}
		if (token.kind === "close") {
			if (!stack.length) issues.push({ line: token.line, column: token.column, message: "unexpected ')' — nothing is open here" });
			else stack.pop();
			continue;
		}
		current().push({ kind: token.kind === "string" ? "string" : "atom", line: token.line, column: token.column, value: token.value, items: [] });
	}
	// An unterminated string swallows whatever follows, so "unclosed (" would be a second symptom of the
	// same mistake — report the string, not the cascade.
	const swallowed = issues.some((issue) => issue.message.startsWith("unterminated string"));
	if (!swallowed) {
		for (const open of stack) issues.push({ line: open.form.line, column: open.form.column, message: "unclosed '(' — this form is never closed" });
	}
	return root;
}

const BLOCK_BODY_HINT: Record<string, string> = {
	event: "event",
	fn: "fn",
	if: "if",
	elif: "elif",
	else: "else",
	for: "for",
	while: "while",
};

/**
 * Pre-flight check for a `write_graph_dsl` script.
 *
 * Scope is deliberate: syntactic traps that are decidable without node semantics. It does not resolve
 * type ids, pin names or arity — `find_node_types` / `get_node_type_pins` / the editor do that.
 */
export function lintDsl(code: string): DslLint {
	const tokenized = tokenize(code);
	const errors: DslIssue[] = [...tokenized.issues];
	const warnings: DslIssue[] = [];
	const forms = parseForms(tokenized.tokens, errors);

	const walk = (form: Form): void => {
		if (form.kind !== "list") {
			if (form.kind === "atom" && /^\/(Script|Game|Engine|CppGame)\b/.test(form.value)) {
				errors.push({ line: form.line, column: form.column, message: `unquoted path '${form.value}' is read as a variable reference — quote it` });
			}
			return;
		}
		const head = form.items[0];
		const headValue = head && head.kind === "atom" ? head.value : undefined;
		const headIsKeywordList = head?.kind === "list" && head.items[0]?.kind === "atom" && (head.items[0]?.value ?? "").startsWith(":");

		if (!form.items.length) {
			warnings.push({ line: form.line, column: form.column, message: "empty form '()'" });
			return;
		}

		if (headIsKeywordList && headValue === undefined) {
			const headKeyword = (head?.items[0]?.value ?? "").replace(/^:/, "");
			const label = headKeyword ? `':${headKeyword}' continuation` : "exec continuation";
			warnings.push({ line: form.line, column: form.column, message: `${label} has no body — a continuation with no statements` });
		}

		// Bodies: `elif`/`else` must be the last form of the parent body.
		if (headValue && BLOCK_BODY_HINT[headValue]) {
			const body = form.items.slice(head === undefined ? 0 : formValueArity(headValue));
			body.forEach((child, index) => {
				const childHead = child.kind === "list" && child.items[0]?.kind === "atom" ? child.items[0]?.value : undefined;
				if ((childHead === "elif" || childHead === "else") && index !== body.length - 1) {
					errors.push({
						line: child.line,
						column: child.column,
						message: `'${childHead}' must be the last form inside '${headValue}' — it IS the else branch, not a statement after it`,
					});
				}
			});
		}

		// Inside a node call: keyword-headed sub-lists are continuations and must follow the data args.
		if (!headIsKeywordList && headValue && !BLOCK_BODY_HINT[headValue] && headValue !== "switch") {
			let sawContinuation = false;
			for (const child of form.items) {
				const childHead = child.kind === "list" && child.items[0]?.kind === "atom" ? (child.items[0]?.value ?? "") : undefined;
				const isContinuation = child.kind === "list" && (childHead?.startsWith(":") ?? false);
				if (isContinuation) {
					sawContinuation = true;
					continue;
				}
				if (sawContinuation) {
					warnings.push({ line: child.line, column: child.column, message: "data/expr form after an exec continuation — continuations must come last in the call" });
				}
			}
		}

		for (const child of form.items) walk(child);
	};

	for (const form of forms) walk(form);
	return { errors, warnings, forms: forms.filter((form) => form.kind === "list").length };
}

/** How many leading items of a block form are not body statements (`event Name (Params)` = 3). */
function formValueArity(head: string): number {
	if (head === "event" || head === "fn") return 3;
	if (head === "if" || head === "elif" || head === "while") return 2;
	if (head === "else") return 1;
	if (head === "for") return 3;
	return 1;
}

export function formatIssues(issues: DslIssue[], limit = 12): string[] {
	return issues.slice(0, limit).map((issue) => `  ${issue.line}:${issue.column}  ${issue.message}`);
}

export function lintText(lint: DslLint): string {
	const lines: string[] = [];
	if (!lint.errors.length && !lint.warnings.length) {
		lines.push(`pre-flight: no syntactic problem found in ${lint.forms} top-level form(s). The editor is still the parser — node type ids and pin names are checked only there.`);
		return lines.join("\n");
	}
	if (lint.errors.length) {
		lines.push(`pre-flight: ${lint.errors.length} error(s) that write_graph_dsl would raise on:`);
		lines.push(...formatIssues(lint.errors));
	}
	if (lint.warnings.length) {
		lines.push(`${lint.errors.length ? "" : "pre-flight"}: ${lint.warnings.length} warning(s):`);
		lines.push(...formatIssues(lint.warnings));
	}
	return lines.join("\n");
}

/** Path of the DSL module inside an engine install — cited in answers so the reader can open it. */
export function dslModulePath(engineRoot: string): string {
	return joinPath(normalizePath(engineRoot), DSL_MODULE_RELATIVE);
}
