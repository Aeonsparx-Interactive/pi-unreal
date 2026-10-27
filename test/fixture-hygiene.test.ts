import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { FIXTURES, materializeFixtures, releaseFixtures } from "./helpers.ts";

const BAKED_PATH = /(?:\b[a-z]:[\\/])|\/(?:home|Users|root|tmp|var|mnt|opt|Volumes|Users[\\/])/i;

function committedFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const child = `${dir}/${entry.name}`;
		if (entry.isDirectory()) out.push(...committedFiles(child));
		else if (/\.(uproject|uplugin|md|cs|json|editorconfig|ini|txt)$/i.test(entry.name)) out.push(child);
	}
	return out;
}

describe("fixture hygiene", () => {
	it("commits no machine-specific absolute path", () => {
		const offenders: string[] = [];
		for (const file of committedFiles(FIXTURES)) {
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, index) => {
					if (BAKED_PATH.test(line)) offenders.push(`${relative(FIXTURES, file)}:${index + 1}: ${line.trim()}`);
				});
		}
		// A baked path resolves to nothing on a CI runner (`/home/runner/work/...`, `D:\a\...`),
		// which is exactly how the inline-association and External-scan-root tests failed there.
		expect(offenders).toEqual([]);
	});

	it("materializes the placeholder into a real absolute root", () => {
		const fx = materializeFixtures();
		try {
			const committed = readFileSync(`${FIXTURES}/ProjPath.uproject`, "utf8");
			expect(committed).toContain("__FIXTURE_ROOT__"); // the repo commits the placeholder, never a path
			const inline = readFileSync(`${fx.root}/ProjPath.uproject`, "utf8");
			expect(inline).not.toContain("__FIXTURE_ROOT__");
			expect(inline).toContain(fx.engineA);
			const project = readFileSync(fx.project, "utf8");
			expect(project).not.toContain("__FIXTURE_ROOT__");
			expect(project).toContain(`${fx.projectDir}/Extra`);
		} finally {
			releaseFixtures(fx);
		}
	});
});
