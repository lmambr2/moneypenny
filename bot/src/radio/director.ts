/**
 * RadioDirector — the program director (docs/radio.md §4/§5). A thin decision
 * layer over the existing player: at each track boundary (after voice declines
 * to resume) it consults the FormatClock and either lets the queue advance or
 * injects a bumper. It also fills dead air on a timer.
 *
 * Load-bearing invariants:
 *   - Disabled (`radio.enabled=false`) → every boundary just calls playNext():
 *     byte-identical to today (§13 R-R1 acceptance).
 *   - Never blocks music: a gate failure or an unready bumper falls through to
 *     playNext() (§6.3, §14). The model/TTS is never between a user and the music.
 *   - A bumper is itself an audio file that emits trackEnd; the `pendingAfterBumper`
 *     one-shot guard (§5.2) consumes that boundary so we advance instead of
 *     re-injecting.
 *
 * All I/O (config, time, timers, player, bumper build) is injected so the whole
 * decision surface is deterministically unit-testable.
 */
import type { AudioPlayer } from "../audio/player.js";
import type { Logger } from "../logger.js";
import { FormatClock, isWithinQuietHours } from "./clock.js";
import type { RadioConfig, WheelSlot } from "./types.js";

/** A built bumper ready to play: an absolute audio path + an optional label. */
export interface BuiltBumper {
  path: string;
  label?: string;
}

/** The bumper source the director drives (concrete factory lands with R-R2/R-R4). */
export interface BumperFactory {
  /** Resolve a bumper for this slot, or null if none is available/ready. */
  build(slot: WheelSlot): Promise<BuiltBumper | null>;
}

export interface RadioDirectorDeps {
  getConfig: () => RadioConfig;
  player: Pick<AudioPlayer, "getState" | "play" | "resetFailures">;
  bumperFactory: BumperFactory;
  /** Advance the queue; resolves false when the queue is dry (drives dead air). */
  playNext: () => Promise<boolean>;
  logger: Logger;
  /** Injectable clock (ms epoch) for cooldown/rate tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

const HOUR_MS = 3_600_000;

export class RadioDirector {
  private pendingAfterBumper = false;
  private bumperInFlight = false;
  private lastBumperAt = 0;
  private bumperTimes: number[] = [];
  private lastHumanCount = 0;
  private deadAirHandle: ReturnType<typeof setTimeout> | null = null;
  private clockCache: { sig: string; clock: FormatClock } | null = null;

  constructor(private deps: RadioDirectorDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return (this.deps.setTimer ?? setTimeout)(fn, ms) as ReturnType<typeof setTimeout>;
  }

  private clearTimer(h: ReturnType<typeof setTimeout>): void {
    (this.deps.clearTimer ?? clearTimeout)(h);
  }

  /**
   * A track boundary fired and voice did not resume its saved music. Decide
   * whether to inject a bumper or advance the queue. This is the seam wired into
   * `event-bindings.ts` in place of the bare `playNext()` (§5.1).
   */
  async onTrackBoundary(): Promise<void> {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) {
      await this.deps.playNext();
      return;
    }
    if (this.pendingAfterBumper) {
      // Our own bumper just ended (§5.2) — consume the boundary, don't re-inject.
      this.pendingAfterBumper = false;
      await this.advance();
      return;
    }
    const slot = this.clock().nextSlot();
    if (slot.slot === "song") {
      await this.advance();
      return;
    }
    if (!this.canBroadcast(cfg) || !(await this.tryBumper(cfg, slot))) {
      await this.advance(); // gate failed or bumper unready → music first
    }
    // else: the bumper is playing; its trackEnd will drive the next advance.
  }

  /**
   * Idle-poller backstop (§5.3): refresh presence and, if we're sitting idle
   * with listeners and no dead-air timer armed, arm one.
   */
  onPoll(_clients: unknown[], humanCount: number): void {
    this.lastHumanCount = humanCount;
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return;
    if (
      this.deps.player.getState() === "idle" &&
      humanCount >= cfg.minPresentToBroadcast &&
      this.deadAirHandle == null
    ) {
      this.armDeadAir();
    }
  }

  /** Advance the queue; if it's dry, arm the dead-air fill timer. */
  private async advance(): Promise<void> {
    let more = false;
    try {
      more = await this.deps.playNext();
    } catch (err) {
      this.deps.logger.error({ err }, "radio: playNext failed");
    }
    if (more) this.cancelDeadAir();
    else this.armDeadAir();
  }

  private async tryBumper(cfg: RadioConfig, slot: WheelSlot): Promise<boolean> {
    if (this.bumperInFlight) return false;
    this.bumperInFlight = true;
    try {
      const bumper = await this.deps.bumperFactory.build(this.resolveSources(cfg, slot));
      if (!bumper) return false; // §14: not ready → caller advances (music first)
      this.recordBumper();
      this.pendingAfterBumper = true;
      this.deps.player.resetFailures();
      this.deps.player.play(bumper.path);
      this.deps.logger.info({ path: bumper.path, label: bumper.label }, "radio: bumper injected");
      return true;
    } catch (err) {
      this.deps.logger.warn({ err }, "radio: bumper build/play failed — advancing");
      this.pendingAfterBumper = false;
      return false;
    } finally {
      this.bumperInFlight = false;
    }
  }

  /** Fill an idle window with a bumper (§5.3). Queue-seeding (`thenAutoProgram`)
   *  is R-R4; R-R1 just plays a throttled fill and re-arms if still dry. */
  private async fillDeadAir(): Promise<void> {
    this.deadAirHandle = null;
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return;
    if (this.deps.player.getState() !== "idle") return; // music resumed meanwhile
    if (!this.canBroadcast(cfg)) return;
    const fill = cfg.clock?.deadAir?.fill ?? (["prerecorded", "stationId"] as const);
    await this.tryBumper(cfg, { slot: "bumper", sources: [...fill] });
    // On the fill bumper's trackEnd the pending guard advances; if still dry the
    // advance re-arms this timer.
  }

  private armDeadAir(): void {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return;
    this.cancelDeadAir();
    this.deadAirHandle = this.setTimer(() => {
      void this.fillDeadAir();
    }, Math.max(1, cfg.deadAirSeconds) * 1000);
  }

  private cancelDeadAir(): void {
    if (this.deadAirHandle != null) {
      this.clearTimer(this.deadAirHandle);
      this.deadAirHandle = null;
    }
  }

  private canBroadcast(cfg: RadioConfig): boolean {
    if (this.lastHumanCount < cfg.minPresentToBroadcast) return false;
    if (isWithinQuietHours(new Date(this.now()), cfg.quietHours)) return false;
    const now = this.now();
    if (now - this.lastBumperAt < cfg.cooldownSeconds * 1000) return false;
    this.pruneHourly(now);
    if (this.bumperTimes.length >= cfg.maxBumpersPerHour) return false;
    return true;
  }

  private recordBumper(): void {
    const now = this.now();
    this.lastBumperAt = now;
    this.bumperTimes.push(now);
    this.pruneHourly(now);
  }

  private pruneHourly(now: number): void {
    const cutoff = now - HOUR_MS;
    while (this.bumperTimes.length > 0 && this.bumperTimes[0] < cutoff) {
      this.bumperTimes.shift();
    }
  }

  /** Bumper slots carry explicit sources; a stationId slot defaults to that
   *  single source; a bare bumper slot inherits the config's source list. */
  private resolveSources(cfg: RadioConfig, slot: WheelSlot): WheelSlot {
    if (slot.sources && slot.sources.length > 0) return slot;
    if (slot.slot === "stationId") return { ...slot, sources: ["stationId"] };
    return { ...slot, sources: cfg.sources };
  }

  private clock(): FormatClock {
    const cfg = this.deps.getConfig();
    const sig = JSON.stringify({ n: cfg.everyNSongs, w: cfg.clock?.wheel, s: cfg.sources });
    if (!this.clockCache || this.clockCache.sig !== sig) {
      this.clockCache = {
        sig,
        clock: FormatClock.forConfig(cfg.everyNSongs, cfg.clock, cfg.sources),
      };
    }
    return this.clockCache.clock;
  }

  /** Stop timers (bot shutdown / disconnect). */
  dispose(): void {
    this.cancelDeadAir();
  }
}
