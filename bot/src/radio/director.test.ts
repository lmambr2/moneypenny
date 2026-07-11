import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerState } from "../audio/player.js";
import { type BuiltBumper, RadioDirector } from "./director.js";
import { defaultRadioConfig, type RadioConfig } from "./types.js";

/** Test harness: mutable config + fakes for player, bumper factory, timers, clock. */
function harness(cfgOverrides: Partial<RadioConfig> = {}) {
  const cfg: RadioConfig = { ...defaultRadioConfig(), enabled: true, ...cfgOverrides };
  let nowMs = 1_000_000_000;
  let bumper: BuiltBumper | null = { path: "/bumpers/id.mp3", label: "id" };
  let playerState: PlayerState = "playing";
  let queueHasMore = true;
  const pendingTimers: Array<() => void> = [];

  const player = {
    getState: (): PlayerState => playerState,
    play: vi.fn(),
    resetFailures: vi.fn(),
  };
  const bumperFactory = {
    build: vi.fn(async () => bumper),
    say: vi.fn(async (text: string) => ({ path: `/tmp/say-${text.length}.wav`, label: "say" })),
  };
  const playNext = vi.fn(async () => queueHasMore);
  const autoProgram = vi.fn(async () => false);
  const stopForEmptyChannel = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  const director = new RadioDirector({
    getConfig: () => cfg,
    player,
    bumperFactory,
    playNext,
    autoProgram,
    stopForEmptyChannel,
    logger,
    now: () => nowMs,
    setTimer: (fn) => {
      pendingTimers.push(fn);
      return pendingTimers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: vi.fn(),
  });

  return {
    director,
    player,
    bumperFactory,
    playNext,
    autoProgram,
    stopForEmptyChannel,
    cfg,
    setNow: (ms: number) => (nowMs = ms),
    advanceNow: (ms: number) => (nowMs += ms),
    setBumper: (b: BuiltBumper | null) => (bumper = b),
    setPlayerState: (s: PlayerState) => (playerState = s),
    setQueueHasMore: (v: boolean) => (queueHasMore = v),
    fireTimers: () => {
      const fns = pendingTimers.splice(0);
      for (const fn of fns) fn();
    },
    pendingTimerCount: () => pendingTimers.length,
  };
}

describe("RadioDirector", () => {
  let h: ReturnType<typeof harness>;

  describe("disabled (byte-identical to today)", () => {
    beforeEach(() => (h = harness({ enabled: false })));

    it("just advances the queue, never a bumper", async () => {
      await h.director.onTrackBoundary();
      await h.director.onTrackBoundary();
      expect(h.playNext).toHaveBeenCalledTimes(2);
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.bumperFactory.build).not.toHaveBeenCalled();
    });
  });

  describe("every-N injection + pending-bumper guard", () => {
    beforeEach(() => {
      h = harness({ everyNSongs: 2, minPresentToBroadcast: 1 });
      h.director.onPoll([], 1); // one listener present (player is 'playing' → no dead-air arm)
    });

    it("plays a bumper after N song boundaries, then resumes without double-injecting", async () => {
      await h.director.onTrackBoundary(); // song
      await h.director.onTrackBoundary(); // song
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalledTimes(2);

      await h.director.onTrackBoundary(); // bumper slot → inject
      expect(h.bumperFactory.build).toHaveBeenCalledTimes(1);
      expect(h.player.play).toHaveBeenCalledWith("/bumpers/id.mp3", 0, 0, { volumePctFloor: 85 });
      expect(h.playNext).toHaveBeenCalledTimes(2); // did NOT advance the queue

      await h.director.onTrackBoundary(); // the bumper's own trackEnd → guard consumes it
      expect(h.player.play).toHaveBeenCalledTimes(1); // no second bumper
      expect(h.playNext).toHaveBeenCalledTimes(3); // advanced instead
    });

    it("advances (music first) when the bumper is not ready", async () => {
      h.setBumper(null);
      await h.director.onTrackBoundary(); // song
      await h.director.onTrackBoundary(); // song
      await h.director.onTrackBoundary(); // bumper slot, but build() → null
      expect(h.bumperFactory.build).toHaveBeenCalledTimes(1);
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalledTimes(3); // fell through to playNext
    });
  });

  describe("gates", () => {
    it("suppresses bumpers when too few listeners are present", async () => {
      h = harness({ clock: { wheel: [{ slot: "bumper" }] }, minPresentToBroadcast: 2 });
      h.director.onPoll([], 1); // only 1 present, need 2
      await h.director.onTrackBoundary();
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalledTimes(1);
    });

    it("voice/chat activity counts as presence when clientlist undercounts", async () => {
      // Alone-stop uses list count only; disable it so this tests bumper minPresent backup.
      h = harness({
        clock: { wheel: [{ slot: "bumper" }] },
        minPresentToBroadcast: 1,
        emptyChannelStopSeconds: -1,
      });
      h.director.onPoll([], 0); // poll says empty (channelID bug)
      h.director.noteHumanActivity(48); // but we heard voice from clid 48
      h.director.noteHumanActivity(54);
      expect(h.director.effectiveHumanCount()).toBe(2);
      await h.director.onTrackBoundary();
      expect(h.player.play).toHaveBeenCalledTimes(1);
    });

    it("enforces the cooldown between bumpers", async () => {
      h = harness({
        clock: { wheel: [{ slot: "bumper" }] },
        cooldownSeconds: 180,
        minPresentToBroadcast: 1,
      });
      h.director.onPoll([], 1);

      await h.director.onTrackBoundary(); // bumper 1
      expect(h.player.play).toHaveBeenCalledTimes(1);
      await h.director.onTrackBoundary(); // bumper's trackEnd → guard advances

      h.advanceNow(1000); // still inside the 180s cooldown
      await h.director.onTrackBoundary(); // wants a bumper but cooldown blocks
      expect(h.player.play).toHaveBeenCalledTimes(1); // no second bumper

      h.advanceNow(180_000); // cooldown elapsed
      await h.director.onTrackBoundary();
      expect(h.player.play).toHaveBeenCalledTimes(2);
    });

    it("holds the hourly cap under flood (§13 R-R5)", async () => {
      h = harness({
        clock: { wheel: [{ slot: "bumper" }] },
        cooldownSeconds: 0,
        maxBumpersPerHour: 3,
        minPresentToBroadcast: 1,
      });
      h.director.onPoll([], 1);
      // Flood: every boundary wants a bumper; only 3 may fire within the hour.
      for (let i = 0; i < 10; i++) {
        await h.director.onTrackBoundary();
        h.advanceNow(1000);
      }
      expect(h.player.play).toHaveBeenCalledTimes(3);

      h.advanceNow(3_600_000); // window rolls over → allowed again
      await h.director.onTrackBoundary();
      expect(h.player.play).toHaveBeenCalledTimes(4);
    });

    it("respects quiet hours", async () => {
      h = harness({
        clock: { wheel: [{ slot: "bumper" }] },
        minPresentToBroadcast: 1,
        quietHours: [{ from: "00:00", to: "23:59" }], // effectively always quiet
      });
      h.director.onPoll([], 1);
      h.setNow(new Date(2026, 5, 30, 3, 0).getTime());
      await h.director.onTrackBoundary();
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalledTimes(1);
    });
  });

  describe("classification floor (§6.3)", () => {
    function floorHarness(
      over: Partial<RadioConfig> = {},
      resolveFloor?: (c: unknown[]) => string[],
    ) {
      const hh = harness({
        clock: { wheel: [{ slot: "bumper" }] },
        minPresentToBroadcast: 1,
        ...over,
      });
      const director = new RadioDirector({
        getConfig: () => ({
          ...defaultRadioConfig(),
          enabled: true,
          clock: { wheel: [{ slot: "bumper" }] },
          minPresentToBroadcast: 1,
          ...over,
        }),
        player: hh.player,
        bumperFactory: hh.bumperFactory,
        playNext: hh.playNext,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
        resolveFloor,
        now: () => 1_000_000_000,
      });
      return { director, build: hh.bumperFactory.build };
    }

    it("passes the resolved floor (from polled members) to the factory", async () => {
      const resolve = vi.fn(() => ["unclassified", "restricted"]);
      const { director, build } = floorHarness({}, resolve);
      const clients = [{ uid: "a" }, { uid: "b" }];
      director.onPoll(clients, 2);
      await director.onTrackBoundary();
      expect(resolve).toHaveBeenCalledWith(clients);
      expect(build).toHaveBeenCalledWith(expect.anything(), ["unclassified", "restricted"]);
    });

    it("defaults to unclassified with no resolver or a throwing one (§14)", async () => {
      const { director, build } = floorHarness();
      director.onPoll([], 1);
      await director.onTrackBoundary();
      expect(build).toHaveBeenCalledWith(expect.anything(), ["unclassified"]);

      const { director: d2, build: b2 } = floorHarness({}, () => {
        throw new Error("ts down");
      });
      d2.onPoll([], 1);
      await d2.onTrackBoundary();
      expect(b2).toHaveBeenCalledWith(expect.anything(), ["unclassified"]);
    });

    it("config classificationFloor override wins over the resolver", async () => {
      const { director, build } = floorHarness({ classificationFloor: ["unclassified"] }, () => [
        "unclassified",
        "secret",
      ]);
      director.onPoll([], 1);
      await director.onTrackBoundary();
      expect(build).toHaveBeenCalledWith(expect.anything(), ["unclassified"]);
    });
  });

  describe("operator cue / skip (§6.4/§12, R-R5)", () => {
    it("cueBumper while playing fires at the next boundary in place of the slot, wheel untouched", async () => {
      h = harness({ everyNSongs: 2, minPresentToBroadcast: 1, cooldownSeconds: 9999 });
      h.director.onPoll([], 1);

      expect(await h.director.cueBumper()).toBe("cued"); // player is 'playing'
      await h.director.onTrackBoundary(); // would be a song slot — cue takes it
      expect(h.player.play).toHaveBeenCalledTimes(1); // forced, despite the cooldown gate
      await h.director.onTrackBoundary(); // bumper's own end → advance

      // Wheel resumes where it was: song, song, then the scheduled bumper slot.
      await h.director.onTrackBoundary(); // song 2
      expect(h.playNext).toHaveBeenCalledTimes(2);
    });

    it("cueBumper fires immediately when idle and reports 'played'", async () => {
      h = harness({ minPresentToBroadcast: 0 });
      h.setPlayerState("idle");
      expect(await h.director.cueBumper()).toBe("played");
      expect(h.player.play).toHaveBeenCalledTimes(1);
    });

    it("cued bumper plays on !skip / track boundary (even when every-N not due)", async () => {
      h = harness({ everyNSongs: 99, minPresentToBroadcast: 1, cooldownSeconds: 9999 });
      h.director.onPoll([], 1);
      expect(await h.director.cueBumper()).toBe("cued");
      expect(await h.director.onTrackBoundary()).toBe("bumper");
      expect(h.player.play).toHaveBeenCalledTimes(1);
      expect(h.playNext).not.toHaveBeenCalled();
    });

    it("cued bumper wins dead-air fill (bypasses presence gate and fill sources)", async () => {
      h = harness({
        everyNSongs: 4,
        minPresentToBroadcast: 5, // would block scheduled fill
        cooldownSeconds: 9999,
      });
      h.director.onPoll([], 1);
      h.setQueueHasMore(false);
      expect(await h.director.cueBumper()).toBe("cued"); // still playing

      await h.director.onTrackBoundary(); // dry advance → would arm dead air, but cue fires at boundary first
      // If cue already fired at the boundary above, play was called. If not (song slot consumed cue):
      expect(h.player.play).toHaveBeenCalledTimes(1);
      expect(h.director.status().cuePending).toBe(false);
    });

    it("cued bumper fires on idle poll without waiting deadAirSeconds", async () => {
      h = harness({ minPresentToBroadcast: 1, deadAirSeconds: 60 });
      h.director.onPoll([], 1);
      expect(await h.director.cueBumper()).toBe("cued");
      // Simulate !stop: player goes idle without a track boundary
      h.setPlayerState("idle");
      h.director.onPoll([], 1);
      await Promise.resolve();
      await Promise.resolve();
      expect(h.player.play).toHaveBeenCalledTimes(1);
      expect(h.pendingTimerCount()).toBe(0); // did not wait for dead-air timer
    });

    it("cued bumper fires immediately when dead-air arm finds idle + cue", async () => {
      h = harness({ everyNSongs: 4, minPresentToBroadcast: 1, deadAirSeconds: 60 });
      h.director.onPoll([], 1);
      h.setQueueHasMore(false);
      expect(await h.director.cueBumper()).toBe("cued");
      // Boundary with cued still present fires the cue before advance — use a path
      // where cue survives: fire after dry state via armDeadAir only.
      // Clear by: skip the boundary path — set idle and call onPoll.
      h.setPlayerState("idle");
      h.director.onPoll([], 1);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.player.play).toHaveBeenCalledTimes(1);
    });

    it("a topic cue targets the doctrine source but keeps the classification floor", async () => {
      h = harness({ minPresentToBroadcast: 1 });
      h.director.onPoll([], 1);
      h.setPlayerState("idle");
      await h.director.cueBumper("refinery yields");
      expect(h.bumperFactory.build).toHaveBeenCalledWith(
        { slot: "bumper", sources: ["doctrine"], topic: "refinery yields" },
        ["unclassified"],
      );
    });

    it("cueSay speaks via the factory's say path", async () => {
      h = harness({});
      h.setPlayerState("idle");
      expect(await h.director.cueSay("stand by for briefing")).toBe("played");
      expect(h.bumperFactory.say).toHaveBeenCalledWith("stand by for briefing");
      expect(h.bumperFactory.build).not.toHaveBeenCalled();
    });

    it("returns unavailable when radio is off", async () => {
      h = harness({ enabled: false });
      expect(await h.director.cueBumper()).toBe("unavailable");
      expect(await h.director.cueSay("x")).toBe("unavailable");
    });

    it("skipBumper cancels a pending cue, else skips the next scheduled bumper slot", async () => {
      h = harness({ everyNSongs: 1, minPresentToBroadcast: 1 }); // [song, bumper]
      h.director.onPoll([], 1);

      await h.director.cueBumper();
      expect(h.director.skipBumper()).toBe("cue"); // cancels the cue
      await h.director.onTrackBoundary(); // song slot — no forced bumper fires
      expect(h.player.play).not.toHaveBeenCalled();

      expect(h.director.skipBumper()).toBe("next");
      await h.director.onTrackBoundary(); // the wheel's bumper slot — skipped
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalledTimes(2); // music instead, both times
    });
  });

  describe("boundary result + status (skip-as-boundary, countdown)", () => {
    it("reports 'bumper' when one fires and 'advanced' otherwise", async () => {
      h = harness({ everyNSongs: 1, minPresentToBroadcast: 1 }); // [song, bumper]
      h.director.onPoll([], 1);
      expect(await h.director.onTrackBoundary()).toBe("advanced"); // song slot
      expect(await h.director.onTrackBoundary()).toBe("bumper"); // bumper slot
      expect(await h.director.onTrackBoundary()).toBe("advanced"); // bumper's own end
    });

    it("status exposes the live countdown and pending flags", async () => {
      h = harness({ everyNSongs: 2, minPresentToBroadcast: 1 });
      h.director.onPoll([], 1);
      expect(h.director.status().songsUntilBumper).toBe(2);
      await h.director.onTrackBoundary();
      expect(h.director.status().songsUntilBumper).toBe(1);
      await h.director.cueBumper();
      expect(h.director.status().cuePending).toBe(true);
      h.director.skipBumper(); // cancels the cue
      h.director.skipBumper(); // now flags skip-next
      expect(h.director.status()).toMatchObject({ cuePending: false, skipNextPending: true });
    });

    it("status countdown is null when radio is off", () => {
      h = harness({ enabled: false });
      expect(h.director.status().songsUntilBumper).toBeNull();
    });
  });

  describe("dead air", () => {
    it("arms a fill timer when the queue runs dry and fills with a bumper", async () => {
      h = harness({ everyNSongs: 4, minPresentToBroadcast: 1 });
      h.director.onPoll([], 1);
      h.setQueueHasMore(false); // queue is dry

      await h.director.onTrackBoundary(); // song slot → advance → playNext=false → arm timer
      expect(h.pendingTimerCount()).toBe(1);
      expect(h.player.play).not.toHaveBeenCalled();

      h.setPlayerState("idle"); // still idle when the timer fires
      h.fireTimers();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.bumperFactory.build).toHaveBeenCalledTimes(1);
      expect(h.player.play).toHaveBeenCalledWith("/bumpers/id.mp3", 0, 0, { volumePctFloor: 85 });
    });

    it("self-heals: bumper first, music restocked from the profile at its end", async () => {
      h = harness({ everyNSongs: 4, minPresentToBroadcast: 1 });
      h.director.onPoll([], 1);
      h.setQueueHasMore(false); // queue dry
      h.autoProgram.mockResolvedValue(true);

      await h.director.onTrackBoundary(); // dry advance → dead-air timer armed
      h.setPlayerState("idle");
      h.fireTimers(); // fill fires: bumper plays
      await new Promise((r) => setTimeout(r, 0));
      expect(h.player.play).toHaveBeenCalledTimes(1);
      expect(h.autoProgram).not.toHaveBeenCalled(); // not during the bumper (single stream)

      await h.director.onTrackBoundary(); // the fill bumper's own trackEnd
      expect(h.autoProgram).toHaveBeenCalledTimes(1); // music restocked now
      expect(h.playNext).toHaveBeenCalledTimes(1); // autoProgram started music itself — no extra advance
    });

    it("restocks music directly when no fill bumper is available (gates or TTS down)", async () => {
      h = harness({ minPresentToBroadcast: 5 }); // gate blocks the bumper
      h.director.onPoll([], 1);
      h.setQueueHasMore(false);
      h.autoProgram.mockResolvedValue(true);

      await h.director.onTrackBoundary();
      h.setPlayerState("idle");
      h.fireTimers();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.player.play).not.toHaveBeenCalled(); // bumper gated
      expect(h.autoProgram).toHaveBeenCalledTimes(1); // music is NOT a broadcast — restocked anyway
    });

    it("re-arms and retries when nothing can play (no profile either)", async () => {
      h = harness({ minPresentToBroadcast: 5 });
      h.director.onPoll([], 1);
      h.setQueueHasMore(false);
      await h.director.onTrackBoundary();
      h.setPlayerState("idle");
      expect(h.pendingTimerCount()).toBe(1);
      h.fireTimers();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.pendingTimerCount()).toBe(1); // re-armed for another window
    });

    it("thenAutoProgram:false keeps the old bumper-only behavior", async () => {
      h = harness({
        minPresentToBroadcast: 5,
        clock: {
          wheel: [{ slot: "song" }],
          deadAir: { afterSeconds: 25, fill: ["stationId"], thenAutoProgram: false },
        },
      });
      h.director.onPoll([], 1);
      h.setQueueHasMore(false);
      await h.director.onTrackBoundary();
      h.setPlayerState("idle");
      h.fireTimers();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.autoProgram).not.toHaveBeenCalled();
    });

    it("does not fill if music resumed before the timer fired", async () => {
      h = harness({ minPresentToBroadcast: 1 });
      h.director.onPoll([], 1);
      h.setQueueHasMore(false);
      await h.director.onTrackBoundary();

      h.setPlayerState("playing"); // music came back
      h.fireTimers();
      await Promise.resolve();
      expect(h.player.play).not.toHaveBeenCalled();
    });
  });

  describe("empty-channel stop (alone = only bot)", () => {
    it("stops immediately when human count hits 0 (emptyChannelStopSeconds=0)", async () => {
      h = harness({
        everyNSongs: 99,
        minPresentToBroadcast: 1,
        emptyChannelStopSeconds: 0,
        cooldownSeconds: 9999,
      });
      h.director.onPoll([], 0); // only bot left
      h.setPlayerState("playing");
      await h.director.onTrackBoundary();
      expect(h.stopForEmptyChannel).toHaveBeenCalledTimes(1);
      expect(h.playNext).not.toHaveBeenCalled();
    });

    it("stops on poll as soon as alone", async () => {
      h = harness({
        minPresentToBroadcast: 1,
        emptyChannelStopSeconds: 0,
      });
      h.setPlayerState("playing");
      h.director.onPoll([], 0);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.stopForEmptyChannel).toHaveBeenCalledTimes(1);
    });

    it("keeps playing during optional grace window", async () => {
      h = harness({
        everyNSongs: 99,
        minPresentToBroadcast: 1,
        emptyChannelStopSeconds: 300,
        cooldownSeconds: 9999,
      });
      h.director.onPoll([], 0);
      h.setPlayerState("playing");
      await h.director.onTrackBoundary();
      expect(h.playNext).toHaveBeenCalled();
      expect(h.stopForEmptyChannel).not.toHaveBeenCalled();
    });

    it("stops after grace when emptyChannelStopSeconds > 0", async () => {
      h = harness({
        everyNSongs: 99,
        minPresentToBroadcast: 1,
        emptyChannelStopSeconds: 60,
        cooldownSeconds: 9999,
      });
      h.director.onPoll([], 0);
      h.setPlayerState("playing");
      h.advanceNow(60_000);
      await h.director.onTrackBoundary();
      expect(h.stopForEmptyChannel).toHaveBeenCalledTimes(1);
      expect(h.playNext).not.toHaveBeenCalled();
    });

    it("starts again when a human joins after alone-stop (count 1→2)", async () => {
      h = harness({
        minPresentToBroadcast: 1,
        emptyChannelStopSeconds: 0,
        deadAirSeconds: 5,
      });
      h.autoProgram.mockResolvedValue(true);
      h.setPlayerState("playing");
      h.director.onPoll([], 0); // bot alone
      await new Promise((r) => setTimeout(r, 0));
      expect(h.stopForEmptyChannel).toHaveBeenCalled();

      h.setPlayerState("idle");
      h.director.onPoll([], 1); // human joined → "2" including bot
      await new Promise((r) => setTimeout(r, 0));
      expect(h.autoProgram).toHaveBeenCalled();
    });

    it("emptyChannelStopSeconds=-1 keeps legacy keep-playing behavior", async () => {
      h = harness({
        everyNSongs: 99,
        minPresentToBroadcast: 1,
        emptyChannelStopSeconds: -1,
        cooldownSeconds: 9999,
      });
      h.director.onPoll([], 0);
      h.advanceNow(3_600_000);
      await h.director.onTrackBoundary();
      expect(h.stopForEmptyChannel).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalled();
    });
  });
});
