import { describe, expect, it } from "vitest";
import {
  parseMusicPlatform,
  parseWithSchema,
  zMusicPlatform,
  zPlayerModeToken,
  zSeekSeconds,
  zVolume,
} from "./validate.js";

describe("web/validate", () => {
  it("accepts volume in range", () => {
    const r = parseWithSchema(zVolume, 50);
    expect(r).toEqual({ ok: true, data: 50 });
  });

  it("rejects volume out of range", () => {
    const r = parseWithSchema(zVolume, 200);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/100|less|max/i);
  });

  it("coerces seek seconds", () => {
    const r = parseWithSchema(zSeekSeconds, "12.5");
    expect(r).toEqual({ ok: true, data: 12.5 });
  });

  it("validates player mode tokens", () => {
    expect(parseWithSchema(zPlayerModeToken, "shuffle").ok).toBe(false);
    expect(parseWithSchema(zPlayerModeToken, "random")).toEqual({ ok: true, data: "random" });
  });

  it("parseMusicPlatform keeps the three platforms and rejects the rest", () => {
    expect(parseMusicPlatform(undefined)).toBe("youtube");
    expect(parseMusicPlatform("")).toBe("youtube");
    expect(parseMusicPlatform("stream")).toBe("stream");
    expect(parseMusicPlatform("local")).toBe("local");
    expect(parseMusicPlatform("spotify")).toBeNull();
    expect(parseWithSchema(zMusicPlatform, "tidal").ok).toBe(false);
  });
});
