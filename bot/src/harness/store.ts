import type { HarnessTurn, HarnessTurnStore } from "./types.js";

/** In-memory ring buffer of recent harness turns (admin dashboard). */
export class InMemoryHarnessStore implements HarnessTurnStore {
  private turns: HarnessTurn[] = [];

  constructor(private max = 50) {}

  push(turn: HarnessTurn): void {
    this.turns.unshift(turn);
    if (this.turns.length > this.max) this.turns.length = this.max;
  }

  list(limit = 30): HarnessTurn[] {
    return this.turns.slice(0, Math.max(1, Math.min(limit, this.max)));
  }

  clear(): void {
    this.turns = [];
  }
}
