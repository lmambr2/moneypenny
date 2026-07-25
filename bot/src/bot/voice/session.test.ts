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
function fakePlayer() {
  let ducked = false;
  return {
    ducked: () => ducked,
    getState: vi.fn(() => "playing" as const),
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
    const player = fakePlayer();
    player.getState = vi.fn(() => "idle" as const);
    const { session, internal } = makeSession({ player } as unknown as Partial<VoiceSessionDeps>);
    session.enable();
    internal.speakerArm.arm(1);
    internal.ensureMusicDuckedOnWake(1);
    expect(player.isSttDucked()).toBe(false);
  });
});
