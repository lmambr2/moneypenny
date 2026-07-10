/**
 * Sliding-window voice transport error counter (S-OC2).
 * Reconnect only on transport/session send failures — never ordinary decode/DTX.
 */

export interface VoiceTransportHealthOptions {
  /** Errors within window to trigger (default 5). */
  threshold?: number;
  /** Window ms (default 30_000). */
  windowMs?: number;
  /** Successful sends that clear the window (default 20). */
  healthyReset?: number;
  now?: () => number;
}

export class VoiceTransportHealth {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly healthyReset: number;
  private readonly now: () => number;

  private errorTimes: number[] = [];
  private healthyStreak = 0;
  private recoveryFired = false;

  constructor(opts: VoiceTransportHealthOptions = {}) {
    this.threshold = opts.threshold ?? 5;
    this.windowMs = opts.windowMs ?? 30_000;
    this.healthyReset = opts.healthyReset ?? 20;
    this.now = opts.now ?? Date.now;
  }

  /** Call after a successful sendVoice. */
  noteSuccess(): void {
    this.healthyStreak += 1;
    if (this.healthyStreak >= this.healthyReset) {
      this.errorTimes = [];
      this.healthyStreak = 0;
      this.recoveryFired = false;
    }
  }

  /**
   * Call after sendVoice throws.
   * @returns true once when threshold crossed (single-flight until reset).
   */
  noteError(): boolean {
    this.healthyStreak = 0;
    const t = this.now();
    this.errorTimes.push(t);
    const cutoff = t - this.windowMs;
    this.errorTimes = this.errorTimes.filter((x) => x >= cutoff);
    if (this.errorTimes.length < this.threshold || this.recoveryFired) {
      return false;
    }
    this.recoveryFired = true;
    this.errorTimes = [];
    return true;
  }

  /** After reconnect started — allow a future trigger. */
  clearRecoveryLatch(): void {
    this.recoveryFired = false;
  }

  /** Test helper. */
  get errorCount(): number {
    return this.errorTimes.length;
  }
}
