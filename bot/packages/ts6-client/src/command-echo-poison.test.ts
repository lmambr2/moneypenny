import { describe, expect, it } from "vitest";
import { isCommandEchoPoison, sanitizeOutboundCommandPrefix } from "./client.js";

describe("isCommandEchoPoison", () => {
  it("flags the historical skip usage flood string", () => {
    expect(
      isCommandEchoPoison(
        "!skip / !next only advance the queue. To start a title or URL now: !jump <query|url> (or !go). To put it up next without cutting: !playnext <query|url>.",
      ),
    ).toBe(true);
    expect(isCommandEchoPoison("!skip / !next only advance the queue.")).toBe(true);
  });

  it("allows normal human skip commands", () => {
    expect(isCommandEchoPoison("!skip")).toBe(false);
    expect(isCommandEchoPoison("!skip ella")).toBe(false);
    expect(isCommandEchoPoison("Skipped — now playing: Foo")).toBe(false);
  });
});

describe("sanitizeOutboundCommandPrefix", () => {
  it("rewrites a leading !command so re-parse cannot treat it as a command", () => {
    const out = sanitizeOutboundCommandPrefix(
      "!skip / !next only advance the queue. To start a title now: !jump x",
    );
    expect(out.startsWith("!")).toBe(false);
    expect(out.startsWith("！")).toBe(true);
  });

  it("leaves normal replies alone", () => {
    expect(sanitizeOutboundCommandPrefix("Skipped — now playing: X")).toBe(
      "Skipped — now playing: X",
    );
    expect(sanitizeOutboundCommandPrefix("Queue is empty")).toBe("Queue is empty");
  });
});
