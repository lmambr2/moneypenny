import { isKnownCommand, parseCommand } from "../bot/commands.js";
import { normalizeVoiceTranscript } from "../control/router.js";

/** Collapse punctuation/whitespace for tokenization. */
export function normalizeForWatchword(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WatchwordMatch {
  matched: boolean;
  /** Command text after the watchword (may be empty). */
  command: string;
}

export interface WatchwordOptions {
  /** sherpa-onnx KWS detected the wake word in audio for this utterance. */
  kwsDetected?: boolean;
  /** Speaker is in the post-wake command window — accept a bare follow-up command. */
  armed?: boolean;
  /** Dev/smoke-test fallback when KWS is unavailable (stt-mock). */
  textWakeFallback?: boolean;
}

/** Optional leading articles only — not STT “mishear” maps. */
const LEADING_FILLER = /^(?:a|an|the|uh+|um+)\s+/i;

const PLAYBACK_VERBS = new Set([
  "pause",
  "resume",
  "skip",
  "stop",
  "play",
  "next",
  "jump",
  "go",
  "prev",
]);

/**
 * True when a partial transcript mentions the candidate command by its real name
 * (no garble synonym table — KWS + STT must produce the actual verb).
 */
export function partialMentionsCommand(partial: string, command: string): boolean {
  const verb = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!verb) return false;
  return new RegExp(`\\b${escapeRegExp(verb)}\\b`, "i").test(partial);
}

/**
 * Zero-arg (or flag-only) commands. Trailing free-form STT junk is almost always
 * channel banter that happened to start with a common English word ("now I need…")
 * — not an intentional voice command.
 */
const ZERO_ARG_VOICE_COMMANDS = new Set([
  "pause",
  "resume",
  "skip",
  "stop",
  "next",
  "prev",
  "now",
  "clear",
  "queue",
  "list",
  "lyrics",
  "help",
  "test",
  "roast",
  "roastout",
  "roastin",
  "recall",
  "reindex",
  "ingeststatus",
  "follow",
  "chevron7",
]);
// jump/go require a query — not zero-arg

/** Whether parsed name+args look like a deliberate voice command (not banter). */
export function voiceCommandShapeOk(name: string, args: string): boolean {
  const a = args.trim();
  if (ZERO_ARG_VOICE_COMMANDS.has(name)) {
    return a === "";
  }
  if (name === "forget") {
    return a === "all" || /^\d+$/.test(a);
  }
  // Free-form personal fact — need a real payload (not "remember" alone / one word).
  if (name === "remember") {
    const words = a.split(/\s+/).filter(Boolean);
    return words.length >= 2 || a.length >= 8;
  }
  if (name === "vol") {
    return /^\d{1,3}$/.test(a);
  }
  if (name === "mode") {
    return /^(seq|loop|random|rloop)$/i.test(a);
  }
  if (name === "karaoke") {
    return a === "" || /^(on|off|status)$/i.test(a);
  }
  if (name === "rate" || name === "unrate") {
    return a === "" || /^[1-5]$/.test(a);
  }
  return true;
}

/** True when text maps to a real bot command (pause, skip, …) — not LLM chit-chat. */
export function isActionableVoiceCommand(
  command: string,
  aliases: Record<string, string> = {},
): boolean {
  const text = command.trim();
  if (!text) return false;
  const parsed = parseCommand(`!${text}`, "!", aliases);
  if (!parsed) return false;
  const name = parsed.name.replace(/[.,!?;:]+$/u, "");
  if (!isKnownCommand(name)) return false;
  return voiceCommandShapeOk(name, parsed.args ?? "");
}

/**
 * Transport verbs safe to route from STT partials — excludes play/add (need full
 * title + one resolve) and high-frequency English words that false-fire mid-speech.
 */
const PARTIAL_SAFE_COMMANDS = new Set([
  "pause",
  "resume",
  "skip",
  "stop",
  "next",
  "prev",
  "vol",
  "clear",
  "mode",
]);

export function isPartialSafeVoiceCommand(
  command: string,
  aliases: Record<string, string> = {},
): boolean {
  if (!isActionableVoiceCommand(command, aliases)) return false;
  const parsed = parseCommand(`!${command.trim()}`, "!", aliases);
  if (!parsed) return false;
  const name = parsed.name.replace(/[.,!?;:]+$/u, "");
  return PARTIAL_SAFE_COMMANDS.has(name) && !(parsed.args ?? "").trim();
}

function stripLeadingFiller(text: string): string {
  let t = text.trim();
  while (LEADING_FILLER.test(t)) {
    t = t.replace(LEADING_FILLER, "").trim();
  }
  return t;
}

/** Keep the first phrase before STT run-on punctuation. */
export function normalizeVoiceCommand(command: string): string {
  const trimmed = command.replace(/^[,:;\-–—\s]+/, "").trim();
  const chunk = trimmed.split(/[,;]/)[0]?.trim() ?? "";
  return normalizeVoiceTranscript(stripLeadingFiller(chunk));
}

function finalizeCommand(raw: string): string {
  return normalizeVoiceCommand(raw);
}

function parseNorm(transcript: string): string {
  return normalizeVoiceTranscript(transcript).toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Allow commas between STT tokens (e.g. "money, penny" when wake is two words). */
function aliasPrefixPattern(alias: string): RegExp {
  const parts = alias.split(/\s+/).filter(Boolean);
  const escaped = parts.map((p) => escapeRegExp(p));
  return new RegExp(`^${escaped.join("[\\s,]+")}(?=$|[\\s,;:])`);
}

/**
 * Forms of the configured watchword for prefix stripping only.
 * No STT garble dictionary — only the exact phrase and a space-split of a
 * single compound token (moneypenny → "money penny").
 */
export function watchwordAliases(watchword: string): string[] {
  const base = normalizeForWatchword(watchword);
  if (!base) return [];
  const aliases = new Set<string>([base]);
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length === 1 && parts[0].length >= 8) {
    // Split camel/compound: moneypenny → money + penny when second half starts with a consonant cluster.
    const m = parts[0].match(/^([a-z]{3,})(penny|penney)$/);
    if (m) aliases.add(`${m[1]} ${m[2]}`);
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}

function stripWatchwordPrefix(
  norm: string,
  watchword: string,
): { stripped: boolean; rest: string } {
  for (const alias of watchwordAliases(watchword)) {
    const match = norm.match(aliasPrefixPattern(alias));
    if (!match) continue;
    const rest = norm
      .slice(match[0].length)
      .replace(/^[\s,;:]+/, "")
      .trim();
    return { stripped: true, rest };
  }
  return { stripped: false, rest: "" };
}

function aliasInfixPattern(alias: string): RegExp {
  const parts = alias.split(/\s+/).filter(Boolean);
  const escaped = parts.map((p) => escapeRegExp(p));
  return new RegExp(`(?:^|[\\s,;:])${escaped.join("[\\s,]+")}(?=$|[\\s,;:])`);
}

function finalizeCommandSegment(raw: string): string {
  const trimmed = raw.replace(/^[,:;\-–—\s]+/, "").trim();
  const chunk = trimmed.split(/[,;]/)[0]?.trim() ?? "";
  const parts = stripLeadingFiller(chunk).split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return normalizeVoiceTranscript(parts.join(" "));
}

function resolvePlaybackVerbToken(token: string): string | undefined {
  const key = token.replace(/[.,!?;:'"]/g, "").toLowerCase();
  if (!key) return undefined;
  return PLAYBACK_VERBS.has(key) ? key : undefined;
}

/**
 * Scan tokens for a real playback verb; `play` keeps trailing args.
 * No synonym table — only exact verb tokens.
 */
function extractPlaybackVerb(tokens: string[]): string {
  const cleaned = tokens.map((t) => t.replace(/[.,!?;:'"]/g, "").toLowerCase()).filter(Boolean);
  if (!cleaned.length) return "";

  if (cleaned.length <= 5) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      const verb = resolvePlaybackVerbToken(tokens[i]);
      if (!verb) continue;
      if (verb === "play") {
        const play = finalizeCommandSegment(tokens.slice(i).join(" "));
        if (!play.split(/\s+/).slice(1).join("").trim()) return "play";
        return play;
      }
      return verb;
    }
    return "";
  }

  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (resolvePlaybackVerbToken(cleaned[i]) !== "play") continue;
    if (i >= cleaned.length - 1) continue;
    return finalizeCommandSegment(tokens.slice(i).join(" "));
  }

  const first = resolvePlaybackVerbToken(cleaned[0]);
  if (first === "play" && cleaned.length > 1) {
    return finalizeCommandSegment(tokens.join(" "));
  }
  return "";
}

/**
 * Parse a command-mode STT segment after KWS opened the window.
 * Uses exact verbs only (no English-word → command translation).
 */
export function extractCommandSegment(transcript: string, watchword: string): string {
  const norm = parseNorm(transcript);
  if (!norm) return "";

  const { stripped, rest } = stripWatchwordPrefix(norm, watchword);
  if (stripped && rest) {
    const verb = extractPlaybackVerb(rest.split(/\s+/).filter(Boolean));
    if (verb && (verb === "play" || isActionableVoiceCommand(verb))) return verb;
    const seg = finalizeCommandSegment(rest);
    if (seg && isActionableVoiceCommand(seg)) return seg;
    return "";
  }

  for (const alias of watchwordAliases(watchword)) {
    const match = norm.match(aliasInfixPattern(alias));
    if (!match) continue;
    const after = norm
      .slice((match.index ?? 0) + match[0].length)
      .replace(/^[\s,;:]+/, "")
      .trim();
    if (after) {
      const verb = extractPlaybackVerb(after.split(/\s+/).filter(Boolean));
      if (verb && (verb === "play" || isActionableVoiceCommand(verb))) return verb;
      const seg = finalizeCommandSegment(after);
      if (seg && isActionableVoiceCommand(seg)) return seg;
    }
    return "";
  }

  const verb = extractPlaybackVerb(norm.split(/\s+/).filter(Boolean));
  if (verb && isActionableVoiceCommand(verb)) return verb;
  if (verb === "play") return "play";

  const seg = finalizeCommandSegment(norm);
  if (seg && isActionableVoiceCommand(seg)) return seg;
  return "";
}

/**
 * Gate voice routing on the wake phrase.
 * Production: KWS opens the command window; STT only runs post-wake in command mode.
 * textWakeFallback: prefix-only matching for stt-mock / admin smoke tests.
 */
export function extractWatchwordCommand(
  transcript: string,
  watchword: string,
  opts: WatchwordOptions = {},
): WatchwordMatch {
  const norm = parseNorm(transcript);

  if (opts.kwsDetected || opts.textWakeFallback) {
    const { stripped, rest } = stripWatchwordPrefix(norm, watchword);
    if (stripped) {
      const command =
        opts.kwsDetected || opts.armed ? finalizeCommandSegment(rest) : finalizeCommand(rest);
      return { matched: true, command };
    }
    if (opts.kwsDetected) {
      return { matched: true, command: norm ? extractCommandSegment(transcript, watchword) : "" };
    }
  }

  if (opts.armed) {
    return { matched: true, command: norm ? extractCommandSegment(transcript, watchword) : "" };
  }

  return { matched: false, command: "" };
}
