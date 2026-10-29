/**
 * clangd support for MSVC-compiled Unreal projects.
 *
 * `UnrealBuildTool -Mode=GenerateClangDatabase` is the engine-sanctioned way to produce a compile
 * database, and it works with MSVC installed (no clang required). It emits `cl.exe` command lines,
 * which clangd cannot use as written:
 *
 * 1. Each entry points at a shared response file (`@<Target>.<n>.rsp`). The rsp tail carries
 *    `/YuFILE` (create/use a shared PCH), `/FmFILE.obj`, `/FInull`. `FILE` is a placeholder the
 *    build substitutes per translation unit (UnrealBuildTool's makefile `PrimarySourceFiles`
 *    template), so a database entry cannot rely on it. clangd's driver reports
 *    `option '/YuFILE': no source file to create a PCH with`.
 * 2. `/link ...` tails are linker arguments, not compiler arguments.
 *
 * Epic's own VS Code integration does the same job in two pieces:
 * `Engine/Source/Programs/UnrealBuildTool/GA/VSCodeProjectFileGenerator.cs` writes
 * `compileCommands_<Target>.json` plus `compileCommands_<Target>/<Target>.0.rsp` (with
 * `-FI <SharedPCH.h>`), and the `stripPostPch.py` script shipped with Epic's Unreal-clangd plugin
 * removes `/Yu*`, `/Fm*`, `/Fe*`, `/FInull` and everything after `/link`. The project's `.clangd`
 * finishes the job by removing those flags again (`CompileFlags.Remove` covers `/Yu* /Fm* /FI*
 * /Fp*`) and forcing clang-cl as the compiler.
 *
 * This module is the portable TypeScript port of that pipeline. The database is written into the
 * pi-unreal cache, never into the project tree: a generated database encodes this machine's
 * absolute paths and toolchain version, so checking it in is a trap.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { moduleFromSourcePath } from "./store.ts";
import { cacheDir } from "./cache.ts";
import { buildQueryArgs, hostPlatform, locateUbt } from "./ubt.ts";
import { baseName, isAbsolutePath, normalizePath, realFs, type FsAdapter } from "./util.ts";

export interface CompileEntry {
	file: string;
	directory: string;
	command: string;
	/** Kept when present: `arguments[]` is the token form some generators write. */
	arguments?: string[];
	output?: string;
}

export interface CompileDatabase {
	path: string;
	entries: CompileEntry[];
}

/* ─────────────────────────────────────────────────────────────────── tokens */

/** Split a command line on whitespace, keeping quoted runs together. */
export function tokenizeCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (const char of command) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Rebuild a command line; tokens containing whitespace get quoted. */
export function joinTokens(tokens: string[]): string {
	return tokens.map((token) => (/[ \t]/.test(token) ? `"${token}"` : token)).join(" ");
}

const isSwitch = (token: string, ...prefixes: string[]) => prefixes.some((prefix) => token.startsWith(prefix));

/**
 * Drop the switches clangd cannot use. `/Yu` needs a PCH source, `/Fm`/`/Fe`/`/F*` write MSVC
 * artifacts, `/FInull` is a placeholder, and `/link` starts the linker tail.
 * Mirrors Epic's `stripPostPch.py`.
 */
export function stripPostPchTokens(tokens: string[]): { tokens: string[]; dropped: string[] } {
	const kept: string[] = [];
	const dropped: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (token.toLowerCase() === "/link") {
			dropped.push("/link", ...tokens.slice(index + 1));
			break;
		}
		const lower = token.toLowerCase();
		if (isSwitch(lower, "/yu", "/fm", "/fe", "/fp", "/fni", "/fina")) {
			dropped.push(token);
			continue;
		}
		kept.push(token);
	}
	return { tokens: kept, dropped };
}

/** Replace `@file` response indirection with the file's own tokens (depth-limited). */
export function expandResponseTokens(tokens: string[], opts: { baseDir: string; depth?: number; maxDepth?: number }): { tokens: string[]; expanded: string[]; missing: string[] } {
	const maxDepth = opts.maxDepth ?? 3;
	const depth = opts.depth ?? 0;
	const out: string[] = [];
	const expanded: string[] = [];
	const missing: string[] = [];
	for (const token of tokens) {
		if (!token.startsWith("@") || depth >= maxDepth) {
			out.push(token);
			continue;
		}
		const path = token.slice(1).replace(/^"|"$/g, "");
		const abs = path.includes("/") || path.includes("\\") ? path : join(opts.baseDir, path);
		if (!existsSync(abs)) {
			missing.push(abs);
			out.push(token);
			continue;
		}
		const text = readFileSync(abs, "utf8").replace(/^﻿/, "");
		const nested = expandResponseTokens(tokenizeCommand(text), { baseDir: dirname(abs), depth: depth + 1, maxDepth });
		out.push(...nested.tokens);
		expanded.push(abs);
		missing.push(...nested.missing);
	}
	return { tokens: out, expanded, missing };
}

/** UnrealBuildTool's `FILE` placeholder: the translation unit being compiled. */
function resolveFileToken(tokens: string[], file: string): string[] {
	const quoted = `"${file}"`;
	return tokens.map((token) => {
		if (token === "FILE") return file;
		if (token.endsWith("FILE")) return token.slice(0, -"FILE".length) + file;
		if (token.includes('"FILE"')) return token.replace(/"FILE"/g, file);
		if (token.includes("FILE")) return token.replace(/FILE/g, file);
		return token;
	}).map((token, index) => (index === 0 ? token : token === quoted ? file : token));
}

/* ────────────────────────────────────────────────────────────────── entries */

export function readCompileCommands(path: string): CompileEntry[] {
	const raw = JSON.parse(readFileSync(path, "utf8")) as CompileEntry[];
	return Array.isArray(raw) ? raw : [];
}

export function writeCompileCommands(path: string, entries: CompileEntry[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(entries, null, 1));
	renameSync(tmp, path);
}

/** Keep entries whose `file` starts with an include prefix and matches no exclude prefix. */
export function filterEntries(entries: CompileEntry[], opts: { include?: string[]; exclude?: string[] } = {}): CompileEntry[] {
	const include = (opts.include ?? []).map((p) => normalizePath(p).toLowerCase());
	const exclude = (opts.exclude ?? []).map((p) => normalizePath(p).toLowerCase());
	return entries.filter((entry) => {
		const file = normalizePath(entry.file).toLowerCase();
		if (include.length && !include.some((prefix) => file.startsWith(prefix))) return false;
		if (exclude.some((prefix) => file.startsWith(prefix))) return false;
		return true;
	});
}

/** Header entries carry no independent information: a header's flags come from its includers. */
export function dropHeaderEntries(entries: CompileEntry[]): { entries: CompileEntry[]; dropped: number } {
	const kept = entries.filter((entry) => !/\.(h|hpp|inl|cpp)\.h$/i.test(entry.file) && !/\.h$/i.test(entry.file));
	return { entries: kept, dropped: entries.length - kept.length };
}

/** Epic's shared-PCH translation units (`SharedPCH.*.h.cpp`) — clangd cannot build PCHs. */
function isPchEntry(file: string): boolean {
	return /SharedPCH[^\/]*\.h\.cpp$/i.test(file) || /PCH\.[^\/]*\.h\.cpp$/i.test(file);
}

/**
 * Make a database clangd can consume: expand response files, drop PCH/link switches, resolve the
 * `FILE` placeholder, optionally keep only the requested source scope.
 */
export function normalizeDatabase(entries: CompileEntry[], opts: {
	baseDir: string;
	include?: string[];
	exclude?: string[];
	inlineResponseFiles?: boolean;
	dropHeaders?: boolean;
	target?: string;
} = { baseDir: "." }): { entries: CompileEntry[]; stats: { droppedPch: number; droppedHeaders: number; droppedSwitches: number; expandedRsp: number; missingRsp: string[]; kept: number } } {
	const stats = { droppedPch: 0, droppedHeaders: 0, droppedSwitches: 0, expandedRsp: 0, missingRsp: [] as string[], kept: 0 };
	let working = entries.filter((entry) => {
		if (isPchEntry(entry.file)) {
			stats.droppedPch++;
			return false;
		}
		return true;
	});
	if (opts.dropHeaders) {
		const result = dropHeaderEntries(working);
		working = result.entries;
		stats.droppedHeaders = result.dropped;
	}
	working = filterEntries(working, { include: opts.include, exclude: opts.exclude });
	const out: CompileEntry[] = [];
	for (const entry of working) {
		const tokens = entry.arguments?.length ? [...entry.arguments] : tokenizeCommand(entry.command);
		const expanded = expandResponseTokens(tokens, { baseDir: opts.baseDir });
		stats.missingRsp.push(...expanded.missing);
		const stripped = stripPostPchTokens(expanded.tokens);
		stats.droppedSwitches += stripped.dropped.length;
		const resolved = resolveFileToken(stripped.tokens, entry.file);
		if (expanded.expanded.length) stats.expandedRsp += expanded.expanded.length;
		out.push({ file: entry.file, directory: entry.directory, command: joinTokens(resolved) });
	}
	stats.kept = out.length;
	return { entries: out, stats };
}

/* ────────────────────────────────────────────────────────────────── running */

export interface GenerateOptions {
	engineRoot: string;
	projectPath?: string;
	target: string;
	platform?: string;
	configuration?: string;
	/** Where UnrealBuildTool writes compile_commands.json. Defaults to the pi-unreal cache. */
	outputDir?: string;
	/** Absolute prefixes kept in the final database (applied locally; UnrealBuildTool -Include= matches nothing useful). */
	include?: string[];
	exclude?: string[];
	timeoutMs?: number;
	onProgress?: (message: string) => void;
}

/** Where UnrealBuildTool writes the database for a target (it ignores `-OutputPath=` for this mode). */
export function ubtCompileDbPaths(opts: { engineRoot: string; projectDir?: string; platform?: string }): string[] {
	const platform = opts.platform ?? hostPlatform();
	const paths = [
		opts.projectDir ? join(opts.projectDir, "Intermediate", "Build", "Windows", "UnrealBuildTool", "compile_commands.json") : "",
		opts.projectDir ? join(opts.projectDir, "Intermediate", "Build", platform, "UnrealBuildTool", "compile_commands.json") : "",
		join(opts.engineRoot, "Engine", "Intermediate", "Build", platform, "UnrealBuildTool", "compile_commands.json"),
	].filter(Boolean);
	return paths.map(normalizePath);
}

/** Run `-Mode=GenerateClangDatabase`. Costs minutes: UBT regenerates the makefile and UHT code. */
export async function runGenerateClangDatabase(opts: GenerateOptions): Promise<{ rawPath: string; log: string; seconds: number; warnings: string[] }> {
	const warnings: string[] = [];
	const ubt = locateUbt(opts.engineRoot);
	if (!ubt) throw new Error(`UnrealBuildTool not found under ${opts.engineRoot} — is the engine installed?`);
	const command = ubt.kind === "exe" ? ubt.path : undefined;
	if (!command) throw new Error(`only the ${ubt.kind} launcher at ${ubt.path} was found; run UnrealBuildTool from a shell that can execute it`);
	const platform = opts.platform ?? hostPlatform();
	const configuration = opts.configuration ?? "Development";
	// UnrealBuildTool does not create -OutputDir, and dies with DirectoryNotFoundException if it is missing.
	const outputDir = opts.outputDir ?? normalizePath(join(cacheDir(), "compiledb", "raw", `${opts.target}.${platform}.${configuration}`));
	if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
	const args = [
		// TargetDescriptor.ParseSingleCommandLine only inspects arguments that do NOT start with '-', and
		// its '+' split needs every token to be the same kind (all platforms, all configs, all names):
		// `Win64+Development+LpEditor` dies with `The platform name Development is not a valid platform
		// name`, and a bare `-Target=LpEditor` dies with `No platforms specified for target`. Separate
		// positional tokens are the form that parses: platform, configuration, target name.
		platform,
		configuration,
		opts.target,
		// `-Platform=` / `-Configuration=` are deliberately absent: they set BuildConfiguration, and the
		// positional token `Win64` is already consumed as a platform — passing a second one via
		// `-Platform=Win64` makes TargetDescriptor reject it as a duplicate platform.
		// Quotes belong to the shell, not to the argument: UnrealBuildTool reads the value verbatim.
		...(opts.projectPath ? [`-Project=${opts.projectPath}`] : []),
		"-Mode=GenerateClangDatabase",
		// -Include= rules are token-path patterns and match nothing useful here (measured: -Include=Source/Lp
		// and -Include=*/Source/Lp/* both yield an empty database), so scoping happens in normalizeDatabase.
		"-NoExecCodeGenActions",
		...(outputDir ? [`-OutputDir=${outputDir}`] : []),
		"-Progress",
	];
	const started = Date.now();
	opts.onProgress?.(`running UnrealBuildTool -Mode=GenerateClangDatabase ${platform}+${configuration}+${opts.target}`);
	const log = await new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, { cwd: opts.engineRoot, windowsHide: true, shell: false });
		let text = "";
		child.stdout.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
			const line = text.split("\n").filter(Boolean).pop();
			if (line) opts.onProgress?.(line.trim());
		});
		child.stderr.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
		});
		const timer = opts.timeoutMs ? setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`UnrealBuildTool timed out after ${opts.timeoutMs} ms; log tail:\n${text.slice(-2000)}`));
		}, opts.timeoutMs) : undefined;
		child.on("error", (error: Error) => {
			if (timer) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code: number | null) => {
			if (timer) clearTimeout(timer);
			if (code === 0) resolve(text);
			else reject(new Error(`UnrealBuildTool exited with ${code}; log tail:\n${text.slice(-2000)}`));
		});
	});
	const seconds = (Date.now() - started) / 1000;
	const written = writtenPathFrom(log);
	const candidates = [outputDir ? normalizePath(join(outputDir, "compile_commands.json")) : "", written, ...ubtCompileDbPaths({ engineRoot: opts.engineRoot, projectDir: opts.projectPath ? dirname(opts.projectPath) : undefined, platform })].filter(Boolean);
	const rawPath = candidates.find((path) => path && existsSync(path));
	if (!rawPath) throw new Error(`UnrealBuildTool reported success but no compile_commands.json was found. Looked at:\n${candidates.map((path) => `- ${path}`).join("\n")}`);
	const size = statSync(rawPath).size;
	if (size < 1024) warnings.push(`${rawPath} is only ${size} bytes — the target generated almost no source entries`);
	return { rawPath, log, seconds, warnings };
}

function writtenPathFrom(log: string): string | undefined {
	// UnrealBuildTool's line is `ClangDatabase written to <path>`; older builds log `Writing <path>`.
	const match = /(?:ClangDatabase written to|Writing)\s+"?([^"\r\n]+\.json)"?/i.exec(
		log.split(/\r?\n/).filter((line) => /compile_commands\.json|ClangDatabase written/i.test(line)).slice(-1)[0] ?? "",
	);
	return match?.[1] ? normalizePath(match[1].replace(/\\/g, "/")) : undefined;
}

export interface EnsureOptions extends GenerateOptions {
	/** Cache key suffix. Defaults to `<target>.<platform>.<configuration>`. */
	key?: string;
	/** Ignore a cached database and regenerate. */
	refresh?: boolean;
	/** Drop `.h`/`.hpp`/`.inl` entries (clangd infers header flags from includers). */
	dropHeaders?: boolean;
}

export interface EnsureResult {
	path: string;
	rawPath?: string;
	entries: number;
	seconds: number;
	reused: boolean;
	stats: { droppedPch: number; droppedHeaders: number; droppedSwitches: number; expandedRsp: number; kept: number };
	warnings: string[];
	scope: string[];
}

/** Generate (or reuse) a clangd-ready database in the cache. */
export async function ensureCompileDb(opts: EnsureOptions): Promise<EnsureResult> {
	const key = opts.key ?? `${opts.target}.${opts.platform ?? hostPlatform()}.${opts.configuration ?? "Development"}`;
	const dir = normalizePath(join(cacheDir(), "compiledb", key));
	const path = normalizePath(join(dir, "compile_commands.json"));
	const warnings: string[] = [];
	if (!opts.refresh && existsSync(path)) {
		const entries = readCompileCommands(path);
		if (entries.length) {
			return {
				path,
				entries: entries.length,
				seconds: 0,
				reused: true,
				stats: { droppedPch: 0, droppedHeaders: 0, droppedSwitches: 0, expandedRsp: 0, kept: entries.length },
				warnings: [`reusing cached database (${entries.length} entries, ${Math.round(statSync(path).size / 1024)} KB, ${Math.round((Date.now() - statSync(path).mtimeMs) / 1000)}s old) — pass refresh to regenerate`],
				scope: opts.include ?? [],
			};
		}
		warnings.push(`cached database ${path} is empty, regenerating`);
	}
	const generated = await runGenerateClangDatabase(opts);
	const rawEntries = readCompileCommands(generated.rawPath);
	const normalized = normalizeDatabase(rawEntries, {
		baseDir: dirname(generated.rawPath),
		include: opts.include,
		exclude: opts.exclude,
		dropHeaders: opts.dropHeaders,
		target: opts.target,
	});
	warnings.push(...generated.warnings);
	if (normalized.stats.missingRsp.length) warnings.push(`response files not readable: ${normalized.stats.missingRsp.slice(0, 3).join(", ")} (${normalized.stats.missingRsp.length} total)`);
	if (!normalized.entries.length) warnings.push(`no entries survived post-processing of ${rawEntries.length} generated entries — check the include/exclude scope`);
	mkdirSync(dir, { recursive: true });
	writeCompileCommands(path, normalized.entries);
	return {
		path,
		rawPath: generated.rawPath,
		entries: normalized.entries.length,
		seconds: generated.seconds,
		reused: false,
		stats: { droppedPch: normalized.stats.droppedPch, droppedHeaders: normalized.stats.droppedHeaders, droppedSwitches: normalized.stats.droppedSwitches, expandedRsp: normalized.stats.expandedRsp, kept: normalized.stats.kept },
		warnings,
		scope: opts.include ?? [],
	};
}

/* ─────────────────────────────────────────────────────────────────── clangd */

const CLANGD_LAYOUTS = [
	"bin/clangd.exe",
	"clangd.exe",
	"clangd_*/bin/clangd.exe",
	"bin/clangd",
];

/** Where a clangd binary might live on this machine (MSVC boxes ship one with the VS LLVM toolset). */
export function discoverClangd(fs: { exists: (p: string) => boolean } = { exists: existsSync }): string[] {
	const found: string[] = [];
	const roots = [
		process.env.CLANGD_PATH,
		"C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/Llvm/x64/bin",
		"C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Tools/Llvm/x64/bin",
		"C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Tools/Llvm/x64/bin",
		"C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/Llvm/x64/bin",
		"C:/Program Files/Microsoft Visual Studio/18/Professional/VC/Tools/Llvm/x64/bin",
		"C:/Program Files/LLVM/bin",
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft/WinGet/Links") : undefined,
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft/WinGet/Packages") : undefined,
	].filter(Boolean) as string[];
	for (const root of roots) {
		for (const layout of CLANGD_LAYOUTS) {
			const candidate = normalizePath(join(root, layout));
			if (!candidate.includes("*") && fs.exists(candidate)) found.push(candidate);
		}
	}
	if (process.env.LOCALAPPDATA) {
		const packages = normalizePath(join(process.env.LOCALAPPDATA, "Microsoft/WinGet/Packages"));
		if (existsSync(packages)) {
			for (const dir of ["LLVM_Microsoft.Winget.Source_8wekyb3d8bbwe", "LLVM.clangd_Microsoft.Winget.Source_8wekyb3d8bbwe"]) {
				const candidate = normalizePath(join(packages, dir, "bin/clangd.exe"));
				if (existsSync(candidate)) found.push(candidate);
				for (const sub of listSubdirs(packages)) {
					const nested = normalizePath(join(packages, sub, "clangd/bin/clangd.exe"));
					if (existsSync(nested)) found.push(nested);
					const versioned = normalizePath(join(packages, sub, "clangd_21.1.8/bin/clangd.exe"));
					if (existsSync(versioned)) found.push(versioned);
				}
			}
		}
	}
	return [...new Set(found)];
}

function listSubdirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * Ask clangd to compile one file with the generated database. This is the acceptance test for a
 * database: a clean run builds a preamble and indexes the headers of the translation unit.
 */
export async function clangdCheck(opts: { file: string; dbDir: string; clangdPath?: string; timeoutMs?: number }): Promise<{ ok: boolean; clangd?: string; summary: string[]; notes: string[]; raw: string }> {
	const clangd = opts.clangdPath ?? discoverClangd()[0];
	if (!clangd) return { ok: false, summary: [], notes: ["no clangd binary found; look at CLANGD_PATH and the VS LLVM toolset"], raw: "" };
	if (!existsSync(opts.file)) return { ok: false, clangd, summary: [], notes: [`file not found: ${opts.file}`], raw: "" };
	// clangd 22 takes a number here: `--check-locations=lines` is rejected at option parsing
	// (`'lines' is invalid value for boolean argument`), which aborts the check before any compile.
	const args = [`--check=${opts.file}`, `--compile-commands-dir=${opts.dbDir}`, "--background-index=false", "--check-locations=1", "--limit-references=0", "--limit-results=0"];
	const raw = await new Promise<string>((resolve, reject) => {
		const child = spawn(clangd, args, { windowsHide: true });
		let text = "";
		child.stdout.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`clangd timed out after ${opts.timeoutMs ?? 120000} ms`));
		}, opts.timeoutMs ?? 120000);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(text);
		});
	});
	const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const summary = lines.filter((line) => /All checks completed|Built preamble|Indexing headers|Building AST|Loaded compilation|Invalid argument|no source file to create a PCH|^.*error:|fatal|option '/i.test(line)).slice(0, 24);
	const ok = /All checks completed, 0 errors/.test(raw) && !/no source file to create a PCH|Loaded compilation\(s\) failed|invalid value/.test(raw);
	return { ok, clangd, summary, notes: ok ? ["clangd compiled the file with the generated database"] : ["clangd rejected the generated database — see summary"], raw };
}

/* ---------------------------------------------------------------------------
 * clangd health: what clangd on this machine is configured to read, and what
 * the database it reads actually covers.
 *
 * `get_diagnostics` returning `published: 0` is NOT evidence that clangd looked. A definitions index
 * makes absence provable (whole file scanned, every declaration recorded); a diagnostics publication
 * is only evidence when a compile actually ran. The two must never be merged into one number, so this
 * probe reports the settings and the file coverage — and never claims what clangd published.
 * (field-findings 2026-10-28 §3: a 76-symbol publish in a prior session proves the pipeline CAN
 * publish; the same query now publishes nothing, and the payload cannot distinguish
 * "looked, found nothing" from "never looked".)
 * ------------------------------------------------------------------------- */

const SKIP_DB_DIRS = new Set(["intermediate", "binaries", "saved", ".git", ".vs", ".vscode", ".pi", ".idea", ".github", "thirdparty", "programs", "build", "content", "config"]);
const TU_EXT = [".cpp", ".cc", ".cxx", ".cpp20", "inl.cpp"];

/** Recursive translation-unit listing under one root (skips build output and ThirdParty). */
export function listTranslationUnits(dir: string, maxFiles = 4000, depth = 0): string[] {
	if (depth > 12) return [];
	let entries: { name: string; isDirectory(): boolean }[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		if (out.length >= maxFiles) break;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DB_DIRS.has(entry.name.toLowerCase())) continue;
			out.push(...listTranslationUnits(abs, maxFiles - out.length, depth + 1));
			continue;
		}
		const lower = entry.name.toLowerCase();
		if (TU_EXT.some((ext) => lower.endsWith(ext)) || (lower.endsWith(".cpp") && !lower.endsWith(".d.cpp"))) out.push(normalizePath(abs));
	}
	return out;
}

export interface DatabaseReport {
	path: string;
	bytes: number;
	ageMs: number;
	entries: number;
	tuCount?: number;
	coveredTus?: number;
	missingTus?: { file: string; module?: string }[];
	entryFilesWithoutCommands?: string[];
}

/** One `compile_commands.json`, measured against the sources that should be in it. */
export function describeDatabase(path: string, roots: { dir: string; module?: string }[] = []): DatabaseReport {
	let bytes = 0;
	let ageMs = 0;
	try {
		const stat = statSync(path);
		bytes = stat.size;
		ageMs = Date.now() - stat.mtimeMs;
	} catch {
		return { path, bytes: 0, ageMs: -1, entries: 0 };
	}
	const entries = readCompileCommands(path);
	const known = new Set(entries.map((entry) => normalizePath(entry.file).toLowerCase()));
	const report: DatabaseReport = { path, bytes, ageMs, entries: entries.length };
	const tus: { file: string; module?: string }[] = [];
	for (const root of roots) {
		// A root rarely carries a module label (the compiledb scope is a list of directories), and the
		// "not in it" list is useless without the module: name it from the /Source/<Module>/ path shape.
		for (const file of listTranslationUnits(root.dir)) tus.push({ file, module: root.module ?? moduleFromSourcePath(file) });
	}
	report.tuCount = tus.length;
	const missing = tus.filter((unit) => !known.has(unit.file.toLowerCase()));
	report.coveredTus = tus.length - missing.length;
	report.missingTus = missing.slice(0, 12);
	report.entryFilesWithoutCommands = entries.filter((entry) => !existsSync(normalizePath(entry.file))).map((entry) => normalizePath(entry.file)).slice(0, 12);
	return report;
}

/** `compile_commands.json` + `compileCommands*.json` files in a directory (clangd's `-bcr` siblings are ignored: they are its own index). */
export function databasesIn(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => /^compile_commands\.json$/i.test(name) || /^compilecommands.*\.json$/i.test(name))
		.map((name) => normalizePath(join(dir, name)));
}

export interface ClangdConfig {
	path?: string;
	compilationDatabase?: string;
	raw?: string;
	notes: string[];
}

/**
 * The project's own clangd configuration. Read, never written: the `.clangd` file is the developer's
 * authority (it carries the `/Yu* /Fm* /FI* /Fp*` removals and the clang-cl forcing), and the
 * Unreal-clangd extension owns `.vscode/settings.json`.
 */
export function readClangdConfig(projectDir: string, fs: FsAdapter = realFs): ClangdConfig {
	const path = normalizePath(join(projectDir, ".clangd"));
	const raw = fs.readText(path);
	if (!raw) return { notes: [`no ${path} (clangd uses its built-in defaults plus --compile-commands-dir from the client)`] };
	const setting = /^\s*CompilationDatabase:\s*(.+)$/m.exec(raw)?.[1]?.trim();
	const notes: string[] = [];
	if (!setting) notes.push(`${path} sets no CompileFlags.CompilationDatabase — clangd searches the file's directory and ancestors for a compile database`);
	return { path, compilationDatabase: setting, raw, notes };
}

/** Directories clangd will actually search for a compile database, derived from the `.clangd` setting. */
export function clangdSearchDirs(projectDir: string, config: ClangdConfig): { dirs: string[]; notes: string[] } {
	const notes: string[] = [];
	if (config.compilationDatabase && config.compilationDatabase.toLowerCase() !== "auto" && config.compilationDatabase.toLowerCase() !== "off") {
		const dir = isAbsolutePath(config.compilationDatabase) ? normalizePath(config.compilationDatabase) : normalizePath(join(projectDir, config.compilationDatabase));
		notes.push(`.clangd CompilationDatabase: ${config.compilationDatabase} → clangd reads ${dir}`);
		return { dirs: [dir], notes };
	}
	if (config.compilationDatabase?.toLowerCase() === "off") {
		notes.push(".clangd CompilationDatabase: off — clangd has no compile database by design");
		return { dirs: [], notes };
	}
	const candidates = [".vscode/unreal-clangd", "Intermediate/Build/Windows/UnrealBuildTool", "Intermediate/Build/Win64/UnrealBuildTool", ".vscode", "."].map((rel) => normalizePath(join(projectDir, rel)));
	notes.push(config.compilationDatabase ? ".clangd CompilationDatabase: auto → clangd searches the source directory and its ancestors" : "no CompilationDatabase setting → clangd searches the source directory and its ancestors");
	return { dirs: candidates.filter((dir) => existsSync(dir)), notes };
}

/** Response files Epic's generator writes with the JSON: their mtime vs the JSON's is the diagnosis. */
export function responseFileStatus(dir: string, dbAgeMs: number): { files: { path: string; ageMs: number; lines: number }[]; note?: string } {
	let names: string[] = [];
	let rspNames: string[] = [];
	try {
		names = readdirSync(dir);
		rspNames = names.filter((name) => /^compilecommands.*\.rsp$/i.test(name) || /\.rsp$/i.test(name));
	} catch {
		return { files: [] };
	}
	const files = rspNames
		.filter((name) => !/\.(obj|log|cache|pdb|json)$/i.test(name))
		.map((name) => {
			const path = normalizePath(join(dir, name));
			let ageMs = -1;
			let lines = 0;
			try {
				ageMs = Date.now() - statSync(path).mtimeMs;
				lines = readFileSync(path, "utf8").split(/\r?\n/).length;
			} catch {
				/* unreadable */
			}
			return { path, ageMs, lines };
		});
	if (!files.length) return { files };
	const newer = files.filter((file) => file.ageMs >= 0 && file.ageMs < dbAgeMs);
	const days = (ms: number) => (Math.round((ms / 86400000) * 10) / 10).toFixed(1);
	return {
		files,
		note: newer.length
			? `${newer.map((file) => `${baseName(file.path)} (${days(file.ageMs)} days, ${file.lines} lines)`).join(", ")} are NEWER than the compile database (${days(dbAgeMs)} days): the include paths are current, the file list is not`
			: undefined,
	};
}

/** Does this file have a compile command in this database? The honest per-file gate. */
export function compileCommandFor(dbPath: string, file: string): { found: boolean; entry?: CompileEntry } {
	const want = normalizePath(file).toLowerCase();
	const entry = readCompileCommands(dbPath).find((candidate) => normalizePath(candidate.file).toLowerCase() === want);
	return entry ? { found: true, entry } : { found: false };
}

export interface CompileDbInventoryEntry {
	key: string;
	dir: string;
	path: string;
	entries: number;
	bytes: number;
	ageMs: number;
}

export function listCompileDbs(root = cacheDir()): CompileDbInventoryEntry[] {
	const base = normalizePath(join(root, "compiledb"));
	let keys: string[] = [];
	try {
		keys = readdirSync(base);
	} catch {
		return [];
	}
	const out: CompileDbInventoryEntry[] = [];
	for (const key of keys) {
		const dir = normalizePath(join(base, key));
		const path = normalizePath(join(dir, "compile_commands.json"));
		if (!existsSync(path)) continue;
		let bytes = 0;
		let ageMs = -1;
		try {
			const stat = statSync(path);
			bytes = stat.size;
			ageMs = Date.now() - stat.mtimeMs;
		} catch {
			continue;
		}
		out.push({ key, dir, path, entries: readCompileCommands(path).length, bytes, ageMs });
	}
	return out.sort((a, b) => a.ageMs - b.ageMs);
}

/** Cache bytes for a subtree (`du`-like, no external tool). */
export function dirBytes(dir: string): number {
	let total = 0;
	let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const abs = join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) total += dirBytes(abs);
		else {
			try {
				total += statSync(abs).size;
			} catch {
				/* ignore */
			}
		}
	}
	return total;
}

export interface InstallResult {
	ok: boolean;
	/** Always named: even a failed copy tells the caller which path was attempted. */
	path: string;
	clangdSnippet: string;
	notes: string[];
	warnings: string[];
}

/**
 * Copy a generated database to where clangd actually reads it, and print the exact `.clangd` lines.
 *
 * The copy is the opt-in half of the wiring. pi-unreal never rewrites `.clangd`: that file carries the
 * developer's flag removals and the clang-cl forcing, and the Unreal-clangd extension owns
 * `.vscode/settings.json`, so the tool prints the two lines to merge and leaves the merge to the
 * developer (field-findings 2026-10-28 §6: the answer must name the live clangd directory, not print a
 * third location the session never reads).
 */
export function installCompileDb(opts: { sourcePath: string; destDir: string; fileName?: string }): InstallResult {
	const snippet = `CompileFlags:\n  CompilationDatabase: ${normalizePath(opts.destDir)}`;
	const dir = normalizePath(opts.destDir);
	const path = normalizePath(join(dir, opts.fileName ?? "compile_commands.json"));
	// `path` is required on every result: a failed install still names the path it attempted.
	if (!existsSync(opts.sourcePath)) return { ok: false, path, clangdSnippet: snippet, notes: [`source database missing: ${opts.sourcePath}`], warnings: ["nothing installed"] };
	try {
		mkdirSync(dir, { recursive: true });
		copyFileSync(opts.sourcePath, path);
	} catch (error) {
		return { ok: false, path, clangdSnippet: snippet, notes: [`copy failed: ${String(error)}`], warnings: ["nothing installed"] };
	}
	return {
		ok: true,
		path,
		clangdSnippet: snippet,
		notes: [
			`installed ${path}`,
			`merge into the project's .clangd (pi-unreal does not write that file — it carries your flag removals and forces clang-cl):\n${snippet}`,
			"restart clangd so the new database is picked up (VS Code: 'Developer: Restart Language Server'; the clangd-server MCP reconnects on its next call)",
			"the database encodes this machine's absolute paths — keep it out of git, regenerate after engine/SDK changes",
		],
		warnings: [],
	};
}
