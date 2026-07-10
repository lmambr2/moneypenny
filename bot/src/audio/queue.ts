export enum PlayMode {
  Sequential = "seq",
  Loop = "loop",
  Random = "random",
  RandomLoop = "rloop",
}

/**
 * Who put the track on the queue.
 * - `user` / omitted: human request (!add, web, tools) — jumps ahead of radio fill
 * - `radio`: auto-DJ / profile restock filler
 * - `system`: bot-internal (rarely used)
 */
export type QueueSource = "user" | "radio" | "system";

export interface QueuedSong {
  id: string;
  name: string;
  artist: string;
  album: string;
  platform: "local" | "youtube" | "stream";
  url?: string; // resolved lazily at play time
  coverUrl: string;
  duration: number; // seconds
  /** Defaults to human priority when omitted. */
  source?: QueueSource;
}

/** Auto-DJ fill tracks lose to any human add. */
export function isRadioFill(song: QueuedSong): boolean {
  return song.source === "radio";
}

export class PlayQueue {
  private songs: QueuedSong[] = [];
  private currentIndex = -1;
  private mode: PlayMode = PlayMode.Sequential;
  private playedIndices = new Set<number>();
  private history: number[] = [];
  private forwardStack: number[] = [];
  private static readonly HISTORY_LIMIT = 50;

  private pushHistory(idx: number): void {
    if (idx < 0 || idx >= this.songs.length) return;
    this.history.push(idx);
    if (this.history.length > PlayQueue.HISTORY_LIMIT) {
      this.history.shift();
    }
  }

  /**
   * Enqueue a song.
   * - **Radio fill** (`source: "radio"`): always append at the end.
   * - **Human / default**: insert after the current track and after any other
   *   human-priority tracks, but **before** the first radio-fill track so
   *   `!add` jumps the auto-DJ queue.
   * @returns index where the song was placed
   */
  add(song: QueuedSong): number {
    if (isRadioFill(song) || this.songs.length === 0) {
      this.songs.push(song);
      return this.songs.length - 1;
    }

    // After now-playing (or at 0 if nothing active), skip past human tracks,
    // stop at the first radio filler.
    const start = this.currentIndex < 0 ? 0 : this.currentIndex + 1;
    let insertAt = this.songs.length;
    for (let i = start; i < this.songs.length; i++) {
      if (isRadioFill(this.songs[i]!)) {
        insertAt = i;
        break;
      }
    }

    if (insertAt >= this.songs.length) {
      this.songs.push(song);
      return this.songs.length - 1;
    }

    this.songs.splice(insertAt, 0, song);
    this.shiftIndicesAfterInsert(insertAt);
    return insertAt;
  }

  addMany(songs: QueuedSong[]): void {
    for (const s of songs) this.add(s);
  }

  /**
   * Insert a song to play immediately after the current one. Falls
   * through to plain push when nothing is playing yet (currentIndex < 0
   * or queue empty), so the existing "add → idle bot starts playing"
   * flow continues to work.
   *
   * Shifts playedIndices and history entries > currentIndex by +1 so
   * their references stay valid after the splice.
   */
  addNext(song: QueuedSong): void {
    const withSource: QueuedSong = song.source ? song : { ...song, source: "user" };
    if (this.currentIndex < 0 || this.songs.length === 0) {
      this.songs.push(withSource);
      return;
    }
    const insertAt = this.currentIndex + 1;
    this.songs.splice(insertAt, 0, withSource);
    this.shiftIndicesAfterInsert(insertAt);
  }

  /** After splicing a song at `insertAt`, shift bookkeeping indices ≥ insertAt. */
  private shiftIndicesAfterInsert(insertAt: number): void {
    const shifted = new Set<number>();
    for (const i of this.playedIndices) {
      shifted.add(i >= insertAt ? i + 1 : i);
    }
    this.playedIndices = shifted;
    this.history = this.history.map((i) => (i >= insertAt ? i + 1 : i));
    this.forwardStack = this.forwardStack.map((i) => (i >= insertAt ? i + 1 : i));
    // currentIndex is never ≥ insertAt when we insert after current; keep as-is.
  }

  remove(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    const [removed] = this.songs.splice(index, 1);

    if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      this.currentIndex--;
    }

    // Rebuild playedIndices to account for shifted indices
    const newPlayed = new Set<number>();
    for (const idx of this.playedIndices) {
      if (idx === index) continue;
      newPlayed.add(idx > index ? idx - 1 : idx);
    }
    this.playedIndices = newPlayed;

    // Same shift logic for history — drop entries pointing at the
    // removed song; shift entries > index down by 1.
    this.history = this.history
      .filter((idx) => idx !== index)
      .map((idx) => (idx > index ? idx - 1 : idx));

    // forwardStack (prev→next resume) must shift the same way or next()
    // can land on a stale index and return undefined.
    this.forwardStack = this.forwardStack
      .filter((idx) => idx !== index)
      .map((idx) => (idx > index ? idx - 1 : idx));

    return removed;
  }

  clear(): void {
    this.songs = [];
    this.currentIndex = -1;
    this.playedIndices.clear();
    this.history = [];
    this.forwardStack = [];
  }

  play(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    this.playedIndices.clear();
    this.history = [];
    this.forwardStack = [];
    this.currentIndex = 0;
    this.playedIndices.add(0);
    return this.songs[0];
  }

  playAt(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    this.pushHistory(this.currentIndex);
    // Reset the Random-mode "unplayed" pool — explicit picks restart
    // shuffle from this point. History tracking is independent and
    // unaffected by this clear.
    this.playedIndices.clear();
    this.forwardStack = [];
    this.currentIndex = index;
    this.playedIndices.add(index);
    return this.songs[index];
  }

  next(): QueuedSong | null {
    if (this.songs.length === 0) return null;

    switch (this.mode) {
      case PlayMode.Sequential: {
        const nextIndex = this.currentIndex + 1;
        if (nextIndex >= this.songs.length) return null;
        this.pushHistory(this.currentIndex);
        this.currentIndex = nextIndex;
        return this.songs[nextIndex];
      }
      case PlayMode.Loop: {
        this.pushHistory(this.currentIndex);
        this.currentIndex = (this.currentIndex + 1) % this.songs.length;
        return this.songs[this.currentIndex];
      }
      case PlayMode.Random:
      case PlayMode.RandomLoop: {
        // Prefer returning to the position recorded in the forward stack (prev song).
        // Skip stale / OOB entries (defensive; remove/addNext also shift the stack).
        while (this.forwardStack.length > 0) {
          const target = this.forwardStack.pop()!;
          if (target < 0 || target >= this.songs.length || target === this.currentIndex) {
            continue;
          }
          this.pushHistory(this.currentIndex);
          this.currentIndex = target;
          this.playedIndices.add(target);
          return this.songs[target];
        }

        // Shuffle bag: pick uniformly from the songs not yet played this
        // cycle, so every song plays once before any repeats.
        // Songs added mid-cycle aren't in playedIndices, so they're
        // naturally eligible within the current cycle.
        const unplayed: number[] = [];
        for (let i = 0; i < this.songs.length; i++) {
          if (!this.playedIndices.has(i)) unplayed.push(i);
        }

        if (unplayed.length === 0) {
          // Cycle complete.
          if (this.mode === PlayMode.Random) return null; // Random: stop after current
          // Random loop: reshuffle and keep going forever.
          if (this.songs.length === 1) {
            this.pushHistory(this.currentIndex);
            this.currentIndex = 0;
            this.playedIndices = new Set([0]);
            return this.songs[0];
          }
          // Start a fresh cycle: every song is eligible again, but exclude
          // the song that just played from THIS pick only, so it doesn't
          // repeat back-to-back across the boundary. It stays eligible for
          // the rest of the new cycle, so every song still plays exactly once.
          this.playedIndices = new Set();
          for (let i = 0; i < this.songs.length; i++) {
            if (i !== this.currentIndex) unplayed.push(i);
          }
        }

        const nextIndex = unplayed[Math.floor(Math.random() * unplayed.length)];
        this.pushHistory(this.currentIndex);
        this.currentIndex = nextIndex;
        this.playedIndices.add(nextIndex);
        return this.songs[nextIndex];
      }
    }
  }

  prev(): QueuedSong | null {
    if (this.songs.length === 0) return null;

    // Record current position to forward stack for next to prefer returning
    if (this.currentIndex >= 0 && this.forwardStack.length < PlayQueue.HISTORY_LIMIT) {
      this.forwardStack.push(this.currentIndex);
    }

    // Preferred: pop from the back-stack so prev means "the song I
    // actually played before this one," not "the previous array slot."
    while (this.history.length > 0) {
      const idx = this.history.pop()!;
      if (idx >= 0 && idx < this.songs.length) {
        this.currentIndex = idx;
        this.playedIndices = new Set([...this.history, this.currentIndex]);
        return this.songs[idx];
      }
      // Stale entry (song removed) — keep popping.
    }

    // Fallback: no history to walk back through. In Sequential we
    // can still meaningfully step the index backward; in random
    // modes there's nothing useful to return.
    if (this.mode === PlayMode.Random || this.mode === PlayMode.RandomLoop) {
      return null;
    }
    const prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) {
      if (this.mode === PlayMode.Sequential) return null;
      this.currentIndex = this.songs.length - 1;
    } else {
      this.currentIndex = prevIndex;
    }
    this.playedIndices.add(this.currentIndex);
    return this.songs[this.currentIndex];
  }

  current(): QueuedSong | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.songs.length) return null;
    return this.songs[this.currentIndex];
  }

  list(): QueuedSong[] {
    return [...this.songs];
  }

  size(): number {
    return this.songs.length;
  }

  isEmpty(): boolean {
    return this.songs.length === 0;
  }

  getMode(): PlayMode {
    return this.mode;
  }

  setMode(mode: PlayMode): void {
    this.mode = mode;
    this.playedIndices.clear();
    this.history = [];
    this.forwardStack = [];
    if (this.currentIndex >= 0) {
      this.playedIndices.add(this.currentIndex);
    }
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /** Number of songs not yet played in Random mode. */
  unplayedCount(): number {
    return this.songs.length - this.playedIndices.size;
  }
}
