#!/usr/bin/env node
/**
 * Light RAG / org-memory eval (R3) — calls admin API or runs unit fixtures.
 *
 *   node scripts/rag-eval.mjs --fixtures   # offline unit path via vitest
 *   node scripts/rag-eval.mjs --url http://127.0.0.1:3000 --cookie 'mp_session=…'
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.includes("--fixtures") || args.length === 0) {
  console.log("Running eval-loop unit fixtures…");
  const r = spawnSync(
    "npx",
    ["vitest", "run", "src/rag/eval-loop.test.ts"],
    { cwd: join(root, "bot"), stdio: "inherit", shell: true },
  );
  process.exit(r.status ?? 1);
}

const urlIdx = args.indexOf("--url");
const cookieIdx = args.indexOf("--cookie");
const base = urlIdx >= 0 ? args[urlIdx + 1] : "http://127.0.0.1:3000";
const cookie = cookieIdx >= 0 ? args[cookieIdx + 1] : "";

const res = await fetch(`${base.replace(/\/$/, "")}/api/bot/rag/eval`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(cookie ? { Cookie: cookie } : {}),
  },
  body: "{}",
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
process.exit(data.ok ? 0 : 1);
