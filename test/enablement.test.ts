import { describe, expect, it } from "bun:test";
import { computeEnablementClosure, enablementIndexRoots, type PluginIndex, type PluginSummary } from "../extensions/unreal/lib/plugin-resolver.ts";
import type { PluginReference, UprojectDescriptor } from "../extensions/unreal/lib/descriptors.ts";

/**
 * The 2026-11-11 field session asked `unreal_context` about PhysicsControl and was told it needed a
 * `.uproject` reference — while the editor log said `Mounting Engine plugin PhysicsControl`, because
 * `AnimatorKit` (EnabledByDefault) declares it. `PluginManager` loads on three grounds (reference,
 * EnabledByDefault, declaration by another loaded plugin); these tests pin that walk.
 */

function plugin(name: string, options: { enabledByDefault?: boolean; declares?: string[]; disabledDeclarations?: string[]; source?: PluginSummary["source"] } = {}): PluginSummary {
	const declares = options.declares ?? [];
	const disabled = options.disabledDeclarations ?? [];
	return {
		name,
		path: `/engine/Plugins/${name}/${name}.uplugin`,
		dir: `/engine/Plugins/${name}`,
		source: options.source ?? "Engine",
		enabledByDefault: options.enabledByDefault ?? false,
		canContainContent: false,
		isBetaVersion: false,
		installed: true,
		supportedTargetPlatforms: [],
		modules: [{ moduleName: name, type: "Runtime" }],
		plugins: [
			...declares.map((dep) => ({ name: dep, enabled: true, optional: false, activate: false })),
			...disabled.map((dep) => ({ name: dep, enabled: false, optional: false, activate: false })),
		],
		diagnostics: [],
	};
}

function indexOf(entries: PluginSummary[]): PluginIndex {
	return {
		additionalDirs: [],
		scannedDirs: [],
		scannedFiles: entries.length,
		entries,
		byName: new Map(entries.map((entry) => [entry.name.toLowerCase(), [entry]])),
		builtAtMs: 0,
	};
}

function descriptor(plugins: PluginReference[], options: { disableEnginePluginsByDefault?: boolean } = {}): UprojectDescriptor {
	return {
		path: "/project/Game.uproject",
		enterprise: false,
		disableEnginePluginsByDefault: options.disableEnginePluginsByDefault ?? false,
		modules: [],
		plugins,
		targetPlatforms: [],
		additionalPluginDirectories: [],
		additionalRootDirectories: [],
		knownFields: [],
		unknownFields: [],
		diagnostics: [],
	};
}

const ref = (name: string, enabled = true): PluginReference => ({ name, enabled, optional: false, activate: false, supportedTargetPlatforms: [] });

describe("enablement closure (loaded is not the same as referenced)", () => {
	it("follows a declaration chain and records who declared the plugin", () => {
		const entries = [plugin("Chooser"), plugin("BlendStack", { declares: ["Chooser"] }), plugin("AnimatorKit", { enabledByDefault: true }), plugin("PhysicsControl", { declares: [] })];
		const closure = computeEnablementClosure(descriptor([ref("BlendStack")]), indexOf(entries));

		const blend = closure.byName.get("blendstack")!;
		expect(blend.kind).toBe("reference");
		expect(blend.chain).toEqual(["uproject:BlendStack"]);
		expect(blend.depth).toBe(0);

		const chooser = closure.byName.get("chooser")!;
		expect(chooser.kind).toBe("dependency");
		expect(chooser.via).toBe("BlendStack");
		expect(chooser.chain).toEqual(["uproject:BlendStack", "BlendStack"]);
		expect(chooser.depth).toBe(1);

		expect(closure.referenced.map((entry) => entry.name)).toEqual(["BlendStack"]);
		expect(closure.defaultEnabled.map((entry) => entry.name)).toEqual(["AnimatorKit"]);
	});

	it("walks deeper than one level, and prefers the shortest chain", () => {
		const entries = [plugin("A"), plugin("B", { declares: ["A"] }), plugin("C", { declares: ["B"] }), plugin("D", { enabledByDefault: true, declares: ["A", "C"] })];
		const closure = computeEnablementClosure(descriptor([ref("C")]), indexOf(entries));
		// A is reachable as C -> B -> A and as D -> A; the shortest (depth 1) chain wins.
		expect(closure.byName.get("a")!.chain).toEqual(["EnabledByDefault:D", "D"]);
		expect(closure.byName.get("b")!.chain).toEqual(["uproject:C", "C"]);
		expect(closure.byName.get("b")!.depth).toBe(1);
		expect(closure.dependencies.map((entry) => entry.name).sort()).toEqual(["A", "B"]);
	});

	it("honours Enabled: false on a reference and on a declared dependency", () => {
		const entries = [plugin("Off"), plugin("Parent", { declares: ["Child"], disabledDeclarations: ["Blocked"] }), plugin("Child"), plugin("Blocked"), plugin("Kept")];
		const closure = computeEnablementClosure(descriptor([ref("Off", false), ref("Parent"), ref("Kept")]), indexOf(entries));
		expect(closure.byName.has("off")).toBe(false);
		expect(closure.byName.get("child")!.kind).toBe("dependency");
		expect(closure.byName.has("blocked")).toBe(false);
		expect(closure.byName.get("kept")!.kind).toBe("reference");
	});

	it("skips a declared dependency the index does not have (Optional references)", () => {
		const closure = computeEnablementClosure(descriptor([ref("Parent")]), indexOf([plugin("Parent", { declares: ["Ghost"] })]));
		expect(closure.byName.has("ghost")).toBe(false);
		expect(closure.byName.get("parent")!.kind).toBe("reference");
	});

	it("honours DisableEnginePluginsByDefault for engine defaults only", () => {
		const entries = [plugin("EngineDefault", { enabledByDefault: true }), plugin("ProjectDefault", { enabledByDefault: true, source: "Project" })];
		const closure = computeEnablementClosure(descriptor([], { disableEnginePluginsByDefault: true }), indexOf(entries));
		expect(closure.byName.has("enginedefault")).toBe(false);
		expect(closure.byName.get("projectdefault")!.kind).toBe("default");
	});

	it("terminates on a declaration cycle", () => {
		const entries = [plugin("Ping", { declares: ["Pong"] }), plugin("Pong", { declares: ["Ping"] })];
		const closure = computeEnablementClosure(descriptor([ref("Ping")]), indexOf(entries));
		expect(closure.byName.size).toBe(2);
		expect(closure.byName.get("pong")!.kind).toBe("dependency");
	});

	it("indexes the references plus their direct dependencies, and nothing from the default bulk", () => {
		const entries = [
			plugin("Chooser"),
			plugin("BlendStack", { declares: ["Chooser"] }),
			plugin("AnimatorKit", { enabledByDefault: true, declares: ["PhysicsControl"] }),
			plugin("PhysicsControl", { declares: ["DeepDep"] }),
			plugin("DeepDep"),
			plugin("Unrelated", { enabledByDefault: true }),
		];
		const roots = enablementIndexRoots(computeEnablementClosure(descriptor([ref("BlendStack")]), indexOf(entries)));
		// References + one hop: Chooser (declared by the reference) and PhysicsControl (declared by an
		// EnabledByDefault plugin). DeepDep is two hops from any seed: pluginAreas territory.
		expect(roots.map((entry) => entry.name).sort()).toEqual(["BlendStack", "Chooser", "PhysicsControl"]);
	});
});
