/** Skip TS6 HTTP Query after auth/timeout failures so every poll is not a 5s wait. */
const QUERY_COOLDOWN_MS = 5 * 60_000;
const QUERY_FAIL_RE =
  /401|403|timeout|invalid api|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket hang up/i;

export function isQueryTransientFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return QUERY_FAIL_RE.test(msg);
}

export class QueryCooldown {
  private until = 0;

  constructor(private readonly ttlMs = QUERY_COOLDOWN_MS) {}

  get remainingMs(): number {
    return Math.max(0, this.until - Date.now());
  }

  get active(): boolean {
    return this.remainingMs > 0;
  }

  noteFailure(err: unknown): void {
    if (isQueryTransientFailure(err)) {
      this.until = Date.now() + this.ttlMs;
    }
  }
}
