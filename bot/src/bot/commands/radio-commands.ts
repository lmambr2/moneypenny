import type { TS3TextMessage } from "@moneypenny/ts6-client";
import type { QueuedSong } from "../../audio/queue.js";
import { isBlockedGenreSong } from "../../music/genre-block.js";
import { isNonMusicContent } from "../../music/non-music.js";
import type { PlaybackBlacklist } from "../../music/playback-blacklist.js";
import type { MusicProvider, Song } from "../../music/provider.js";
import { isYoutubeLivestreamRadioTitle, shouldBlockYoutubeSong } from "../../music/youtube.js";
// YT seed hits are primarily filtered in YouTubeProvider via yt-dlp categories/track.
import { orderKeysHarmonically } from "../../radio/harmonic.js";
import {
  filterAutoDjRepeatEligible,
  isAutoDjRepeatBlocked,
  isUnderBumperDir,
  normalizeAutoDjRepeat,
  pinBumperToPool,
  type RadioConfig,
  type RadioProfile,
  type TagStore,
} from "../../radio/index.js";
import { orderKeysByRatingWeight } from "../../radio/rating-weight.js";
import type { ParsedCommand } from "../commands.js";
import type { CommandExecutorDeps } from "./executor.js";

/** Validate raw select_tracks filters (§9.4) — the LLM proposes, the executor
 *  disposes. Unknown keys are dropped; malformed values become undefined. */
export function parseTagFilters(
  raw: Record<string, unknown>,
): Parameters<TagStore["selectTracks"]>[0] {
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

/** Multi-hour mixes / full albums hog the channel — skip for seed auto-program. */
export const RADIO_SEED_MAX_DURATION_SEC = 15 * 60;
const SEED_SEARCH_LIMIT = 30;
/** Smaller YT pull per seed — yt-dlp is slower and mega-mixes are common. */
const SEED_YT_SEARCH_LIMIT = 12;
const SEED_POOL_CAP = 18;
const RECENT_SEED_MEMORY = 16;
const DEFAULT_SEED_SOURCES: Array<"local" | "youtube" | "stream"> = ["local", "youtube"];
/** ~33% library / ~66% external (YouTube / stream URLs) when both have hits. */
const DEFAULT_SEED_EXTERNAL_RATIO = 2 / 3;

export type RadioSeedSource = "local" | "youtube" | "stream";

/** True when a track is short enough (or duration unknown) and not an obvious mega-mix title. */
export function isRadioSeedFriendlySong(
  song: Pick<Song, "id" | "name" | "artist" | "duration" | "album" | "platform">,
  maxDurationSec = RADIO_SEED_MAX_DURATION_SEC,
  blockedGenres?: readonly string[] | null,
  blacklist?: PlaybackBlacklist | null,
): boolean {
  if (blacklist?.isBlacklisted(song)) return false;
  if (isBlockedGenreSong(song, blockedGenres)) return false;
  // Docs / podcasts / trailers / clickbait — never feed auto-DJ.
  if (isNonMusicContent(song)) return false;
  // 24/7 LIVE radios / Lofi-style streams — yt-dlp returns no URL → dead air.
  if (isYoutubeLivestreamRadioTitle(song.name)) return false;
  // YouTube: same hard gates as search/play (full album, live, >15m, non-music).
  if (
    song.platform === "youtube" &&
    shouldBlockYoutubeSong({
      title: song.name,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
    })
  ) {
    return false;
  }
  if (song.duration > 0 && song.duration > maxDurationSec) return false;
  const n = `${song.name} ${song.artist}`.toLowerCase();
  // "4 hours", "full album", "vol. 1" multi-hour livestream titles, etc.
  if (/\b\d+\s*hours?\b/.test(n)) return false;
  if (/\bfull\s+album\b/.test(n)) return false;
  if (/\b\d+\s*hour\s+of\b/.test(n)) return false;
  // Multi-hour / livestream mix titles (even when duration metadata is missing).
  if (/\bmix\s+for\b/.test(n)) return false;
  if (/\bsynthwave\s+mix\b/.test(n) || /\bstudy\s+music\b/.test(n)) {
    if (song.duration === 0 || song.duration > 20 * 60) return false;
  }
  if (/\bvol\.?\s*\d+\b/.test(n) && (song.duration === 0 || song.duration > 30 * 60)) return false;
  return true;
}

/** Fisher–Yates shuffle (mutates a copy). */
export function shuffleSongs<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Order candidates for a seed pool: demote recently programmed ids, then shuffle
 * within fresh/recent partitions so auto-DJ doesn't lock onto one hit forever.
 */
export function orderSeedCandidates<T extends { id: string }>(
  candidates: T[],
  recentIds: readonly string[],
  opts: { cap?: number; shuffle?: boolean; rng?: () => number } = {},
): T[] {
  const cap = opts.cap ?? SEED_POOL_CAP;
  const doShuffle = opts.shuffle !== false;
  const rng = opts.rng ?? Math.random;
  const recent = new Set(recentIds);
  const fresh = candidates.filter((c) => !recent.has(c.id));
  const stale = candidates.filter((c) => recent.has(c.id));
  const ordered = doShuffle
    ? [...shuffleSongs(fresh, rng), ...shuffleSongs(stale, rng)]
    : [...fresh, ...stale];
  return ordered.slice(0, Math.max(1, cap));
}

/**
 * Interleave local + external seed hits toward `externalRatio`, then fill any
 * remaining slots from whichever side still has tracks (thin library → more YT).
 * Exception: an explicit ratio of 0 or 1 is a hard constraint — the excluded
 * side is never used as backfill.
 */
export function mixLocalAndExternalSeeds<T extends { id: string; platform?: string }>(
  local: T[],
  external: T[],
  opts: {
    cap?: number;
    externalRatio?: number;
    recentIds?: readonly string[];
    shuffle?: boolean;
    rng?: () => number;
  } = {},
): T[] {
  const cap = Math.max(1, opts.cap ?? SEED_POOL_CAP);
  const ratio = Math.min(1, Math.max(0, opts.externalRatio ?? DEFAULT_SEED_EXTERNAL_RATIO));
  const recent = opts.recentIds ?? [];
  const orderOpts = { cap: Math.max(cap * 2, 40), shuffle: opts.shuffle, rng: opts.rng };
  const locals = orderSeedCandidates(local, recent, orderOpts);
  const exts = orderSeedCandidates(external, recent, orderOpts);

  // An explicit 0 or 1 is a hard constraint, not a target: never backfill
  // from the excluded side, even when the preferred side runs thin.
  if (ratio === 0) return locals.slice(0, cap);
  if (ratio === 1) return exts.slice(0, cap);

  if (locals.length === 0) return exts.slice(0, cap);
  if (exts.length === 0) return locals.slice(0, cap);

  // Target split e.g. ratio=2/3 → ~33% local / ~66% external when both sides are full.
  let maxExt = Math.round(cap * ratio);
  if (ratio > 0 && exts.length > 0) maxExt = Math.max(1, maxExt);
  if (ratio < 1 && locals.length > 0) maxExt = Math.min(maxExt, cap - 1);
  maxExt = Math.min(maxExt, exts.length);
  let maxLocal = Math.min(locals.length, cap - maxExt);
  // Thin library → let external fill; thin external → let local fill.
  if (maxLocal + maxExt < cap) {
    maxExt = Math.min(exts.length, cap - maxLocal);
  }
  if (maxLocal + maxExt < cap) {
    maxLocal = Math.min(locals.length, cap - maxExt);
  }

  const out: T[] = [];
  let li = 0;
  let ei = 0;
  // Density-aware interleave: e.g. 1 local then 2 external for a 33/66 split.
  const extPerLocal =
    maxLocal > 0 ? Math.max(1, Math.round(maxExt / Math.max(1, maxLocal))) : maxExt;
  while (out.length < cap && (li < maxLocal || ei < maxExt)) {
    if (li < maxLocal && locals[li]) out.push(locals[li++]!);
    for (let k = 0; k < extPerLocal && out.length < cap && ei < maxExt; k++) {
      if (exts[ei]) out.push(exts[ei++]!);
    }
  }
  while (out.length < cap && li < locals.length) out.push(locals[li++]!);
  while (out.length < cap && ei < exts.length) out.push(exts[ei++]!);
  return out;
}

export function normalizeSeedSources(raw?: readonly string[] | null): RadioSeedSource[] {
  const allowed = new Set<RadioSeedSource>(["local", "youtube", "stream"]);
  const list = (Array.isArray(raw) ? raw : DEFAULT_SEED_SOURCES).filter(
    (s): s is RadioSeedSource => typeof s === "string" && allowed.has(s as RadioSeedSource),
  );
  return list.length > 0 ? [...new Set(list)] : [...DEFAULT_SEED_SOURCES];
}

/**
 * Radio/DJ + rating command implementations (docs/radio.md §9/§12), extracted
 * from CommandExecutor so the transport/queue commands and the radio surface
 * live apart. Same deps object; playlist-ref resolution is borrowed from the
 * executor (shared with !playlist).
 */
export class RadioCommands {
  /** Soft anti-repeat for seed-built pools (song ids programmed recently). */
  private recentSeedSongIds: string[] = [];

  constructor(
    private deps: CommandExecutorDeps,
    private resolvePlaylistSongs: (provider: MusicProvider, ref: string) => Promise<Song[]>,
  ) {}

  async radio(cmd: ParsedCommand): Promise<string> {
    const radio = this.deps.config.radio;
    const p = this.deps.config.commandPrefix;
    const sub = (cmd.rawArgs[0] ?? "status").toLowerCase();
    switch (sub) {
      case "on":
        radio.enabled = true;
        return `📻 Radio mode ON. ${this.summary(radio)} (runtime toggle — set a persistent default in Settings.)`;
      case "off":
        radio.enabled = false;
        this.deps.onRelayChanged?.(null); // stop timer bumpers when leaving radio
        return "📻 Radio mode OFF.";
      case "ops":
        return this.ops(cmd, radio);
      case "bumper": {
        if (!this.deps.radio) return "Radio controls are not available.";
        const topic = cmd.rawArgs.slice(1).join(" ").trim() || undefined;
        const r = await this.deps.radio.cueBumper(topic);
        return r === "played"
          ? "📻 Bumper playing."
          : r === "cued"
            ? "📻 Bumper cued — plays on next skip, track end, or dead air."
            : "No bumper available (radio off, or no source could produce one).";
      }
      case "say": {
        if (!this.deps.radio) return "Radio controls are not available.";
        const text = cmd.rawArgs.slice(1).join(" ").trim();
        if (!text) return `Usage: ${p}radio say <text>`;
        const r = await this.deps.radio.cueSay(text);
        return r === "played"
          ? "📻 On air."
          : r === "cued"
            ? "📻 Liner cued — plays on next skip, track end, or dead air."
            : "Can't speak right now (radio off or TTS unavailable).";
      }
      case "speak-status":
      case "announce": {
        // V3 — spoken radio/status via TTS say path
        if (!this.deps.radio) return "Radio controls are not available.";
        if (typeof this.deps.speakRadioStatus === "function") {
          return this.deps.speakRadioStatus();
        }
        const st = this.deps.radio.status();
        const text =
          st.songsUntilBumper == null
            ? "Radio status unavailable."
            : st.songsUntilBumper === 0
              ? "A bumper is due at the next break."
              : `Next bumper in ${st.songsUntilBumper} tracks.`;
        const r = await this.deps.radio.cueSay(text);
        return r === "played" || r === "cued" ? `📻 ${text}` : `📻 ${text} (TTS unavailable)`;
      }
      case "skip": {
        if (!this.deps.radio) return "Radio controls are not available.";
        return this.deps.radio.skipBumper() === "cue"
          ? "Cued bumper cancelled."
          : "Next scheduled bumper will be skipped.";
      }
      case "pin": {
        if (!this.deps.radio) return "Radio controls are not available.";
        const last = this.deps.radio.getLastPlayedBumper?.() ?? null;
        const dir = this.deps.getBumperDir?.();
        if (!dir) return "Bumper pool directory is not configured.";
        if (last && isUnderBumperDir(last.path, dir)) {
          return "Last bumper is already in the prerecorded pool.";
        }
        const r = pinBumperToPool(last, dir);
        if (!r.ok) return `Could not pin bumper: ${r.error}`;
        return `📌 Pinned to prerecorded pool: ${r.dest}`;
      }
      case "prewarm": {
        if (!this.deps.prewarmRadioBumpers) {
          return "Bumper pre-generate is not available.";
        }
        const rest = cmd.rawArgs.slice(1).map((s) => s.toLowerCase());
        const includeDoctrine = rest.includes("doctrine") || rest.includes("with-doctrine");
        const r = await this.deps.prewarmRadioBumpers({
          includeDoctrine,
          hoursAhead: 12,
        });
        return `📻 Pre-generated ${r.rendered} bumper(s)${r.failed ? `, ${r.failed} failed/skipped` : ""}${
          includeDoctrine ? " (incl. doctrine)" : ""
        }. Live slots use the TTS cache when text matches.`;
      }
      case "gen":
      case "generate": {
        // Alias of !generate — same rights token "generate" checked by router for
        // the top-level command; radio subcommand is checked as radio.* only if
        // canRun is consulted for "generate" by the special path. Here we gate
        // via generateProvider being configured; DJ rights still apply when the
        // operator uses !generate. For !radio gen, require radio.ops-level by
        // reusing generate token if the executor exposes canRun later.
        if (!this.deps.generateProvider?.isConfigured()) {
          return "ACE-Step is not enabled (Settings → ACE-Step music gen).";
        }
        const prompt = cmd.rawArgs.slice(1).join(" ").trim();
        if (!prompt) return `Usage: ${p}radio gen <prompt>`;
        // Play path: generateAndIngest + queue/play like auto-fill
        if (this.deps.generateProvider.isBusy()) {
          return "A generation job is already running.";
        }
        const result = await this.deps.generateProvider.generateAndIngest(prompt);
        if (!result.ok) return `Generation failed: ${result.error}`;
        this.deps.queue.clear();
        this.deps.queue.add({ ...result.song, platform: "local", source: "radio" });
        const first = this.deps.queue.play();
        this.deps.player.resetFailures();
        if (first) await this.deps.playback.resolveAndPlay(first);
        return `Generated and playing: ${result.song.name}`;
      }
      case "status": {
        if (!radio.enabled) return `📻 Radio mode OFF. Use ${p}radio on to start.`;
        return `📻 Radio mode ON. ${this.summary(radio)}${this.countdown()}`;
      }
      default:
        return `Usage: ${p}radio [on|off|status|ops <profile>|ops list|bumper [topic]|say <text>|skip|pin|prewarm [doctrine]|gen <prompt>]`;
    }
  }

  /** `!radio ops <profile>` / `!radio ops list` — set the op context (§8/§12).
   *  One switch retunes bumper topics (the doctrine source reads activeProfile)
   *  AND reprograms the music queue from the profile. The radio.ops gate on the
   *  switch is enforced upstream in the router; `list` is member-level. */
  private async ops(cmd: ParsedCommand, radio: RadioConfig): Promise<string> {
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
    const n = await this.programFromProfile(profile);
    return `🎛 Op context: ${arg}. ${n > 0 ? `Programmed ${n} track${n === 1 ? "" : "s"}.` : "Bumper topics retuned; no music sources matched."}`;
  }

  /**
   * Serialize auto-program: seed YT searches can take tens of seconds while the
   * player stays idle. Overlapping dead-air fills used to run a second
   * programFromProfile that queue.clear()+play() SIGKILLed the first song —
   * the same local head-of-pool track would restart forever.
   */
  private autoProgramInFlight: Promise<boolean> | null = null;

  /** Dead-air self-heal (§7 `thenAutoProgram`): restock + start music from the
   *  active profile; ACE-Step auto-fill when pool empty (docs/ace-step.md A4).
   *  False when nothing matched and gen failed/off. */
  async autoProgram(): Promise<boolean> {
    if (this.autoProgramInFlight) return this.autoProgramInFlight;
    this.autoProgramInFlight = this.runAutoProgram().finally(() => {
      this.autoProgramInFlight = null;
    });
    return this.autoProgramInFlight;
  }

  private async runAutoProgram(): Promise<boolean> {
    const radio = this.deps.config.radio;
    const profile = radio.profiles[radio.activeProfile];
    if (profile?.music) {
      const n = await this.programFromProfile(profile);
      if (n > 0) return true;
    }
    return this.tryAceStepAutoFill(profile);
  }

  /** Build the profile's music pool (§8 selection precedence: tag select +
   *  playlistRefs, then seedQueries as sparse-data fallback), replace the queue
   *  with it, and start playback. Returns the pool size; 0 = queue untouched
   *  (never open a gap). */
  /** Song ids that hit maxPlays within the auto-DJ cooldown window. */
  private autoDjSaturatedIds(): Set<string> {
    const policy = normalizeAutoDjRepeat(this.deps.config.radio?.autoDjRepeat);
    if (!policy.enabled) return new Set();
    const botId = this.deps.botId;
    const db = this.deps.database;
    if (!botId || !db?.getAutoDjSaturatedSongIds) return new Set();
    try {
      return db.getAutoDjSaturatedSongIds(botId, policy.maxPlays, policy.cooldownHours);
    } catch (err) {
      this.deps.logger?.debug?.({ err }, "radio: auto-DJ repeat lookup failed");
      return new Set();
    }
  }

  private async programFromProfile(profile: RadioProfile): Promise<number> {
    const music = profile.music ?? {};
    const pool: QueuedSong[] = [];
    /** Set only when the pool is the live relay URL (timer bumpers apply). */
    let activeRelay: { relayUrl: string; bumperIntervalSec: number } | null = null;
    const saturated = this.autoDjSaturatedIds();

    if (music.select && this.deps.tagStore) {
      let keys = this.deps.tagStore.selectTracks(
        parseTagFilters(music.select as Record<string, unknown>),
      );
      keys = keys.filter((k) => !isAutoDjRepeatBlocked(k, saturated));
      keys = this.applyPoolOrdering(keys);
      pool.push(...(await this.tagKeysToSongs(keys)));
    }
    for (const ref of music.playlistRefs ?? []) {
      // R-R6: local/youtube + spotify/tidal via stream bridge (getPlaylistSongs).
      if (
        ref.platform !== "local" &&
        ref.platform !== "youtube" &&
        ref.platform !== "spotify" &&
        ref.platform !== "tidal"
      ) {
        continue;
      }
      try {
        if (ref.platform === "spotify" || ref.platform === "tidal") {
          const provider = this.deps.getProvider(new Set(["s"]));
          const songs = await provider.getPlaylistSongs(ref.ref);
          if (songs.length === 0) {
            this.deps.logger?.info?.(
              { platform: ref.platform, ref: ref.ref.slice(0, 80) },
              "radio: playlist ref empty (bridge off or unavailable)",
            );
          }
          pool.push(
            ...filterAutoDjRepeatEligible(
              songs.map((s) => ({ ...s, platform: provider.platform })),
              saturated,
            ),
          );
          continue;
        }
        const flag = ref.platform === "youtube" ? "y" : "l";
        const provider = this.deps.getProvider(new Set([flag]));
        const songs = await this.resolvePlaylistSongs(provider, ref.ref);
        pool.push(
          ...filterAutoDjRepeatEligible(
            songs.map((s) => ({ ...s, platform: provider.platform })),
            saturated,
          ),
        );
      } catch {
        /* a dead ref never blocks the profile */
      }
    }
    // R-R6 relay-in: last-resort live stream when no library/playlist pool.
    if (pool.length === 0 && music.relayUrl) {
      try {
        const { resolveRelayFromProfile, relaySongFromUrl } = await import("../../radio/relay.js");
        const relay = resolveRelayFromProfile(music);
        if (relay) {
          const song = relaySongFromUrl(relay.relayUrl);
          // Live relays are not play_history tracks — always allow.
          pool.push({ ...song, platform: "stream" });
          activeRelay = relay;
        }
      } catch {
        /* fail-open */
      }
    }
    if (pool.length === 0) {
      // Seed queries: multi-source mix (default ~33% local / ~66% YouTube+stream),
      // mega-mix filtered, shuffled, soft anti-repeat + play-count cooldown.
      const seeded = await this.expandSeedQueries(music.seedQueries ?? [], music, saturated);
      pool.push(...seeded);
    }
    if (pool.length === 0) {
      // No program → leave relay mode if we were on a timer.
      this.deps.onRelayChanged?.(null);
      return 0;
    }

    // Remember seed-sourced ids so the next restock prefers other tracks.
    this.noteSeedProgrammed(pool.map((s) => s.id));

    this.deps.queue.clear();
    for (const song of pool) {
      this.deps.queue.add({ ...song, source: "radio" });
    }
    const first = this.deps.queue.play();
    this.deps.player.resetFailures();
    if (first) await this.deps.playback.resolveAndPlay(first);
    // Start timer bumpers only for pure relay; stop when profile is library/spotify/etc.
    this.deps.onRelayChanged?.(activeRelay);
    return pool.length;
  }

  /**
   * Expand profile seedQueries into a mixed auto-DJ pool.
   * - Default sources: local + youtube (~33% / ~66% when both hit)
   * - stream source: Spotify/Tidal/Icecast **URLs** in a seed line (bridge)
   * - Multi-hit per seed; drop multi-hour / full-album titles
   * - Soft anti-repeat + shuffle; thin library → more external
   */
  private async expandSeedQueries(
    seeds: string[],
    music: NonNullable<RadioProfile["music"]>,
    saturatedIds?: ReadonlySet<string>,
  ): Promise<QueuedSong[]> {
    const sources = normalizeSeedSources(music.seedSources);
    const shuffle = music.shuffle !== false;
    const externalRatio =
      typeof music.seedExternalRatio === "number" && Number.isFinite(music.seedExternalRatio)
        ? Math.min(1, Math.max(0, music.seedExternalRatio))
        : DEFAULT_SEED_EXTERNAL_RATIO;

    const localById = new Map<string, QueuedSong>();
    const externalById = new Map<string, QueuedSong>();
    const blockedGenres = this.deps.config.musicBlockedGenres;
    const bl = this.deps.playbackBlacklist ?? null;
    const saturated = saturatedIds ?? this.autoDjSaturatedIds();

    const absorb = (
      songs: Song[],
      platform: "local" | "youtube" | "stream",
      into: Map<string, QueuedSong>,
    ) => {
      for (const song of songs) {
        if (!isRadioSeedFriendlySong(song, RADIO_SEED_MAX_DURATION_SEC, blockedGenres, bl))
          continue;
        const id = song.id;
        if (!id || into.has(id) || localById.has(id) || externalById.has(id)) continue;
        if (isAutoDjRepeatBlocked(id, saturated)) continue;
        into.set(id, { ...song, platform });
      }
    };

    const flagFor = (src: RadioSeedSource): string =>
      src === "youtube" ? "y" : src === "stream" ? "s" : "l";
    const limitFor = (src: RadioSeedSource): number =>
      src === "youtube" || src === "stream" ? SEED_YT_SEARCH_LIMIT : SEED_SEARCH_LIMIT;

    for (const seed of seeds) {
      const q = seed.trim();
      if (!q) continue;
      for (const src of sources) {
        try {
          const provider = this.deps.getProvider(new Set([flagFor(src)]));
          const result = await provider.search(q, limitFor(src));
          const platform =
            (provider.platform as "local" | "youtube" | "stream") ||
            (src === "local" ? "local" : src === "youtube" ? "youtube" : "stream");
          absorb(result.songs ?? [], platform, src === "local" ? localById : externalById);
        } catch (err) {
          this.deps.logger?.debug?.({ err, seed: q, src }, "radio: seed search failed");
        }
      }
    }

    // No usable hits — sample the local library (still no mega-mix lock-in).
    if (localById.size === 0 && sources.includes("local")) {
      try {
        const local = this.deps.getProvider(new Set(["l"]));
        const browse = await local.search("", Math.max(SEED_SEARCH_LIMIT, 60));
        absorb(browse.songs ?? [], "local", localById);
      } catch (err) {
        this.deps.logger?.debug?.({ err }, "radio: library sample for seeds failed");
      }
    }

    const ordered = mixLocalAndExternalSeeds([...localById.values()], [...externalById.values()], {
      cap: SEED_POOL_CAP,
      externalRatio,
      recentIds: this.recentSeedSongIds,
      shuffle,
    });

    if (ordered.length > 0) {
      const localN = ordered.filter((s) => s.platform === "local").length;
      const extN = ordered.length - localN;
      this.deps.logger?.info?.(
        {
          seeds,
          sources,
          externalRatio,
          localCandidates: localById.size,
          externalCandidates: externalById.size,
          queued: ordered.length,
          localQueued: localN,
          externalQueued: extN,
          sample: ordered.slice(0, 4).map((s) => `${s.platform}:${s.name}`),
        },
        "radio: seed pool built",
      );
    }
    return ordered;
  }

  private noteSeedProgrammed(ids: string[]): void {
    for (const id of ids) {
      if (!id) continue;
      this.recentSeedSongIds = this.recentSeedSongIds.filter((x) => x !== id);
      this.recentSeedSongIds.push(id);
    }
    while (this.recentSeedSongIds.length > RECENT_SEED_MEMORY) {
      this.recentSeedSongIds.shift();
    }
  }

  /**
   * ACE-Step radio auto-fill (A4). Library/seed pool empty only.
   * Gate: service configured + (profile.music.aceStepAutoFill === true OR global
   * aceStepAutoFill with profile not explicitly false). Fail-open.
   */
  private async tryAceStepAutoFill(profile?: RadioProfile): Promise<boolean> {
    const cfg = this.deps.config;
    const gen = this.deps.generateProvider;
    if (!gen?.isConfigured() || gen.isBusy()) return false;

    const profileFlag = profile?.music?.aceStepAutoFill;
    if (profileFlag === false) return false;
    const allowed = profileFlag === true || !!cfg.aceStepAutoFill;
    if (!allowed) return false;

    const prompt = buildRadioGenPrompt(profile, cfg.radio.activeProfile);
    try {
      const result = await gen.generateAndIngest(prompt);
      if (!result.ok) {
        this.deps.logger?.warn?.(
          { error: result.error, prompt: prompt.slice(0, 80) },
          "radio: ACE-Step auto-fill failed",
        );
        return false;
      }
      this.deps.queue.clear();
      this.deps.queue.add({ ...result.song, platform: "local", source: "radio" });
      const first = this.deps.queue.play();
      this.deps.player.resetFailures();
      if (first) await this.deps.playback.resolveAndPlay(first);
      this.deps.logger?.info?.(
        { song: result.song.name, relPath: result.relPath },
        "radio: ACE-Step auto-fill playing generated track",
      );
      return true;
    } catch (err) {
      this.deps.logger?.warn?.({ err }, "radio: ACE-Step auto-fill threw");
      return false;
    }
  }

  /** Live rotation position (§12: "songs-until-next-bumper"). */
  private countdown(): string {
    const st = this.deps.radio?.status();
    if (!st) return "";
    if (st.cuePending) return " Bumper cued for the next track break.";
    if (st.skipNextPending) return " Next scheduled bumper will be skipped.";
    if (st.songsUntilBumper === null) return "";
    return st.songsUntilBumper === 0
      ? " Bumper at the next track break."
      : ` Next bumper in ${st.songsUntilBumper} track${st.songsUntilBumper === 1 ? "" : "s"}.`;
  }

  private summary(radio: RadioConfig): string {
    const cadence =
      radio.everyNSongs > 0 ? `Bumpers every ${radio.everyNSongs} songs` : "Clock-only";
    return `${cadence}; profile '${radio.activeProfile}'; sources: ${radio.sources.join(", ")}.`;
  }

  /** `!rate <1-5> [song]` — rate the now-playing track (or a searched one) as
   *  this TS user (§9.7). Per-rater, aggregated; one rating per rater (upsert). */
  async rate(cmd: ParsedCommand, msg?: TS3TextMessage): Promise<string> {
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

  /** `!unrate` — remove your rating for the now-playing track. */
  unrate(msg?: TS3TextMessage): string {
    if (!this.deps.tagStore) return "Ratings are not available.";
    const cur = this.deps.queue.current();
    if (!cur) return "Nothing is playing to unrate.";
    const removed = this.deps.tagStore.unrate(cur.id, `ts:${msg?.invokerUid ?? "unknown"}`);
    return removed ? `Removed your rating for "${cur.name}".` : `You hadn't rated "${cur.name}".`;
  }

  /**
   * `selecttracks <json-filters>` — tag-driven selection (§9.4), normally
   * reached via the select_tracks LLM tool. Queries the TagStore overlay,
   * queues the matching LOCAL tracks, and starts playback if idle. Each field
   * is validated here (the LLM proposes, the executor disposes); unknown keys
   * are dropped.
   */
  async selectTracks(cmd: ParsedCommand): Promise<string> {
    if (!this.deps.tagStore) return "Tag selection is not available.";
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(cmd.args || "{}") as Record<string, unknown>;
    } catch {
      return 'Usage: selecttracks {"genreAny":["ambient"],"bpmMax":110}';
    }
    let keys = this.deps.tagStore.selectTracks(parseTagFilters(raw));
    keys = this.applyPoolOrdering(keys);
    const songs = await this.tagKeysToSongs(keys);
    if (songs.length === 0) return "No tracks match those tags.";

    const wasIdle = this.deps.player.getState() === "idle";
    // Tag selection is a human/tool request — jump ahead of auto-DJ fill.
    let firstAt = -1;
    for (const song of songs) {
      const at = this.deps.queue.add({ ...song, source: "user" });
      if (firstAt < 0) firstAt = at;
    }
    if (wasIdle && firstAt >= 0) {
      // playAt the insert point — queue.play() would restart at index 0,
      // replaying an old/radio-fill track instead of this selection.
      this.deps.queue.playAt(firstAt);
      this.deps.player.resetFailures();
      await this.deps.playback.resolveAndPlay(this.deps.queue.current()!);
    }
    return `Queued ${songs.length} track${songs.length === 1 ? "" : "s"} by tags.`;
  }

  /**
   * OQ7 rating weight + OQ5 harmonic sequencing on a selected key list.
   * Rating weight reorders first (preference bag); harmonic then smooths neighbors.
   */
  applyPoolOrdering(keys: string[]): string[] {
    if (keys.length <= 1 || !this.deps.tagStore) return keys;
    const radio = this.deps.config.radio ?? {};
    const store = this.deps.tagStore;
    let ordered = keys;
    const rw = radio.ratingWeight;
    // Default on when radio config omits ratingWeight (matches defaultRadioConfig).
    const weightEnabled = rw?.enabled !== false;
    if (weightEnabled) {
      ordered = orderKeysByRatingWeight(ordered, (k) => store.smoothedScore(k), {
        enabled: true,
        exponent: rw?.exponent ?? 1,
        maxRatio: rw?.maxRatio ?? 3,
      });
    }
    const harmonicOn = !!(
      radio.harmonicSequencing ||
      radio.profiles?.[radio.activeProfile ?? ""]?.music?.harmonicSequencing
    );
    if (harmonicOn) {
      ordered = orderKeysHarmonically(
        ordered,
        (k) => {
          const t = store.get(k);
          return t ? { musicalKey: t.musicalKey, keyScale: t.keyScale } : null;
        },
        true,
      );
    }
    return ordered;
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
}

/** Prompt for radio auto-fill / !radio gen when operator text is absent. */
export function buildRadioGenPrompt(
  profile: RadioProfile | undefined,
  profileName: string,
): string {
  const tone = profile?.bumper?.tone?.trim();
  const topics = profile?.bumper?.topics?.filter(Boolean) ?? [];
  const seeds = profile?.music?.seedQueries?.filter(Boolean) ?? [];
  const mood = profile?.music?.select?.mood;
  const moodBits = Array.isArray(mood) ? mood.join(", ") : "";
  const bits = [
    tone || `Radio profile ${profileName}`,
    topics.length ? `themes: ${topics.slice(0, 4).join(", ")}` : "",
    moodBits ? `mood: ${moodBits}` : "",
    seeds.length
      ? `style: ${seeds.slice(0, 3).join(", ")}`
      : "instrumental bed suitable for TeamSpeak",
    "no vocals preferred, clean for voice channel, steady energy",
  ].filter(Boolean);
  return bits.join(". ");
}
