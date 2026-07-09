import type { TS3TextMessage } from "../../ts-protocol/client.js";
import type { TS3Client } from "../../ts-protocol/client.js";
import type { AudioPlayer } from "../../audio/player.js";
import { PlayMode, type PlayQueue, type QueuedSong } from "../../audio/queue.js";
import type { BotConfig } from "../../data/config.js";
import type { MusicProvider, Song } from "../../music/provider.js";
import type { TagStore } from "../../radio/index.js";
import { RadioCommands } from "./radio-commands.js";
import { AUDIO_COMMANDS, type ParsedCommand } from "../commands.js";
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
  /** Radio director operator surface (!radio bumper/say/skip, §12). */
  radio?: {
    cueBumper(topic?: string): Promise<"played" | "cued" | "unavailable">;
    cueSay(text: string): Promise<"played" | "cued" | "unavailable">;
    skipBumper(): "cue" | "next";
    getLastPlayedBumper?(): { path: string; label?: string } | null;
    /** Manual skip = a track boundary: wheel advances, due/cued bumpers fire. */
    onTrackBoundary(): Promise<"bumper" | "advanced">;
    status(): { songsUntilBumper: number | null; cuePending: boolean; skipNextPending: boolean };
  };
  /** Absolute path to prerecorded bumper assets (`!radio pin`, §6.5). */
  getBumperDir?: () => string;
  /** ACE-Step generate → library (docs/ace-step.md A4 radio auto-fill). */
  generateProvider?: {
    isConfigured(): boolean;
    isBusy(): boolean;
    generateAndIngest(prompt: string): Promise<
      | { ok: true; song: import("../../music/provider.js").Song; relPath: string; jobId: string }
      | { ok: false; error: string }
    >;
  };
  logger?: import("../../logger.js").Logger;
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
  /** Radio/DJ + rating commands (docs/radio.md §9/§12) live in their own module. */
  private radioCommands: RadioCommands;

  constructor(private deps: CommandExecutorDeps) {
    this.radioCommands = new RadioCommands(deps, (provider, ref) => this.resolvePlaylistSongs(provider, ref));
  }

  /** Dead-air auto-program hook for the RadioDirector (docs/radio.md §7). */
  autoProgramRadio(): Promise<boolean> {
    return this.radioCommands.autoProgram();
  }

  async execute(cmd: ParsedCommand, msg?: TS3TextMessage): Promise<string | null> {
    if (!this.deps.isConnected() && AUDIO_COMMANDS.has(cmd.name)) {
      throw new Error("Bot is not connected to TeamSpeak");
    }
    switch (cmd.name) {
      case "play": return this.cmdPlay(cmd);
      case "chevron7": return this.cmdChevron7();
      case "radio": return this.radioCommands.radio(cmd);
      case "rate": return this.radioCommands.rate(cmd, msg);
      case "unrate": return this.radioCommands.unrate(msg);
      case "selecttracks": return this.radioCommands.selectTracks(cmd);
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
    // A manual skip is a track boundary: with radio on, the wheel advances and
    // a due (or cued) bumper plays instead of jumping straight to the next
    // song. Radio off → onTrackBoundary is a plain playNext, identical to before.
    if (this.deps.radio) {
      if ((await this.deps.radio.onTrackBoundary()) === "bumper") {
        return "📻 Station break — music resumes after.";
      }
    } else {
      await this.deps.playNext();
    }
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
      `${p}radio [on|off|status|ops <profile>|bumper|say|skip] — Autonomous DJ (on/off admin; ops/bumper/say/skip @dj)`,
      `${p}rate <1-5> [song] · ${p}unrate — Rate the current (or a searched) track`,
      "",
      "AI & knowledge (needs LLM / RAG enabled in Settings)",
      `${p}ask <question> — Fast AI; doctrine + your memory when enabled`,
      `${p}analyst <task> · ${p}agent <task> — Heavy delegate model (async ack + follow-up)`,
      `${p}intsum [-s] [class:<level>] <points> · ${p}aar [-s] [class:<level>] <points> — Templated INTSUM/AAR (@analyst)`,
      `${p}remember <fact> · ${p}recall · ${p}forget <n|all> — Per-user memory`,
      "",
      "Org economy (seed catalog; optional UEX prices)",
      `${p}mine <ore> [scu:N] [method:name] — Mining pull order + stability clock`,
      `${p}refine <ore> [scu:N] [method:name] — Refine yield / time / cost estimate`,
      `${p}craft <recipe> [qty:N] — Craft bill of materials`,
      `${p}econ [ores|methods|recipes|prices <ore>|search <q>] — Browse catalog / UEX prices`,
      "",
      "Community",
      `${p}roast — Greatest-hits reel · ${p}roastout / ${p}roastin — Leave or rejoin the roast`,
      "",
      "DJ / generation (rights-gated @dj)",
      `${p}generate <prompt> — ACE-Step gen → library → play · ${p}generate prune — drop old gens`,
      `${p}radio gen <prompt> — same gen from radio command surface`,
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