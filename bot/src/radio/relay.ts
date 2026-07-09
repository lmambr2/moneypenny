/**
 * Relay-in (docs/radio.md §10 / R-R6).
 *
 * When a profile sets `music.relayUrl` to a live stream, the station hands
 * music off to that URL. Track boundaries are unknown, so bumpers fire on a
 * **timer** (not every-N songs). Default off — no relay unless a profile sets
 * the URL and radio is enabled.
 */

import type { Logger } from "../logger.js";
import { isStreamableUrl } from "../music/stream.js";
import { isPublicPlaybackUrl } from "../music/url-guard.js";

export interface RelayConfig {
  /** Live stream URL (http/https Icecast/SC). */
  relayUrl: string;
  /** Seconds between timer-driven bumpers while relaying (default 300). */
  bumperIntervalSec: number;
}

export function resolveRelayFromProfile(
  music?: {
    relayUrl?: string | null;
    relayBumperIntervalSec?: number;
  } | null,
): RelayConfig | null {
  const url = (music?.relayUrl ?? "").trim();
  if (!url) return null;
  if (!isStreamableUrl(url) && !isPublicPlaybackUrl(url)) return null;
  // isStreamableUrl already rejects private hosts; also allow public http(s)
  if (!/^https?:\/\//i.test(url)) return null;
  const interval =
    typeof music?.relayBumperIntervalSec === "number" && music.relayBumperIntervalSec > 0
      ? music.relayBumperIntervalSec
      : 300;
  return { relayUrl: url, bumperIntervalSec: interval };
}

export interface RelaySchedulerDeps {
  /** Fire a bumper (or no-op if factory empty). Never throws. */
  onBumper: () => void | Promise<void>;
  logger?: Logger;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}

/**
 * Timer-driven bumper schedule while a relay stream is active.
 * Start/stop is explicit; disabled when interval ≤ 0.
 */
export class RelayScheduler {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private cfg: RelayConfig | null = null;
  private ticks = 0;
  private lastTickAt = 0;
  /** Bumped on every stop/start so in-flight fire() cannot re-arm after stop. */
  private generation = 0;

  constructor(private deps: RelaySchedulerDeps) {}

  get active(): boolean {
    return !!this.cfg && !!this.handle;
  }

  get tickCount(): number {
    return this.ticks;
  }

  getConfig(): RelayConfig | null {
    return this.cfg;
  }

  status(): {
    active: boolean;
    relayUrl: string | null;
    bumperIntervalSec: number | null;
    ticks: number;
    lastTickAt: number;
  } {
    return {
      active: this.active,
      relayUrl: this.cfg?.relayUrl ?? null,
      bumperIntervalSec: this.cfg?.bumperIntervalSec ?? null,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
    };
  }

  /**
   * Begin (or restart) the timer for this relay. Pass null to stop fully
   * (clears cfg + handle; in-flight bumpers will not re-arm).
   * Returns whether the scheduler is now active.
   */
  start(cfg: RelayConfig | null): boolean {
    this.stop();
    if (!cfg || cfg.bumperIntervalSec <= 0) {
      return false;
    }
    this.cfg = cfg;
    this.arm();
    this.deps.logger?.info?.(
      { url: cfg.relayUrl.slice(0, 80), intervalSec: cfg.bumperIntervalSec },
      "radio relay: bumper timer started",
    );
    return true;
  }

  /**
   * Cancel timer and leave relay mode. Safe during an in-flight onBumper —
   * generation guard prevents re-arm when that promise settles.
   */
  stop(): void {
    this.generation += 1;
    if (this.handle != null) {
      (this.deps.clearTimer ?? clearTimeout)(this.handle);
      this.handle = null;
    }
    this.cfg = null;
  }

  /** Test/helper: force one tick now (does not reset the schedule). */
  async tickNow(): Promise<void> {
    await this.fire(this.generation);
  }

  private arm(): void {
    if (!this.cfg) return;
    const gen = this.generation;
    const ms = this.cfg.bumperIntervalSec * 1000;
    this.handle = (this.deps.setTimer ?? setTimeout)(() => {
      void this.fire(gen).then(() => {
        // Only re-arm if this generation is still live (not stopped/restarted).
        if (this.generation === gen && this.cfg) this.arm();
      });
    }, ms) as ReturnType<typeof setTimeout>;
  }

  private async fire(gen: number): Promise<void> {
    if (this.generation !== gen || !this.cfg) return;
    this.ticks += 1;
    this.lastTickAt = (this.deps.now ?? Date.now)();
    try {
      await this.deps.onBumper();
    } catch (err) {
      this.deps.logger?.warn?.({ err }, "radio relay: bumper tick failed (music continues)");
    }
  }
}

/** Song-shaped payload for queuing a relay URL on the stream platform. */
export function relaySongFromUrl(url: string): {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string;
  platform: "stream";
} {
  let name = "Live relay";
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    name = last ? decodeURIComponent(last) : u.hostname;
  } catch {
    /* keep default */
  }
  return {
    id: url,
    name,
    artist: "Relay",
    album: "Live stream",
    duration: 0,
    coverUrl: "",
    platform: "stream",
  };
}
