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
const SRC = readFileSync(fileURLToPath(new URL("./executor.ts", import.meta.url)), "utf8");

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

describe("queue-replacing commands declare their play mode", () => {
  const fns = functionsOf(SRC);

  const replacers = [...fns.entries()].filter(
    ([, body]) => body.includes("queue.clear()") && body.includes("queue.add("),
  );

  it("finds the queue-replacing commands (guards the scan itself)", () => {
    // If this drops to zero the regex has rotted and the test below is vacuous.
    expect(replacers.length).toBeGreaterThanOrEqual(4);
  });

  it.each(replacers.map(([name]) => name))(
    "%s sets an explicit PlayMode instead of inheriting the previous one",
    (name) => {
      const body = fns.get(name)!;
      expect(body).toMatch(/setMode\??\.?\(\s*PlayMode\./);
    },
  );
});
