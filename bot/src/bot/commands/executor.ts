import type { TS3TextMessage } from "../../ts-protocol/client.js";
import type { TS3Client } from "../../ts-protocol/client.js";
import type { AudioPlayer } from "../../audio/player.js";
import { PlayMode, type PlayQueue, type QueuedSong } from "../../audio/queue.js";
import type { BotConfig } from "../../data/config.js";
import type { MusicProvider, Song } from "../../music/provider.js";
import type { RadioConfig, RadioProfile, TagStore } from "../../radio/index.js";
import type { ParsedCommand } from "../commands.js";
import type { BotProfileManager } from "../profile.js";
import { DEFAULT_DEMO_VIDEO_URL } from "../../music/youtube.js";
import type { PlaybackEngine } from "../playback/engine.js";
import { MoveAllPendingStore } from "../control/move-all-pending.js";
import { MoveClientRateLimiter } from "../control/move-rate.js";

export interface CommandExecutorDeps {
  playback: PlaybackEngine;
  player: AudioPlayer;
  queue: PlayQueue;
  config: BotConfig;
  profileManager: BotProfileManager;
  tsClient: Pick<
    TS3Client,
    | "getClientsInChannel"
    | "joinChannel"
    | "joinChannelById"
    | "getClientChannelId"
    | "getChannelId"
    | "moveClientToChannel"
    | "listClientsInCurrentChannel"
  >;
  isConnected: () => boolean;
  playNext: (maxRetries?: number) => Promise<boolean>;
  getProvider: (flags: Set<string>, query?: string) => MusicProvider;
  /** Radio tag overlay, for !rate/!unrate (§9.7). Optional — ratings are inert if absent. */
  tagStore?: TagStore;
}

const AUDIO_COMMANDS = new Set([
  "play", "add", "playnext", "pn", "next", "skip", "prev",
  "playlist", "album", "artist", "test", "chevron7",
]);

/** Validate raw select_tracks filters (§9.4) — the LLM proposes, the executor
 *  disposes. Unknown keys are dropped; malformed values become undefined. */
function parseTagFilters(raw: Record<string, unknown>): Parameters<TagStore["selectTracks"]>[0] {
  const strArr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    mood: strArr(raw.mood),
    genreAny: strArr(raw.genreAny),
    subgenreAny: strArr(raw.subgenreAny),
    bpmMin: num(raw.bpmMin),
    bpmMax: num(raw.bpmMax),
    musicalKey: typeof raw.musicalKey === "string" ? raw.musicalKey : undefined,
    energyMin: num(raw.energyMin),
    energyMax: num(raw.energyMax),
    ratingMin: num(raw.ratingMin),
    limit: num(raw.limit),
  };
}

/**
 * Easter egg: `!chevron7` ("chevron seven locked") dials the Stargate SG-1 theme.
 * Fixed YouTube source — but the PlaybackEngine caches the MP3 into the local
 * library on first play (YtLibrary), so subsequent invocations serve the local
 * file and the URL only needs to be reachable once.
 */
const SG1_THEME_URL = "https://www.youtube.com/watch?v=aafGXNWHGaw";

/**
 * Deterministic `!command` implementations. Delegates playback to PlaybackEngine.
 */
export class CommandExecutor {
  private moveClientLimiter = new MoveClientRateLimiter();
  private moveAllPending = new MoveAllPendingStore();

  constructor(private deps: CommandExecutorDeps) {}

  async execute(cmd: ParsedCommand, msg?: TS3TextMessage): Promise<string | null> {
    if (!this.deps.isConnected() && AUDIO_COMMANDS.has(cmd.name)) {
      throw new Error("Bot is not connected to TeamSpeak");
    }
    switch (cmd.name) {
      case "play": return this.cmdPlay(cmd);
      case "chevron7": return this.cmdChevron7();
      case "radio": return this.cmdRadio(cmd);
      case "rate": return this.cmdRate(cmd, msg);
      case "unrate": return this.cmdUnrate(msg);
      case "selecttracks": return this.cmdSelectTracks(cmd);
      case "add": return this.cmdAdd(cmd);
      case "playnext":
      case "pn": return this.cmdPlayNext(cmd);
      case "pause": return this.cmdPause();
      case "resume": return this.cmdResume();
      case "stop": return this.cmdStop();
      case "next":
      case "skip": return this.cmdNext();
      case "prev": return this.cmdPrev();
      case "vol": return this.cmdVol(cmd);
      case "now": return this.cmdNow();
      case "queue":
      case "list": return this.cmdQueue();
      case "clear": return this.cmdClear();
      case "remove": return this.cmdRemove(cmd);
      case "mode": return this.cmdMode(cmd);
      case "playlist": return this.cmdPlaylist(cmd);
      case "album": return this.cmdAlbum(cmd);
      case "artist": return this.cmdArtist(cmd);
      case "vote": return this.cmdVote(msg);
      case "lyrics": return this.cmdLyrics();
      case "move": return this.cmdMove(cmd);
      case "moveclient": return this.cmdMoveClient(cmd);
      case "moveall": return this.cmdMoveAll(cmd, msg);
      case "follow": return this.cmdFollow(msg);
      case "help": return this.cmdHelp();
      case "test": return this.cmdTest();
      default:
        return `Unknown command: ${cmd.name}. Type ${this.deps.config.commandPrefix}help for help.`;
    }
  }

  private async cmdPlay(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !play <song name or URL>";
    const r = await this.replaceQueueWithFirstHit(cmd);
    if (r.ok) return `Now playing: ${r.song.name} - ${r.song.artist}`;
    return r.reason === "noresults"
      ? `No results found for: ${cmd.args}`
      : `Cannot play: ${r.song.name}`;
  }

  /**
   * Resolve a single query/URL, replace the queue with that one hit, and start
   * it. Shared by `!play` and the `!chevron7` easter egg so the play sequence
   * lives in one place.
   */
  private async replaceQueueWithFirstHit(
    cmd: ParsedCommand,
  ): Promise<
    | { ok: true; song: Song }
    | { ok: false; reason: "noresults" }
    | { ok: false; reason: "cantplay"; song: Song }
  > {
    const hit = await this.deps.playback.searchFirst(cmd, 1);
    if (!hit) return { ok: false, reason: "noresults" };
    const { provider, song } = hit;
    this.deps.queue.clear();
    this.deps.queue.add({ ...song, platform: provider.platform });
    this.deps.queue.play();
    this.deps.player.resetFailures();
    const ok = await this.deps.playback.resolveAndPlay(this.deps.queue.current()!);
    if (!ok) return { ok: false, reason: "cantplay", song };
    return { ok: true, song };
  }

  private async cmdChevron7(): Promise<string> {
    const cmd: ParsedCommand = {
      name: "play",
      args: SG1_THEME_URL,
      rawArgs: [SG1_THEME_URL],
      flags: new Set<string>(),
    };
    const r = await this.replaceQueueWithFirstHit(cmd);
    if (r.ok) return "Chevron seven... locked! 🌌 Dialing the SG-1 theme.";
    return "Chevron seven won't engage — could not dial the SG-1 theme.";
  }

  /**
   * `!radio [on|off|status]` — the R-R1 control surface (docs/radio.md §12).
   * on/off is a runtime toggle (the director reads config live); the persistent
   * default lives in Settings. The admin gate on on/off is enforced upstream in
   * the router via the `radio.power` token.
   */
  private async cmdRadio(cmd: ParsedCommand): Promise<string> {
    const radio = this.deps.config.radio;
    const p = this.deps.config.commandPrefix;
    const sub = (cmd.rawArgs[0] ?? "status").toLowerCase();
    switch (sub) {
      case "on":
        radio.enabled = true;
        return `📻 Radio mode ON. ${this.radioSummary(radio)} (runtime toggle — set a persistent default in Settings.)`;
      case "off":
        radio.enabled = false;
        return "📻 Radio mode OFF.";
      case "ops":
        return this.cmdRadioOps(cmd, radio);
      case "status":
        return radio.enabled
          ? `📻 Radio mode ON. ${this.radioSummary(radio)}`
          : `📻 Radio mode OFF. Use ${p}radio on to start.`;
      default:
        return `Usage: ${p}radio [on|off|status|ops <profile>|ops list]`;
    }
  }

  /** `!radio ops <profile>` / `!radio ops list` — set the op context (§8/§12).
   *  One switch retunes bumper topics (the doctrine source reads activeProfile)
   *  AND reprograms the music queue from the profile. The radio.ops gate on the
   *  switch is enforced upstream in the router; `list` is member-level. */
  private async cmdRadioOps(cmd: ParsedCommand, radio: RadioConfig): Promise<string> {
    const p = this.deps.config.commandPrefix;
    const names = Object.keys(radio.profiles);
    const arg = (cmd.rawArgs[1] ?? "list").toLowerCase();
    if (arg === "list") {
      return names.length > 0
        ? `Profiles: ${names.join(", ")} (active: ${radio.activeProfile})`
        : "No radio profiles configured.";
    }
    const profile = radio.profiles[arg];
    if (!profile) {
      return `Unknown profile '${arg}'.${names.length ? ` Profiles: ${names.join(", ")}` : ""}`;
    }
    radio.activeProfile = arg;
    const programmed = await this.programFromProfile(profile);
    return `🎛 Op context: ${arg}. ${programmed}`;
  }

  /** Build the profile's music pool (§8 selection precedence: tag select +
   *  playlistRefs, then seedQueries as sparse-data fallback) and replace the
   *  queue with it. Empty pool → keep whatever is playing (never open a gap). */
  private async programFromProfile(profile: RadioProfile): Promise<string> {
    const music = profile.music ?? {};
    const pool: QueuedSong[] = [];

    if (music.select && this.deps.tagStore) {
      const keys = this.deps.tagStore.selectTracks(parseTagFilters(music.select as Record<string, unknown>));
      pool.push(...(await this.tagKeysToSongs(keys)));
    }
    for (const ref of music.playlistRefs ?? []) {
      if (ref.platform !== "local" && ref.platform !== "youtube") continue; // §8.1: spotify/tidal skipped with a log
      const flag = ref.platform === "youtube" ? "y" : "l";
      try {
        const provider = this.deps.getProvider(new Set([flag]));
        const songs = await this.resolvePlaylistSongs(provider, ref.ref);
        pool.push(...songs.map((s) => ({ ...s, platform: provider.platform })));
      } catch { /* a dead ref never blocks the profile */ }
    }
    if (pool.length === 0) {
      for (const seed of music.seedQueries ?? []) {
        const hit = await this.deps.playback
          .searchFirst({ name: "play", args: seed, rawArgs: seed.split(/\s+/), flags: new Set() }, 1)
          .catch(() => null);
        if (hit) pool.push({ ...hit.song, platform: hit.provider.platform });
      }
    }
    if (pool.length === 0) return "Bumper topics retuned; no music sources matched.";

    this.deps.queue.clear();
    for (const song of pool) this.deps.queue.add(song);
    const first = this.deps.queue.play();
    this.deps.player.resetFailures();
    if (first) await this.deps.playback.resolveAndPlay(first);
    return `Programmed ${pool.length} track${pool.length === 1 ? "" : "s"}.`;
  }

  private radioSummary(radio: RadioConfig): string {
    const cadence = radio.everyNSongs > 0 ? `Bumpers every ${radio.everyNSongs} songs` : "Clock-only";
    return `${cadence}; profile '${radio.activeProfile}'; sources: ${radio.sources.join(", ")}.`;
  }

  /** `!rate <1-5> [song]` — rate the now-playing track (or a searched one) as
   *  this TS user (§9.7). Per-rater, aggregated; one rating per rater (upsert). */
  private async cmdRate(cmd: ParsedCommand, msg?: TS3TextMessage): Promise<string> {
    if (!this.deps.tagStore) return "Ratings are not available.";
    const p = this.deps.config.commandPrefix;
    const stars = Number.parseInt(cmd.rawArgs[0] ?? "", 10);
    if (!(stars >= 1 && stars <= 5)) return `Usage: ${p}rate <1-5> [song]`;
    const rater = `ts:${msg?.invokerUid ?? "unknown"}`;

    let target: { id: string; name: string } | null;
    const query = cmd.rawArgs.slice(1).join(" ");
    if (query) {
      const hit = await this.deps.playback.searchFirst(
        { name: "play", args: query, rawArgs: cmd.rawArgs.slice(1), flags: cmd.flags },
        1,
      );
      target = hit?.song ?? null;
      if (!target) return `No results for: ${query}`;
    } else {
      target = this.deps.queue.current();
      if (!target) return "Nothing is playing to rate.";
    }
    this.deps.tagStore.rate(target.id, rater, stars);
    return `⭐ Rated "${target.name}" ${stars}/5.`;
  }

  /**
   * `selecttracks <json-filters>` — tag-driven selection (§9.4), normally
   * reached via the select_tracks LLM tool. Queries the TagStore overlay,
   * queues the matching LOCAL tracks, and starts playback if idle. Each field
   * is validated here (the LLM proposes, the executor disposes); unknown keys
   * are dropped.
   */
  private async cmdSelectTracks(cmd: ParsedCommand): Promise<string> {
    if (!this.deps.tagStore) return "Tag selection is not available.";
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(cmd.args || "{}") as Record<string, unknown>;
    } catch {
      return "Usage: selecttracks {\"genreAny\":[\"ambient\"],\"bpmMax\":110}";
    }
    const keys = this.deps.tagStore.selectTracks(parseTagFilters(raw));
    const songs = await this.tagKeysToSongs(keys);
    if (songs.length === 0) return "No tracks match those tags.";

    const wasIdle = this.deps.player.getState() === "idle";
    for (const song of songs) this.deps.queue.add(song);
    if (wasIdle) {
      this.deps.queue.play();
      this.deps.player.resetFailures();
      await this.deps.playback.resolveAndPlay(this.deps.queue.current()!);
    }
    return `Queued ${songs.length} track${songs.length === 1 ? "" : "s"} by tags.`;
  }

  /** Overlay keys → playable local Songs; stale rows (deleted files) skipped. */
  private async tagKeysToSongs(keys: string[]): Promise<QueuedSong[]> {
    const local = this.deps.getProvider(new Set(["l"]));
    const songs: QueuedSong[] = [];
    for (const key of keys) {
      const song = await local.getSongDetail(key).catch(() => null);
      if (song) songs.push({ ...song, platform: "local" });
    }
    return songs;
  }

  /** `!unrate` — remove your rating for the now-playing track. */
  private cmdUnrate(msg?: TS3TextMessage): string {
    if (!this.deps.tagStore) return "Ratings are not available.";
    const cur = this.deps.queue.current();
    if (!cur) return "Nothing is playing to unrate.";
    const removed = this.deps.tagStore.unrate(cur.id, `ts:${msg?.invokerUid ?? "unknown"}`);
    return removed ? `Removed your rating for "${cur.name}".` : `You hadn't rated "${cur.name}".`;
  }

  private async cmdAdd(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !add <song name>";
    const hit = await this.deps.playback.searchFirst(cmd, 1);
    if (!hit) return `No results found for: ${cmd.args}`;
    const { provider, song } = hit;
    const wasIdle = this.deps.player.getState() === "idle";
    this.deps.queue.add({ ...song, platform: provider.platform });
    if (wasIdle) {
      this.deps.queue.playAt(this.deps.queue.size() - 1);
      this.deps.player.resetFailures();
      await this.deps.playback.resolveAndPlay(this.deps.queue.current()!);
      return `Now playing: ${song.name} - ${song.artist}`;
    }
    return `Added to queue: ${song.name} - ${song.artist} (position ${this.deps.queue.size()})`;
  }

  private async cmdPlayNext(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !playnext <song name>";
    const hit = await this.deps.playback.searchFirst(cmd, 1);
    if (!hit) return `No results found for: ${cmd.args}`;
    const { provider, song } = hit;
    const wasIdle = this.deps.player.getState() === "idle";
    const insertedAt =
      this.deps.queue.getCurrentIndex() < 0
        ? this.deps.queue.size()
        : this.deps.queue.getCurrentIndex() + 1;
    this.deps.queue.addNext({ ...song, platform: provider.platform });
    if (wasIdle) {
      this.deps.queue.playAt(insertedAt);
      this.deps.player.resetFailures();
      const ok = await this.deps.playback.resolveAndPlay(this.deps.queue.current()!);
      if (!ok) return `Cannot play: ${song.name}`;
      return `Now playing: ${song.name} - ${song.artist}`;
    }
    return `Up next: ${song.name} - ${song.artist}`;
  }

  private cmdPause(): string {
    this.deps.player.pause();
    return "Paused";
  }

  private cmdResume(): string {
    this.deps.player.resume();
    return "Resumed";
  }

  private cmdStop(): string {
    this.deps.player.stop();
    this.deps.queue.clear();
    this.deps.profileManager.onSongChange(null).catch(() => {});
    return "Stopped and queue cleared";
  }

  private async cmdNext(): Promise<string> {
    await this.deps.playNext();
    const current = this.deps.queue.current();
    if (current) return `Now playing: ${current.name} - ${current.artist}`;
    return "Queue is empty";
  }

  private async cmdPrev(): Promise<string> {
    for (let i = 0; i < 4; i++) {
      const prev = this.deps.queue.prev();
      if (!prev) return "No previous song";
      const ok = await this.deps.playback.resolveAndPlay(prev);
      if (ok) return `Now playing: ${prev.name} - ${prev.artist}`;
    }
    return "Cannot play any previous songs (all failed to resolve)";
  }

  private cmdVol(cmd: ParsedCommand): string {
    const vol = parseInt(cmd.args, 10);
    if (isNaN(vol) || vol < 0 || vol > 100) return "Usage: !vol <0-100>";
    this.deps.player.setVolume(vol);
    return `Volume set to ${vol}%`;
  }

  private cmdNow(): string {
    const song = this.deps.queue.current();
    if (!song) return "Nothing is playing";
    return `Now playing: ${song.name} - ${song.artist} [${song.album}] (${song.platform})`;
  }

  private cmdQueue(): string {
    const songs = this.deps.queue.list();
    if (songs.length === 0) return "Queue is empty";
    const currentIdx = this.deps.queue.getCurrentIndex();
    const lines = songs.map((s, i) => {
      const marker = i === currentIdx ? "▶ " : "  ";
      return `${marker}${i + 1}. ${s.name} - ${s.artist}`;
    });
    return `Queue (${songs.length} songs, mode: ${this.deps.queue.getMode()}):\n${lines.join("\n")}`;
  }

  private cmdClear(): string {
    this.deps.player.stop();
    this.deps.queue.clear();
    this.deps.profileManager.onSongChange(null).catch(() => {});
    return "Queue cleared";
  }

  private cmdRemove(cmd: ParsedCommand): string {
    const index = parseInt(cmd.args, 10) - 1;
    if (isNaN(index) || index < 0) return "Usage: !remove <number>";
    const removed = this.deps.queue.remove(index);
    if (!removed) return "Invalid position";
    return `Removed: ${removed.name}`;
  }

  private cmdMode(cmd: ParsedCommand): string {
    const modeMap: Record<string, PlayMode> = {
      seq: PlayMode.Sequential,
      loop: PlayMode.Loop,
      random: PlayMode.Random,
      rloop: PlayMode.RandomLoop,
    };
    const mode = modeMap[cmd.args];
    if (mode === undefined) return "Usage: !mode <seq|loop|random|rloop>";
    this.deps.queue.setMode(mode);
    return `Play mode set to: ${cmd.args}`;
  }

  /** Resolve a playlist reference (URL, numeric id, or name) to its songs.
   *  Shared by !playlist and radio ops profile programming (§8.1). */
  private async resolvePlaylistSongs(provider: MusicProvider, ref: string): Promise<Song[]> {
    const id = this.deps.playback.extractId(ref);
    const isNumericId = /^\d+$/.test(ref.trim());
    let playlistId: string;
    if (isNumericId || id !== ref) {
      playlistId = id;
    } else {
      const result = await provider.search(ref);
      let playlists = result.playlists ?? [];
      if (provider.getUserPlaylists) {
        try {
          const userPlaylists = await provider.getUserPlaylists();
          const query = ref.toLowerCase();
          const matched = userPlaylists.filter((p) => p.name.toLowerCase().includes(query));
          playlists = [...playlists, ...matched];
        } catch { /* continue */ }
      }
      if (playlists.length === 0) return [];
      playlistId = playlists[0].id;
    }
    return provider.getPlaylistSongs(playlistId);
  }

  private async cmdPlaylist(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !playlist <playlist name or ID>";
    const provider = this.deps.getProvider(cmd.flags);
    const songs = await this.resolvePlaylistSongs(provider, cmd.args);
    if (songs.length === 0) return `Playlist is empty or not found: ${cmd.args}`;
    this.deps.queue.clear();
    for (const song of songs) {
      this.deps.queue.add({ ...song, platform: provider.platform });
    }
    const first = this.deps.queue.play();
    if (first) await this.deps.playback.resolveAndPlay(first);
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdAlbum(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !album <album name or ID>";
    const provider = this.deps.getProvider(cmd.flags);
    const id = this.deps.playback.extractId(cmd.args);
    const isNumericId = /^\d+$/.test(cmd.args.trim());
    let albumId: string;
    if (isNumericId || id !== cmd.args) {
      albumId = id;
    } else {
      const result = await provider.search(cmd.args);
      const albums = result.albums ?? [];
      if (albums.length === 0) return `No albums found for: ${cmd.args}`;
      albumId = albums[0].id;
    }
    const songs = await provider.getAlbumSongs(albumId);
    if (songs.length === 0) return "Album is empty or not found";
    this.deps.queue.clear();
    for (const song of songs) {
      this.deps.queue.add({ ...song, platform: provider.platform });
    }
    const first = this.deps.queue.play();
    if (first) await this.deps.playback.resolveAndPlay(first);
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdArtist(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !artist <artist name>";
    const provider = this.deps.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 50);
    if (result.songs.length === 0) return `No results found for artist: ${cmd.args}`;
    const query = cmd.args.toLowerCase();
    let filtered = result.songs.filter((s) => s.artist.toLowerCase().includes(query));
    if (filtered.length === 0) filtered = result.songs.slice(0, 20);
    this.deps.queue.clear();
    for (const song of filtered) {
      this.deps.queue.add({ ...song, platform: provider.platform });
    }
    this.deps.queue.setMode(PlayMode.Loop);
    this.deps.player.resetFailures();
    const first = this.deps.queue.play();
    if (first) await this.deps.playback.resolveAndPlay(first);
    return `Artist mode: ${cmd.args} — ${filtered.length} songs loaded. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdVote(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Vote can only be used in TeamSpeak";
    this.deps.playback.recordVote(msg.invokerUid);
    const clients = await this.deps.tsClient.getClientsInChannel();
    const totalUsers = clients.length - 1;
    const needed = Math.max(1, Math.ceil(totalUsers / 2));
    const votes = this.deps.playback.voteCount;
    if (votes >= needed) {
      this.deps.playback.clearVoteSkip();
      this.deps.playNext().catch(() => {});
      return `Vote passed (${votes}/${needed}). Skipping to next song.`;
    }
    return `Vote to skip: ${votes}/${needed} (need ${needed - votes} more)`;
  }

  private async cmdLyrics(): Promise<string> {
    const song = this.deps.queue.current();
    if (!song) return "Nothing is playing";
    const provider = this.deps.playback.getProviderFor(song.platform);
    const lyrics = await provider.getLyrics(song.id);
    if (lyrics.length === 0) return "No lyrics available";
    const lines = lyrics.slice(0, 10).map((l) => l.text);
    return `Lyrics for ${song.name}:\n${lines.join("\n")}`;
  }

  private async cmdMove(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !move <channel name or ID>";
    await this.deps.tsClient.joinChannel(cmd.args);
    return `Moved to channel: ${cmd.args}`;
  }

  /** Move another user to a channel (admin; DESIGN §R4). */
  private async cmdMoveClient(cmd: ParsedCommand): Promise<string> {
    if (!this.deps.isConnected()) return "Bot is not connected to TeamSpeak.";
    if (cmd.rawArgs.length < 2) {
      return `Usage: ${this.deps.config.commandPrefix}moveclient <nickname|clid> <channel>`;
    }
    if (!this.moveClientLimiter.tryTake()) {
      return "Too many moves — wait a minute and try again.";
    }
    const target = cmd.rawArgs[0]!;
    const channel = cmd.rawArgs.slice(1).join(" ");
    return this.deps.tsClient.moveClientToChannel(target, channel);
  }

  /**
   * Mass-move other users in the current channel (admin; DESIGN §R4).
   * `!moveall <channel>` stages; `!moveall confirm` executes within 30s.
   */
  private async cmdMoveAll(cmd: ParsedCommand, msg?: TS3TextMessage): Promise<string> {
    if (!this.deps.isConnected()) return "Bot is not connected to TeamSpeak.";
    const invokerUid = msg?.invokerUid?.trim();
    if (!invokerUid) return "Mass move must be requested from TeamSpeak chat.";

    if (cmd.rawArgs[0]?.toLowerCase() === "confirm") {
      if (!this.moveClientLimiter.tryTake()) {
        return "Too many moves — wait a minute and try again.";
      }
      const pending = this.moveAllPending.confirm(invokerUid);
      if (!pending) {
        return "No pending mass move (or it expired). Run !moveall <channel> first.";
      }
      const results: string[] = [];
      for (const t of pending.targets) {
        const out = await this.deps.tsClient.moveClientToChannel(String(t.clid), pending.channel);
        results.push(out);
      }
      const ok = results.filter((r) => r.startsWith("Moved ")).length;
      return `Mass move complete: ${ok}/${pending.targets.length} → ${pending.channel}.`;
    }

    const channel = cmd.args.trim();
    if (!channel) {
      return `Usage: ${this.deps.config.commandPrefix}moveall <channel> — then ${this.deps.config.commandPrefix}moveall confirm within 30s`;
    }

    const targets = await this.deps.tsClient.listClientsInCurrentChannel();
    if (targets.length === 0) {
      return "Nobody else is in this channel to move.";
    }
    if (targets.length > this.moveAllPending.maxTargets) {
      return `Too many clients (${targets.length}) — max ${this.moveAllPending.maxTargets} per mass move. Move individuals with moveclient.`;
    }

    const names = targets.map((t) => t.nickname).join(", ");
    this.moveAllPending.stage(channel, targets, invokerUid);
    const p = this.deps.config.commandPrefix;
    return (
      `Move ${targets.length} client(s) (${names}) → ${channel}? ` +
      `Reply ${p}moveall confirm within 30 seconds.`
    );
  }

  private async cmdFollow(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Follow can only be used in TeamSpeak";
    if (!this.deps.isConnected()) return "Bot is not connected to TeamSpeak.";
    const clid = Number.parseInt(msg.invokerId, 10);
    if (!Number.isFinite(clid)) return "Could not resolve your client id.";
    const channelId = await this.deps.tsClient.getClientChannelId(clid);
    if (!channelId) return "Could not find your channel.";
    const alreadyHere = this.deps.tsClient.getChannelId() === channelId;
    const ok = await this.deps.tsClient.joinChannelById(channelId);
    if (!ok) return "Failed to move to your channel.";
    return alreadyHere ? "Already in your channel." : "Following you — moved to your channel.";
  }

  private cmdHelp(): string {
    const p = this.deps.config.commandPrefix;
    return [
      "Moneypenny Commands:",
      "",
      "Music",
      `${p}play <query|url> — Local first, else YouTube (-y forces YT, -l Local). URLs: YT/X/Twitter/Bandcamp/Spotify/Tidal/stream`,
      `${p}add <song> · ${p}playnext <song> (${p}pn) — Queue · play next`,
      `${p}skip/next · ${p}prev · ${p}pause · ${p}resume · ${p}stop — Transport`,
      `${p}queue · ${p}now · ${p}clear · ${p}remove <n> · ${p}vol <0-100> · ${p}mode <seq|loop|random|rloop>`,
      `${p}playlist <name|id> · ${p}album <id> · ${p}artist <name> · ${p}lyrics · ${p}vote`,
      `${p}test — Demo track (local copy if saved, else ${DEFAULT_DEMO_VIDEO_URL})`,
      `${p}radio [on|off|status] — Autonomous DJ: bumpers between tracks (on/off = admin)`,
      `${p}rate <1-5> [song] · ${p}unrate — Rate the current (or a searched) track`,
      "",
      "AI & knowledge (needs LLM / RAG enabled in Settings)",
      `${p}ask <question> — Fast AI; doctrine + your memory when enabled`,
      `${p}analyst <task> · ${p}agent <task> — Heavy delegate model (async ack + follow-up)`,
      `${p}intsum [-s] [class:<level>] <points> · ${p}aar [-s] [class:<level>] <points> — Templated INTSUM/AAR (@analyst)`,
      `${p}remember <fact> · ${p}recall · ${p}forget <n|all> — Per-user memory`,
      "",
      "Community",
      `${p}roast — Greatest-hits cringe reel · ${p}roastout — Opt out + purge your lines`,
      "",
      "Admin (rights-gated)",
      `${p}reindex [path.md] — Re-embed doctrine (all or one file)`,
      `${p}ingeststatus — Recent moneypenny-drop ingests`,
      `${p}move <channel> · ${p}follow — Move bot / follow you`,
      `${p}moveclient <user> <channel> — Move another member`,
      `${p}moveall <channel> · ${p}moveall confirm — Mass-move (30s, max 10)`,
      "",
      `${p}help — This message`,
    ].join("\n");
  }

  private async cmdTest(): Promise<string> {
    if (!this.deps.isConnected()) {
      return "Bot is not connected to TeamSpeak — start it from the web UI first.";
    }
    return this.deps.playback.playDemoTrack();
  }
}