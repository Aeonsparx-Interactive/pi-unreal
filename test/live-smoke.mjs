// Live smoke against the real bench (not part of `bun test`): real registry, real engine, real project.
// Run: bun test/live-smoke.mjs [path-to-.uproject]
import { parseUproject, readBuildVersion } from "../extensions/unreal/lib/descriptors.ts";
import { resolveEngineForProject, enumerateInstallations } from "../extensions/unreal/lib/engine-resolver.ts";
import { buildPluginIndex, computeScanDirs, resolveProjectPlugins } from "../extensions/unreal/lib/plugin-resolver.ts";
import { createWindowsRegistryReader } from "../extensions/unreal/lib/registry.ts";
import { computeCacheKey, loadCachedIndex, saveCachedIndex } from "../extensions/unreal/lib/cache.ts";
import { realFs } from "../extensions/unreal/lib/util.ts";

const project = process.argv[2];
const registry = createWindowsRegistryReader({ timeoutMs: 15000 });

const t0 = Date.now();
const resolution = await resolveEngineForProject(project, { fs: realFs, registry });
console.log(`[resolve ${Date.now() - t0}ms] status=${resolution.status} engineRoot=${resolution.engineRoot} identifier=${resolution.identifier} source=${resolution.source} installedBuild=${resolution.installedBuild}`);
if (resolution.remediation.length) console.log("  remediation:", resolution.remediation.join(" | "));

const descriptor = parseUproject(project, realFs);
console.log(`[project] modules=${descriptor.modules.map((m) => m.moduleName).join(",")} pluginRefs=${descriptor.plugins.length} unknownFields=${descriptor.unknownFields.join(",") || "-"}`);
console.log(`[project] diagnostics: ${descriptor.diagnostics.length ? descriptor.diagnostics.join(" | ") : "none"}`);

const version = resolution.version ?? (resolution.engineRoot ? readBuildVersion(resolution.engineRoot, realFs) : undefined);
const projectDir = project.slice(0, project.lastIndexOf("/"));
const scanned = computeScanDirs({ engineRoot: resolution.engineRoot, projectDir, additionalPluginDirectories: descriptor.additionalPluginDirectories });
const keyInfo = computeCacheKey({ engineRoot: resolution.engineRoot, projectDir, scannedDirs: scanned.map((s) => s.dir), versionChangelist: version?.changelist });

const t1 = Date.now();
let index = loadCachedIndex(keyInfo.key, realFs);
const cacheMode = index ? "hit" : "miss";
if (!index) {
	index = await buildPluginIndex({ engineRoot: resolution.engineRoot, projectDir, additionalPluginDirectories: descriptor.additionalPluginDirectories });
	saveCachedIndex(index, keyInfo.key, keyInfo.roots);
}
console.log(`[index ${Date.now() - t1}ms cache=${cacheMode}] entries=${index.entries.length} scannedFiles=${index.scannedFiles} dirs=${scanned.length}`);

const results = resolveProjectPlugins(descriptor, index, version);
const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log(`[refs] ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" ")}`);
for (const r of results) console.log(`  ${r.status.padEnd(14)} ${r.name}${r.plugin ? ` <- ${r.plugin.source} ${r.plugin.semVersion ?? r.plugin.versionName ?? ""}`.trimEnd() : ""}${r.notes.length ? ` :: ${r.notes.join(" | ")}` : ""}`);

const t2 = Date.now();
const index2 = loadCachedIndex(keyInfo.key, realFs);
console.log(`[cache warm ${Date.now() - t2}ms] reload=${index2 ? index2.entries.length : "MISS"}`);
