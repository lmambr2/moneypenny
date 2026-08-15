import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger.js";
import { VoiceSession, type VoiceSessionDeps } from "./session.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as unknown as Logger;

/** AudioPlayer stand-in tracking only the duck state the session drives. */
type PlayerState = "idle" | "playing" | "paused";

function fakePlayer(state: PlayerState = "playing") {
  let ducked = false;
  return {
    ducked: () => ducked,
    getState: vi.fn((): PlayerState => state),
    duckForStt: vi.fn((_level: number) => {
      ducked = true;
      return true;
    }),
    restoreFromSttDuck: vi.fn(() => {
      const was = ducked;
      ducked = false;
      return was;
    }),
    isSttDucked: vi.fn(() => ducked),
    getVolume: vi.fn(() => 30),
    setVolume: vi.fn(),
    stop: vi.fn(),
    play: vi.fn(),
    getElapsed: vi.fn(() => 0),
  };
}

function makeSession(over: Partial<VoiceSessionDeps> = {}) {
  const player = fakePlayer();
  const tsClient = {
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    ensureInboundVoiceCapture: vi.fn(),
    releaseInboundVoiceCapture: vi.fn(),
    getClientsInChannel: vi.fn(async () => []),
  };
  const onClientList = vi.fn();

  const deps = {
    config: {
      commandPrefix: "!",
      voice: {
        enabled: true,
        // Never dialled in these tests — the STT client is lazy.
        sttUrl: "http://127.0.0.1:9/",
        watchword: "moneypenny",
        requireWatchword: true,
        energyThreshold: 200,
        duckMusicOnSpeech: true,
        duckMusicVolume: 15,
      },
    },
    logger: silentLogger,
    tsClient,
    player,
    // A current track is required before the wake duck engages — there is
    // nothing to attenuate on an idle channel.
    queue: {
      current: () => ({
        id: "t1",
        name: "Track",
        artist: "Artist",
        album: "Album",
        platform: "local" as const,
        coverUrl: "",
        duration: 180,
      }),
    },
    router: {},
    bot: {},
    rightsEngine: () => null,
    getProviderFor: vi.fn(),
    isConnected: () => true,
    onClientList,
    ...over,
  } as unknown as VoiceSessionDeps;

  const session = new VoiceSession(deps);
  // Reach into private state the way the other suites in this repo do.
  const internal = session as unknown as {
    speakerArm: { arm(id: number): void; isArmed(id: number): boolean };
    captureDuck: unknown;
    ensureMusicDuckedOnWake(clientId: number): void;
    pruneClientMaps(live: Set<number>): void;
    ttsPlaybackActive: boolean;
    speechQueue: { isSpeaking: boolean };
  };

  return { session, deps, player, tsClient, onClientList, internal };
}

function client(id: number) {
  return { id, uid: `uid-${id}`, serverGroups: ["7"], nickname: `user${id}` };
}

describe("VoiceSession lifecycle", () => {
  it("is inactive until enabled", () => {
    const { session } = makeSession();
    expect(session.isActive).toBe(false);
  });

  it("enable() wires inbound voice capture and activates the pipeline", () => {
    const { session, tsClient } = makeSession();
    session.enable();
    expect(session.isActive).toBe(true);
    expect(tsClient.on).toHaveBeenCalledWith("voiceData", expect.any(Function));
    expect(tsClient.ensureInboundVoiceCapture).toHaveBeenCalled();
  });

  it("does not enable when voice is disabled in config", () => {
    const { session, tsClient } = makeSession({
      config: { commandPrefix: "!", voice: { enabled: false } },
    } as unknown as Partial<VoiceSessionDeps>);
    session.enable();
    expect(session.isActive).toBe(false);
    expect(tsClient.ensureInboundVoiceCapture).not.toHaveBeenCalled();
  });

  // An STT URL is the one hard requirement; without it the loop cannot run.
  it("does not enable when no sttUrl is configured", () => {
    const { session } = makeSession({
      config: { commandPrefix: "!", voice: { enabled: true, sttUrl: "" } },
    } as unknown as Partial<VoiceSessionDeps>);
    session.enable();
    expect(session.isActive).toBe(false);
  });

  it("disable() deactivates the pipeline", () => {
    const { session } = makeSession();
    session.enable();
    expect(session.isActive).toBe(true);
    session.disable();
    expect(session.isActive).toBe(false);
  });
});

describe("VoiceSession client cache", () => {
  it("ignores refreshes while the pipeline is inactive", () => {
    const { session, onClientList } = makeSession();
    session.refreshClientCache([client(1)]);
    expect(onClientList).not.toHaveBeenCalled();
  });

  it("forwards the live client list once enabled", () => {
    const { session, onClientList } = makeSession();
    session.enable();
    session.refreshClientCache([client(1), client(2)]);
    expect(onClientList).toHaveBeenCalledOnce();
    expect(onClientList.mock.calls[0]![0]).toHaveLength(2);
  });

  it("defaults missing serverGroups to an empty list rather than undefined", () => {
    const { session, onClientList } = makeSession();
    session.enable();
    session.refreshClientCache([{ id: 3, uid: "uid-3", nickname: "user3" }]);
    expect(onClientList.mock.calls[0]![0][0].serverGroups).toEqual([]);
  });
});

/**
 * Audit A2. pruneClientMaps used to delete `armedUntil` directly, which skipped
 * releaseCaptureDuck — so if an armed speaker left the channel the music stayed
 * attenuated until the arm timer (15s) or the duck watchdog (18s) fired.
 */
describe("VoiceSession duck release on speaker departure (audit A2)", () => {
  it("restores music volume when an armed, ducking speaker leaves", () => {
    const { session, player, internal } = makeSession();
    session.enable();
    session.refreshClientCache([client(1)]);

    internal.speakerArm.arm(1);
    internal.ensureMusicDuckedOnWake(1);
    expect(player.isSttDucked()).toBe(true);

    // Speaker 1 is gone from the channel on the next poll.
    session.refreshClientCache([client(2)]);

    expect(player.restoreFromSttDuck).toHaveBeenCalled();
    expect(player.isSttDucked()).toBe(false);
    expect(internal.speakerArm.isArmed(1)).toBe(false);
  });

  it("keeps the duck while the armed speaker is still present", () => {
    const { session, player, internal } = makeSession();
    session.enable();
    session.refreshClientCache([client(1)]);

    internal.speakerArm.arm(1);
    internal.ensureMusicDuckedOnWake(1);
    expect(player.isSttDucked()).toBe(true);

    session.refreshClientCache([client(1), client(2)]);

    expect(player.isSttDucked()).toBe(true);
    expect(internal.speakerArm.isArmed(1)).toBe(true);
  });

  it("disarms a departed speaker even when nothing was ducked", () => {
    const { session, internal } = makeSession();
    session.enable();
    session.refreshClientCache([client(1)]);
    internal.speakerArm.arm(1);

    session.refreshClientCache([]);
    expect(internal.speakerArm.isArmed(1)).toBe(false);
  });

  it("does not duck when no music is playing", () => {
    const player = fakePlayer("idle");
    const { session, internal } = makeSession({ player } as unknown as Partial<VoiceSessionDeps>);
    session.enable();
    internal.speakerArm.arm(1);
    internal.ensureMusicDuckedOnWake(1);
    expect(player.isSttDucked()).toBe(false);
  });
});

describe("VoiceSession wake duck vs the bot's own TTS", () => {
  // The player is shared: speak() parks the song in savedMusic and plays the
  // reply on the SAME AudioPlayer. getState() reports "playing" either way, so
  // a wake arriving mid-reply used to duck the reply itself — heard live as
  // Moneypenny dropping to a mutter partway through "Now playing: ...".
  it("ducks normally when the player is playing actual music", () => {
    const { internal, player } = makeSession();
    internal.ensureMusicDuckedOnWake(1);
    expect(player.duckForStt).toHaveBeenCalledWith(15);
    expect(player.ducked()).toBe(true);
    expect(internal.captureDuck).not.toBeNull();
  });

  it("does NOT duck while a TTS reply is playing", () => {
    const { internal, player } = makeSession();
    internal.ttsPlaybackActive = true;
    internal.ensureMusicDuckedOnWake(1);
    expect(player.duckForStt).not.toHaveBeenCalled();
    expect(player.ducked()).toBe(false);
    // No duck means no capture state and therefore no watchdog to leak.
    expect(internal.captureDuck).toBeNull();
  });

  it("does NOT duck while the speech queue is still speaking", () => {
    const { internal, player } = makeSession();
    // isSpeaking is a getter on SpeechQueue — spy on it rather than assigning.
    vi.spyOn(internal.speechQueue, "isSpeaking", "get").mockReturnValue(true);
    internal.ensureMusicDuckedOnWake(1);
    expect(player.duckForStt).not.toHaveBeenCalled();
    expect(player.ducked()).toBe(false);
  });

  it("resumes ducking once the reply has finished", () => {
    const { internal, player } = makeSession();
    internal.ttsPlaybackActive = true;
    internal.ensureMusicDuckedOnWake(1);
    expect(player.duckForStt).not.toHaveBeenCalled();

    // cleanup() in speak() clears the flag when trackEnd/error/abort fires.
    internal.ttsPlaybackActive = false;
    internal.ensureMusicDuckedOnWake(1);
    expect(player.duckForStt).toHaveBeenCalledWith(15);
    expect(player.ducked()).toBe(true);
  });

  it("karaoke mode ducks to 80 instead of the configured 15", () => {
    const { session, internal, player } = makeSession({
      config: {
        commandPrefix: "!",
        voice: {
          enabled: true,
          sttUrl: "http://127.0.0.1:9/",
          duckMusicOnSpeech: true,
          duckMusicVolume: 15,
          karaokeMode: true,
        },
      },
    } as unknown as Partial<VoiceSessionDeps>);
    session.enable();
    internal.ensureMusicDuckedOnWake(1);
    expect(player.duckForStt).toHaveBeenCalledWith(80);
  });

  it("setKaraokeMode re-applies the duck while already ducked", () => {
    const { session, internal, player } = makeSession();
    session.enable();
    internal.ensureMusicDuckedOnWake(1);
    expect(player.duckForStt).toHaveBeenCalledWith(15);
    session.setKaraokeMode(true);
    expect(player.duckForStt).toHaveBeenCalledWith(80);
    session.setKaraokeMode(false);
    expect(player.duckForStt).toHaveBeenLastCalledWith(15);
  });

  it("still skips the duck when TTS is playing over an otherwise duckable track", () => {
    // Guards against a future refactor reordering the TTS check below the
    // getState()/queue.current() guards, which would restore the old bug.
    const { internal, player } = makeSession();
    internal.ttsPlaybackActive = true;
    vi.spyOn(internal.speechQueue, "isSpeaking", "get").mockReturnValue(true);
    internal.ensureMusicDuckedOnWake(1);
    expect(player.duckForStt).not.toHaveBeenCalled();
  });
});

/**
 * suppressNextTrackAdvance is armed by a pause/stop voice reply and meant to
 * swallow exactly ONE trackEnd — the one from that reply's TTS, arriving within
 * seconds. Barge-in cancels TTS via player.stop(), which emits no trackEnd, so
 * the flag could survive and later eat a real end-of-song, parking the queue
 * into dead air. Same shape as the other cross-path state bugs.
 */
describe("VoiceSession stale pause/stop suppression", () => {
  type Internals = {
    suppressNextTrackAdvance: boolean;
    suppressArmedAt: number;
    savedMusic: unknown;
    captureDuck: unknown;
    ttsPlaybackActive: boolean;
  };

  it("swallows the trackEnd from the reply it was armed for", async () => {
    const { session } = makeSession();
    const inner = session as unknown as Internals;
    inner.suppressNextTrackAdvance = true;
    inner.suppressArmedAt = Date.now();

    const playNext = vi.fn(async () => true);
    expect(await session.handleTrackEnd(playNext)).toBe(true);
    expect(playNext).not.toHaveBeenCalled();
  });

  it("ignores a stale flag rather than parking the queue", async () => {
    const { session } = makeSession();
    const inner = session as unknown as Internals;
    inner.suppressNextTrackAdvance = true;
    inner.suppressArmedAt = Date.now() - 5 * 60_000; // TTS trackEnd never came

    const playNext = vi.fn(async () => true);
    await session.handleTrackEnd(playNext);
    // Must fall through to the normal resume/advance path, not swallow it.
    expect(inner.suppressNextTrackAdvance).toBe(false);
  });

  it("clears cross-path state on cleanup so it cannot survive a reconnect", () => {
    const { session } = makeSession();
    const inner = session as unknown as Internals;
    inner.suppressNextTrackAdvance = true;
    inner.savedMusic = { song: { id: "x" }, elapsed: 5 };
    inner.ttsPlaybackActive = true;

    session.cleanup();

    expect(inner.suppressNextTrackAdvance).toBe(false);
    expect(inner.savedMusic).toBeNull();
    expect(inner.captureDuck).toBeNull();
    expect(inner.ttsPlaybackActive).toBe(false);
  });
});

/**
 * The shared AudioPlayer reports "playing" for a TTS reply as well as music,
 * because speak() airs the reply on the same player. Callers that mean "music
 * is competing with the speaker" must not be fooled by the bot's own voice.
 *
 * This bit twice: once ducking a reply mid-sentence, and once dropping command
 * audio -- the flush guard held capture "until music is ducked", but during TTS
 * the duck is deliberately skipped, so the guard never released.
 */
describe("VoiceSession music-vs-own-voice", () => {
  type Internals = {
    ttsPlaybackActive: boolean;
    speechQueue: { isSpeaking: boolean };
    isMusicPlaying(): boolean;
    isBotSpeaking(): boolean;
  };

  it("counts real music as music", () => {
    const { session } = makeSession(); // fakePlayer defaults to "playing"
    const inner = session as unknown as Internals;
    expect(inner.isMusicPlaying()).toBe(true);
    expect(inner.isBotSpeaking()).toBe(false);
  });

  it("does not count the bot's own TTS as music", () => {
    const { session } = makeSession();
    const inner = session as unknown as Internals;
    inner.ttsPlaybackActive = true;
    expect(inner.isBotSpeaking()).toBe(true);
    expect(inner.isMusicPlaying()).toBe(false);
  });

  it("does not count a queued reply still being spoken as music", () => {
    const { session } = makeSession();
    const inner = session as unknown as Internals;
    vi.spyOn(inner.speechQueue, "isSpeaking", "get").mockReturnValue(true);
    expect(inner.isMusicPlaying()).toBe(false);
  });

  it("reports no music when the player is idle", () => {
    const player = fakePlayer("idle");
    const { session } = makeSession({ player } as unknown as Partial<VoiceSessionDeps>);
    expect((session as unknown as Internals).isMusicPlaying()).toBe(false);
  });
});
