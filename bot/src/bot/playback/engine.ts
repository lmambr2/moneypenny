import type { EventEmitter } from "node:events";
import path from "node:path";
import type { AudioPlayer } from "../../audio/player.js";
import type { PlayQueue, QueuedSong } from "../../audio/queue.js";
import type { BotConfig } from "../../data/config.js";
import type { BotDatabase } from "../../data/database.js";
import type { Logger } from "../../logger.js";
import {
  blockedGenreMessage,
  isBlockedGenreSong,
  normalizeMusicBlockedGenres,
} from "../../music/genre-block.js";
import type { LocalProvider } from "../../music/local.js";
import type { MusicProvider, Song } from "../../music/provider.js";
import { searchFirstWithFallback } from "../../music/search-fallback.js";
import { isSpotifyRef, isTidalUrl, resolveExternalTrackQuery } from "../../music/stream.js";
import { assertSafePlaybackTarget } from "../../music/url-guard.js";
import {
  DEFAULT_DEMO_VIDEO_ID,
  DEFAULT_DEMO_VIDEO_URL,
  extractVideoId,
  shouldBlockYoutubeSong,
} from "../../music/youtube.js";
import type { YtLibrary } from "../../music/ytlibrary.js";
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

  constructor(opts: PlaybackEngineOptions) {
    this.opts = opts;
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
      this.opts.queue.clear();
      this.opts.queue.add({ ...localSong, platform: "local", source: "user" });
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
    this.opts.queue.clear();
    this.opts.queue.add({ ...song, platform: provider.platform, source: "user" });
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
    const resolved = await this.resolveExternalRef(cmd);
    const provider = this.pickProvider(resolved.flags, resolved.args);
    const fallback =
      provider === this.opts.localProvider && !resolved.flags.has("l")
        ? this.opts.youtubeProvider
        : undefined;
    return searchFirstWithFallback(
      provider,
      resolved.args,
      limit,
      fallback,
      this.opts.config.musicBlockedGenres,
    );
  }

  async resolveExternalRef(cmd: ParsedCommand): Promise<ParsedCommand> {
    const q = cmd.args?.trim();
    if (!q || !(isSpotifyRef(q) || isTidalUrl(q))) return cmd;
    if (this.opts.config.streamBridgeUrl || process.env.STREAM_BRIDGE_URL) return cmd;
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

  async resolveAndPlay(song: QueuedSong): Promise<boolean> {
    const next = this.playResolveSerial.then(
      () => this.resolveAndPlayOnce(song),
      () => this.resolveAndPlayOnce(song),
    );
    this.playResolveSerial = next.then(
      () => true,
      () => false,
    );
    return next;
  }

  private async resolveAndPlayOnce(song: QueuedSong): Promise<boolean> {
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
      if (isBlockedGenreSong(song, this.opts.config.musicBlockedGenres)) {
        this.opts.logger.info(
          { songId: song.id, name: song.name, artist: song.artist },
          "Genre policy blocked track — skipping",
        );
        return false;
      }
      // Belt-and-suspenders: refuse full-album / >15m dumps even if already queued.
      if (
        song.platform === "youtube" &&
        shouldBlockYoutubeSong({ title: song.name, duration: song.duration })
      ) {
        this.opts.logger.info(
          { songId: song.id, name: song.name, duration: song.duration },
          "YouTube full-album or over-long track blocked — skipping",
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
      this.opts.player.play(url, 0, song.duration);
      this.opts.database.addPlayHistory({
        botId: this.opts.botId,
        songId: song.id,
        songName: song.name,
        artist: song.artist,
        album: song.album,
        platform: song.platform,
        coverUrl: song.coverUrl,
      });
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
    this.opts.queue.clear();
    this.opts.player.stop();
    this.emitState();
  }

  async skipNext(): Promise<void> {
    const next = this.opts.queue.next();
    if (next) await this.resolveAndPlay(next);
    else this.opts.player.stop();
    this.emitState();
  }

  pausePlayback(): void {
    this.opts.player.pause();
    this.emitState();
  }

  resumePlayback(): void {
    this.opts.player.resume();
    this.emitState();
  }

  setVolume(volume: number): void {
    this.opts.player.setVolume(Math.max(0, Math.min(100, volume)));
    this.emitState();
  }

  private emitState(): void {
    this.opts.events.emit("stateChange");
  }
}
