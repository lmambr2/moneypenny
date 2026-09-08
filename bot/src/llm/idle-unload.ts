import type { Logger } from "../logger.js";

/** Default: 15 minutes empty before the penny chat model is unloaded. */
export const LLM_IDLE_UNLOAD_SECONDS_DEFAULT = 900;

export interface LlmIdleUnloaderDeps {
  /** Seconds the channel may stay empty. ≤0 disables. Read live so settings apply. */
  getSeconds: () => number;
  unload: () => Promise<void>;
  warm: () => Promise<void>;
  logger?: Logger;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * Unload the penny chat model after the TeamSpeak channel has been empty for
 * N seconds (default 15m). A human joining cancels the timer and re-warms if
 * the model was already dropped. Occupied-channel keep_alive stays 24h.
 *
 * Talker (PersonaPlex) is also dropped on empty when `unload` includes it.
 * Join warms **12B only** — Talker stays cold until watchword (K15).
 */
export class LlmIdleUnloader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unloaded = false;
  private unloading = false;
  private epoch = 0;
  private setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private clearTimer: (h: ReturnType<typeof setTimeout>) => void;

  constructor(private deps: LlmIdleUnloaderDeps) {
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  /** Latest channel human count (bot itself excluded). */
  onHumanCount(humans: number): void {
    if (humans >= 1) {
      this.onOccupied();
      return;
    }
    this.onEmpty();
  }

  stop(): void {
    this.clearPending();
    this.epoch++;
  }

  private onOccupied(): void {
    this.clearPending();
    this.epoch++;
    const e = this.epoch;
    // In-flight unload will re-warm when it sees the epoch bump — don't race it.
    if (this.unloading) return;
    if (!this.unloaded) return;
    this.unloaded = false;
    void this.deps
      .warm()
      .then(() => {
        if (e !== this.epoch) return;
        this.deps.logger?.info("LLM idle: channel occupied — chat model warming");
      })
      .catch((err) => {
        this.deps.logger?.warn({ err }, "LLM idle: warm after join failed");
      });
  }

  private onEmpty(): void {
    if (this.timer || this.unloaded || this.unloading) return;
    const seconds = this.deps.getSeconds();
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const ms = Math.max(1, Math.floor(seconds * 1000));
    this.deps.logger?.info({ seconds }, "LLM idle: channel empty — unload armed");
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.fireUnload();
    }, ms);
  }

  private async fireUnload(): Promise<void> {
    const seconds = this.deps.getSeconds();
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const e = this.epoch;
    this.unloading = true;
    try {
      await this.deps.unload();
      if (e !== this.epoch) {
        this.unloading = false;
        this.unloaded = false;
        void this.deps.warm().catch((err) => {
          this.deps.logger?.warn({ err }, "LLM idle: re-warm after raced unload failed");
        });
        return;
      }
      this.unloading = false;
      this.unloaded = true;
      this.deps.logger?.info("LLM idle: unloaded chat model (empty channel)");
    } catch (err) {
      this.unloading = false;
      if (e !== this.epoch) return;
      this.deps.logger?.warn({ err }, "LLM idle: unload failed — will retry on next empty window");
    }
  }

  private clearPending(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
