/**
 * Per-client post-wake "armed" window (audit D2).
 * Owns arm timers + keepalive + partial-route dedupe; VoiceSession supplies side effects.
 */

export type SpeakerArmHooks = {
  /** Called when the arm window expires (listen timeout). */
  onExpire: (clientId: number) => void;
  /** Optional: keep STT command mode warm while armed. */
  onKeepalive?: (clientId: number) => void;
  listenWindowMs: number;
  keepaliveIntervalMs?: number;
};

/**
 * Finite arm state per speaker:
 *   idle → armed (on wake) → idle (timeout | disarm | leave)
 */
export class SpeakerArmTracker {
  private armedUntil = new Map<number, number>();
  private armTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private keepaliveTimers = new Map<number, ReturnType<typeof setInterval>>();
  private partialRoutedCommand = new Map<number, string>();

  constructor(private hooks: SpeakerArmHooks) {}

  get listenWindowMs(): number {
    return this.hooks.listenWindowMs;
  }

  setListenWindowMs(ms: number): void {
    this.hooks.listenWindowMs = ms;
  }

  isArmed(clientId: number): boolean {
    const until = this.armedUntil.get(clientId);
    if (!until) return false;
    if (Date.now() >= until) {
      this.armedUntil.delete(clientId);
      return false;
    }
    return true;
  }

  anyArmed(): boolean {
    for (const id of this.armedUntil.keys()) {
      if (this.isArmed(id)) return true;
    }
    return false;
  }

  /** Client ids currently in the arm map (may include expired until isArmed prunes). */
  armedClientIds(): number[] {
    return [...this.armedUntil.keys()];
  }

  /** Fresh arm: clear partial dedupe and open the listen window. */
  arm(clientId: number): void {
    this.partialRoutedCommand.delete(clientId);
    this.touch(clientId);
  }

  /** Extend the post-wake window (speech activity). */
  touch(clientId: number): void {
    this.clearArmTimer(clientId);
    const windowMs = this.hooks.listenWindowMs;
    this.armedUntil.set(clientId, Date.now() + windowMs);
    const timer = setTimeout(() => {
      this.armTimers.delete(clientId);
      this.armedUntil.delete(clientId);
      this.clearKeepalive(clientId);
      this.partialRoutedCommand.delete(clientId);
      this.hooks.onExpire(clientId);
    }, windowMs);
    this.armTimers.set(clientId, timer);
    this.scheduleKeepalive(clientId);
  }

  /** Immediate disarm without calling onExpire (caller handles side effects). */
  disarm(clientId: number): void {
    this.clearArmTimer(clientId);
    this.clearKeepalive(clientId);
    this.armedUntil.delete(clientId);
    this.partialRoutedCommand.delete(clientId);
  }

  markPartialRouted(clientId: number, command: string): void {
    this.partialRoutedCommand.set(clientId, command);
  }

  lastPartialRouted(clientId: number): string | undefined {
    return this.partialRoutedCommand.get(clientId);
  }

  clearPartialRouted(clientId: number): void {
    this.partialRoutedCommand.delete(clientId);
  }

  /** Drop timers/maps for clients not in `live` (channel roster). */
  prune(live: Set<number>): number[] {
    const gone: number[] = [];
    for (const id of [...this.armedUntil.keys()]) {
      if (!live.has(id)) {
        gone.push(id);
        this.disarm(id);
      }
    }
    return gone;
  }

  dispose(): void {
    for (const id of [...this.armTimers.keys()]) this.clearArmTimer(id);
    for (const id of [...this.keepaliveTimers.keys()]) this.clearKeepalive(id);
    this.armedUntil.clear();
    this.partialRoutedCommand.clear();
  }

  private clearArmTimer(clientId: number): void {
    const t = this.armTimers.get(clientId);
    if (t) {
      clearTimeout(t);
      this.armTimers.delete(clientId);
    }
  }

  private clearKeepalive(clientId: number): void {
    const t = this.keepaliveTimers.get(clientId);
    if (t) {
      clearInterval(t);
      this.keepaliveTimers.delete(clientId);
    }
  }

  private scheduleKeepalive(clientId: number): void {
    this.clearKeepalive(clientId);
    const onKeepalive = this.hooks.onKeepalive;
    if (!onKeepalive) return;
    const interval = this.hooks.keepaliveIntervalMs ?? 4_000;
    const timer = setInterval(() => {
      if (!this.isArmed(clientId)) {
        this.clearKeepalive(clientId);
        return;
      }
      onKeepalive(clientId);
    }, interval);
    this.keepaliveTimers.set(clientId, timer);
  }
}
