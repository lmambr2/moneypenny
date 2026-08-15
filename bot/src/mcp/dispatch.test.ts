import { describe, expect, it } from "vitest";
import { buildPlayCommand, simpleCommand } from "./dispatch.js";

describe("buildPlayCommand", () => {
  it("maps the three music platforms to command flags", () => {
    expect(buildPlayCommand("play", "neon", "youtube")?.flags.has("y")).toBe(true);
    expect(buildPlayCommand("add", "neon", "stream")?.flags.has("s")).toBe(true);
    expect(buildPlayCommand("playnext", "neon", "local")?.flags.has("l")).toBe(true);
  });

  it("rejects an unknown platform instead of dropping the flag (local default)", () => {
    expect(buildPlayCommand("play", "neon", "spotify")).toBeNull();
    expect(buildPlayCommand("play", "neon", "tidal")).toBeNull();
  });

  it("omitted platform stays flagless (local-first default)", () => {
    const cmd = buildPlayCommand("play", "neon");
    expect(cmd?.name).toBe("play");
    expect(cmd?.flags.size).toBe(0);
    expect(cmd?.args).toBe("neon");
  });
});

describe("simpleCommand", () => {
  it("parses a bare verb", () => {
    expect(simpleCommand("skip")?.name).toBe("skip");
  });
});
