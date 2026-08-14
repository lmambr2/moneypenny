import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Queue mode is shared mutable state: PlayQueue keeps whatever the last feature
 * set. Three separate "song repeating" bugs came from that, the worst being
 * !play — which clears the queue to ONE track, then inherited the RandomLoop
 * default, whose single-song branch replays forever.
 *
 * So the invariant is structural, not behavioural: any command that REPLACES
 * the queue must declare the mode it wants. This is a parity test in the same
 * spirit as the COMMAND_MANIFEST ones — it fails when a NEW command is written
 * with the old habit, which no per-command test would catch.
 */
/**
 * Every file that can REPLACE the queue, not just executor.ts. The first cut of
 * this test only scanned executor.ts and therefore missed playDemoTrack() in
 * engine.ts — !test kept looping in production while this test stayed green.
 * A guard scoped narrower than the bug class is worse than none: it reads as
 * coverage.
 */
const SOURCES: Array<[string, string]> = (
  [
    ["executor.ts", "./executor.ts"],
    ["engine.ts", "../playback/engine.ts"],
  ] as Array<[string, string]>
).map(([label, rel]) => [
  label,
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
]);

/** Split the class body into `private/async name(...)` chunks. */
function functionsOf(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^ {2}(?:private |public )?(?:async )?(\w+)\(/gm;
  const starts: Array<{ name: string; at: number }> = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    starts.push({ name: m[1]!, at: m.index });
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    out.set(s.name, src.slice(s.at, starts[i + 1]?.at ?? src.length));
  }
  return out;
}

/**
 * One replacement SITE = a `queue.clear()` and the `queue.play()`/`playAt()`
 * that follows it. Checking whole functions is too coarse: playDemoTrack has
 * two independent replace paths, so a function-level check passes even when one
 * of them forgot its mode.
 */
function replacementSites(body: string): string[] {
  const out: string[] = [];
  const clearRe = /queue\.clear\(\)/g;
  for (let m = clearRe.exec(body); m; m = clearRe.exec(body)) {
    const rest = body.slice(m.index);
    const end = rest.search(/queue\.(play|playAt)\(/);
    if (end < 0) continue; // a bare clear (e.g. !stop) queues nothing
    const site = rest.slice(0, end);
    if (!/queue\.(add|addMany)\(/.test(site)) continue; // cleared but not refilled
    out.push(site);
  }
  return out;
}

describe("queue-replacing code declares its play mode", () => {
  const sites: Array<[string, string]> = [];
  for (const [label, src] of SOURCES) {
    for (const [name, body] of functionsOf(src)) {
      replacementSites(body).forEach((site, i) => {
        sites.push([`${label}:${name}#${i + 1}`, site]);
      });
    }
  }

  it("finds replacement sites in every scanned file (guards the scan itself)", () => {
    for (const [label] of SOURCES) {
      expect(sites.some(([id]) => id.startsWith(`${label}:`))).toBe(true);
    }
    expect(sites.length).toBeGreaterThanOrEqual(8);
  });

  it.each(sites.map(([id]) => id))(
    "%s sets an explicit PlayMode instead of inheriting the previous one",
    (id) => {
      const site = sites.find(([x]) => x === id)![1];
      expect(site).toMatch(/setMode\??\.?\(\s*PlayMode\./);
    },
  );
});
