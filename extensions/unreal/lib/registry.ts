/**
 * Windows registry / launcher enumeration for Unreal Engine installs.
 *
 * Source of truth mirrored from engine code:
 *   Engine/Source/Developer/DesktopPlatform/Private/DesktopPlatformWindows.cpp
 *     - `HKLM:\SOFTWARE\EpicGames\Unreal Engine\<version>` -> `InstalledDirectory`
 *     - `HKLM:\SOFTWARE\EpicGames\Unreal Engine` default value (INSTALLDIR)
 *     - `HKCU:\SOFTWARE\Epic Games\Unreal Engine\Builds` -> value name is the GUID
 *       association identifier, value data is the engine root (source builds)
 *   Engine/Source/Developer/DesktopPlatform/Private/DesktopPlatformBase.cpp
 *     - `%PROGRAMDATA%\UnrealEngineLauncher\LauncherInstalled.dat`
 *
 * Reads only. This module never writes a registry key — which matters, because the engine's
 * own `GetEngineIdentifierFromRootDir()` falls back to `RegisterEngineInstallation()` and
 * *writes* `HKCU\...\Builds` when it cannot map a directory. An inspection tool must not do that.
 *
 * `pwsh` is used instead of `reg.exe` because `reg.exe` arguments get mangled by MSYS path
 * conversion in Git-Bash style shells on this machine (verified: `/s` becomes `S:/`, and
 * `MSYS_NO_PATHCONV=1` does not prevent it).
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HklmEngineKey {
	version: string;
	installedDirectory?: string;
	/** `(Default)` value, historically the INSTALLDIR. */
	installDirDefault?: string;
}

export interface HkcuBuildEntry {
	/** Value name: the GUID association identifier written into `.uproject`. */
	identifier: string;
	/** Value data: engine root directory. */
	root: string;
}

export interface RegistrySnapshot {
	/** False when not Windows, `pwsh` is missing, or the registry read failed. */
	available: boolean;
	hklmVersions: HklmEngineKey[];
	hkcuBuilds: HkcuBuildEntry[];
	installDirDefault?: string;
	launcherDat?: { appName: string; installLocation: string; buildVersion?: string }[];
	launcherDatPath: string;
	launcherDatExists: boolean;
	envUnrealEngine?: string;
	error?: string;
}

export type RegistryReader = () => Promise<RegistrySnapshot>;

const EMPTY: RegistrySnapshot = {
	available: false,
	hklmVersions: [],
	hkcuBuilds: [],
	launcherDatPath: "",
	launcherDatExists: false,
};

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{
  hklmVersions      = @()
  hkcuBuilds        = @()
  installDirDefault = $null
  launcherDat       = @()
  launcherDatPath   = ''
  launcherDatExists = $false
  envUnrealEngine   = $env:UNREAL_ENGINE
  error             = $null
}
try {
  $root = 'HKLM:\\SOFTWARE\\EpicGames\\Unreal Engine'
  foreach ($key in (Get-ChildItem -Path $root -ErrorAction SilentlyContinue)) {
    $p = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
    $out.hklmVersions += [ordered]@{
      version            = $key.PSChildName
      installedDirectory = [string]$p.'InstalledDirectory'
      installDirDefault  = [string]$p.'(Default)'
    }
  }
  $base = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
  $out.installDirDefault = [string]$base.'(Default)'

  $builds = Get-ItemProperty -Path 'HKCU:\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds' -ErrorAction SilentlyContinue
  if ($builds) {
    foreach ($prop in $builds.PSObject.Properties) {
      if ($prop.Name -like 'PS*') { continue }
      $out.hkcuBuilds += [ordered]@{ identifier = $prop.Name; root = [string]$prop.Value }
    }
  }

  $dat = Join-Path $env:PROGRAMDATA 'UnrealEngineLauncher\\LauncherInstalled.dat'
  $out.launcherDatPath = $dat
  $out.launcherDatExists = Test-Path -LiteralPath $dat
  if ($out.launcherDatExists) {
    $json = Get-Content -Raw -LiteralPath $dat | ConvertFrom-Json
    foreach ($entry in $json.InstallationList) {
      $out.launcherDat += [ordered]@{
        appName        = [string]$entry.AppName
        installLocation = [string]$entry.InstallLocation
        buildVersion   = [string]$entry.BuildVersion
      }
    }
  }
} catch {
  $out.error = $_.Exception.Message
}
$result = [ordered]@{
  hklmVersions      = [array]$out.hklmVersions
  hkcuBuilds        = [array]$out.hkcuBuilds
  installDirDefault = $out.installDirDefault
  launcherDat       = [array]$out.launcherDat
  launcherDatPath   = $out.launcherDatPath
  launcherDatExists = $out.launcherDatExists
  envUnrealEngine   = $out.envUnrealEngine
  error             = $out.error
}
$result | ConvertTo-Json -Depth 6 -Compress
`;

/* The arrays are cast explicitly so `ConvertTo-Json` cannot collapse a one-element array into a
   bare object (PowerShell's habit); `toArray` below normalizes them again on the TypeScript side. */

export interface WindowsRegistryReaderOptions {
	/** Milliseconds before the registry probe is abandoned. Default 8000. */
	timeoutMs?: number;
	/** Override for tests / non-default shells. */
	pwshPath?: string;
}

/**
 * Reads the registry once per process and memoizes the result. Never throws: a missing shell
 * or non-Windows host degrades to `available: false` so callers fall back to file-based sources.
 */
export function createWindowsRegistryReader(options: WindowsRegistryReaderOptions = {}): RegistryReader {
	let pending: Promise<RegistrySnapshot> | undefined;
	return () => {
		if (pending) return pending;
		pending = readRegistrySnapshot(options);
		return pending;
	};
}

async function readRegistrySnapshot(options: WindowsRegistryReaderOptions): Promise<RegistrySnapshot> {
	if (process.platform !== "win32") {
		return { ...EMPTY, launcherDatPath: "", error: `platform ${process.platform}: registry sources unavailable` };
	}
	const timeoutMs = options.timeoutMs ?? 8000;
	const scriptPath = options.pwshPath ? undefined : join(tmpdir(), "pi-unreal-registry.ps1");
	try {
		if (scriptPath) writeFileSync(scriptPath, PS_SCRIPT, "utf8");
		const command = options.pwshPath ?? "pwsh";
		const args = scriptPath
			? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
			: ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT];
		const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
			execFile(
				command,
				args,
				{ windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs },
				(error, out, err) => {
					if (error) reject(new Error(`${command} failed: ${error.message}${err ? ` | ${err.trim()}` : ""}`));
					else resolve({ stdout: out });
				},
			);
		});
		const raw = JSON.parse(stdout.trim()) as Partial<RegistrySnapshot> & Record<string, unknown>;
		return {
			available: true,
			hklmVersions: (raw.hklmVersions as HklmEngineKey[]) ?? [],
			hkcuBuilds: (raw.hkcuBuilds as HkcuBuildEntry[]) ?? [],
			installDirDefault: cleanDir(raw.installDirDefault),
			launcherDat: (raw.launcherDat as RegistrySnapshot["launcherDat"]) ?? [],
			launcherDatPath: normalizeOut(raw.launcherDatPath),
			launcherDatExists: Boolean(raw.launcherDatExists),
			envUnrealEngine: cleanDir(raw.envUnrealEngine),
			error: raw.error ? String(raw.error) : undefined,
		};
	} catch (error) {
		return {
			...EMPTY,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function normalizeOut(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

function cleanDir(value: unknown): string | undefined {
	const text = normalizeOut(value);
	return text ? text : undefined;
}

/** Registry snapshot from data, for tests and for `--engine-root` style overrides. */
export function createStaticRegistryReader(snapshot: Partial<RegistrySnapshot>): RegistryReader {
	const resolved: RegistrySnapshot = { ...EMPTY, ...snapshot, available: snapshot.available ?? true };
	return async () => resolved;
}

export const noRegistry: RegistryReader = async () => ({ ...EMPTY, error: "registry sources disabled" });
