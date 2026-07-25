#!/usr/bin/env node
/**
 * Fail when a package.json `allowScripts` key no longer matches the version
 * actually installed.
 *
 * npm >= 12 blocks dependency install/postinstall scripts unless `allowScripts`
 * covers them, and the keys are version-pinned (`better-sqlite3@13.0.1`). Bump
 * the dependency without bumping the key and npm silently stops building the
 * native addon: `npm ci` still exits 0, and the failure only surfaces later as
 * "Could not locate the bindings file". Dependency bots do not update these
 * keys, so this drifts on any native-dep upgrade.
 *
 * Usage: node scripts/check-allow-scripts.mjs [packageDir ...]
 * Defaults to `bot` and `bot/web`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = process.argv.slice(2);
const packageDirs = targets.length > 0 ? targets : ["bot", path.join("bot", "web")];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Installed version from the package's own node_modules, or null when absent. */
function installedVersion(packageDir, depName) {
  const manifest = path.join(repoRoot, packageDir, "node_modules", depName, "package.json");
  try {
    return readJson(manifest).version;
  } catch {
    return null;
  }
}

let failed = false;

for (const packageDir of packageDirs) {
  const manifestPath = path.join(repoRoot, packageDir, "package.json");
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (err) {
    console.error(`✗ ${packageDir}: cannot read package.json — ${err.message}`);
    failed = true;
    continue;
  }

  const allowScripts = manifest.allowScripts;
  if (!allowScripts || Object.keys(allowScripts).length === 0) {
    console.log(`· ${packageDir}: no allowScripts entries`);
    continue;
  }

  for (const [key, allowed] of Object.entries(allowScripts)) {
    // Only allowed entries matter. A denied entry that drifts just means npm
    // asks about the new version again — it never silently skips a build.
    if (!allowed) continue;

    // Keys look like `name@version`; scoped names keep their leading @.
    const at = key.lastIndexOf("@");
    if (at <= 0) {
      console.error(`✗ ${packageDir}: allowScripts key "${key}" is not name@version`);
      failed = true;
      continue;
    }
    const depName = key.slice(0, at);
    const pinnedVersion = key.slice(at + 1);
    const actual = installedVersion(packageDir, depName);

    if (actual === null) {
      console.error(
        `✗ ${packageDir}: allowScripts lists ${key} but ${depName} is not installed — ` +
          `drop the stale key`,
      );
      failed = true;
    } else if (actual !== pinnedVersion) {
      console.error(
        `✗ ${packageDir}: allowScripts pins ${key} but ${actual} is installed — ` +
          `its install script is being SKIPPED. Run: npm install-scripts approve ${depName}`,
      );
      failed = true;
    } else {
      console.log(`✓ ${packageDir}: ${key}`);
    }
  }
}

process.exit(failed ? 1 : 0);
