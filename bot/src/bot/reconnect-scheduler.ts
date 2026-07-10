/**
 * Event-driven reconnect with exponential backoff (S-OC3).
 * delay = min(baseMs * 2^(attempt-1), maxMs). Single-flight per bot id.
 */

export type ReconnectSchedulerLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export interface ReconnectSchedulerOptions {
  reconnect: (id: string) => Promise<void>;
  /** Default 2000. */
  baseMs?: number;
  /** Default 60_000. */
  maxMs?: number;
  logger?: ReconnectSchedulerLogger;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class ReconnectScheduler {
  private readonly reconnect: (id: string) => Promise<void>;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly logger?: ReconnectSchedulerLogger;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private attempts = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = new Set<string>();

  constructor(opts: ReconnectSchedulerOptions) {
    this.reconnect = opts.reconnect;
    this.baseMs = opts.baseMs ?? 2_000;
    this.maxMs = opts.maxMs ?? 60_000;
    this.logger = opts.logger;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  }

  /** True if a timer is pending or reconnect() is running. */
  isBusy(id: string): boolean {
    return this.timers.has(id) || this.inFlight.has(id);
  }

  /** Clear timers/attempts (e.g. successful connect or operator stop). */
  cancel(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) {
      this.clearTimeoutFn(t);
      this.timers.delete(id);
    }
    this.attempts.delete(id);
    // Leave inFlight alone — the running reconnect will finish; mark cancelled via attempts reset after.
  }

  /** Reset backoff after a healthy connection. */
  reset(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) {
      this.clearTimeoutFn(t);
      this.timers.delete(id);
    }
    this.attempts.delete(id);
  }

  /**
   * Schedule a reconnect. No-ops if already busy (single-flight).
   * `reason` is for logs only.
   */
  schedule(id: string, reason = "disconnected"): void {
    if (this.isBusy(id)) {
      this.logger?.info({ botId: id, reason }, "Reconnect already scheduled or in flight");
      return;
    }

    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    const delay = Math.min(this.baseMs * 2 ** (attempt - 1), this.maxMs);

    this.logger?.warn({ botId: id, reason, attempt, delayMs: delay }, "Scheduling reconnect");

    const timer = this.setTimeoutFn(() => {
      this.timers.delete(id);
      void this.run(id, reason, attempt);
    }, delay);
    // Don't keep the process alive solely for reconnect timers.
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private async run(id: string, reason: string, attempt: number): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    let failed = false;
    try {
      this.logger?.info({ botId: id, reason, attempt }, "Reconnect attempt starting");
      await this.reconnect(id);
      this.attempts.delete(id);
      this.logger?.info({ botId: id, attempt }, "Reconnect attempt succeeded");
    } catch (err) {
      failed = true;
      this.logger?.error(
        { err: err instanceof Error ? err.message : String(err), botId: id, attempt },
        "Reconnect attempt failed — will reschedule with backoff",
      );
    } finally {
      this.inFlight.delete(id);
    }
    // Reschedule only after clearing inFlight so single-flight allows the next timer.
    if (failed && !this.timers.has(id)) {
      this.schedule(id, "retry-after-fail");
    }
  }

  /** Test helper: current attempt count (0 if none). */
  getAttempt(id: string): number {
    return this.attempts.get(id) ?? 0;
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.cancel(id);
    this.inFlight.clear();
  }
}

/** Pure delay helper for tests/docs. */
export function reconnectDelayMs(attempt: number, baseMs = 2_000, maxMs = 60_000): number {
  if (attempt < 1) return baseMs;
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}
