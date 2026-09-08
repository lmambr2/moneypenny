import { describe, expect, it } from "vitest";
import {
  type DuplexHealth,
  DuplexWatch,
  FALLBACK_HOLD_MS,
  parseDuplexHealth,
} from "./duplex-watch.js";

function loadedOk(over: Partial<DuplexHealth> = {}): DuplexHealth {
  return { ok: true, loaded: true, realtime: true, rtf: 0.9, vram_mb: 64, engine: "mock", ...over };
}

function unloadedOk(): DuplexHealth {
  return { ok: true, loaded: false, realtime: false, rtf: 0, vram_mb: 0, engine: "mock" };
}

describe("DuplexWatch (K4 crash vs sticky RTF)", () => {
  it("crash ok=false enters fallback-cascaded and asks unload if loaded", () => {
    const w = new DuplexWatch();
    const tick = w.applyHealth({ ok: false, loaded: true }, 1000);
    expect(tick.state).toBe("fallback-cascaded");
    expect(tick.actions).toEqual(["mute_out", "unload"]);
  });

  it("crash recovery ok=true returns to idle and must not warm", () => {
    const w = new DuplexWatch();
    w.applyHealth({ ok: false }, 1);
    const tick = w.applyHealth(unloadedOk(), 2);
    expect(tick.state).toBe("idle");
    expect(tick.actions).toEqual([]);
  });

  it("unloaded realtime=false does not start RTF hold", () => {
    const w = new DuplexWatch();
    w.applyHealth(unloadedOk(), 0);
    const tick = w.applyHealth(unloadedOk(), FALLBACK_HOLD_MS + 50_000);
    expect(tick.state).toBe("idle");
    expect(tick.actions).toEqual([]);
  });

  it("RTF hold + unload stays fallback-rtf while ok=true loaded=false (no warm)", () => {
    const w = new DuplexWatch();
    w.applyHealth(loadedOk({ realtime: false, rtf: 2 }), 0);
    const held = w.applyHealth(loadedOk({ realtime: false, rtf: 2 }), FALLBACK_HOLD_MS);
    expect(held.state).toBe("fallback-rtf");
    expect(held.actions).toEqual(["mute_out", "unload"]);

    const after = w.applyHealth(unloadedOk(), FALLBACK_HOLD_MS + 1000);
    expect(after.state).toBe("fallback-rtf");
    expect(after.actions).toEqual([]);
  });

  it("watchword during fallback-rtf does not warm", () => {
    const w = new DuplexWatch();
    w.applyHealth(loadedOk({ realtime: false }), 0);
    w.applyHealth(loadedOk({ realtime: false }), FALLBACK_HOLD_MS);
    const tick = w.onWatchword(false);
    expect(tick.state).toBe("fallback-rtf");
    expect(tick.actions).toEqual([]);
  });

  it("operator voice.mode=duplex exits sticky RTF to idle", () => {
    const w = new DuplexWatch();
    w.applyHealth(loadedOk({ realtime: false }), 0);
    w.applyHealth(loadedOk({ realtime: false }), FALLBACK_HOLD_MS);
    const tick = w.onOperatorSetDuplex();
    expect(tick.state).toBe("idle");
  });

  it("empty channel stays idle and unloads if loaded — not fallback", () => {
    const w = new DuplexWatch();
    const tick = w.onEmptyChannel(true);
    expect(tick.state).toBe("idle");
    expect(tick.actions).toEqual(["mute_out", "unload"]);
  });

  it("watchword while unloaded warms then arms; loaded skips warm", () => {
    const w = new DuplexWatch();
    expect(w.onWatchword(false)).toEqual({ state: "armed-duplex", actions: ["warm"] });
    w.state = "idle";
    expect(w.onWatchword(true)).toEqual({ state: "armed-duplex", actions: [] });
  });

  it("listen window expiry returns armed to idle", () => {
    const w = new DuplexWatch();
    w.onWatchword(true);
    expect(w.onListenExpired().state).toBe("idle");
  });

  it("parseDuplexHealth treats missing ok as down", () => {
    expect(parseDuplexHealth(null).ok).toBe(false);
    expect(parseDuplexHealth({ ok: true, loaded: false, vram_mb: 0 }).loaded).toBe(false);
  });
});
