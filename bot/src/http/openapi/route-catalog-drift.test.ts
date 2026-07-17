/**
 * PR — API ops: fail CI when Express routes drift from OpenAPI catalog.
 * Regenerating: hand-edit operations.ts (or run scripts/sync-openapi-routes.mjs).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_OPERATIONS } from "./operations.js";

const here = dirname(fileURLToPath(import.meta.url));
const botSrc = join(here, "../..");

const FILE_MOUNT: Record<string, string> = {
  "session.ts": "/api/session",
  "bot.ts": "/api/bot",
  "music.ts": "/api/music",
  "player.ts": "/api/player",
  "auth.ts": "/api/auth",
  "economy.ts": "/api/economy",
  "users.ts": "/api/users",
  "audit.ts": "/api/audit",
  "rag.ts": "/api/rag",
};

const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
const APP_RE = /app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;

function normalizePath(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, "{$1}");
}

function collectRouterRoutes(): Set<string> {
  const out = new Set<string>();
  const apiDir = join(botSrc, "web/api");
  for (const name of readdirSync(apiDir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const base = FILE_MOUNT[name];
    if (!base) continue;
    const text = readFileSync(join(apiDir, name), "utf8");
    for (const m of text.matchAll(ROUTE_RE)) {
      const method = m[1].toLowerCase();
      const rel = m[2];
      const full = rel === "/" ? base : base + (rel.startsWith("/") ? rel : `/${rel}`);
      out.add(`${method} ${normalizePath(full)}`);
    }
  }
  // app.get/post on http plugins (health, openapi, /v1/turn, docs)
  const httpRoot = join(botSrc, "http");
  const stack = [httpRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) {
        if (name.name !== "node_modules") stack.push(p);
        continue;
      }
      if (!name.name.endsWith(".ts") || name.name.includes(".test.")) continue;
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(APP_RE)) {
        out.add(`${m[1].toLowerCase()} ${normalizePath(m[2])}`);
      }
    }
  }
  return out;
}

describe("OpenAPI route catalog drift", () => {
  it("catalog matches Express router + app mounts", () => {
    const live = collectRouterRoutes();
    const catalog = new Set(API_OPERATIONS.map((o) => `${o.method} ${o.path}`));

    const missing = [...live].filter((k) => !catalog.has(k)).sort();
    const extra = [...catalog].filter((k) => !live.has(k)).sort();

    expect(missing, `routes missing from API_OPERATIONS:\n${missing.join("\n")}`).toEqual([]);
    expect(extra, `catalog entries with no route:\n${extra.join("\n")}`).toEqual([]);
  });
});
