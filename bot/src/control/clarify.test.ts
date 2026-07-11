import { describe, expect, it } from "vitest";
import { decideClarifyOnce } from "./clarify.js";

describe("decideClarifyOnce", () => {
  it("proceeds when disabled", () => {
    expect(decideClarifyOnce([{ name: "play_music", arguments: {} }], { enabled: false })).toEqual({
      action: "proceed",
    });
  });

  it("clarifies play_music without query", () => {
    const d = decideClarifyOnce([{ name: "play_music", arguments: {} }], { enabled: true });
    expect(d.action).toBe("clarify");
  });

  it("clarifies queue without query", () => {
    const d = decideClarifyOnce([{ name: "queue", arguments: {} }], { enabled: true });
    expect(d.action).toBe("clarify");
  });

  it("proceeds play_music with query", () => {
    expect(
      decideClarifyOnce([{ name: "play_music", arguments: { query: "jazz" } }], { enabled: true }),
    ).toEqual({ action: "proceed" });
  });

  it("proceeds select_tracks with tag-only arguments", () => {
    expect(
      decideClarifyOnce([{ name: "select_tracks", arguments: { mood: ["calm"] } }], {
        enabled: true,
      }),
    ).toEqual({ action: "proceed" });
  });

  it("clarifies play_music+stop conflict", () => {
    const d = decideClarifyOnce(
      [
        { name: "play_music", arguments: { query: "x" } },
        { name: "stop", arguments: {} },
      ],
      { enabled: true },
    );
    expect(d.action).toBe("clarify");
  });

  it("clarifies select_tracks+pause conflict", () => {
    const d = decideClarifyOnce(
      [
        { name: "select_tracks", arguments: { mood: ["calm"] } },
        { name: "pause", arguments: {} },
      ],
      { enabled: true },
    );
    expect(d.action).toBe("clarify");
  });

  it("does not treat set_volume alongside play_music as a conflict", () => {
    expect(
      decideClarifyOnce(
        [
          { name: "play_music", arguments: { query: "x" } },
          { name: "set_volume", arguments: { level: 50 } },
        ],
        { enabled: true },
      ),
    ).toEqual({ action: "proceed" });
  });

  it("does not clarify twice", () => {
    expect(
      decideClarifyOnce([{ name: "play_music", arguments: {} }], {
        enabled: true,
        clarifyPending: true,
      }),
    ).toEqual({ action: "proceed" });
  });
});
