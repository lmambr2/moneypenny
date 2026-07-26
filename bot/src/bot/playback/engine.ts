import type { EventEmitter } from "node:events";
import path from "node:path";
import type { AudioPlayer } from "../../audio/player.js";
import { isRadioFill, PlayMode, type PlayQueue, type QueuedSong } from "../../audio/queue.js";
import type { BotConfig } from "../../data/config.js";
import type { BotDatabase } from "../../data/database.js";
import type { Logger } from "../../logger.js";
import {
  blockedGenreMessage,
  isBlockedGenreSong,
  normalizeMusicBlockedGenres,
} from "../../music/genre-block.js";
import type { LocalProvider } from "../../music/local.js";
import type { PlaybackBlacklist } from "../../music/playback-blacklist.js";
import type { MusicProvider, Song } from "../../music/provider.js";
import { searchFirstWithFallback } from "../../music/search-fallback.js";
import { isSpotifyRef, isTidalUrl, resolveExternalTrackQuery } from "../../music/stream.js";
import { assertSafePlaybackTarget } from "../../music/url-guard.js";
import {
  DEFAULT_DEMO_VIDEO_ID,
  DEFAULT_DEMO_VIDEO_URL,
  extractVideoId,
  isDemoTestTrack,
  shouldBlockYoutubeSong,
} from "../../music/youtube.js";
import type { YtLibrary } from "../../music/ytlibrary.js";
import { planMixWindow } from "../../radio/mix-window.js";
import type { ParsedCommand } from "../commands.js";
import type { BotProfileManager } from "../profile.js";
import { extractMediaId, pickProvider, providerForPlatform } from "./providers.js";

export interface PlaybackEngineOptions {
  botId: string;
  player: AudioPlayer;
  queue: PlayQueue;
  localProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  streamProvider: MusicProvider;
  ytLibrary: YtLibrary;
  database: BotDatabase;
  config: BotConfig;
  profileManager: BotProfileManager;
  logger: Logger;
  events: Pick<EventEmitter, "emit">;
  isConnected: () => boolean;
  isAdvancing: () => boolean;
  setAdvancing: (v: boolean) => void;
  /** Admin-curated playback ban list (optional). */
  playbackBlacklist?: PlaybackBlacklist | null;
}

/**
 * Queue resolution, URL fetching, and transport control. Extracted from
 * BotInstance so playback logic is testable without TS/LLM/voice wiring.
 */
export class PlaybackEngine {
  private opts: PlaybackEngineOptions;
  private voteSkipUsers = new Set<string>();
  /** Serialize URL resolve + ffmpeg start so voice partials cannot spawn double YT jobs. */
  private playResolveSerial: Promise<boolean> = Promise.resolve(true);
  /**
   * Song ids known to be the !test demo (including local opaque ids discovered
   * by playDemoTrack). Always includes DEFAULT_DEMO_VIDEO_ID.
   */
  private protectedDemoIds = new Set<string>([DEFAULT_DEMO_VIDEO_ID]);
  /**
   * Operator pause checkpoint. Soft `player.pause()` is destroyed when TTS
   * speaks "Paused" (player.play replaces the stream). Keep song position so
   * resume re-seeks the same track, and so radio dead-air does not restock.
   */
  private userPause: { songId: string; elapsed: number } | null = null;

  constructor(opts: PlaybackEngineOptions) {
    this.opts = opts;
  }

  /** True while the operator has paused (soft pause or TTS-killed stream). */
  isUserPaused(): boolean {
    if (this.userPause) return true;
    return this.opts.player.getState() === "paused";
  }

  clearUserPause(): void {
    this.userPause = null;
  }

  /** True while the queue's current track is the !test / PHASE0 demo. */
  isDemoTestPlaying(): boolean {
    const cur = this.opts.queue.current();
    if (!cur) return false;
    if (this.protectedDemoIds.has(cur.id)) return true;
    return isDemoTestTrack(cur);
  }

  rememberDemoSongId(id: string): void {
    if (id) this.protectedDemoIds.add(id);
  }

  clearVoteSkip(): void {
    this.voteSkipUsers.clear();
  }

  recordVote(uid: string): void {
    this.voteSkipUsers.add(uid);
  }

  get voteCount(): number {
    return this.voteSkipUsers.size;
  }

  getProviderFor(platform: "local" | "youtube" | "stream"): MusicProvider {
    return providerForPlatform(
      platform,
      this.opts.localProvider,
      this.opts.youtubeProvider,
      this.opts.streamProvider,
    );
  }

  pickProvider(flags: Set<string>, query?: string): MusicProvider {
    return pickProvider(
      flags,
      this.opts.localProvider,
      this.opts.youtubeProvider,
      this.opts.streamProvider,
      query,
    );
  }

  extractId(input: string): string {
    return extractMediaId(input);
  }

  /** Saved YT MP3 path or an indexed local track tagged with `[videoId]`. */
  async resolveYoutubeLocalPath(videoId: string): Promise<string | null> {
    if (!videoId) return null;
    const saved = this.opts.ytLibrary.lookup(videoId);
    if (saved) return saved;

    const local = this.opts.localProvider as LocalProvider;
    let song = await local.findSongByVideoId(videoId);
    if (!song) {
      await local.refresh();
      song = await local.findSongByVideoId(videoId);
    }
    if (song) return local.getSongUrl(song.id);
    return null;
  }

  /**
   * Play the canonical demo / !test track, preferring a local copy when one exists
   * (YT save dir or indexed library) instead of hitting YouTube for search/stream.
   */
  async playDemoTrack(): Promise<string> {
    const localSong = await this.findDemoAsLocalSong(DEFAULT_DEMO_VIDEO_ID);
    if (localSong) {
      this.rememberDemoSongId(localSong.id);
      this.opts.queue.clear();
      this.opts.queue.add({ ...localSong, platform: "local", source: "system" });
      // One song in the queue: without an explicit mode this inherits whatever
      // the last feature left (RandomLoop by default), whose single-song branch
      // replays forever. !test is a demo — it plays once.
      this.opts.queue.setMode?.(PlayMode.Sequential);
      this.opts.queue.play();
      this.opts.player.resetFailures();
      const ok = await this.resolveAndPlay(this.opts.queue.current()!);
      if (ok) return `Now playing: ${localSong.name} - ${localSong.artist} (local)`;
      this.opts.logger.warn(
        { song: localSong.name },
        "Local demo copy failed to play — falling back to stream",
      );
      this.opts.queue.clear();
    }

    const hit = await this.searchFirst(
      {
        name: "play",
        args: DEFAULT_DEMO_VIDEO_URL,
        rawArgs: [DEFAULT_DEMO_VIDEO_URL],
        flags: new Set<string>(),
      },
      1,
    );
    if (!hit) return `No results found for: ${DEFAULT_DEMO_VIDEO_URL}`;
    const { provider, song } = hit;
    this.rememberDemoSongId(song.id);
    this.opts.queue.clear();
    this.opts.queue.add({ ...song, platform: provider.platform, source: "system" });
    this.opts.queue.setMode?.(PlayMode.Sequential);
    this.opts.queue.play();
    this.opts.player.resetFailures();
    const ok = await this.resolveAndPlay(this.opts.queue.current()!);
    if (!ok) return `Cannot play: ${song.name}`;
    const localPath = await this.resolveYoutubeLocalPath(DEFAULT_DEMO_VIDEO_ID);
    const suffix = localPath ? " (local)" : "";
    return `Now playing: ${song.name} - ${song.artist}${suffix}`;
  }

  private async findDemoAsLocalSong(videoId: string): Promise<Song | null> {
    const local = this.opts.localProvider as LocalProvider;
    const saved = this.opts.ytLibrary.lookup(videoId);

    let song = await local.findSongByVideoId(videoId);
    if (song) return song;

    if (saved) {
      await local.refresh();
      song = await local.findSongByVideoId(videoId);
      if (song) return song;

      const rel = path.relative(local.getMusicDir(), saved);
      if (rel && !rel.startsWith("..")) {
        const resolved = await local.resolve(rel);
        if (resolved?.type === "song") return resolved.item as Song;
        const byName = await local.resolve(path.basename(saved));
        if (byName?.type === "song") return byName.item as Song;
      }
    }

    return null;
  }

  /** Station genre policy (default: rap / hip-hop / R&B). Explicit `[]` allows all. */
  blockedGenres(): string[] {
    return normalizeMusicBlockedGenres(this.opts.config.musicBlockedGenres);
  }

  async searchFirst(
    cmd: ParsedCommand,
    limit = 1,
  ): Promise<{ provider: MusicProvider; song: Song } | null> {
    const originalQ = cmd.args?.trim() ?? "";
    const resolved = await this.resolveExternalRef(cmd);
    const provider = this.pickProvider(resolved.flags, resolved.args);
    const fallback =
      provider === this.opts.localProvider && !resolved.flags.has("l")
        ? this.opts.youtubeProvider
        : undefined;
    let hit = await searchFirstWithFallback(
      provider,
      resolved.args,
      limit,
      fallback,
      this.opts.config.musicBlockedGenres,
      this.opts.playbackBlacklist,
    );
    // Bridge configured but resolve failed (auth, premium, etc.) → scrape
    // metadata and fall open to local/YouTube so the link still does something.
    if (
      !hit &&
      (isSpotifyRef(originalQ) || isTidalUrl(originalQ)) &&
      provider === this.opts.streamProvider
    ) {
      const url = originalQ.startsWith("spotify:track:")
        ? `https://open.spotify.com/track/${originalQ.split(":")[2]}`
        : originalQ;
      const q = await resolveExternalTrackQuery(url, this.opts.logger);
      if (q) {
        this.opts.logger.info(
          { url: originalQ, resolved: q },
          "Stream bridge miss — falling back to local/YouTube search",
        );
        hit = await searchFirstWithFallback(
          this.opts.localProvider,
          q,
          limit,
          this.opts.youtubeProvider,
          this.opts.config.musicBlockedGenres,
          this.opts.playbackBlacklist,
        );
      }
    }
    return hit;
  }

  async resolveExternalRef(cmd: ParsedCommand): Promise<ParsedCommand> {
    const q = cmd.args?.trim();
    if (!q || !(isSpotifyRef(q) || isTidalUrl(q))) return cmd;
    // Keep the DRM ref when StreamProvider has a bridge for this service —
    // it will resolve a real stream URL at search/play time.
    const stream = this.opts.streamProvider as MusicProvider & {
      canHandle?: (query: string) => boolean;
    };
    if (stream.canHandle?.(q)) return cmd;
    const url = q.startsWith("spotify:track:")
      ? `https://open.spotify.com/track/${q.split(":")[2]}`
      : q;
    const resolved = await resolveExternalTrackQuery(url, this.opts.logger);
    if (!resolved) return cmd;
    this.opts.logger.info(
      { url: q, resolved },
      "Resolved Spotify/Tidal link to a search query (no bridge)",
    );
    return { ...cmd, args: resolved, rawArgs: resolved.split(/\s+/) };
  }

  async resolveAndPlay(
    song: QueuedSong,
    opts?: { seekSeconds?: number; skipHistory?: boolean },
  ): Promise<boolean> {
    const next = this.playResolveSerial.then(
      () => this.resolveAndPlayOnce(song, opts),
      () => this.resolveAndPlayOnce(song, opts),
    );
    this.playResolveSerial = next.then(
      () => true,
      () => false,
    );
    return next;
  }

  private async resolveAndPlayOnce(
    song: QueuedSong,
    opts?: { seekSeconds?: number; skipHistory?: boolean },
  ): Promise<boolean> {
    if (!this.opts.isConnected()) {
      this.opts.logger.warn(
        { songId: song.id, name: song.name },
        "resolveAndPlay called on disconnected bot — skipping",
      );
      return false;
    }
    this.voteSkipUsers.clear();
    const provider = this.getProviderFor(song.platform);
    try {
      if (this.opts.playbackBlacklist?.isBlacklisted(song)) {
        this.opts.logger.info(
          { songId: song.id, name: song.name, artist: song.artist },
          "Playback blacklist blocked track — skipping",
        );
        return false;
      }
      // Human !play / !add / explicit URL: honor intent — skip genre + YT content gates.
      // Radio fill still runs station policy so auto-DJ cannot sneak blocked material.
      const humanRequest = song.source !== "radio";
      if (!humanRequest && isBlockedGenreSong(song, this.opts.config.musicBlockedGenres)) {
        this.opts.logger.info(
          { songId: song.id, name: song.name, artist: song.artist },
          "Genre policy blocked track — skipping",
        );
        return false;
      }
      if (
        !humanRequest &&
        song.platform === "youtube" &&
        shouldBlockYoutubeSong({
          title: song.name,
          artist: song.artist,
          album: song.album,
          duration: song.duration,
        })
      ) {
        this.opts.logger.info(
          { songId: song.id, name: song.name, duration: song.duration },
          "YouTube non-music / full-album / over-long track blocked — skipping",
        );
        return false;
      }
      let url: string | null;
      if (song.platform === "youtube") {
        const videoId = extractVideoId(song.id) ?? song.id;
        const localPath = await this.resolveYoutubeLocalPath(videoId);
        if (localPath) {
          url = localPath;
          this.opts.logger.info(
            { videoId, path: localPath },
            "YouTube: playing local library copy",
          );
        } else {
          url = await provider.getSongUrl(videoId);
          if (url && this.opts.config.youtubeSaveEnabled) {
            this.opts.ytLibrary.saveInBackground(videoId, {
              name: song.name,
              artist: song.artist,
              duration: song.duration,
            });
          }
        }
      } else {
        url = await provider.getSongUrl(song.id);
      }
      if (!url) {
        this.opts.logger.warn({ songId: song.id, name: song.name }, "No URL available, skipping");
        return false;
      }
      // Final SSRF gate for every platform (stream/YT CDN hops; local paths pass).
      if (!(await assertSafePlaybackTarget(url))) {
        this.opts.logger.warn(
          { songId: song.id, name: song.name, url: url.slice(0, 80) },
          "Playback URL failed public safety check — skipping",
        );
        return false;
      }
      if (!this.opts.isConnected()) {
        this.opts.logger.warn(
          { songId: song.id, name: song.name },
          "bot disconnected during URL resolve — aborting playback",
        );
        return false;
      }
      song.url = url;
      // New intentional play (not a pause-resume seek) clears operator pause.
      // skipHistory resumes keep the flag until resumePlayback clears it after success.
      if (!opts?.skipHistory) this.userPause = null;
      const seek = Math.max(0, opts?.seekSeconds ?? 0);
      // Long auto-DJ mixes air as a ~10 minute window rather than owning the
      // station for hours. Only radio fill, and only when this is not already a
      // positioned play (pause-resume / explicit seek) — a track someone asked
      // for by name plays in full however long it is.
      const window =
        isRadioFill(song) && seek === 0 && !opts?.skipHistory ? planMixWindow(song.duration) : null;
      if (window) {
        this.opts.logger.info(
          {
            songId: song.id,
            name: song.name,
            durationSec: song.duration,
            seekSeconds: window.seekSeconds,
            windowSec: window.maxSeconds,
          },
          "radio: airing a window of a long mix",
        );
      }
      // Only pass options when windowing — an unwindowed play keeps the plain
      // three-argument call it has always made.
      if (window) {
        this.opts.player.play(url, window.seekSeconds, song.duration, {
          maxSeconds: window.maxSeconds,
        });
      } else {
        this.opts.player.play(url, seek, song.duration);
      }
      if (!opts?.skipHistory) {
        this.opts.database.addPlayHistory({
          botId: this.opts.botId,
          songId: song.id,
          songName: song.name,
          artist: song.artist,
          album: song.album,
          platform: song.platform,
          coverUrl: song.coverUrl,
        });
      }
      this.opts.profileManager.onSongChange(song).catch((err) => {
        this.opts.logger.warn({ err }, "Profile update failed after song change");
      });
      this.emitState();
      return true;
    } catch (err) {
      this.opts.logger.error({ err, songId: song.id }, "Failed to resolve URL");
      return false;
    }
  }

  async playNext(maxRetries = 3): Promise<boolean> {
    if (this.opts.isAdvancing() || !this.opts.isConnected()) return false;
    this.opts.setAdvancing(true);
    try {
      this.voteSkipUsers.clear();
      const next = this.opts.queue.next();
      let started = false;
      if (next) {
        started = await this.resolveAndPlay(next);
        if (!started) {
          for (let i = 0; i < maxRetries && this.opts.isConnected(); i++) {
            const retry = this.opts.queue.next();
            if (!retry) break;
            if (await this.resolveAndPlay(retry)) {
              started = true;
              break;
            }
          }
        }
        if (!started) {
          this.opts.player.stop();
          this.opts.profileManager.onSongChange(null).catch(() => {});
        }
      } else {
        this.opts.player.stop();
        this.opts.profileManager.onSongChange(null).catch(() => {});
      }
      this.emitState();
      return started;
    } finally {
      this.opts.setAdvancing(false);
    }
  }

  async playResolvedItem(
    resolved: { type: "song" | "playlist"; item: any },
    platform: "local" | "youtube" | "stream" = "local",
  ): Promise<string> {
    if (resolved.type === "playlist") {
      const songs = await this.opts.localProvider.getPlaylistSongs(resolved.item.id);
      const allowed = songs.filter(
        (s) => !isBlockedGenreSong(s, this.opts.config.musicBlockedGenres),
      );
      if (allowed.length === 0) {
        return songs.length === 0
          ? `Playlist "${resolved.item.name}" is empty or could not be loaded.`
          : `Playlist "${resolved.item.name}" has no tracks allowed by genre policy.`;
      }
      this.opts.queue.clear();
      this.opts.queue.addMany(allowed.map((s) => ({ ...s, platform, source: "user" as const })));
      // Play the playlist through, then end — do not inherit a loop mode.
      this.opts.queue.setMode?.(PlayMode.Sequential);
      this.opts.queue.play();
      this.opts.player.resetFailures();
      const ok = await this.resolveAndPlay(this.opts.queue.current()!);
      this.emitState();
      return ok
        ? `Playing playlist: ${resolved.item.name} (${allowed.length} tracks)`
        : `Failed to start playlist: ${resolved.item.name}`;
    }
    if (isBlockedGenreSong(resolved.item, this.opts.config.musicBlockedGenres)) {
      return blockedGenreMessage(resolved.item);
    }
    this.opts.queue.clear();
    this.opts.queue.add({ ...resolved.item, platform, source: "user" });
    this.opts.queue.setMode?.(PlayMode.Sequential);
    this.opts.queue.play();
    this.opts.player.resetFailures();
    const ok = await this.resolveAndPlay(this.opts.queue.current()!);
    this.emitState();
    return ok
      ? `Now playing: ${resolved.item.name} - ${resolved.item.artist} (local)`
      : `Cannot play: ${resolved.item.name}`;
  }

  async addResolvedItem(
    resolved: { type: "song" | "playlist"; item: any },
    platform: "local" | "youtube" | "stream" = "local",
  ): Promise<string> {
    if (resolved.type === "playlist") {
      const songs = await this.opts.localProvider.getPlaylistSongs(resolved.item.id);
      const allowed = songs.filter(
        (s) => !isBlockedGenreSong(s, this.opts.config.musicBlockedGenres),
      );
      if (allowed.length === 0) {
        return songs.length === 0
          ? "Playlist is empty."
          : `Playlist has no tracks allowed by genre policy.`;
      }
      const wasIdle = this.opts.player.getState() === "idle";
      // User tracks priority-insert BEFORE radio fill — the pre-add queue size
      // is not where the playlist lands; use the insert index addMany returns.
      const firstIdx = this.opts.queue.addMany(
        allowed.map((s) => ({ ...s, platform, source: "user" as const })),
      );
      if (wasIdle && firstIdx >= 0) {
        this.opts.queue.playAt(firstIdx);
        this.opts.player.resetFailures();
        await this.resolveAndPlay(this.opts.queue.current()!);
        this.emitState();
        return `Added playlist "${resolved.item.name}" and started playback.`;
      }
      this.emitState();
      return `Added playlist "${resolved.item.name}" (${allowed.length} tracks) to queue.`;
    }
    if (isBlockedGenreSong(resolved.item, this.opts.config.musicBlockedGenres)) {
      return blockedGenreMessage(resolved.item);
    }
    const wasIdle = this.opts.player.getState() === "idle";
    const at = this.opts.queue.add({ ...resolved.item, platform, source: "user" });
    if (wasIdle) {
      this.opts.queue.playAt(at);
      this.opts.player.resetFailures();
      await this.resolveAndPlay(this.opts.queue.current()!);
      this.emitState();
      return `Now playing: ${resolved.item.name} - ${resolved.item.artist}`;
    }
    this.emitState();
    return `Added to queue: ${resolved.item.name} - ${resolved.item.artist}`;
  }

  clearQueueAndStop(): void {
    this.userPause = null;
    this.opts.queue.clear();
    this.opts.player.stop();
    this.emitState();
  }

  /**
   * Advance one track with retries (same as transport skip). Prefer
   * CommandExecutor `!skip` for radio boundary; this is the programmatic path.
   */
  async skipNext(): Promise<void> {
    this.userPause = null;
    await this.playNext();
    this.emitState();
  }

  /**
   * Operator pause. Records a checkpoint so resume can re-seek after TTS
   * "Paused" destroys the soft-paused ffmpeg session.
   */
  pausePlayback(): string {
    const state = this.opts.player.getState();
    const current = this.opts.queue.current();
    if ((state === "playing" || state === "paused") && current) {
      // Capture position then hard-stop the stream. Soft pause alone is fragile:
      // voice TTS uses player.play() which replaces the session; a late trackEnd
      // used to restore music after "Paused". Checkpoint + stop is the durable
      // operator pause; resume re-seeks from here.
      const elapsed =
        state === "playing" || state === "paused"
          ? Math.max(0, Math.floor(this.opts.player.getElapsed()))
          : 0;
      this.userPause = { songId: current.id, elapsed };
      this.opts.player.stop();
      this.emitState();
      return "Paused";
    }
    if (this.userPause) {
      this.emitState();
      return "Already paused";
    }
    // Idle with a current track (e.g. alone-stop race mid-stream) — mark intent.
    if (current) {
      this.userPause = { songId: current.id, elapsed: 0 };
      this.emitState();
      return "Paused";
    }
    return "Nothing is playing";
  }

  /**
   * Operator resume. Soft resume if still paused; otherwise re-play the
   * checkpointed queue current from the saved elapsed.
   * Clears the pause flag only after playback actually starts so concurrent
   * radio dead-air restock cannot win the race.
   */
  async resumePlayback(): Promise<string> {
    const state = this.opts.player.getState();
    if (state === "playing" && !this.userPause) {
      return "Already playing";
    }

    // Legacy soft-pause (if any path still uses player.pause without stop).
    if (state === "paused" && this.userPause) {
      this.opts.player.resume();
      this.userPause = null;
      this.emitState();
      return "Resumed";
    }

    const current = this.opts.queue.current();
    const checkpoint = this.userPause;
    if (current && checkpoint && current.id === checkpoint.songId) {
      const elapsed = checkpoint.elapsed;
      const ok = await this.resolveAndPlay(current, {
        seekSeconds: elapsed,
        skipHistory: true,
      });
      if (!ok) return "Could not resume — try play again";
      this.userPause = null;
      this.emitState();
      return "Resumed";
    }

    // Checkpoint lost but queue still has a current track — restart it.
    if (current) {
      const ok = await this.resolveAndPlay(current, {
        seekSeconds: checkpoint?.elapsed ?? 0,
        skipHistory: true,
      });
      if (!ok) return "Could not resume — try play again";
      this.userPause = null;
      this.emitState();
      return "Resumed";
    }

    this.userPause = null;
    return "Nothing to resume";
  }

  setVolume(volume: number): void {
    this.opts.player.setVolume(Math.max(0, Math.min(100, volume)));
    this.emitState();
  }

  private emitState(): void {
    this.opts.events.emit("stateChange");
  }
}
