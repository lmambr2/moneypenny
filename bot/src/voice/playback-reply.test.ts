import { describe, it, expect } from "vitest";
import {
  isPlaybackControlReply,
  shouldSpeakVoiceReply,
  voiceReplyClearsSavedMusic,
  voiceSpokenAck,
} from "./playback-reply.js";

describe("playback voice replies", () => {
  it("clears savedMusic handoff only for pause/stop, not resume/skip", () => {
    expect(voiceReplyClearsSavedMusic("Paused")).toBe(true);
    expect(voiceReplyClearsSavedMusic("Stopped and queue cleared")).toBe(true);
    expect(voiceReplyClearsSavedMusic("Resumed")).toBe(false);
    expect(voiceReplyClearsSavedMusic("Playback resumed.")).toBe(false);
    expect(voiceReplyClearsSavedMusic("Skipped to next.")).toBe(false);
  });

  it("detects transport control acks", () => {
    expect(isPlaybackControlReply("Paused")).toBe(true);
    expect(isPlaybackControlReply("Resumed")).toBe(true);
    expect(isPlaybackControlReply("Stopped and queue cleared")).toBe(true);
    expect(isPlaybackControlReply("Skipped to next.")).toBe(true);
    expect(isPlaybackControlReply("One does find that dwelling")).toBe(false);
  });

  it("maps transport acks to short spoken confirmations", () => {
    expect(voiceSpokenAck("Paused")).toBe("Paused.");
    expect(voiceSpokenAck("Playback resumed.")).toBe("Resumed.");
    expect(voiceSpokenAck("Skipped to next.")).toBe("Skipped.");
    expect(voiceSpokenAck("Now playing: long song title")).toBeNull();
  });

  it("speaks short transport acks but not long LLM answers", () => {
    expect(shouldSpeakVoiceReply("Paused")).toBe(true);
    expect(shouldSpeakVoiceReply("x".repeat(200))).toBe(false);
    expect(shouldSpeakVoiceReply("Right away.")).toBe(true);
  });
});