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
import type { LastPlayedBumper } from "./pin.js";

/** A built bumper ready to play: an absolute audio path + an optional label. */
export interface BuiltBumper {
  path: string;
  label?: string;
}

/** The bumper source the director drives (concrete factory lands with R-R2/R-R4). */
export interface BumperFactory {
  /** Resolve a bumper for this slot, or null if none is available/ready.
   *  `floor` is the broadcast classification floor (§6.3) — the intersection of
   *  every present member's clearance; generated sources must retrieve at it. */
  build(slot: WheelSlot, floor: string[]): Promise<BuiltBumper | null>;
  /** One-off operator liner (`!radio say`, §12) — TTS'd but never cached. */
  say?(text: string): Promise<BuiltBumper | null>;
}

export interface RadioDirectorDeps {
  getConfig: () => RadioConfig;
  player: Pick<AudioPlayer, "getState" | "play" | "resetFailures">;
  bumperFactory: BumperFactory;
  /** Advance the queue; resolves false when the queue is dry (drives dead air). */
  playNext: () => Promise<boolean>;
  logger: Logger;
  /** Resolve the classification floor from the last-polled channel members
   *  (§6.3). Absent or throwing → the director uses ["unclassified"] (§14). */
  resolveFloor?: (clients: unknown[]) => string[];
  /** Dead-air self-heal (§7 thenAutoProgram): reprogram + start music from the
   *  active profile. Resolves false when no profile/source matched. */
  autoProgram?: () => Promise<boolean>;
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
  private lastClients: unknown[] = [];
  private deadAirHandle: ReturnType<typeof setTimeout> | null = null;
  private clockCache: { sig: string; clock: FormatClock } | null = null;
  /** Operator cue (`!radio bumper` / `!radio say`, §6.4/§12): consumed at the
   *  next boundary, or fired immediately when idle. Explicit operator action —
   *  bypasses the rate/quiet gates but never the classification floor. */
  private cued: { slot?: WheelSlot; sayText?: string } | null = null;
  private skipNext = false;
  /** Set when a dead-air fill bumper fires: restock music at its trackEnd. */
  private autoProgramAfterBumper = false;
  /** Last bumper that actually started playing — used by `!radio pin` (§6.5). */
  private lastPlayed: LastPlayedBumper | null = null;

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
   * A track boundary fired — either a natural trackEnd (after voice declined to
   * resume; wired in `event-bindings.ts`, §5.1) or a manual `!skip` (a skip IS a
   * track break from the listener's side). Decide whether to inject a bumper or
   * advance the queue; returns which happened so callers can phrase the reply.
   */
  async onTrackBoundary(): Promise<"bumper" | "advanced"> {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) {
      await this.deps.playNext();
      return "advanced";
    }
    if (this.pendingAfterBumper) {
      // Our own bumper just ended (§5.2) — consume the boundary, don't re-inject.
      this.pendingAfterBumper = false;
      if (this.autoProgramAfterBumper) {
        // Dead-air sequence: the fill bumper has finished — now restock music
        // from the active profile (it starts playback itself; don't advance).
        this.autoProgramAfterBumper = false;
        if (await this.tryAutoProgram()) return "advanced";
      }
      await this.advance();
      return "advanced";
    }
    if (this.cued) {
      // Operator cue fires in place of this boundary's slot; the wheel cursor
      // is untouched so rotation resumes exactly where it was.
      if (await this.fireCued(cfg)) return "bumper";
      await this.advance();
      return "advanced";
    }
    const slot = this.clock().nextSlot();
    if (slot.slot === "song") {
      await this.advance();
      return "advanced";
    }
    if (this.skipNext) {
      this.skipNext = false; // `!radio skip` — drop this bumper slot, music instead
      await this.advance();
      return "advanced";
    }
    if (!this.canBroadcast(cfg) || !(await this.tryBumper(cfg, slot))) {
      await this.advance(); // gate failed or bumper unready → music first
      return "advanced";
    }
    // The bumper is playing; its trackEnd will drive the next advance.
    return "bumper";
  }

  /** `!radio bumper [topic]` (§6.4/§12): cue a bumper — immediate when idle,
   *  otherwise at the next track boundary. Returns what happened for the reply. */
  async cueBumper(topic?: string): Promise<"played" | "cued" | "unavailable"> {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return "unavailable";
    // A topic targets the doctrine source (still subject to the global source
    // toggle — an operator can't resurrect a source the admin disabled).
    this.cued = { slot: { slot: "bumper", sources: topic ? ["doctrine"] : cfg.sources, topic } };
    return this.maybeFireNow(cfg);
  }

  /** `!radio say <text>` (§12): one-off spoken liner, same cue semantics. */
  async cueSay(text: string): Promise<"played" | "cued" | "unavailable"> {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled || !this.deps.bumperFactory.say) return "unavailable";
    this.cued = { sayText: text };
    return this.maybeFireNow(cfg);
  }

  /** Live rotation position for `!radio status` (§12). */
  status(): { songsUntilBumper: number | null; cuePending: boolean; skipNextPending: boolean } {
    return {
      songsUntilBumper: this.deps.getConfig().enabled ? this.clock().songsUntilNonSong() : null,
      cuePending: this.cued !== null,
      skipNextPending: this.skipNext,
    };
  }

  /** Last bumper that started playing (for `!radio pin`). */
  getLastPlayedBumper(): LastPlayedBumper | null {
    return this.lastPlayed;
  }

  /** `!radio skip` (§12): drop the operator cue if present, else the next
   *  scheduled bumper slot. Returns which one was skipped. */
  skipBumper(): "cue" | "next" {
    if (this.cued) {
      this.cued = null;
      return "cue";
    }
    this.skipNext = true;
    return "next";
  }

  private async maybeFireNow(cfg: RadioConfig): Promise<"played" | "cued" | "unavailable"> {
    if (this.deps.player.getState() !== "idle") return "cued";
    const ok = await this.fireCued(cfg);
    return ok ? "played" : "unavailable";
  }

  /** Consume and play the operator cue. Bypasses the rate/quiet gates (explicit
   *  operator action) but keeps the classification floor (§6.3 is security, the
   *  gates are anti-spam). */
  private async fireCued(cfg: RadioConfig): Promise<boolean> {
    const cue = this.cued;
    this.cued = null;
    if (!cue) return false;
    try {
      const bumper = cue.sayText
        ? await this.deps.bumperFactory.say?.(cue.sayText) ?? null
        : await this.deps.bumperFactory.build(cue.slot!, this.currentFloor(cfg));
      if (!bumper) return false;
      this.recordBumper(); // still counts against the hourly window
      this.pendingAfterBumper = true;
      this.deps.player.resetFailures();
      this.markPlayed(bumper);
      this.deps.player.play(bumper.path, 0, 0, { volumePctFloor: cfg.speechVolumePct ?? 85 });
      this.deps.logger.info({ path: bumper.path, label: bumper.label, forced: true }, "radio: forced bumper");
      return true;
    } catch (err) {
      this.deps.logger.warn({ err }, "radio: forced bumper failed");
      this.pendingAfterBumper = false;
      return false;
    }
  }

  /**
   * Idle-poller backstop (§5.3): refresh presence and, if we're sitting idle
   * with listeners and no dead-air timer armed, arm one.
   */
  onPoll(clients: unknown[], humanCount: number): void {
    this.lastClients = clients;
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

  /** Broadcast classification floor (§6.3): config override wins, then the
   *  injected resolver over present members; any uncertainty → unclassified-only
   *  (§14). One uncleared listener floors the whole window. */
  private currentFloor(cfg: RadioConfig): string[] {
    if (cfg.classificationFloor && cfg.classificationFloor.length > 0) return cfg.classificationFloor;
    if (!this.deps.resolveFloor) return ["unclassified"];
    try {
      const floor = this.deps.resolveFloor(this.lastClients);
      return floor.length > 0 ? floor : ["unclassified"];
    } catch (err) {
      this.deps.logger.warn({ err }, "radio: floor resolution failed — defaulting to unclassified");
      return ["unclassified"];
    }
  }

  private async tryBumper(cfg: RadioConfig, slot: WheelSlot): Promise<boolean> {
    if (this.bumperInFlight) return false;
    this.bumperInFlight = true;
    try {
      const bumper = await this.deps.bumperFactory.build(this.resolveSources(cfg, slot), this.currentFloor(cfg));
      if (!bumper) return false; // §14: not ready → caller advances (music first)
      this.recordBumper();
      this.pendingAfterBumper = true;
      this.deps.player.resetFailures();
      this.markPlayed(bumper);
      this.deps.player.play(bumper.path, 0, 0, { volumePctFloor: cfg.speechVolumePct ?? 85 });
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

  /** Fill an idle window (§5.3/§7): play a fill bumper, then self-heal the
   *  queue from the active profile (`thenAutoProgram`, default on). The
   *  broadcast gates apply only to the bumper — restocking MUSIC is not a
   *  broadcast, so quiet hours/cooldown never leave the channel silent. */
  private async fillDeadAir(): Promise<void> {
    this.deadAirHandle = null;
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return;
    if (this.deps.player.getState() !== "idle") return; // music resumed meanwhile
    const wantProgram = cfg.clock?.deadAir?.thenAutoProgram ?? true;
    if (this.canBroadcast(cfg)) {
      const fill = cfg.clock?.deadAir?.fill ?? (["prerecorded", "stationId"] as const);
      if (await this.tryBumper(cfg, { slot: "bumper", sources: [...fill] })) {
        // Music restock happens at the bumper's trackEnd (single stream).
        this.autoProgramAfterBumper = wantProgram;
        return;
      }
    }
    if (wantProgram && (await this.tryAutoProgram())) return;
    this.armDeadAir(); // nothing to play yet — retry after another window
  }

  private async tryAutoProgram(): Promise<boolean> {
    if (!this.deps.autoProgram) return false;
    try {
      const ok = await this.deps.autoProgram();
      if (ok) {
        this.cancelDeadAir();
        this.deps.logger.info("radio: dead air — auto-programmed from the active profile");
      }
      return ok;
    } catch (err) {
      this.deps.logger.warn({ err }, "radio: auto-program failed");
      return false;
    }
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

  private markPlayed(bumper: BuiltBumper): void {
    this.lastPlayed = { path: bumper.path, label: bumper.label };
  }

  /** Stop timers (bot shutdown / disconnect). */
  dispose(): void {
    this.cancelDeadAir();
  }
}
