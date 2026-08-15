import { describe, expect, it } from "vitest";
import { isKnownCommand, parseCommand } from "./commands.js";

describe("Command Parser", () => {
  it("parses simple command", () => {
    const result = parseCommand("!play Bohemian Rhapsody", "!");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("play");
    expect(result!.args).toBe("Bohemian Rhapsody");
    expect(result!.rawArgs).toEqual(["Bohemian", "Rhapsody"]);
  });

  it("parses command with flags", () => {
    const result = parseCommand("!play -y Hotel California", "!");
    expect(result!.name).toBe("play");
    expect(result!.flags.has("y")).toBe(true);
    expect(result!.args).toBe("Hotel California");
  });

  it("returns null for non-command messages", () => {
    expect(parseCommand("hello world", "!")).toBeNull();
    expect(parseCommand("", "!")).toBeNull();
  });

  it("handles custom prefix", () => {
    const result = parseCommand("/play test", "/");
    expect(result!.name).toBe("play");
    expect(result!.args).toBe("test");
  });

  it("resolves aliases", () => {
    const aliases = { p: "play", s: "skip", n: "skip" };
    const result = parseCommand("!p Stairway to Heaven", "!", aliases);
    expect(result!.name).toBe("play");
    expect(result!.args).toBe("Stairway to Heaven");
  });

  it("parses command with no args", () => {
    const result = parseCommand("!pause", "!");
    expect(result!.name).toBe("pause");
    expect(result!.args).toBe("");
    expect(result!.rawArgs).toEqual([]);
  });

  it("parses vol command with number arg", () => {
    const result = parseCommand("!vol 80", "!");
    expect(result!.name).toBe("vol");
    expect(result!.args).toBe("80");
  });

  it("parses mode command", () => {
    const result = parseCommand("!mode loop", "!");
    expect(result!.name).toBe("mode");
    expect(result!.args).toBe("loop");
  });

  it("parses remove command with index", () => {
    const result = parseCommand("!remove 3", "!");
    expect(result!.name).toBe("remove");
    expect(result!.args).toBe("3");
  });

  it("trims space after the prefix so '! ask …' is ask", () => {
    const result = parseCommand("! ask what is a jump point", "!");
    expect(result!.name).toBe("ask");
    expect(result!.args).toBe("what is a jump point");
  });

  it("strips trailing punctuation on the command name", () => {
    const result = parseCommand("!ask, how do I refine", "!");
    expect(result!.name).toBe("ask");
    expect(result!.args).toBe("how do I refine");
  });

  it("recognizes the chevron7 easter egg as a known command", () => {
    // Must route deterministically (not fall through to LLM fuzzy intent).
    const result = parseCommand("!chevron7", "!");
    expect(result!.name).toBe("chevron7");
    expect(isKnownCommand("chevron7")).toBe(true);
  });
});
