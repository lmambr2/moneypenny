import type { Logger } from "./logger.js";

/**
 * Watchdog (DESIGN §13, Phase 3 polish).
 *
 * Recovers from two failure modes on the single-board deployment:
 *  1. A bot that should be connected (autoStart) has dropped — reconnect it,
 *     rate-limited per bot so a flapping server isn't hammered.
 *  2. Process RSS exceeds a memory ceiling (NPU/transcode pressure, leaks) —
 *     log and invoke `onMemoryExceeded` (wire it to `process.exit` so Docker's
 *     `restart: unless-stopped` brings the container back cleanly).
 *
 * The clock and memory reader are injectable so the logic is unit-testable
 * without real timers or process state.
 */

export interface WatchdogTarget {
  id: string;
  name?: string;
  isConnected(): boolean;
  reconnect(): Promise<void>;
  /** When true, event-driven reconnect already owns recovery — skip this tick. */
  isReconnecting?: () => boolean;
}

export interface WatchdogOptions {
  getTargets: () => WatchdogTarget[];
  logger: Logger;
  /** Poll interval. Default 30s. */
  intervalMs?: number;
  /** Minimum gap between reconnect attempts for the same bot. Default 60s. */
  reconnectCooldownMs?: number;
  /** RSS ceiling in MB; 0/undefined disables the memory check. */
  memoryLimitMb?: number;
  onMemoryExceeded?: (rssMb: number) => void;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Injectable RSS reader (bytes). Defaults to process RSS. */
  memoryUsage?: () => number;
}

export class Watchdog {
  private opts: WatchdogOptions;
  private logger: Logger;
  private intervalMs: number;
  private cooldownMs: number;
  private memoryLimitMb: number;
  private now: () => number;
  private memoryUsage: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAttempt = new Map<string, number>();
  private ticking = false;

  constructor(opts: WatchdogOptions) {
    this.opts = opts;
    this.logger = opts.logger.child ? opts.logger.child({ component: "watchdog" }) : opts.logger;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.cooldownMs = opts.reconnectCooldownMs ?? 60_000;
    this.memoryLimitMb = opts.memoryLimitMb ?? 0;
    this.now = opts.now ?? (() => Date.now());
    this.memoryUsage = opts.memoryUsage ?? (() => process.memoryUsage().rss);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error({ err }, "Watchdog tick failed"));
    }, this.intervalMs);
    // Don't keep the event loop alive solely for the watchdog.
    this.timer.unref?.();
    this.logger.info(
      { intervalMs: this.intervalMs, memoryLimitMb: this.memoryLimitMb },
      "Watchdog started",
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One monitoring cycle. Safe to call directly (tests). Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return; // don't overlap slow reconnects with the next interval
    this.ticking = true;
    try {
      this.checkMemory();
      await this.checkConnections();
    } finally {
      this.ticking = false;
    }
  }

  private checkMemory(): void {
    if (this.memoryLimitMb <= 0) return;
    const rssMb = this.memoryUsage() / (1024 * 1024);
    if (rssMb > this.memoryLimitMb) {
      this.logger.error(
        { rssMb: Math.round(rssMb), limitMb: this.memoryLimitMb },
        "Memory ceiling exceeded",
      );
      this.opts.onMemoryExceeded?.(rssMb);
    }
  }

  private async checkConnections(): Promise<void> {
    const now = this.now();
    for (const t of this.opts.getTargets()) {
      if (t.isConnected()) {
        this.lastAttempt.delete(t.id); // healthy — reset backoff
        continue;
      }
      // S-OC3: event-driven scheduler may already be backing off / connecting.
      if (t.isReconnecting?.()) {
        this.logger.debug?.(
          { botId: t.id, name: t.name },
          "Bot disconnected — event reconnect in progress, watchdog skipping",
        );
        continue;
      }
      const last = this.lastAttempt.get(t.id);
      // Never-attempted targets are always eligible; otherwise honor the cooldown.
      if (last !== undefined && now - last < this.cooldownMs) continue;
      this.lastAttempt.set(t.id, now);
      this.logger.warn({ botId: t.id, name: t.name }, "Bot disconnected — attempting reconnect");
      try {
        await t.reconnect();
        this.logger.info({ botId: t.id, name: t.name }, "Watchdog reconnect succeeded");
      } catch (err) {
        this.logger.error(
          { err, botId: t.id },
          "Watchdog reconnect failed (will retry after cooldown)",
        );
      }
    }
  }
}
