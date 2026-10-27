// Regenerates the fixture .uproject files (run: node test/write-fixtures.cjs).
const fs = require("fs");
const path = require("path");

const F = path.join(__dirname, "fixtures");
const projDir = path.join(F, "ProjDir").replace(/\\/g, "/");

const refs = [
	{ Name: "Alpha" },
	{ Name: "Shared" },
	{ Name: "Legacy" },
	{ Name: "Beta" },
	{ Name: "NoModules" },
	{ Name: "Ghost", Optional: true },
	{ Name: "ModOnly" },
	{ Name: "ExtraPlug" },
	{ Name: "Alpha", Enabled: false },
];

function refLines(list) {
	return list
		.map((r) => {
			const parts = [`\t\t\t"Name": ${JSON.stringify(r.Name)}`];
			if (r.Optional) parts.push('\t\t\t"Optional": true');
			parts.push(`\t\t\t"Enabled": ${r.Enabled === false ? "false" : "true"}`);
			return `\t\t{\n${parts.join(",\n")}\n\t\t},`;
		})
		.join("\n");
}

fs.writeFileSync(
	path.join(F, "ProjDir", "Fixture.uproject"),
	`// JSONC fixture: comments, a trailing comma, and a key the engine does not serialize.\n{\n\t"FileVersion": 3,\n\t"EngineAssociation": "5.8",\n\t"Category": "Testing",\n\t"Description": "Fixture project",\n\t"Modules": [\n\t\t{ "Name": "Fixture", "Type": "Runtime", "LoadingPhase": "Default" },\n\t\t{ "Name": "FixtureEditor", "Type": "Editor", "LoadingPhase": "Default", "AdditionalDependencies": ["UnrealEd"] },\n\t],\n\t"Plugins": [\n${refLines(refs)}\n\t],\n\t"TargetPlatforms": [ "Windows", "Android", ],\n\t"AdditionalPluginDirectories": [\n\t\t"${ROOT}/ProjDir/Extra"\n\t],\n\t"NotAnEngineField": true,\n}\n`,
);

fs.writeFileSync(
	path.join(F, "Bom.uproject"),
	"﻿{\n\t\"FileVersion\": 3,\n\t\"EngineAssociation\": \"5.8\",\n\t\"Modules\": [\n\t\t{ \"Name\": \"Bom\", \"Type\": \"Runtime\", \"LoadingPhase\": \"PostEngineInit\" }\n\t]\n}\n",
);

// A plugin reference without the mandatory "Enabled" field (UE 5.8 refuses to load it).
fs.writeFileSync(
	path.join(F, "ProjNoEnabled.uproject"),
	'{\n\t"FileVersion": 3,\n\t"EngineAssociation": "5.8",\n\t"Modules": [ { "Name": "NoEnabled", "Type": "Runtime" } ],\n\t"Plugins": [ { "Name": "Alpha" } ]\n}\n',
);

console.log("fixtures written");
