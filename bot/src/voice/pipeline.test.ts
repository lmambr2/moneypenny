import { describe, it, expect, vi } from "vitest";
import { VoicePipeline } from "./pipeline.js";
import type { Utterance, SttProvider, TtsProvider, VoiceOutput } from "./types.js";
import { ControlRouter, type LlmAssist, type RouterContext } from "../control/router.js";

function fakeLogger(): any {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  l.child = () => l;
  return l;
}

function utterance(id = 1): Utterance {
  return { speakerClientId: id, speakerUid: "u-1", pcm: Buffer.alloc(4), sampleRate: 16000, channels: 1, durationMs: 100 };
}

const fakeBot = { isConnected: () => true, localProvider: undefined } as any;

function sttReturning(text: string): SttProvider {
  return { transcribe: vi.fn().mockResolvedValue(text) };
}

function pipelineOpts(overrides: Partial<ConstructorParameters<typeof VoicePipeline>[0]> = {}) {
  return {
    buildContext: () => ({ bot: fakeBot, logger: fakeLogger() }),
    logger: fakeLogger(),
    watchword: "moneypenny",
    requireWatchword: true,
    textWakeFallback: true,
    ...overrides,
  };
}

describe("VoicePipeline", () => {
  it("dispatches a spoken known command after the watchword", async () => {
    const skip = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "skip", execute: async () => { skip(); return "Skipped to next."; } });

    const tts: TtsProvider = { synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from("a"), format: "wav" }) };
    const output: VoiceOutput = { speak: vi.fn().mockResolvedValue(undefined) };

    const pipeline = new VoicePipeline({
      ...pipelineOpts(),
      router,
      stt: sttReturning("Moneypenny skip"),
      tts,
      output,
      respondWithVoice: true,
    });

    const turn = await pipeline.handleUtterance(utterance());
    expect(skip).toHaveBeenCalled();
    expect(turn.reply).toBe("Skipped to next.");
    expect(turn.watchwordOnly).toBe(false);
    expect(tts.synthesize).toHaveBeenCalledWith("Skipped.");
    expect(output.speak).toHaveBeenCalled();
  });

  it("routes STT filler resume (Money, Penny, a resume.) deterministically", async () => {
    const resume = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "resume", execute: async () => { resume(); return "Playback resumed."; } });

    const pipeline = new VoicePipeline({
      ...pipelineOpts(),
      router,
      stt: sttReturning("Money, Penny, a resume."),
    });

    const turn = await pipeline.handleUtterance(utterance());
    expect(resume).toHaveBeenCalled();
    expect(turn.reply).toBe("Playback resumed.");
    expect(turn.watchwordOnly).toBe(false);
  });

  it("ignores commands spoken without the watchword", async () => {
    const skip = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "skip", execute: async () => { skip(); return "Skipped to next."; } });
    const route = vi.spyOn(router, "routeVoice");

    const pipeline = new VoicePipeline({
      ...pipelineOpts(),
      router,
      stt: sttReturning("skip"),
    });

    const turn = await pipeline.handleUtterance(utterance());
    expect(turn.reply).toBeNull();
    expect(turn.watchwordOnly).toBe(false);
    expect(skip).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it("arms the speaker when only the watchword is heard", async () => {
    const arm = vi.fn();
    const router = new ControlRouter(fakeLogger());
    const pipeline = new VoicePipeline({
      ...pipelineOpts({ arm }),
      router,
      stt: sttReturning("Moneypenny"),
    });
    const turn = await pipeline.handleUtterance(utterance());
    expect(turn.reply).toBeNull();
    expect(turn.watchwordOnly).toBe(true);
    expect(arm).toHaveBeenCalledWith(1);
  });

  it("accepts a follow-up command while armed", async () => {
    const pause = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "pause", execute: async () => { pause(); return "Paused"; } });
    const pipeline = new VoicePipeline({
      ...pipelineOpts({ isArmed: () => true }),
      router,
      stt: sttReturning("pause"),
    });
    const turn = await pipeline.handleUtterance(utterance());
    expect(pause).toHaveBeenCalled();
    expect(turn.reply).toBe("Paused");
  });

  it("ignores banter without KWS or text wake fallback", async () => {
    const pause = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "pause", execute: async () => { pause(); return "Paused"; } });
    const pipeline = new VoicePipeline({
      ...pipelineOpts({ textWakeFallback: false }),
      router,
      stt: sttReturning("Why do you pay any pause?"),
    });
    const turn = await pipeline.handleUtterance(utterance());
    expect(pause).not.toHaveBeenCalled();
    expect(turn.reply).toBeNull();
  });

  it("answers a spoken question after the watchword via the LLM intent path", async () => {
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn().mockResolvedValue({ content: "Not much." }),
      delegate: vi.fn(),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const pipeline = new VoicePipeline({
      ...pipelineOpts(),
      router,
      stt: sttReturning("Moneypenny what's up"),
    });
    const turn = await pipeline.handleUtterance(utterance());
    expect(llm.chatForIntent).toHaveBeenCalledWith("what's up", undefined, { moveClientEnabled: true });
    expect(turn.reply).toBe("Not much.");
  });

  it("ignores empty transcripts (no routing, no speech)", async () => {
    const router = new ControlRouter(fakeLogger());
    const route = vi.spyOn(router, "routeVoice");
    const tts: TtsProvider = { synthesize: vi.fn() };
    const output: VoiceOutput = { speak: vi.fn() };
    const pipeline = new VoicePipeline({
      ...pipelineOpts(),
      router,
      stt: sttReturning("   "),
      tts,
      output,
      respondWithVoice: true,
    });
    const turn = await pipeline.handleUtterance(utterance());
    expect(turn.reply).toBeNull();
    expect(route).not.toHaveBeenCalled();
    expect(output.speak).not.toHaveBeenCalled();
  });

  it("respects rank gating on voice commands", async () => {
    const skip = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "stop", execute: async () => { skip(); return "stopped"; } });
    const pipeline = new VoicePipeline({
      ...pipelineOpts(),
      router,
      stt: sttReturning("Moneypenny stop"),
      buildContext: () => ({ bot: fakeBot, logger: fakeLogger(), canRun: () => false }),
    });
    const turn = await pipeline.handleUtterance(utterance());
    expect(skip).not.toHaveBeenCalled();
    expect(turn.reply).toMatch(/permission/i);
  });

  it("does not throw if STT fails", async () => {
    const router = new ControlRouter(fakeLogger());
    const pipeline = new VoicePipeline({
      ...pipelineOpts(),
      router,
      stt: { transcribe: vi.fn().mockRejectedValue(new Error("stt down")) },
    });
    const turn = await pipeline.handleUtterance(utterance());
    expect(turn.reply).toBeNull();
  });

  it("text-only mode skips TTS even when a reply is produced", async () => {
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "pause", execute: async () => "Paused." });
    const tts: TtsProvider = { synthesize: vi.fn() };
    const output: VoiceOutput = { speak: vi.fn() };
    const pipeline = new VoicePipeline({
      ...pipelineOpts(),
      router,
      stt: sttReturning("Moneypenny pause"),
      tts,
      output,
      respondWithVoice: false,
    });
    const turn = await pipeline.handleUtterance(utterance());
    expect(turn.reply).toBe("Paused.");
    expect(tts.synthesize).not.toHaveBeenCalled();
    expect(output.speak).not.toHaveBeenCalled();
  });

  it("speaks an instant ack before a slow play resolve", async () => {
    const play = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({
      name: "play",
      execute: async () => {
        play();
        await new Promise((r) => setTimeout(r, 50));
        return "Now playing: Toto - Africa - TOTO";
      },
    });

    const tts: TtsProvider = {
      synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from("a"), format: "wav" }),
    };
    const output: VoiceOutput = { speak: vi.fn().mockResolvedValue(undefined) };

    const pipeline = new VoicePipeline({
      ...pipelineOpts(),
      router,
      stt: sttReturning("Moneypenny play toto africa"),
      tts,
      output,
      respondWithVoice: true,
    });

    const turn = await pipeline.handleUtterance(utterance());
    expect(play).toHaveBeenCalled();
    expect(turn.reply).toContain("Now playing");
    expect(tts.synthesize).toHaveBeenCalledWith("On it.");
  });

  it("ignores duplicate play while resolve is in-flight", async () => {
    const play = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({
      name: "play",
      execute: async () => {
        play();
        await new Promise((r) => setTimeout(r, 80));
        return "Now playing: Toto - Africa - TOTO";
      },
    });

    const inFlight = new Set<number>();
    const pipeline = new VoicePipeline({
      ...pipelineOpts({ isArmed: () => true }),
      router,
      stt: sttReturning("play toto africa"),
      isPlayInFlight: (id) => inFlight.has(id),
      markPlayInFlight: (id) => inFlight.add(id),
      clearPlayInFlight: (id) => inFlight.delete(id),
    });

    inFlight.add(1);
    const turn = await pipeline.handleUtterance(utterance());
    expect(play).not.toHaveBeenCalled();
    expect(turn.reply).toBeNull();
  });

  it("disarms after a successful play reply", async () => {
    const disarm = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({
      name: "play",
      execute: async () => "Now playing: Toto - Africa - TOTO",
    });

    const pipeline = new VoicePipeline({
      ...pipelineOpts({ disarm }),
      router,
      stt: sttReturning("Moneypenny play toto africa"),
    });

    await pipeline.handleUtterance(utterance());
    expect(disarm).toHaveBeenCalledWith(1);
  });

  it("routes without a watchword when requireWatchword is false", async () => {
    const skip = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "skip", execute: async () => { skip(); return "ok"; } });
    const pipeline = new VoicePipeline({
      ...pipelineOpts({ requireWatchword: false }),
      router,
      stt: sttReturning("skip"),
    });
    const turn = await pipeline.handleUtterance(utterance());
    expect(turn.reply).toBe("ok");
    expect(skip).toHaveBeenCalled();
  });
});