import { describe, it, expect, vi } from "vitest";
import { VoicePipeline } from "./pipeline.js";
import type { Utterance, SttProvider, TtsProvider, VoiceOutput } from "./types.js";
import { ControlRouter, type LlmAssist, type RouterContext } from "../control/router.js";

function fakeLogger(): any {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  l.child = () => l;
  return l;
}

function utterance(): Utterance {
  return { speakerClientId: 1, speakerUid: "u-1", pcm: Buffer.alloc(4), sampleRate: 16000, channels: 1, durationMs: 100 };
}

const fakeBot = { isConnected: () => true, localProvider: undefined } as any;

function sttReturning(text: string): SttProvider {
  return { transcribe: vi.fn().mockResolvedValue(text) };
}

describe("VoicePipeline", () => {
  it("dispatches a spoken known command deterministically and speaks the reply", async () => {
    const skip = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "skip", execute: async () => { skip(); return "Skipped to next."; } });

    const tts: TtsProvider = { synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from("a"), format: "wav" }) };
    const output: VoiceOutput = { speak: vi.fn().mockResolvedValue(undefined) };

    const pipeline = new VoicePipeline({
      router,
      stt: sttReturning("skip"),
      tts,
      output,
      respondWithVoice: true,
      buildContext: () => ({ bot: fakeBot, logger: fakeLogger() }),
      logger: fakeLogger(),
    });

    const reply = await pipeline.handleUtterance(utterance());
    expect(skip).toHaveBeenCalled();
    expect(reply).toBe("Skipped to next.");
    expect(tts.synthesize).toHaveBeenCalledWith("Skipped to next.");
    expect(output.speak).toHaveBeenCalledWith(expect.any(Buffer), "wav");
  });

  it("answers a spoken question via the LLM intent path", async () => {
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn().mockResolvedValue({ content: "Not much." }),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const pipeline = new VoicePipeline({
      router,
      stt: sttReturning("what's up"),
      buildContext: () => ({ bot: fakeBot, logger: fakeLogger() }),
      logger: fakeLogger(),
    });
    const reply = await pipeline.handleUtterance(utterance());
    expect(llm.chatForIntent).toHaveBeenCalledWith("what's up", undefined);
    expect(reply).toBe("Not much.");
  });

  it("ignores empty transcripts (no routing, no speech)", async () => {
    const router = new ControlRouter(fakeLogger());
    const route = vi.spyOn(router, "routeVoice");
    const tts: TtsProvider = { synthesize: vi.fn() };
    const output: VoiceOutput = { speak: vi.fn() };
    const pipeline = new VoicePipeline({
      router, stt: sttReturning("   "), tts, output, respondWithVoice: true,
      buildContext: () => ({ bot: fakeBot, logger: fakeLogger() }),
    });
    expect(await pipeline.handleUtterance(utterance())).toBeNull();
    expect(route).not.toHaveBeenCalled();
    expect(output.speak).not.toHaveBeenCalled();
  });

  it("respects rank gating on voice commands", async () => {
    const skip = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "stop", execute: async () => { skip(); return "stopped"; } });
    const pipeline = new VoicePipeline({
      router,
      stt: sttReturning("stop"),
      buildContext: () => ({ bot: fakeBot, logger: fakeLogger(), canRun: () => false }),
    });
    const reply = await pipeline.handleUtterance(utterance());
    expect(skip).not.toHaveBeenCalled();
    expect(reply).toMatch(/permission/i);
  });

  it("does not throw if STT fails", async () => {
    const router = new ControlRouter(fakeLogger());
    const pipeline = new VoicePipeline({
      router,
      stt: { transcribe: vi.fn().mockRejectedValue(new Error("stt down")) },
      buildContext: () => ({ bot: fakeBot, logger: fakeLogger() }),
      logger: fakeLogger(),
    });
    expect(await pipeline.handleUtterance(utterance())).toBeNull();
  });

  it("text-only mode skips TTS even when a reply is produced", async () => {
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "pause", execute: async () => "Paused." });
    const tts: TtsProvider = { synthesize: vi.fn() };
    const output: VoiceOutput = { speak: vi.fn() };
    const pipeline = new VoicePipeline({
      router, stt: sttReturning("pause"), tts, output,
      respondWithVoice: false, // text-only
      buildContext: () => ({ bot: fakeBot, logger: fakeLogger() }),
    });
    const reply = await pipeline.handleUtterance(utterance());
    expect(reply).toBe("Paused.");
    expect(tts.synthesize).not.toHaveBeenCalled();
    expect(output.speak).not.toHaveBeenCalled();
  });
});
