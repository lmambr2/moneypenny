import { describe, it, expect } from "vitest";
import {
  extractCommandSegment,
  extractWatchwordCommand,
  partialMentionsCommand,
  isActionableVoiceCommand,
  normalizeVoiceCommand,
  watchwordAliases,
} from "./watchword.js";

describe("extractWatchwordCommand", () => {
  it("extracts a command after the watchword (text fallback)", () => {
    expect(
      extractWatchwordCommand("Moneypenny pause", "moneypenny", { textWakeFallback: true }),
    ).toEqual({
      matched: true,
      command: "pause",
    });
  });

  it("accepts STT split variants via prefix aliases", () => {
    expect(
      extractWatchwordCommand("money penny skip", "moneypenny", { textWakeFallback: true }),
    ).toEqual({
      matched: true,
      command: "skip",
    });
  });

  it("maps money penny past to pause (common STT garble)", () => {
    expect(
      extractWatchwordCommand("Money, penny, past.", "moneypenny", { textWakeFallback: true }),
    ).toEqual({
      matched: true,
      command: "pause",
    });
  });

  it("routes on KWS even when STT drops the wake name", () => {
    expect(
      extractWatchwordCommand("pause", "moneypenny", { kwsDetected: true }),
    ).toEqual({ matched: true, command: "pause" });
  });

  it("watchword-only with KWS and empty STT", () => {
    expect(extractWatchwordCommand("", "moneypenny", { kwsDetected: true })).toEqual({
      matched: true,
      command: "",
    });
  });

  it("does not false-positive on casual channel banter without KWS", () => {
    expect(extractWatchwordCommand("You've never heard of the song.", "moneypenny")).toEqual({
      matched: false,
      command: "",
    });
    expect(extractWatchwordCommand("Why do you pay any pause?", "moneypenny")).toEqual({
      matched: false,
      command: "",
    });
  });

  it("accepts bare follow-up commands while armed", () => {
    expect(extractWatchwordCommand("pause", "moneypenny", { armed: true })).toEqual({
      matched: true,
      command: "pause",
    });
    expect(extractCommandSegment("Pause.", "moneypenny")).toBe("pause");
    expect(extractWatchwordCommand("Resume.", "moneypenny", { armed: true })).toEqual({
      matched: true,
      command: "resume",
    });
    expect(partialMentionsCommand("Rezoom.", "resume")).toBe(true);
  });

  it("pulls the verb from command-mode STT that bleeds the wake name back in", () => {
    expect(extractCommandSegment("Honey penny pass.", "moneypenny")).toBe("pause");
    expect(extractWatchwordCommand("Honey penny pass.", "moneypenny", { armed: true })).toEqual({
      matched: true,
      command: "pause",
    });
  });

  it("extracts a canonical verb after wake-bleed (the 'any pause' case)", () => {
    // "moneypenny pause" → Moonshine "any pause" (…penny→any). "pause" is a
    // canonical verb, not a mishear alias, so the verb scan must still catch it.
    expect(extractCommandSegment("Any pause?", "moneypenny")).toBe("pause");
    expect(extractWatchwordCommand("Any pause?", "moneypenny", { kwsDetected: true })).toEqual({
      matched: true,
      command: "pause",
    });
  });

  it("ignores utterances without the watchword", () => {
    expect(extractWatchwordCommand("pause", "moneypenny")).toEqual({
      matched: false,
      command: "",
    });
  });

  it("matches watchword-only utterances with an empty command", () => {
    expect(
      extractWatchwordCommand("Moneypenny", "moneypenny", { textWakeFallback: true }),
    ).toEqual({
      matched: true,
      command: "",
    });
  });
});

describe("normalizeVoiceCommand", () => {
  it("strips leading articles from short commands", () => {
    expect(normalizeVoiceCommand("a resume")).toBe("resume");
    expect(normalizeVoiceCommand("the pause")).toBe("pause");
  });

  it("maps playback verb mishears", () => {
    expect(normalizeVoiceCommand("peri")).toBe("resume");
    expect(normalizeVoiceCommand("pass")).toBe("resume");
    expect(normalizeVoiceCommand("past")).toBe("pause");
    expect(normalizeVoiceCommand("paws")).toBe("pause");
    expect(normalizeVoiceCommand("ship")).toBe("skip");
  });
});

describe("isActionableVoiceCommand", () => {
  it("accepts playback verbs", () => {
    expect(isActionableVoiceCommand("pause")).toBe(true);
    expect(isActionableVoiceCommand("stop")).toBe(true);
  });

  it("rejects lyric bleed", () => {
    expect(isActionableVoiceCommand("awesome")).toBe(false);
    expect(isActionableVoiceCommand("you")).toBe(false);
  });
});

describe("watchwordAliases", () => {
  it("includes default STT splits for moneypenny", () => {
    expect(watchwordAliases("moneypenny")).toEqual(
      expect.arrayContaining(["moneypenny", "money penny", "money petty", "mighty pretty"]),
    );
  });
});