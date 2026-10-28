#!/usr/bin/env bun
/**
 * Live machine check (not part of `bun test` — it depends on this machine's installs and the
 * user-approved bench project). Run: bun test/live-check.ts
 */
import { parseUproject, readBuildVersion } from "../extensions/unreal/lib/descriptors.ts";
import { enumerateInstallations, resolveEngineForProject } from "../extensions/unreal/lib/engine-resolver.ts";
import { buildPluginIndex, computeScanDirs, resolveProjectPlugins } from "../extensions/unreal/lib/plugin-resolver.ts";
import { createWindowsRegistryReader } from "../extensions/unreal/lib/registry.ts";
import { realFs } from "../extensions/unreal/lib/util.ts";

const BENCH = process.argv[2];
if (!BENCH) {
	console.error("usage: bun test/live-check.ts <path/to.project.uproject> (no baked default: a machine path resolves to nothing on CI)");
	process.exit(1);
}
const registry = createWindowsRegistryReader({ timeoutMs: 10000 });

const t0 = Date.now();
const installs = await enumerateInstallations({ fs: realFs, registry });
console.log(`── enumerateInstallations (${Date.now() - t0} ms)`);
for (const install of installs) {
	console.log(
		`  ${install.source.padEnd(18)} ${String(install.identifier).padEnd(40)} valid=${install.validRoot} v=${install.version?.raw ?? "-"} ${install.root}`,
	);
}

console.log(`\n── resolve ${BENCH}`);
const descriptor = parseUproject(BENCH, realFs);
console.log(`  association: "${descriptor.engineAssociation}"`);
console.log(`  modules: ${descriptor.modules.map((m) => m.moduleName).join(", ")}`);
console.log(`  plugin references: ${descriptor.plugins.length}; jsonc diagnostics: ${descriptor.diagnostics.length}`);

const resolution = await resolveEngineForProject(BENCH, { fs: realFs, registry });
console.log(`  status: ${resolution.status}`);
console.log(`  engineRoot: ${resolution.engineRoot ?? "-"}`);
console.log(`  identifier: ${resolution.identifier ?? "-"}  source: ${resolution.source ?? "-"}  installedBuild: ${resolution.installedBuild}`);
console.log(`  version: ${resolution.version?.raw ?? "-"}`);
console.log(`  Build.version: ${resolution.buildVersionPath ?? "-"}`);
for (const line of resolution.remediation) console.log(`  · ${line}`);

if (resolution.status === "resolved" && resolution.engineRoot) {
	const scanDirs = computeScanDirs({
		engineRoot: resolution.engineRoot,
		projectDir: resolution.projectDir,
		additionalPluginDirectories: descriptor.additionalPluginDirectories,
		additionalRootDirectories: descriptor.additionalRootDirectories,
	});
	const t1 = Date.now();
	const index = await buildPluginIndex({
		engineRoot: resolution.engineRoot,
		projectDir: resolution.projectDir,
		additionalPluginDirectories: descriptor.additionalPluginDirectories,
		additionalRootDirectories: descriptor.additionalRootDirectories,
		fs: realFs,
	});
	console.log(
		`\n── plugin index: ${index.entries.length} plugins from ${index.scannedDirs.length} roots in ${Date.now() - t1} ms`,
	);
	console.log(`   scanned: ${index.scannedDirs.join(", ")}`);
	const results = resolveProjectPlugins(descriptor, index, resolution.version);
	const tally = new Map<string, number>();
	for (const result of results) tally.set(result.status, (tally.get(result.status) ?? 0) + 1);
	console.log(`   reference statuses: ${[...tally].map(([k, v]) => `${k}=${v}`).join(", ")}`);
	for (const result of results) {
		console.log(`  ${result.name}: ${result.status}${result.plugin ? ` ← ${result.plugin.source}` : ""}${result.notes.length ? ` (${result.notes.join("; ")})` : ""}`);
	}
	const engineVersion = await readBuildVersion(resolution.engineRoot, realFs);
	void engineVersion;
	void scanDirs;
}
