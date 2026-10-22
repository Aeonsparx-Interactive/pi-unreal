#!/usr/bin/env bun
/**
 * Side census (not part of `bun test`): collects the union of top-level `.uplugin` keys, nested
 * `Plugins` reference keys, and `Modules` keys across real engine/plugin trees, so the known-field
 * sets in descriptors.ts can be validated against the engine's own output. An "unknown field"
 * diagnostic that fires on genuine engine plugins is noise, and noise is what this package exists
 * to remove.
 *
 * Run: bun test/keys.census.mjs "<dir>" [more dirs]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";

const roots = process.argv.slice(2);
const keys = new Map();
const refKeys = new Map();
const moduleKeys = new Map();
const files = { count: 0, failed: [] };

function bump(map, key) {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const p = join(dir, entry);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			if (!["Binaries", "Intermediate", "Saved", "ThirdParty", ".git"].includes(entry)) walk(p);
			continue;
		}
		if (!entry.endsWith(".uplugin")) continue;
		files.count++;
		const errors = [];
		const res = parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""), errors, {
			allowTrailingComma: true,
			disallowComments: false,
		});
		if (errors.length > 0) {
			files.failed.push(`${p} :: ${errors.map((e) => e.error).join(",")}`);
		}
		if (!res || typeof res !== "object") {
			files.failed.push(p);
			continue;
		}
		for (const k of Object.keys(res)) bump(keys, k);
		for (const pref of Array.isArray(res.Plugins) ? res.Plugins : []) {
			if (!pref || typeof pref !== "object") continue;
			for (const k of Object.keys(pref)) bump(refKeys, k);
		}
		for (const mod of Array.isArray(res.Modules) ? res.Modules : []) {
			if (!mod || typeof mod !== "object") continue;
			for (const k of Object.keys(mod)) bump(moduleKeys, k);
		}
	}
}

for (const root of roots) walk(root);

console.log(`uplugin files: ${files.count}  with parse errors: ${files.failed.length}`);
for (const line of files.failed.slice(0, 10)) console.log(`  FAIL ${line}`);
const fmt = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}(${c})`).join(" ");
console.log(`\nUPLUGIN KEYS: ${fmt(keys)}`);
console.log(`\nPLUGIN-REFERENCE KEYS: ${fmt(refKeys)}`);
console.log(`\nMODULE KEYS: ${fmt(moduleKeys)}`);
