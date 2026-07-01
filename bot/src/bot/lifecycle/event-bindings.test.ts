import { describe, it, expect, vi } from "vitest";
import { bindPlayerEvents, type PlayerEventBindings } from "./event-bindings.js";

/** Minimal player stub: captures event handlers so tests can emit them. */
function fakePlayer() {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    on(ev: string, cb: (...a: unknown[]) => void) {
      (handlers[ev] ??= []).push(cb);
    },
    emit(ev: string, ...args: unknown[]) {
      (handlers[ev] ?? []).forEach((h) => h(...args));
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function wire(opts: { resumed: boolean }) {
  const player = fakePlayer();
  const voice = { handleTrackEnd: vi.fn(async () => opts.resumed), onPlayerError: vi.fn() };
  const radio = { onTrackBoundary: vi.fn(async () => {}) };
  const playNext = vi.fn(async () => true);
  const deps = {
    player,
    tsClient: { sendVoiceData: vi.fn() },
    voice,
    radio,
    logger: { debug: vi.fn(), error: vi.fn() },
    playNext,
  } as unknown as PlayerEventBindings;
  bindPlayerEvents(deps);
  return { player, voice, radio, playNext };
}

describe("bindPlayerEvents trackEnd seam", () => {
  it("routes the post-voice advance through the radio director", async () => {
    const { player, voice, radio } = wire({ resumed: false });
    player.emit("trackEnd");
    await flush();
    expect(voice.handleTrackEnd).toHaveBeenCalledTimes(1);
    expect(radio.onTrackBoundary).toHaveBeenCalledTimes(1);
  });

  it("preserves voice precedence: if voice resumed, radio is not consulted", async () => {
    const { player, radio } = wire({ resumed: true });
    player.emit("trackEnd");
    await flush();
    expect(radio.onTrackBoundary).not.toHaveBeenCalled();
  });
});
