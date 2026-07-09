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

describe("bindPlayerEvents Icecast PCM tee path", () => {
  it("forwards player pcm events to onPcm (real bindPlayerEvents path)", () => {
    const player = fakePlayer();
    const onPcm = vi.fn();
    const sendVoiceData = vi.fn();
    bindPlayerEvents({
      player,
      tsClient: { sendVoiceData },
      voice: { handleTrackEnd: vi.fn(), onPlayerError: vi.fn() },
      radio: { onTrackBoundary: vi.fn() },
      logger: { debug: vi.fn(), error: vi.fn() },
      playNext: vi.fn(async () => true),
      onPcm,
    } as unknown as PlayerEventBindings);

    const pcm = Buffer.alloc(480);
    player.emit("pcm", pcm);
    expect(onPcm).toHaveBeenCalledWith(pcm);

    const opus = Buffer.from([1, 2, 3]);
    player.emit("frame", opus);
    expect(sendVoiceData).toHaveBeenCalledWith(opus);
  });

  it("integration: running IcecastTee.writePcm receives program PCM via onPcm", async () => {
    const { IcecastTee } = await import("../../radio/icecast-tee.js");
    const stdin = { write: vi.fn(() => true), end: vi.fn() };
    const spawn = vi.fn(() => ({
      stdin,
      killed: false,
      kill: vi.fn(),
      on: vi.fn(),
    }));
    const tee = new IcecastTee({ spawn });
    const started = tee.apply({
      enabled: true,
      mountUrl: "icecast://source:x@127.0.0.1:8000/live",
    });
    expect(started.running).toBe(true);

    const player = fakePlayer();
    bindPlayerEvents({
      player,
      tsClient: { sendVoiceData: vi.fn() },
      voice: { handleTrackEnd: vi.fn(), onPlayerError: vi.fn() },
      radio: { onTrackBoundary: vi.fn() },
      logger: { debug: vi.fn(), error: vi.fn() },
      playNext: vi.fn(async () => true),
      // Same wiring as BotInstance: onPcm → tee.writePcm
      onPcm: (pcm: Buffer) => tee.writePcm(pcm),
    } as unknown as PlayerEventBindings);

    const frame = Buffer.alloc(960);
    frame.writeInt16LE(1234, 0);
    player.emit("pcm", frame);
    expect(stdin.write).toHaveBeenCalledWith(frame);
    tee.stop();
  });
});
