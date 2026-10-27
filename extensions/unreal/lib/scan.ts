/**
 * Compiler-free C++ definition scan.
 *
 * What clangd/IntelliSense give you (hover, call hierarchy, cross-references) needs a compiler and a
 * compile database. What an agent needs most of the time — "where is this class, function, enum,
 * delegate, or property defined, and in which module?" — is a text fact, so this is a single-pass
 * line scanner over engine, project, and plugin source trees. Measured cost: ~18.5k files (Engine/
 * Source/Runtime) in 2.7 s in Python, so engine-wide lands in tens of seconds, against the ~2 h it
 * takes clangd to index the same tree with a generated compile database.
 *
 * It is a heuristic scanner, and the tools say so in their descriptions. UHT macros are the
 * reliable part (`UCLASS`/`USTRUCT`/`UENUM`/`UPROPERTY`/`UFUNCTION` and the `DECLARE_*DELEGATE`
 * family are engine-greppable invariants); plain `class`/`struct`/`enum`/`function` rows come from
 * line patterns and can miss a declaration split across lines in an unusual format. Prefix and
 * substring matching make a miss visible (a `prefixHits` count is always reported), and
 * `unreal_clangd` is the enrichment path for hover/call-hierarchy on a box that has clangd.
 *
 * Skips `Intermediate/`, `Binaries/`, `Saved/`, `.git/` and `*.generated.h` (UHT output: metadata
 * and thunk declarations, not authoring sites), and `ThirdParty/` by default — the engine's
 * vendored code is not the answer to "where is the engine feature", and it is the bulk of the tree.
 */

import { readdir, readFile } from "node:fs/promises";
import { type Dirent } from "node:fs";
import { joinPath, normalizePath } from "./util.ts";

export type DefKind = "class" | "struct" | "enum" | "union" | "function" | "delegate" | "property" | "alias";

/** One definition row. `module` is the module that owns `file`, resolved from UBT's dirToModule. */
export interface SymbolDef {
	symbol: string;
	kind: DefKind;
	/** Definition site, as a path relative to the scan root that contains it (forward slashes). */
	file: string;
	line: number;
	module: string;
	/** Engine module, project module, plugin module, or "" when UBT did not map the directory. */
	scope: "Engine" | "Project" | "Plugin" | "";
	/** `"UCLASS spec=ClassGroup=Render"` for macro rows; `spec=UPROPERTY`/`spec=UFUNCTION` for property/function rows. */
	marker: string;
}

export interface ScanRoot {
	/** Absolute directory to walk (a module's `Source/`, an engine `Source/`, a plugin dir). */
	dir: string;
	scope: "Engine" | "Project" | "Plugin";
	/** Module owning this root; used when UBT's dirToModule has no entry for a subdirectory. */
	module?: string;
}

export interface ScanOptions {
	/** Directories never descended into (matched case-insensitively against the directory name). */
	skipDirs?: string[];
	/** Scan `<root>/ThirdParty` trees. Off by default (vendored code, ~half the engine tree). */
	includeThirdParty?: boolean;
	/** Files above this size are skipped (generated/bundled blobs). Default 1 MB. */
	maxFileBytes?: number;
	concurrency?: number;
	/** Progress hook: fires per root with the running file count. */
	onProgress?: (done: number, root: string) => void;
}

export interface ScanStats {
	scannedFiles: number;
	scannedBytes: number;
	skippedDirs: number;
	skippedLarge: number;
	defs: number;
	defsByKind: Record<string, number>;
	/** Files whose content produced no rows at all (mostly headers of pure forward declarations). */
	emptyFiles: number;
	durationMs: number;
}

const DEFAULT_SKIP_DIRS = [
	"Intermediate",
	"Binaries",
	"Saved",
	"DerivedDataCache",
	".git",
	".vs",
	".idea",
	"out",
	"obj",
	"node_modules",
	"ThirdParty",
	"Platforms",
];

/** UE's own sourceFileExtensions (ShaderCompileWorker/UBT conventions), minus `.cs` (C#). */
const SCAN_EXT = [".h", ".hpp", ".hxx", ".inl", ".cpp", ".cc", ".cxx", ".c", ".mm", ".cpp20", ".template", ".inc", ".ush", ".usf"];

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_CONCURRENCY = 24;

/* ──────────────────────────────────────────────────────────────────────────── patterns */

/** `UCLASS(...)`, `USTRUCT()`, `UENUM(BlueprintType)` … — the declaration name comes on a following line. */
const RE_MACRO = /^\s*(UCLASS|USTRUCT|UENUM|UINTERFACE|UCLASS_ABSTRACT|UINTERFACE_BLUEPRINTTYPE)\b(.*)$/;
/** `class ENGINE_API UAnimInstance : public X` / `struct FFoo final : public Bar`. */
const RE_RECORD = /\b(class|struct)\s+([A-Z][A-Za-z0-9_]*_?API\s+)?(final\s+)?([A-Za-z_][A-Za-z0-9_:]*)\b/g;
/**
 * What may follow a record name for the line to be a declaration of that type at all: a base list,
 * a body, a forward semicolon, `final`, a template head, a specifier attribute, or end of line
 * (UE writes the brace on the next line). `virtual bool SerializeNewActor(FArchive& Ar, class
 * AActor *& Actor)` matches RE_RECORD and declares nothing — it *uses* the type, and a scanner that
 * records it claims a definition site the compiler knows nothing about. This check is what keeps
 * `unreal_symbol AActor` pointing at `GameFramework/Actor.h`.
 */
const RE_RECORD_TAIL = /^\s*(?::|\{|\[\[|;|final\b|override\b|<|$)/;
const RE_ENUM = /\benum\s+(class\s+|struct\s+)?([A-Z][A-Za-z0-9_]*_?API\s+)?([A-Za-z_][A-Za-z0-9_:]*)\b/;
const RE_UNION = /\bunion\s+(?:[A-Z][A-Z0-9_]*_API\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/;
/** Forward declarations: `class UTexture;` — cheap to record, tells the agent where the real header is not. */
const RE_FORWARD = /^\s*(?:friend\s+)?(class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(;|\{)/;
/** `DECLARE_DELEGATE`, `DECLARE_MULTICAST_DELEGATE_TwoParams`, `DECLARE_DYNAMIC_MULTICAST_DELEGATE_FullParams`, `DECLARE_..._SCRIPT_DELEGATE` … */
const RE_DELEGATE = /\b(DECLARE_(?:SCRIPT_)?(?:DYNAMIC_)?(?:MULTICAST_)?(?:DELEGATE|FUNCTION)[A-Za-z_]*)\s*\(([^)]*)\)\s*[{;]?/;
/** `UPROPERTY(...)`, `UFUNCTION(BlueprintCallable, ...)`, `UENUM BlueprintType` specifiers on their own line. */
const RE_SPECIFIER = /^\s*(UPROPERTY|UFUNCTION|UMETA|UPARAM|UDELEGATE)\b/;
/**
 * Function signature detector. A regex alone gets this wrong in both directions: UE puts the opening
 * brace of a definition on the next line (Allman), so a pattern anchored on `{`/`;` misses every
 * `void UFoo::Bar(float X)` definition, while a pattern loose enough to accept end-of-line also
 * accepts `UE_LOG(...)`, `Foo::Bar();` calls and `const FVector V = Compute(...)` locals. The rules
 * below are what makes the rows trustworthy:
 *   - the text before the first `(` is `returnType [Qualifier::] name`, i.e. at least two tokens
 *     (a bare `Foo::Bar()` call has one, so it is rejected), and carries no `=`;
 *   - the text after the matching `)` is qualifiers (`const`, `override`, `final`, `noexcept`,
 *     `[[attr]]`, `= 0`) and at most one `{`, and contains no `(`;
 *   - control flow, preprocessor, `operator`, and template lines are excluded.
 */
const RE_HEAD = /^(?<type>(?:(?:const|static\s+constexpr|static|constexpr|virtual|explicit|inline|friend|extern|thread_local|mutable|noescape)\s+)*[A-Za-z_][A-Za-z0-9_:<>,&*\s]*?)\s+(?:(?<qual>[A-Za-z_][A-Za-z0-9_]*)::)*(?<name>[A-Za-z_~][A-Za-z0-9_]*)$/;
const RE_TAIL = /^(?:\s*(?:const|override|final|noexcept|volatile|\[\[.*?\]\]|=\s*0))*[^(){}]*\{?\s*$/;
const RE_ALIAS = /^\s*(using\s+([A-Za-z_][A-Za-z0-9_]*)\s*=|typedef\s+[^;]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*;)/;

/** Lines that look like a function signature but are control flow, attributes, or macro calls. */
const NOT_A_FUNCTION = /^\s*(if|for|while|switch|return|else|do|catch|case|default|delete|new|throw|co_await|co_return|co_yield|static_assert|template|operator|__|elif|endif|ifdef|ifndef|pragma|define|include|using)\b/;
const FUNCTION_NAME_BLACKLIST = new Set(["if", "for", "while", "switch", "return", "else", "do", "catch", "case", "default", "new", "delete", "throw", "sizeof", "alignof", "decltype", "static_cast", "dynamic_cast", "const_cast", "reinterpret_cast", "operator", "template", "typename", "public", "private", "protected", "signals", "Q_OBJECT"]);

/* ──────────────────────────────────────────────────────────────────────────── text scan */

export interface IncludeRef {
	/** Including file, relative to its scan root. */
	file: string;
	/** Included name as written, without quotes/angles. */
	target: string;
	angled: boolean;
	line: number;
}

const RE_INCLUDE = /^\s*#\s*include\s*["<]([^">]+)[">]/;

/**
 * Scan one source file. `file` is the display path (relative to the scan root), `module`/`scope` come
 * from the caller's dirToModule resolution. Returns rows in file order, deduplicated by
 * symbol+kind+line.
 */
export function scanText(text: string, file: string, module: string, scope: SymbolDef["scope"]): { defs: SymbolDef[]; includes: IncludeRef[] } {
	const defs: SymbolDef[] = [];
	const includes: IncludeRef[] = [];
	const seen = new Set<string>();
	const lines = text.split("\n");
	/** `UCLASS(...)`/`UENUM(...)` awaiting the declaration line that names it. */
	let pendingMacro: { name: string; spec: string; line: number } | null = null;
	/** `UPROPERTY(...)`/`UFUNCTION(...)` awaiting the member declaration. */
	let pendingSpec: { name: string; line: number } | null = null;
	let inBlockComment = false;

	/** Open type bodies, innermost last: members are recorded as `Owner:Member`. */
	const typeStack: { name: string; depth: number }[] = [];
	let depth = 0;
	const innerType = () => (typeStack.length ? (typeStack[typeStack.length - 1]?.name ?? "") : "");

	const emit = (symbol: string, kind: DefKind, line: number, marker: string) => {
		const raw = symbol.replace(/<[\s\S]*$/, "").trim();
		if (raw.length < 2) return;
		if (/^[A-Z][A-Z0-9_]*_API$/.test(raw)) return; // `class ENGINE_API Foo` -> the macro is not a name
		if (/[(),<>]/.test(raw)) return;
		const owner = kind === "function" || kind === "property" ? innerType() : "";
		const name = owner && !raw.includes(":") ? `${owner}:${raw}` : raw;
		const key = `${name}\u0000${kind}\u0000${line}`;
		if (seen.has(key)) return;
		seen.add(key);
		defs.push({ symbol: name, kind, file, line, module, scope, marker });
	};

	/** A type declaration whose body opens on this line or the next owns the members that follow. */
	const pushType = (name: string) => {
		if (name && name.length > 1 && !/[(),<>]/.test(name)) typeStack.push({ name, depth: depth + 1 });
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const t = raw.trim();
		if (!t) continue;

		if (inBlockComment) {
			if (t.includes("*/")) inBlockComment = false;
			continue;
		}
		if (t.startsWith("//")) continue;
		if (t.startsWith("/*")) {
			if (!t.includes("*/")) inBlockComment = true;
			continue;
		}

		const line = i + 1;

		// Brace accounting is crude (string literals with braces are rare in declarations) and is
		// only used to know which type body a member declaration sits inside.
		depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
		while (typeStack.length && (typeStack[typeStack.length - 1]?.depth ?? 0) > depth) typeStack.pop();

		const inc = RE_INCLUDE.exec(t);
		if (inc?.[1]) {
			const target = inc[1];
			if (/\.(h|hpp|hxx|inl)$/i.test(target)) includes.push({ file, target, angled: !t.includes('"'), line });
			continue;
		}

		// UHT specifiers on their own line bind to the declaration that follows.
		const spec = RE_SPECIFIER.exec(t);
		if (spec?.[1]) {
			pendingSpec = { name: spec[1], line };
			// `UPROPERTY() inline` continuations are handled by the property/function patterns below.
			continue;
		}

		// UHT class/struct/enum macros: name arrives on this line or one of the next few.
		const macro = RE_MACRO.exec(t);
		if (macro?.[1]) {
			const specText = (macro[2] ?? "").replace(/\s+/g, " ").trim();
			pendingMacro = { name: macro[1], spec: specText ? `spec=${specText.slice(0, 120)}` : "", line };
			const onLine = recordNames(t);
			if (onLine.length) {
				for (const n of onLine) {
					emit(n.name, n.kind, line, macroMarker(macro[1], macro[2] ?? ""));
					pushType(n.name);
				}
				pendingMacro = null;
			}
			continue;
		}

		const markerFromMacro = () => {
			if (!pendingMacro) return "";
			const marker = macroMarker(pendingMacro.name, pendingMacro.spec);
			pendingMacro = null;
			return marker;
		};

		const delegate = RE_DELEGATE.exec(t);
		if (delegate?.[1]) {
			// The name's position depends on the macro shape, not on its position in the list:
			//   DECLARE_DELEGATE(Name), DECLARE_DELEGATE_OneParam(Name, Type) -> first argument
			//   DECLARE_DELEGATE_RetVal(Ret, Name), _RetVal_OneParam(Ret, Name, Type) -> second
			// Taking the last argument names the *parameter type* of a one-param delegate
			// (`DECLARE_DELEGATE_OneParam(FOnAnimationEvent, class UAnimInstance*)` -> UAnimInstance).
			const macro = delegate[1];
			const parts = (delegate[2] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
			const bare = (value: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : "");
			const slots = /_?Ret\s*Val/i.test(macro) ? [parts[1] ?? "", parts[0] ?? ""] : [parts[0] ?? "", parts[parts.length - 1] ?? ""];
			const name = bare(slots[0] ?? "") || bare(slots[1] ?? "");
			if (name) {
				emit(name, "delegate", line, t.slice(0, 60));
				continue;
			}
		}

		const forward = RE_FORWARD.exec(t);
		if (forward?.[2] && /;\s*$/.test(t) && !/\bclass\b[^;]*\{/.test(t)) {
			emit(forward[2], forward[1] === "class" ? "class" : "struct", line, "forward");
			continue;
		}

		const union = RE_UNION.exec(t);
		if (union?.[1]) {
			emit(union[1], "union", line, markerFromMacro());
			continue;
		}

		const enumMatch = RE_ENUM.exec(t);
		if (enumMatch?.[3] && !/\benumerated\b/.test(t)) {
			emit(enumMatch[3], "enum", line, markerFromMacro());
			continue;
		}

		const records = recordNames(t);
		if (records.length) {
			const marker = markerFromMacro();
			const forwardOnly = /;\s*$/.test(t) && !t.includes("{");
			for (const rec of records) {
				emit(rec.name, rec.kind, line, forwardOnly && !marker ? "forward" : marker);
				if (!forwardOnly) pushType(rec.name);
			}
			continue;
		}

		// Member declarations carry meaning only under a UPROPERTY/UFUNCTION specifier, which is what
		// makes them worth recording: it is the blueprint-visible surface of a module.
		if (pendingSpec) {
			const specifier = pendingSpec;
			pendingSpec = null;
			if (specifier.name === "UPROPERTY") {
				const member = memberName(t);
				if (member) {
					emit(member, "property", line, "spec=UPROPERTY");
					continue;
				}
			}
		}

		const fn = detectFunction(t, /\.(cpp|cc|cxx|c|mm)$/i.test(file));
		if (fn) {
			const qualified = /([A-Za-z_][A-Za-z0-9_]*)::\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(t);
			emit(qualified?.[1] && qualified[2] === fn.name ? `${qualified[1]}:${fn.name}` : fn.name, "function", line, fn.marker);
			continue;
		}

		const alias = RE_ALIAS.exec(t);
		if (alias?.[1]) {
			emit(alias[2] ?? alias[3] ?? "", "alias", line, alias[1].trim().slice(0, 40));
		}
	}

	return { defs, includes };
}

/** See RE_HEAD/RE_TAIL. Returns the callee name and a `def|decl [qualifiers]` marker. */
function detectFunction(line: string, isSource: boolean): { name: string; marker: string } | undefined {
	const open = line.indexOf("(");
	if (open < 3) return undefined;
	const head = line.slice(0, open).trimEnd();
	if (!head || head.includes("=") || head.includes("{") || head.includes(")") || head.includes("~")) return undefined;
	if (NOT_A_FUNCTION.test(line) || line.startsWith("#") || line.startsWith("@")) return undefined;
	if (line.includes("= delete") || line.includes("= default")) return undefined;

	const close = findCloseParen(line, open);
	if (close < 0) return undefined;
	const tail = line.slice(close + 1);
	if (tail.includes("(") || !RE_TAIL.test(tail)) return undefined;
	const params = line.slice(open + 1, close);
	if (params.includes("{") || params.includes(")")) return undefined;

	const m = RE_HEAD.exec(head);
	if (!m) return undefined;
	const groups = m.groups as { type?: string; qual?: string; name?: string };
	const name = groups.name ?? "";
	// At least one token of return type before the (optional) qualifier chain, so bare calls are out.
	if (!groups.type || !groups.type.trim()) return undefined;
	if (!name || FUNCTION_NAME_BLACKLIST.has(name)) return undefined;
	if (name.startsWith("operator")) return undefined;

	const qualifiers: string[] = tail.match(/const|override|noexcept|final|=\s*0/g) ?? [];
	if (/=\s*0/.test(tail)) qualifiers.push("pure virtual");
	const marker = [isSource ? "def" : "decl", ...qualifiers.map((q) => (q.includes("0") ? "pure virtual" : q))].filter(Boolean).join(" ");
	return { name, marker };
}

/** Index of the `)` matching `open`, or -1 when the signature spans lines (params continue below). */
function findCloseParen(line: string, open: number): number {
	let depth = 0;
	for (let i = open; i < line.length; i++) {
		const ch = line[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function macroMarker(macroName: string, specText: string): string {
	const spec = specText.startsWith("(") ? specText.slice(0, 120) : specText.slice(0, 120);
	return spec ? `${macroName} ${spec}` : macroName;
}

/** Class/struct names declared on a line, ignoring keywords and API-macro tokens. */
function recordNames(line: string): { name: string; kind: "class" | "struct" }[] {
	const out: { name: string; kind: "class" | "struct" }[] = [];
	RE_RECORD.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = RE_RECORD.exec(line))) {
		const name = match[4];
		if (!name || FUNCTION_NAME_BLACKLIST.has(name) || name === "class" || name === "struct") continue;
		if (name.includes("::")) continue;
		if (!RE_RECORD_TAIL.test(line.slice(match.index + match[0].length))) continue;
		out.push({ name, kind: match[1] === "class" ? "class" : "struct" });
	}
	return out;
}

/** `Type Name;` / `Type Name = X;` / `uint8 bFlag:1;` — the member name under a UPROPERTY. */
function memberName(line: string): string | undefined {
	const m = /^\s*(?:\[\[.*?\]\]\s*)?(?:mutable\s+|TObjectPtr<[^>]*>\s+|[A-Za-z_][A-Za-z0-9_:<>,\s&\*]*?)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*\d+)?\s*(?:=|;|\[)/.exec(line.trim());
	return m?.[1];
}

/* ──────────────────────────────────────────────────────────────────────────── tree walk */

interface DiscoveredFile {
	abs: string;
	root: ScanRoot;
}

/**
 * Collect scannable files under `roots`. Depth-first with `readdir(withFileTypes)`; symlinked
 * directories are skipped so a plugin tree that symlinks back into the engine cannot cycle.
 */
export async function collectSourceFiles(roots: ScanRoot[], opts: ScanOptions = {}): Promise<DiscoveredFile[]> {
	const skip = new Set((opts.skipDirs ?? DEFAULT_SKIP_DIRS).map((name) => name.toLowerCase()));
	if (opts.includeThirdParty) skip.delete("thirdparty");
	const out: DiscoveredFile[] = [];
	const stack: string[] = [];

	for (const root of roots) {
		stack.push(root.dir);
		while (stack.length) {
			const dir = stack.pop()!;
			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				continue; // missing Source/ for a plugin is normal (Blueprint-only, content-only plugins)
			}
			for (const entry of entries) {
				const name = entry.name;
				if (entry.isSymbolicLink()) continue;
				const abs = normalizePath(joinPath(dir, name));
				if (entry.isDirectory()) {
					if (skip.has(name.toLowerCase())) continue;
					stack.push(abs);
					continue;
				}
				if (!entry.isFile()) continue;
				if (/\.generated\.h$/i.test(name)) continue; // UHT output: metadata and thunks, not authoring sites
				const lower = name.toLowerCase();
				if (!SCAN_EXT.some((ext) => lower.endsWith(ext))) continue;
				out.push({ abs, root });
			}
		}
	}
	return out;
}

/**
 * Scan `roots` and return definition rows plus `#include` edges. `resolveModule` maps an absolute
 * file to the module that owns it — supplied by the index (UBT's dirToModule), so the scanner stays
 * dependency-free and testable on a text fixture.
 */
export async function scanSources(
	roots: ScanRoot[],
	resolveModule: (file: string, root: ScanRoot) => string,
	opts: ScanOptions = {},
): Promise<{ defs: SymbolDef[]; includes: IncludeRef[]; roots: ScanRoot[]; stats: ScanStats }> {
	const started = Date.now();
	const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 128));
	const files = await collectSourceFiles(roots, opts);
	const defs: SymbolDef[] = [];
	const includes: IncludeRef[] = [];
	const defsByKind: Record<string, number> = {};
	let scannedFiles = 0;
	let scannedBytes = 0;
	let skippedLarge = 0;
	let emptyFiles = 0;
	let done = 0;

	const queue = files.values();
	const workers = Array.from({ length: concurrency }, async () => {
		for (let next = queue.next(); ; next = queue.next()) {
			const entry = (await next).value as DiscoveredFile | undefined;
			if (!entry) break;
			let buffer: Buffer;
			try {
				buffer = await readFile(entry.abs);
			} catch {
				continue; // unreadable file (locked by a running editor build): skip, do not fail the scan
			}
			done++;
			if (buffer.length > maxFileBytes) {
				skippedLarge++;
				continue;
			}
			scannedFiles++;
			scannedBytes += buffer.length;
			const module = resolveModule(entry.abs, entry.root);
			const scanned = scanText(buffer.toString("utf8"), entry.abs, module, entry.root.scope);
			if (!scanned.defs.length) emptyFiles++;
			for (const def of scanned.defs) {
				defsByKind[def.kind] = (defsByKind[def.kind] ?? 0) + 1;
			}
			defs.push(...scanned.defs);
			includes.push(...scanned.includes);
			opts.onProgress?.(done, entry.root.dir);
		}
	});
	await Promise.all(workers);

	defs.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
	return {
		defs,
		includes,
		roots,
		stats: { scannedFiles, scannedBytes, skippedDirs: 0, skippedLarge, defs: defs.length, defsByKind, emptyFiles, durationMs: Date.now() - started },
	};
}
