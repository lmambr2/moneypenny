import { describe, expect, it } from "vitest";
import { decideClarifyOnce } from "./clarify.js";

describe("decideClarifyOnce", () => {
  it("proceeds when disabled", () => {
    expect(decideClarifyOnce([{ name: "play", arguments: {} }], { enabled: false })).toEqual({
      action: "proceed",
    });
  });

  it("clarifies play without query", () => {
    const d = decideClarifyOnce([{ name: "play", arguments: {} }], { enabled: true });
    expect(d.action).toBe("clarify");
  });

  it("proceeds play with query", () => {
    expect(
      decideClarifyOnce([{ name: "play", arguments: { query: "jazz" } }], { enabled: true }),
    ).toEqual({ action: "proceed" });
  });

  it("clarifies play+stop conflict", () => {
    const d = decideClarifyOnce(
      [
        { name: "play", arguments: { query: "x" } },
        { name: "stop", arguments: {} },
      ],
      { enabled: true },
    );
    expect(d.action).toBe("clarify");
  });

  it("does not clarify twice", () => {
    expect(
      decideClarifyOnce([{ name: "play", arguments: {} }], {
        enabled: true,
        clarifyPending: true,
      }),
    ).toEqual({ action: "proceed" });
  });
});
