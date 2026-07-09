import { describe, expect, it, vi } from "vitest";
import { buildTagGuessPrompt, guessTrackTags, parseTagGuessResponse } from "./tag-guess.js";

describe("buildTagGuessPrompt", () => {
  it("includes title artist album and JSON instruction", () => {
    const p = buildTagGuessPrompt({
      name: "Neon Drift",
      artist: "Vapor Cats",
      album: "Night Drive",
    });
    expect(p).toContain("Neon Drift");
    expect(p).toContain("Vapor Cats");
    expect(p).toContain("Night Drive");
    expect(p).toContain('"genre"');
  });

  it("mentions existing tags when present", () => {
    const p = buildTagGuessPrompt({
      name: "X",
      existing: { genre: "ambient", mood: "calm" },
    });
    expect(p).toContain("ambient");
    expect(p).toContain("calm");
  });
});

describe("parseTagGuessResponse", () => {
  it("parses bare JSON", () => {
    expect(parseTagGuessResponse('{"genre":"Synthwave","mood":"Energetic"}')).toEqual({
      genre: "synthwave",
      mood: "energetic",
    });
  });

  it("parses fenced JSON and strips junk keys", () => {
    const raw =
      'Sure!\n```json\n{"genre":"lofi","subgenre":"chillhop","mood":"calm","bpm":90}\n```';
    expect(parseTagGuessResponse(raw)).toEqual({
      genre: "lofi",
      subgenre: "chillhop",
      mood: "calm",
    });
  });

  it("extracts embedded object from prose", () => {
    expect(parseTagGuessResponse('I think {"genre":"rock","mood":"dark"} fits.')).toEqual({
      genre: "rock",
      mood: "dark",
    });
  });

  it("returns null for empty, invalid, or empty-field replies", () => {
    expect(parseTagGuessResponse(null)).toBeNull();
    expect(parseTagGuessResponse("")).toBeNull();
    expect(parseTagGuessResponse("not json")).toBeNull();
    expect(parseTagGuessResponse('{"genre":"","mood":"unknown"}')).toBeNull();
  });
});

describe("guessTrackTags", () => {
  it("calls askLlm and returns parsed tags", async () => {
    const ask = vi.fn(async (_q: string) => '{"genre":"ambient","mood":"focus"}');
    const tags = await guessTrackTags(ask, { name: "Study", artist: "A" });
    expect(tags).toEqual({ genre: "ambient", mood: "focus" });
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("Study"));
  });

  it("returns null when LLM is down", async () => {
    const ask = vi.fn(async () => null);
    expect(await guessTrackTags(ask, { name: "X" })).toBeNull();
  });
});
