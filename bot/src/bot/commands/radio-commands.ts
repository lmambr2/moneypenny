import type { QueuedSong } from "../../audio/queue.js";
import type { MusicProvider, Song } from "../../music/provider.js";
import { orderKeysHarmonically } from "../../radio/harmonic.js";
import {
  isUnderBumperDir,
  pinBumperToPool,
  type RadioConfig,
  type RadioProfile,
  type TagStore,
} from "../../radio/index.js";
import { orderKeysByRatingWeight } from "../../radio/rating-weight.js";
import type { TS3TextMessage } from "../../ts-protocol/client.js";
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

/**
 * Radio/DJ + rating command implementations (docs/radio.md §9/§12), extracted
 * from CommandExecutor so the transport/queue commands and the radio surface
 * live apart. Same deps object; playlist-ref resolution is borrowed from the
 * executor (shared with !playlist).
 */
export class RadioCommands {
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
        this.deps.queue.add({ ...result.song, platform: "local" });
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

  /** Dead-air self-heal (§7 `thenAutoProgram`): restock + start music from the
   *  active profile; ACE-Step auto-fill when pool empty (docs/ace-step.md A4).
   *  False when nothing matched and gen failed/off. */
  async autoProgram(): Promise<boolean> {
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
  private async programFromProfile(profile: RadioProfile): Promise<number> {
    const music = profile.music ?? {};
    const pool: QueuedSong[] = [];
    /** Set only when the pool is the live relay URL (timer bumpers apply). */
    let activeRelay: { relayUrl: string; bumperIntervalSec: number } | null = null;

    if (music.select && this.deps.tagStore) {
      let keys = this.deps.tagStore.selectTracks(
        parseTagFilters(music.select as Record<string, unknown>),
      );
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
          pool.push(...songs.map((s) => ({ ...s, platform: provider.platform })));
          continue;
        }
        const flag = ref.platform === "youtube" ? "y" : "l";
        const provider = this.deps.getProvider(new Set([flag]));
        const songs = await this.resolvePlaylistSongs(provider, ref.ref);
        pool.push(...songs.map((s) => ({ ...s, platform: provider.platform })));
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
          pool.push({ ...song, platform: "stream" });
          activeRelay = relay;
        }
      } catch {
        /* fail-open */
      }
    }
    if (pool.length === 0) {
      for (const seed of music.seedQueries ?? []) {
        const hit = await this.deps.playback
          .searchFirst(
            { name: "play", args: seed, rawArgs: seed.split(/\s+/), flags: new Set() },
            1,
          )
          .catch(() => null);
        if (hit) pool.push({ ...hit.song, platform: hit.provider.platform });
      }
    }
    if (pool.length === 0) {
      // No program → leave relay mode if we were on a timer.
      this.deps.onRelayChanged?.(null);
      return 0;
    }

    this.deps.queue.clear();
    for (const song of pool) this.deps.queue.add(song);
    const first = this.deps.queue.play();
    this.deps.player.resetFailures();
    if (first) await this.deps.playback.resolveAndPlay(first);
    // Start timer bumpers only for pure relay; stop when profile is library/spotify/etc.
    this.deps.onRelayChanged?.(activeRelay);
    return pool.length;
  }

  /**
   * ACE-Step radio auto-fill (A4). Only when aceStepAutoFill is on and library
   * selection produced nothing. Fail-open: never throws into the director.
   */
  private async tryAceStepAutoFill(profile?: RadioProfile): Promise<boolean> {
    const cfg = this.deps.config;
    if (!cfg.aceStepAutoFill) return false;
    const gen = this.deps.generateProvider;
    if (!gen?.isConfigured() || gen.isBusy()) return false;

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
      this.deps.queue.add({ ...result.song, platform: "local" });
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
    for (const song of songs) this.deps.queue.add(song);
    if (wasIdle) {
      this.deps.queue.play();
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
