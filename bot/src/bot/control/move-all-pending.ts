import type { QueryClient } from "../../ts-protocol/move-resolver.js";

export interface MoveAllPending {
  channel: string;
  targets: QueryClient[];
  invokerUid: string;
  expiresAt: number;
}

/** Short-lived confirmation gate for mass channel moves (DESIGN §R4). */
export class MoveAllPendingStore {
  private pending: MoveAllPending | null = null;

  constructor(
    private readonly ttlMs = 30_000,
    readonly maxTargets = 10,
  ) {}

  stage(channel: string, targets: QueryClient[], invokerUid: string, now = Date.now()): void {
    this.pending = { channel, targets, invokerUid, expiresAt: now + this.ttlMs };
  }

  /** Consume a pending mass-move if the invoker confirms in time. */
  confirm(invokerUid: string, now = Date.now()): MoveAllPending | null {
    const p = this.pending;
    if (!p || now > p.expiresAt || p.invokerUid !== invokerUid) return null;
    this.pending = null;
    return p;
  }

  clear(): void {
    this.pending = null;
  }
}
