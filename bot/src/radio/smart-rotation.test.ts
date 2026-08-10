import { describe, expect, it } from "vitest";
import {
  applySmartRotation,
  orderKeysByEnergyBias,
  orderKeysWithSeparation,
  type SmartRotationTrackMeta,
} from "./smart-rotation.js";

const meta: Record<string, SmartRotationTrackMeta> = {
  a1: { artist: "Alpha", album: "LP1", energy: 0.2, musicalKey: "C", keyScale: "major" },
  a2: { artist: "Alpha", album: "LP1", energy: 0.25, musicalKey: "G", keyScale: "major" },
  a3: { artist: "Alpha", album: "LP2", energy: 0.3, musicalKey: "D", keyScale: "major" },
  b1: { artist: "Beta", album: "B1", energy: 0.8, musicalKey: "F#", keyScale: "major" },
  b2: { artist: "Beta", album: "B1", energy: 0.75, musicalKey: "B", keyScale: "major" },
  c1: { artist: "Gamma", album: "G1", energy: 0.5, musicalKey: "A", keyScale: "minor" },
};

const metaOf = (k: string) => meta[k];

describe("orderKeysWithSeparation", () => {
  it("is identity when disabled", () => {
    const keys = ["a1", "a2", "b1"];
    expect(
      orderKeysWithSeparation(keys, metaOf, {
        enabled: false,
        artistWindow: 4,
        albumWindow: 6,
        relaxOnEmpty: true,
      }),
    ).toEqual(keys);
  });

  it("avoids same artist inside artistWindow when alternatives exist", () => {
    const keys = ["a1", "a2", "b1", "c1"];
    const out = orderKeysWithSeparation(keys, metaOf, {
      enabled: true,
      artistWindow: 3,
      albumWindow: 6,
      relaxOnEmpty: true,
    });
    // a1 and a2 should not be adjacent when b/c available after first Alpha
    expect(out[0]).toBe("a1");
    expect(out[1]).not.toBe("a2");
    expect(out).toContain("a2");
    expect(out).toHaveLength(4);
  });

  it("relaxes when only same-artist tracks remain", () => {
    const keys = ["a1", "a2", "a3"];
    const out = orderKeysWithSeparation(keys, metaOf, {
      enabled: true,
      artistWindow: 10,
      albumWindow: 10,
      relaxOnEmpty: true,
    });
    expect(out).toHaveLength(3);
    expect(new Set(out)).toEqual(new Set(keys));
  });
});

describe("orderKeysByEnergyBias", () => {
  it("is identity when disabled", () => {
    const keys = ["a1", "b1", "c1"];
    expect(
      orderKeysByEnergyBias(keys, (k) => metaOf(k)?.energy, { enabled: false, maxJump: 0.35 }),
    ).toEqual(keys);
  });

  it("prefers smooth energy after a low-energy start", () => {
    // Start bag: low a1, then high b1, mid c1 — after bias, neighbor of a1 should
    // not jump straight to b1 if c1 is closer.
    const keys = ["a1", "b1", "c1"];
    const out = orderKeysByEnergyBias(keys, (k) => metaOf(k)?.energy, {
      enabled: true,
      maxJump: 0.35,
    });
    expect(out[0]).toBe("a1");
    expect(out[1]).toBe("c1"); // 0.5 closer to 0.2 than 0.8
    expect(out[2]).toBe("b1");
  });
});

describe("applySmartRotation", () => {
  it("runs separation before rating weight", () => {
    // Fixed rng always picks first remaining weight slot deterministically enough
    // that separation still spaces Alpha.
    let n = 0;
    const rng = () => {
      n += 1;
      return (n * 0.17) % 1;
    };
    const keys = ["a1", "a2", "b1", "c1"];
    const out = applySmartRotation(keys, metaOf, {
      separation: { enabled: true, artistWindow: 3, albumWindow: 6, relaxOnEmpty: true },
      rating: { enabled: true, exponent: 1, maxRatio: 3 },
      energyBias: { enabled: false, maxJump: 0.35 },
      harmonic: false,
      scoreOf: () => 3,
      rng,
    });
    expect(out).toHaveLength(4);
    expect(new Set(out)).toEqual(new Set(keys));
  });

  it("identity when all stages disabled", () => {
    const keys = ["a1", "b1", "c1"];
    const out = applySmartRotation(keys, metaOf, {
      separation: { enabled: false, artistWindow: 4, albumWindow: 6, relaxOnEmpty: true },
      rating: { enabled: false },
      energyBias: { enabled: false, maxJump: 0.35 },
      harmonic: false,
    });
    expect(out).toEqual(keys);
  });
});
