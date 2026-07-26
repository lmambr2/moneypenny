#!/usr/bin/env node
/**
 * Fail when a native addon requires a newer glibc than the runtime image has.
 *
 * CI runners ship a newer glibc than `node:*-bookworm-slim` (Debian 12,
 * GLIBC 2.36). An addon can therefore load perfectly in CI and still die at
 * runtime with:
 *
 *   Error: /lib/aarch64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found
 *
 * That is exactly how better-sqlite3 13 reached production: it ships a
 * linux-arm64 prebuild built against GLIBC 2.38, every CI check was green, and
 * the container crash-looped on the Pi. `npm ls` and a require() both pass —
 * only the symbol versions in the binary reveal it.
 *
 * Scope: only PREBUILT artifacts (`prebuilds/` / `prebuild/`), because those
 * ship and load as-is. Addons compiled at install time (`build/Release/…`) are
 * built against whatever glibc is present — on this dev box or inside the
 * bookworm image — so their tags say nothing about the runtime. Pass --all to
 * check every .node anyway, which is meaningful only when run inside an
 * environment that matches the runtime image.
 *
 * Reads the GLIBC_x.y version tags out of each .node binary and compares them
 * to the floor. Uses `strings` when available, else scans the file for the
 * literal tags, so it needs no toolchain.
 *
 * Usage: node bot/scripts/check-glibc-floor.mjs [--floor 2.36] [--all] [dir ...]
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = process.argv.slice(2);
let floor = "2.36"; // node:*-bookworm-slim (Debian 12)
let checkAll = false;
const dirs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--floor") {
    floor = args[++i] ?? floor;
  } else if (args[i] === "--all") {
    checkAll = true;
  } else {
    dirs.push(args[i]);
  }
}

/** Shipped-as-is prebuilt artifact, versus one compiled during install. */
function isPrebuilt(file) {
  return /(^|[\\/])(prebuilds|prebuild)[\\/]/.test(file);
}
if (dirs.length === 0) {
  dirs.push(path.join(repoRoot, "bot", "node_modules"), path.join(repoRoot, "bot", "packages"));
}

function cmpVersion(a, b) {
  const [am, an] = a.split(".").map(Number);
  const [bm, bn] = b.split(".").map(Number);
  return am !== bm ? am - bm : an - bn;
}

/** Recursively collect .node binaries, skipping nested build scratch dirs. */
function findNodeBinaries(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "target" || e.name === "obj.target") continue;
      findNodeBinaries(full, out, depth + 1);
    } else if (e.isFile() && e.name.endsWith(".node")) {
      out.push(full);
    }
  }
  return out;
}

/** GLIBC_x.y tags referenced by a binary. */
function glibcTags(file) {
  let text = "";
  try {
    text = execFileSync("strings", ["-a", file], {
      encoding: "latin1",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    try {
      text = readFileSync(file, "latin1");
    } catch {
      return [];
    }
  }
  const tags = new Set();
  for (const m of text.matchAll(/GLIBC_(\d+\.\d+)/g)) tags.add(m[1]);
  return [...tags];
}

let failed = false;
let checked = 0;

for (const dir of dirs) {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    continue;
  }
  if (!isDir) continue;

  for (const file of findNodeBinaries(dir)) {
    if (!checkAll && !isPrebuilt(file)) continue;
    const tags = glibcTags(file);
    if (tags.length === 0) continue;
    checked++;
    const worst = tags.reduce((a, b) => (cmpVersion(a, b) >= 0 ? a : b));
    const rel = path.relative(repoRoot, file);
    if (cmpVersion(worst, floor) > 0) {
      console.error(`✗ ${rel} requires GLIBC_${worst} > floor ${floor}`);
      failed = true;
    } else {
      console.log(`✓ ${rel} (max GLIBC_${worst})`);
    }
  }
}

if (checked === 0) {
  console.log(
    checkAll
      ? "· no native addons found to check"
      : "· no prebuilt addons found (install-time builds are not checked; use --all)",
  );
}
if (failed) {
  console.error(
    `\nAn addon needs a newer glibc than the runtime image (floor ${floor}, ` +
      `node:*-bookworm-slim = Debian 12). It will crash at startup with ` +
      `ERR_DLOPEN_FAILED even though CI passed. Pin the dependency back, force a ` +
      `source build, or move the image to a newer Debian base.`,
  );
}
process.exit(failed ? 1 : 0);
