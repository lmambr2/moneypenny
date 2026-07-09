/**
 * V3 — drive BotInstance.speakRadioStatus (real method) + !radio speak-status path.
 */
import { describe, expect, it, vi } from "vitest";
import { defaultRadioConfig } from "../radio/index.js";
import { BotInstance } from "./instance.js";
import { CommandExecutor } from "./commands/executor.js";

const speakRadioStatus = BotInstance.prototype.speakRadioStatus;

function liveStatus(partial?: {
  nowPlaying?: { name: string; artist?: string } | null;
  radio?: {
    enabled: boolean;
    activeProfile: string;
    nextBumperHint: string;
  } | null;
}) {
  return {
    connected: true,
    nowPlaying: partial?.nowPlaying ?? null,
    queue: [],
    radio: partial?.radio ?? null,
    scope: {
      channelHint: null,
      serverLabel: "test",
      virtualServerId: null,
      channelPinned: false,
    },
  };
}

describe("BotInstance.speakRadioStatus (V3)", () => {
  it("speaks now-playing + radio hint via cueSay when played", async () => {
    const cueSay = vi.fn(async () => "played" as const);
    const getLiveStatus = vi.fn(async () =>
      liveStatus({
        nowPlaying: { name: "Track A", artist: "Artist" },
        radio: {
          enabled: true,
          activeProfile: "lobby",
          nextBumperHint: "Next bumper in 2 track(s)",
        },
      }),
    );
    const self = { getLiveStatus, radio: { cueSay } };
    const out = await speakRadioStatus.call(self);
    expect(out).toMatch(/^📻 /);
    expect(out).toMatch(/Track A/);
    expect(out).toMatch(/Artist/);
    expect(out).toMatch(/lobby/);
    expect(out).toMatch(/Next bumper in 2/);
    expect(cueSay).toHaveBeenCalledOnce();
    const spoken = cueSay.mock.calls[0]![0] as string;
    expect(spoken).toMatch(/Now playing Track A by Artist/);
    expect(spoken).toMatch(/Radio is on, profile lobby/);
  });

  it("reports nothing playing and radio off; text-only when cueSay unavailable", async () => {
    const cueSay = vi.fn(async () => "unavailable" as const);
    const getLiveStatus = vi.fn(async () =>
      liveStatus({ nowPlaying: null, radio: { enabled: false, activeProfile: "x", nextBumperHint: "" } }),
    );
    const out = await speakRadioStatus.call({ getLiveStatus, radio: { cueSay } });
    expect(out).toMatch(/Nothing is playing/);
    expect(out).toMatch(/Radio is off/);
    expect(out).toMatch(/speech unavailable/i);
  });

  it("fail-open text when cueSay throws", async () => {
    const cueSay = vi.fn(async () => {
      throw new Error("tts down");
    });
    const getLiveStatus = vi.fn(async () =>
      liveStatus({
        nowPlaying: { name: "Solo" },
        radio: {
          enabled: true,
          activeProfile: "combat",
          nextBumperHint: "Bumper due next break",
        },
      }),
    );
    const out = await speakRadioStatus.call({ getLiveStatus, radio: { cueSay } });
    expect(out).toMatch(/Solo/);
    expect(out).toMatch(/speech failed/i);
  });

  it("returns cued result as success text", async () => {
    const cueSay = vi.fn(async () => "cued" as const);
    const getLiveStatus = vi.fn(async () =>
      liveStatus({
        nowPlaying: { name: "Q" },
        radio: { enabled: true, activeProfile: "mining", nextBumperHint: "in 1" },
      }),
    );
    const out = await speakRadioStatus.call({ getLiveStatus, radio: { cueSay } });
    expect(out.startsWith("📻")).toBe(true);
    expect(out).not.toMatch(/unavailable|failed/i);
  });
});

describe("!radio speak-status / announce (V3 command path)", () => {
  function makeExecutor(deps: {
    speakRadioStatus?: () => Promise<string>;
    cueSay?: (t: string) => Promise<"played" | "cued" | "unavailable">;
    songsUntilBumper?: number | null;
  }) {
    const radioCfg = defaultRadioConfig();
    radioCfg.enabled = true;
    const status = {
      songsUntilBumper: deps.songsUntilBumper ?? 3,
      cuePending: false,
      skipNextPending: false,
    };
    return new CommandExecutor({
      playback: {} as never,
      player: {} as never,
      queue: {} as never,
      config: { commandPrefix: "!", radio: radioCfg } as never,
      profileManager: {} as never,
      tsClient: {} as never,
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn(),
      speakRadioStatus: deps.speakRadioStatus,
      radio: {
        cueSay: deps.cueSay ?? (async () => "played" as const),
        skipBumper: () => "none" as const,
        onTrackBoundary: async () => "advanced" as const,
        status: () => status,
      },
    });
  }

  it("speak-status calls injectable speakRadioStatus (instance path)", async () => {
    const speak = vi.fn(async () => "📻 Now playing X. Radio is on.");
    const ex = makeExecutor({ speakRadioStatus: speak });
    const out = await ex.execute({
      name: "radio",
      args: "speak-status",
      rawArgs: ["speak-status"],
      flags: new Set(),
    });
    expect(speak).toHaveBeenCalledOnce();
    expect(out).toBe("📻 Now playing X. Radio is on.");
  });

  it("announce is an alias for speak-status", async () => {
    const speak = vi.fn(async () => "📻 announced");
    const ex = makeExecutor({ speakRadioStatus: speak });
    const out = await ex.execute({
      name: "radio",
      args: "announce",
      rawArgs: ["announce"],
      flags: new Set(),
    });
    expect(speak).toHaveBeenCalledOnce();
    expect(out).toBe("📻 announced");
  });

  it("fallback uses radio.status + cueSay when speakRadioStatus not wired", async () => {
    const cueSay = vi.fn(async (t: string) => {
      expect(t).toMatch(/Next bumper in 2 tracks/);
      return "played" as const;
    });
    const ex = makeExecutor({ songsUntilBumper: 2, cueSay });
    const out = await ex.execute({
      name: "radio",
      args: "speak-status",
      rawArgs: ["speak-status"],
      flags: new Set(),
    });
    expect(cueSay).toHaveBeenCalledOnce();
    expect(out).toMatch(/Next bumper in 2 tracks/);
    expect(out).toMatch(/^📻 /);
  });
});
