import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DSL_FACTS,
	dslModulePath,
	dslUsageSections,
	extractUsage,
	formatIssues,
	lintDsl,
	lintText,
	locateDslUsage,
} from "../extensions/unreal/lib/dsl-grammar.ts";

/**
 * The fixtures here are hand-written, not copies of Epic's `USAGE` text: the grammar is Epic's
 * content (redistributing it is not ours to do), and what these tests pin down is the reader and the
 * lint rules, not the wording of the reference.
 */
const USAGE_SOURCE = [
	'"""Module docstring."""',
	"",
	'USAGE = """\\',
	"GRAMMAR OVERVIEW",
	"  A script is a sequence of top-level forms.",
	"",
	"STATEMENTS",
	"  (bind name expr)        store an expression",
	"  (if c A (elif c2 B (else C)))",
	"",
	"MULTI-EXEC (latent/task nodes with named exec outputs)",
	"  (Node (:OnComplete stmts ...))",
	'"""',
	"",
	"def register():",
	"    pass",
].join("\n");

describe("extractUsage", () => {
	test("reads a triple-quoted constant that opens on its own line", () => {
		const usage = extractUsage(USAGE_SOURCE);
		expect(usage).toBeDefined();
		expect(usage!.line).toBe(3);
		expect(usage!.text.startsWith("GRAMMAR OVERVIEW")).toBe(true);
		expect(usage!.text.endsWith("(Node (:OnComplete stmts ...))")).toBe(true);
		// The module docstring and the code after the constant are not part of the grammar.
		expect(usage!.text).not.toContain("def register");
	});

	test("handles a one-line constant", () => {
		expect(extractUsage('USAGE = """(a b)"""\nx = 1')?.text).toBe("(a b)");
	});

	test("a file without USAGE is not a grammar", () => {
		expect(extractUsage("def f():\n    return None\n")).toBeUndefined();
		expect(extractUsage('USAGE = """never closed\nmore')).toBeUndefined();
	});
});

describe("locateDslUsage", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-unreal-dsl-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const relative = "Engine/Plugins/Experimental/Toolsets/EditorToolset/Content/Python/editor_toolset/toolsets";

	test("no engine root means no local grammar, not a guess", () => {
		expect(locateDslUsage({})).toBeUndefined();
	});

	test("an engine without the plugin reports nothing", () => {
		expect(locateDslUsage({ engineRoot: join(dir, "missing-engine") })).toBeUndefined();
	});

	test("finds the module inside an engine install and cites its line", () => {
		const engine = join(dir, "UE_Test");
		mkdirSync(join(engine, relative), { recursive: true });
		writeFileSync(join(engine, relative, "blueprint_dsl.py"), USAGE_SOURCE, "utf8");
		const found = locateDslUsage({ engineRoot: engine });
		expect(found).toBeDefined();
		expect(found!.line).toBe(3);
		expect(found!.file.replace(/\\/g, "/")).toContain("blueprint_dsl.py");
		expect(found!.file.replace(/\\/g, "/")).toBe(dslModulePath(engine).replace(/\/$/, ""));
	});
});

describe("dslUsageSections", () => {
	test("splits at headings, including one with a parenthesised gloss", () => {
		const sections = dslUsageSections(extractUsage(USAGE_SOURCE)!.text);
		expect(sections.map((section) => section.title)).toEqual([
			"GRAMMAR OVERVIEW",
			"STATEMENTS",
			"MULTI-EXEC (latent/task nodes with named exec outputs)",
		]);
		expect(sections[1]!.body).toContain("(bind name expr)");
		expect(sections[2]!.body).toContain(":OnComplete");
	});

	test("lowercase prose is never mistaken for a heading", () => {
		const sections = dslUsageSections("STATEMENTS\n  note: wrap in parens\n  also lowercase\n");
		expect(sections.length).toBe(1);
		expect(sections[0]!.body).toContain("also lowercase");
	});
});

describe("lintDsl", () => {
	const clean = (code: string) => {
		const lint = lintDsl(code);
		return { errors: lint.errors, warnings: lint.warnings };
	};

	test("a well-formed event has nothing to report", () => {
		const lint = clean('(event Custom|MyEvent\n  (Development|PrintString "Hello"))');
		expect(lint.errors).toEqual([]);
		expect(lint.warnings).toEqual([]);
	});

	test("unclosed and stray parens are errors with positions", () => {
		const unclosed = clean('(event Custom|MyEvent\n  (Development|PrintString "Hello")');
		expect(unclosed.errors.map((issue) => issue.message)).toEqual(["unclosed '(' — this form is never closed"]);
		expect(unclosed.errors[0]!.line).toBe(1);

		const stray = clean('(event A (Development|PrintString "x")))');
		expect(stray.errors.some((issue) => issue.message.includes("unexpected ')'"))).toBe(true);
		expect(stray.errors[0]!.column).toBe(40);
	});

	test("an unterminated string is reported once, without a paren cascade", () => {
		const lint = clean('(development|PrintString "hello)');
		expect(lint.errors.length).toBe(1);
		expect(lint.errors[0]!.message).toContain("unterminated string");
	});

	test("an unquoted class path is the 'undefined variable' trap", () => {
		const lint = clean("(Game|SpawnActorfromClass :Class /Script/Engine.StaticMeshActor)");
		expect(lint.errors.length).toBe(1);
		expect(lint.errors[0]!.message).toContain("unquoted path '/Script/Engine.StaticMeshActor'");
		expect(lint.errors[0]!.message).toContain("quote it");
	});

	test("elif/else is the else branch, so it must be last in the body", () => {
		const lint = clean('(fn F (V)\n  (if (< V 0) (return 0)\n    (elif (> V 1) (return 1))\n    (return V)))');
		expect(lint.errors.length).toBe(1);
		expect(lint.errors[0]!.message).toContain("must be the last form inside 'if'");

		const ok = clean("(fn Clamp (Value Min Max)\n  (if (< Value Min)\n    (return Min)\n    (elif (> Value Max)\n      (return Max)\n      (else\n        (return Value)))))");
		expect(ok.errors).toEqual([]);
	});

	test("an exec continuation comes after the data arguments", () => {
		const ordered = clean('(Ability|Tasks|WaitDelay 2.0\n  (:OnComplete (Development|PrintString "d")))');
		expect(ordered.warnings).toEqual([]);

		const outOfOrder = clean('(Ability|Tasks|WaitDelay (:OnComplete (Development|PrintString "d")) 2.0)');
		expect(outOfOrder.errors).toEqual([]);
		expect(outOfOrder.warnings.length).toBe(1);
		expect(outOfOrder.warnings[0]!.message).toContain("exec continuation");
	});

	test("a quoted pin name is not a keyword argument", () => {
		expect(clean('(Utilities|IsValid self\n  (:"Is Valid" (Development|PrintString "ok")))').errors).toEqual([]);
	});

	test("an empty form is a warning, not a hard failure", () => {
		const lint = clean("(event X ())");
		expect(lint.errors).toEqual([]);
		expect(lint.warnings[0]!.message).toBe("empty form '()'");
	});

	test("comments do not participate", () => {
		expect(clean("; (unclosed forever\n(event E\n  ; stray ) too\n  (Development|PrintString \"x\"))").errors).toEqual([]);
	});

	test("form count is the top-level shape, not the node count", () => {
		expect(lintDsl("(event A (Development|PrintString \"x\"))\n(fn B (X) (return X))").forms).toBe(2);
	});
});

describe("rendering", () => {
	test("a clean script says so, and still points at the editor", () => {
		const text = lintText(lintDsl('(event A (Development|PrintString "x"))'));
		expect(text).toContain("no syntactic problem found");
		expect(text).toContain("The editor is still the parser");
	});

	test("errors are listed with line:column and capped", () => {
		const lint = lintDsl(Array.from({ length: 20 }, () => "(event").join("\n"));
		const text = lintText(lint);
		expect(text).toContain("unclosed '('");
		expect(text.split("\n").length).toBeLessThan(20);
		expect(formatIssues(lint.errors, 3).length).toBe(3);
	});

	test("the distilled invariants mention both pin syntaxes", () => {
		expect(DSL_FACTS.length).toBeGreaterThan(4);
		expect(DSL_FACTS.join("\n")).toContain("(:Pin stmts");
		expect(DSL_FACTS.join("\n")).toContain('(:"Is Valid"');
	});
});
