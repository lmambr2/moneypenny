/**
 * CJS loader for the N-API binary (PR-B4).
 * Callers catch load errors and fall back to @discordjs/opus / TS VAD.
 */
"use strict";

const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { arch, platform } = require("node:os");

function platformTriple() {
  const p = platform();
  const a = arch();
  if (p === "linux" && a === "x64") return "linux-x64-gnu";
  if (p === "linux" && a === "arm64") return "linux-arm64-gnu";
  if (p === "darwin" && a === "x64") return "darwin-x64";
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "win32" && a === "x64") return "win32-x64-msvc";
  return `${p}-${a}`;
}

function load() {
  const candidates = [
    join(__dirname, `audio-native.${platformTriple()}.node`),
    join(__dirname, "audio-native.node"),
  ];
  const errors = [];
  for (const p of candidates) {
    if (!existsSync(p)) {
      errors.push(`${p}: missing`);
      continue;
    }
    try {
      return require(p);
    } catch (e) {
      errors.push(`${p}: ${e.message}`);
    }
  }
  throw new Error(
    `@moneypenny/audio-native: native addon not loadable (${errors.join("; ")}). Run: npm run build -w @moneypenny/audio-native`,
  );
}

module.exports = load();
