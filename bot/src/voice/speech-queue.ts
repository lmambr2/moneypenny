/**
 * Serial speech/TTS queue with barge-in (S-OC1 / openclaw PlaybackQueue idea).
 * Does not own music — only work submitted as "speech" jobs.
 */

export class SpeechQueue {
  #tail: Promise<void> = Promise.resolve();
  #currentAbort: AbortController | null = null;

  /**
   * Enqueue a speech job. Subsequent jobs wait. If `signal` aborts (or
   * `interrupt()` is called), the current job should stop.
   */
  play(run: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const abort = new AbortController();
    const forward = () => abort.abort();
    if (signal) {
      // A signal that aborted before enqueue never fires "abort" again —
      // propagate it by hand so the job still observes cancellation.
      if (signal.aborted) abort.abort();
      else signal.addEventListener("abort", forward, { once: true });
    }

    const prev = this.#tail;
    const next = prev.then(async () => {
      // Claim the interrupt slot only when the job actually starts, so
      // interrupt() targets the job that is playing, not the newest enqueued.
      this.#currentAbort = abort;
      // Always invoke run so callers can observe an already-aborted signal.
      await run(abort.signal);
    });
    this.#tail = next
      .catch(() => {})
      .finally(() => {
        signal?.removeEventListener("abort", forward);
        if (this.#currentAbort === abort) this.#currentAbort = null;
      });
    return next;
  }

  /** Abort the in-flight speech job (user barge-in). */
  interrupt(): void {
    this.#currentAbort?.abort();
    this.#currentAbort = null;
  }

  get isSpeaking(): boolean {
    return this.#currentAbort !== null;
  }
}
