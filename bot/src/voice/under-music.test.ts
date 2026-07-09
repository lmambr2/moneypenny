import { describe, expect, it } from "vitest";
import {
  defaultUnderMusicConfig,
  planUnderMusicCapture,
  runUnderMusicSmoke,
  simulateUnderMusicTurn,
} from "./under-music.js";

describe("voice under music (V1/H4)", () => {
  it("plans duck + listen window + text fallback", () => {
    const plan = planUnderMusicCapture(defaultUnderMusicConfig());
    expect(plan.duckActive).toBe(true);
    expect(plan.duckLevel).toBe(20);
    expect(plan.listenWindowMs).toBeGreaterThanOrEqual(15_000);
    expect(plan.progressiveWake).toBe("text-fallback");
    expect(plan.textFallbackAlwaysWorks).toBe(true);
  });

  it("text wake works without KWS (progressive enhancement)", () => {
    const cfg = defaultUnderMusicConfig({ textWakeFallback: true });
    const r = simulateUnderMusicTurn("Moneypenny pause", cfg);
    expect(r.matched).toBe(true);
    expect(r.command).toMatch(/pause/i);
    expect(r.path).toBe("text-wake");
    expect(r.wouldDuck).toBe(true);
    expect(r.textFallbackCommand).toBeTruthy();
  });

  it("armed follow-up accepts bare pause after wake", () => {
    const cfg = defaultUnderMusicConfig({ textWakeFallback: false });
    const r = simulateUnderMusicTurn("pause", cfg, { armed: true });
    expect(r.matched).toBe(true);
    expect(r.command).toMatch(/pause/i);
    expect(r.path).toBe("armed");
  });

  it("smoke suite passes on default config", () => {
    const report = runUnderMusicSmoke();
    expect(report.ok).toBe(true);
    expect(report.results.every((r) => r.pass)).toBe(true);
  });

  it("legacy duck volumes 2 and 25 migrate to soft 20 in defaults", () => {
    expect(defaultUnderMusicConfig({ duckMusicVolume: 2 }).duckMusicVolume).toBe(20);
    expect(defaultUnderMusicConfig({ duckMusicVolume: 25 }).duckMusicVolume).toBe(20);
  });
});
