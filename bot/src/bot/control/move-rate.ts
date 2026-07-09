/**
 * Simple sliding-window rate limit for privileged client moves (DESIGN §R4).
 * Prevents accidental "move everyone" spam from chat or voice.
 */
export class MoveClientRateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxPerWindow = 5,
    private readonly windowMs = 60_000,
  ) {}

  /** Returns false when the limit is exceeded. */
  tryTake(now = Date.now()): boolean {
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxPerWindow) return false;
    this.timestamps.push(now);
    return true;
  }
}
