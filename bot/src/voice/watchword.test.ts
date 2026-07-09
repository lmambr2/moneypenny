import { describe, it, expect } from "vitest";
import {
  extractCommandSegment,
  extractWatchwordCommand,
  partialMentionsCommand,
  isActionableVoiceCommand,
  isPartialSafeVoiceCommand,
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

  it("accepts space-split watchword prefix", () => {
    expect(
      extractWatchwordCommand("money penny skip", "moneypenny", { textWakeFallback: true }),
    ).toEqual({
      matched: true,
      command: "skip",
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
    expect(partialMentionsCommand("Resume.", "resume")).toBe(true);
  });

  it("keeps song args on play commands", () => {
    expect(extractCommandSegment("Play bohemian rap.", "moneypenny")).toBe("play bohemian rap");
    expect(extractWatchwordCommand("Play bohemian rap.", "moneypenny", { armed: true })).toEqual({
      matched: true,
      command: "play bohemian rap",
    });
  });

  it("does not invent commands from STT garble words", () => {
    expect(extractCommandSegment("Money peri, France, and.", "moneypenny")).toBe("");
    expect(isActionableVoiceCommand(extractCommandSegment("Money peri, France, and.", "moneypenny"))).toBe(
      false,
    );
    // "pass" is not mapped to pause/resume — only exact verbs.
    expect(extractCommandSegment("Honey penny pass.", "moneypenny")).toBe("");
  });

  it("extracts a canonical verb after noise (exact 'pause')", () => {
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

  it("does not map english garble to playback verbs", () => {
    expect(normalizeVoiceCommand("peri")).toBe("peri");
    expect(normalizeVoiceCommand("pass")).toBe("pass");
    expect(normalizeVoiceCommand("past")).toBe("past");
    expect(normalizeVoiceCommand("paws")).toBe("paws");
    expect(normalizeVoiceCommand("ship")).toBe("ship");
  });
});

describe("isPartialSafeVoiceCommand", () => {
  it("allows transport verbs from silence-tail but not play/search", () => {
    expect(isPartialSafeVoiceCommand("pause")).toBe(true);
    expect(isPartialSafeVoiceCommand("play toto africa")).toBe(false);
  });

  it("does not partial-route high-frequency English words", () => {
    expect(isPartialSafeVoiceCommand("now")).toBe(false);
    expect(isPartialSafeVoiceCommand("queue")).toBe(false);
  });
});

describe("isActionableVoiceCommand", () => {
  it("accepts playback verbs", () => {
    expect(isActionableVoiceCommand("pause")).toBe(true);
    expect(isActionableVoiceCommand("stop")).toBe(true);
    expect(isActionableVoiceCommand("play toto africa")).toBe(true);
  });

  it("rejects lyric bleed", () => {
    expect(isActionableVoiceCommand("awesome")).toBe(false);
    expect(isActionableVoiceCommand("you")).toBe(false);
  });

  it("rejects conversational false positives from live Pi logs", () => {
    expect(isActionableVoiceCommand("now i need to go to a room")).toBe(false);
    expect(isActionableVoiceCommand("forget it. i think the problem is she's slow")).toBe(false);
    expect(isActionableVoiceCommand("forget all")).toBe(true);
    expect(isActionableVoiceCommand("forget 3")).toBe(true);
  });

  it("accepts voice memory remember/recall with real payloads", () => {
    expect(isActionableVoiceCommand("recall")).toBe(true);
    expect(isActionableVoiceCommand("remember")).toBe(false);
    expect(isActionableVoiceCommand("remember jazz")).toBe(false); // one word too thin
    expect(isActionableVoiceCommand("remember I like jazz")).toBe(true);
    expect(isActionableVoiceCommand("remember callsign raven")).toBe(true);
  });
});

describe("extractCommandSegment false positives", () => {
  it("does not treat mid-sentence pod as pause", () => {
    expect(
      extractCommandSegment(
        "I mean that's like the easiest way. There's also like a pod on should.",
        "moneypenny",
      ),
    ).toBe("");
  });

  it("still extracts short transport and play+title", () => {
    expect(extractCommandSegment("Any pause?", "moneypenny")).toBe("pause");
    expect(extractCommandSegment("Money Penny, play Toto Africa.", "moneypenny")).toBe(
      "play toto africa",
    );
  });

  it("does not treat now+banter as now", () => {
    expect(extractCommandSegment("Now I need to go to a room.", "moneypenny")).toBe("");
  });
});

describe("watchwordAliases", () => {
  it("includes exact and space-split form of moneypenny only", () => {
    expect(watchwordAliases("moneypenny")).toEqual(
      expect.arrayContaining(["moneypenny", "money penny"]),
    );
    expect(watchwordAliases("moneypenny")).not.toEqual(
      expect.arrayContaining(["money petty", "money peri", "honey penny"]),
    );
  });
});
