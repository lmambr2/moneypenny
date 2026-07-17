import { describe, expect, it } from "vitest";
import {
  knownLlmToolNames,
  sourceFlags,
  SPECIAL_TOOL_MAPPERS,
  toolCallToCommand,
} from "./tool-map.js";

describe("tool-map (PR-A3)", () => {
  it("has no switch — special mappers are a plain object", () => {
    expect(SPECIAL_TOOL_MAPPERS.play_music).toBeTypeOf("function");
    expect(SPECIAL_TOOL_MAPPERS.select_tracks).toBeTypeOf("function");
    expect(SPECIAL_TOOL_MAPPERS.move_client).toBeTypeOf("function");
  });

  it("play_music with youtube source", () => {
    const cmd = toolCallToCommand({
      name: "play_music",
      arguments: { query: "Never Gonna Give You Up", source: "youtube" },
    });
    expect(cmd?.name).toBe("play");
    expect(cmd?.args).toContain("Never Gonna");
    expect(cmd?.flags.has("y")).toBe(true);
  });

  it("select_tracks lone genre → play", () => {
    const cmd = toolCallToCommand({ name: "select_tracks", arguments: { genreAny: ["Jazz"] } });
    expect(cmd?.name).toBe("play");
    expect(cmd?.args).toBe("Jazz");
  });

  it("select_tracks with mood stays selecttracks JSON", () => {
    const cmd = toolCallToCommand({
      name: "select_tracks",
      arguments: { genreAny: ["Jazz"], mood: ["calm"] },
    });
    expect(cmd?.name).toBe("selecttracks");
    expect(cmd?.args).toContain("calm");
  });

  it("set_volume rounds level", () => {
    expect(toolCallToCommand({ name: "set_volume", arguments: { level: 42.6 } })?.args).toBe("43");
  });

  it("move_client and move_all_clients", () => {
    const m = toolCallToCommand({
      name: "move_client",
      arguments: { client: "Bob", channel: "Hangar" },
    });
    expect(m?.name).toBe("moveclient");
    expect(m?.rawArgs).toEqual(["Bob", "Hangar"]);
    expect(toolCallToCommand({ name: "move_all_clients", arguments: { channel: "Lobby" } })?.name).toBe(
      "moveall",
    );
  });

  it("simple aliases via manifest", () => {
    expect(toolCallToCommand({ name: "skip" })?.name).toBe("skip");
    expect(toolCallToCommand({ name: "now_playing" })?.name).toBe("now");
    expect(toolCallToCommand({ name: "unknown_tool_xyz" })).toBeNull();
  });

  it("sourceFlags", () => {
    expect(sourceFlags("youtube").has("y")).toBe(true);
    expect(sourceFlags("local").has("l")).toBe(true);
    expect(sourceFlags("auto").size).toBe(0);
  });

  it("knownLlmToolNames includes specials and aliases", () => {
    const names = knownLlmToolNames();
    expect(names).toContain("play_music");
    expect(names).toContain("select_tracks");
    expect(names).toContain("now_playing");
  });
});
