import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { scanText } from "../extensions/unreal/lib/scan.ts";
import { buildIndex, clearFreshnessCache, freshnessNote, indexFreshness, lookupSymbol, patchIndex, pickIndex } from "../extensions/unreal/lib/store.ts";

// The index writes to the machine cache dir; tests must not touch it.
const CACHE = mkdtempSync(join(tmpdir(), "pi-unreal-freshness-"));
process.env.PI_UNREAL_CACHE_DIR = CACHE;

const ROOT = mkdtempSync(join(tmpdir(), "pi-unreal-fresh-src-")).split("\\").join("/");
const HEADER = `${ROOT}/Public/Thing.h`;
mkdirSync(`${ROOT}/Public`, { recursive: true });

const resolveModule = () => ({ module: "Thing", scope: "Project" as const });

/** Build a one-root index over `Thing.h` with the given text, always under a fresh key. */
async function indexOf(text: string, suffix: string) {
	writeFileSync(HEADER, text);
	const key = `idx-freshness-${suffix}`;
	await buildIndex({ key, mode: "definitions", roots: [{ dir: ROOT, scope: "Project", module: "Thing" }], projectName: "Thing" });
	clearFreshnessCache();
	const index = pickIndex({ key }).index!;
	return { index, key };
}

describe("precise scanning", () => {
	it("indexes destructors (they were dropped by a '~' guard)", () => {
		const { defs } = scanText("class THING_API UThing\n{\npublic:\n\tvirtual ~UThing() override;\n};\n", `${ROOT}/Public/Thing.h`, "Thing", "Project");
		const destructor = defs.find((def) => def.symbol === "UThing:~UThing");
		expect(destructor?.kind).toBe("function");
		expect(destructor?.marker).toContain("override");
	});

	it("does not record a local variable as a function in a .cpp", () => {
		const body = [
			"void AThing::Tick(float DeltaSeconds)",
			"{",
			"\tFScopeLock Lock(&CriticalSection);",
			"\tUE::TReadScopeLock ReadLock(Lock);",
			"\tTPropertyCombinationSet<64> CopyConstructed(Set);",
			"\tFVector V = Compute(1);",
			"}",
			"",
		].join("\n");
		const { defs } = scanText(body, `${ROOT}/Private/Thing.cpp`, "Thing", "Project");
		const names = defs.map((def) => def.symbol);
		expect(names).toContain("AThing:Tick");
		expect(names).not.toContain("Lock");
		expect(names).not.toContain("_");
		expect(names).not.toContain("CopyConstructed");
		expect(names).not.toContain("V");
	});

	it("keeps a member declared in a class body inside a .cpp", () => {
		const body = "struct FHelper\n{\n\tvoid Reset() const;\n};\n";
		const { defs } = scanText(body, `${ROOT}/Private/Thing.cpp`, "Thing", "Project");
		expect(defs.map((def) => def.symbol)).toContain("FHelper:Reset");
	});

	it("names a pure virtual member once", () => {
		const { defs } = scanText("class IThing\n{\npublic:\n\tvirtual void Run() = 0;\n};\n", `${ROOT}/Public/Thing.h`, "Thing", "Project");
		const run = defs.find((def) => def.symbol === "IThing:Run");
		expect(run?.marker.match(/pure virtual/g)?.length).toBe(1);
	});
});

describe("freshness", () => {
	it("stores per-file mtimes and reports a clean index as fresh", async () => {
		const { index } = await indexOf("class THING_API UThingA\n{\n};\n", "clean");
		expect(index.meta.version).toBe(7);
		const freshness = indexFreshness(index, { ttlMs: 0 });
		expect(freshness.supported).toBe(true);
		expect(freshness.checked).toBe(1);
		expect(freshness.changed).toEqual([]);
		expect(freshnessNote(index, freshness)).toBeUndefined();
	});

	it("detects an edited file and names it", async () => {
		const { index } = await indexOf("class THING_API UThingB\n{\n};\n", "edited");
		writeFileSync(HEADER, "class THING_API UThingB\n{\n};\n\nclass THING_API UThingC\n{\n};\n");
		const later = index.meta.freshness!.newestMtimeMs + 5_000;
		utimesSync(HEADER, new Date(later), new Date(later));
		clearFreshnessCache();
		const freshness = indexFreshness(index, { ttlMs: 0 });
		expect(freshness.changed).toEqual([HEADER]);
		expect(freshnessNote(index, freshness)).toContain("stale");
	});

	it("patches the edited file so a new symbol resolves and the index reads fresh again", async () => {
		const { index, key } = await indexOf("class THING_API UThingD\n{\n};\n", "patched");
		expect(lookupSymbol(index, "UThingE")).toEqual([]);
		writeFileSync(HEADER, "class THING_API UThingD\n{\n};\n\nclass THING_API UThingE\n{\n};\n");
		const later = index.meta.freshness!.newestMtimeMs + 5_000;
		utimesSync(HEADER, new Date(later), new Date(later));
		clearFreshnessCache();
		const stale = indexFreshness(index, { ttlMs: 0 });
		expect(stale.changed).toEqual([HEADER]);
		const result = await patchIndex(index, [...stale.changed, ...stale.missing], resolveModule);
		expect(result.updated).toBe(1);
		expect(result.removed).toBe(1);
		expect(result.deleted).toBe(0);
		clearFreshnessCache();
		const reloaded = pickIndex({ key }).index!;
		expect(lookupSymbol(reloaded, "UThingE").map((row) => row.symbol)).toContain("UThingE");
		const after = indexFreshness(reloaded, { ttlMs: 0 });
		expect(after.changed).toEqual([]);
		expect(after.missing).toEqual([]);
	});

	it("drops the rows of a file that no longer exists", async () => {
		const { index, key } = await indexOf("class THING_API UThingF\n{\n};\n", "deleted");
		const gone = `${ROOT}/Public/Gone.h`;
		writeFileSync(gone, "class THING_API UGone\n{\n};\n");
		// index the second file through a patch, then delete it from disk
		await patchIndex(index, [gone], resolveModule);
		clearFreshnessCache();
		const withGone = pickIndex({ key }).index!;
		expect(lookupSymbol(withGone, "UGone").length).toBe(1);
		const { rmSync } = await import("node:fs");
		rmSync(gone);
		clearFreshnessCache();
		const freshness = indexFreshness(pickIndex({ key }).index!, { ttlMs: 0 });
		expect(freshness.missing).toContain(gone);
		const result = await patchIndex(pickIndex({ key }).index!, freshness.missing, resolveModule);
		expect(result.deleted).toBe(1);
		clearFreshnessCache();
		expect(lookupSymbol(pickIndex({ key }).index!, "UGone")).toEqual([]);
	});

	it("carries the declaration's own text with each lookup row", async () => {
		const { index } = await indexOf("class THING_API UThingG : public UObject\n{\n};\n", "snippet");
		const row = lookupSymbol(index, "UThingG")[0];
		expect(row?.snippet).toBe("class THING_API UThingG : public UObject");
	});
});
