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

/** Moonshine often inserts filler before short playback verbs ("a resume", "the pause"). */
const LEADING_FILLER = /^(?:a|an|the|uh+|um+)\s+/i;

/** Canonicalize common STT mishears for deterministic playback verbs. */
const VOICE_COMMAND_ALIASES: Record<string, string> = {
  peri: "resume",
  pass: "resume",
  past: "pause",
  paused: "pause",
  pod: "pause",
  rezoom: "resume",
  rezume: "resume",
  paws: "pause",
  poz: "pause",
  ship: "skip",
};

/** Known STT splits for the default wake name (text fallback / command stripping). */
const DEFAULT_WAKE_ALIASES = [
  "moneypenny",
  "money penny",
  "money petty",
  "money pretty",
  "honey penny",
  "mighty pretty",
];

/** In the post-wake command window, STT often confuses pause/pass. */
const COMMAND_MODE_ALIASES: Record<string, string> = {
  pass: "pause",
};

const PLAYBACK_VERBS = new Set(["pause", "resume", "skip", "stop", "play", "next", "prev"]);

/** STT spellings that should count as mentioning a canonical playback verb in a partial. */
export function partialMentionsCommand(partial: string, command: string): boolean {
  const hints = new Set<string>([command]);
  for (const [alias, verb] of Object.entries(VOICE_COMMAND_ALIASES)) {
    if (verb === command) hints.add(alias);
  }
  for (const [alias, verb] of Object.entries(COMMAND_MODE_ALIASES)) {
    if (verb === command) hints.add(alias);
  }
  const p = partial.toLowerCase();
  for (const hint of hints) {
    if (new RegExp(`\\b${escapeRegExp(hint)}\\b`, "i").test(p)) return true;
  }
  return false;
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
  return isKnownCommand(name);
}

function stripLeadingFiller(text: string): string {
  let t = text.trim();
  while (LEADING_FILLER.test(t)) {
    t = t.replace(LEADING_FILLER, "").trim();
  }
  return t;
}

function canonicalizeVoiceVerb(text: string): string {
  const stripped = stripLeadingFiller(text);
  const parts = stripped.split(/\s+/).filter(Boolean);
  if (!parts.length) return stripped;
  const alias = VOICE_COMMAND_ALIASES[parts[0].toLowerCase()];
  if (!alias) return stripped;
  parts[0] = alias;
  return parts.join(" ");
}

/** Keep the first phrase before STT run-on punctuation (e.g. "pause, money petty play"). */
export function normalizeVoiceCommand(command: string): string {
  const trimmed = command.replace(/^[,:;\-–—\s]+/, "").trim();
  const chunk = trimmed.split(/[,;]/)[0]?.trim() ?? "";
  return normalizeVoiceTranscript(canonicalizeVoiceVerb(chunk));
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

/** Allow commas between STT tokens (e.g. "money, penny"). */
function aliasPrefixPattern(alias: string): RegExp {
  const parts = alias.split(/\s+/).filter(Boolean);
  const escaped = parts.map((p) => escapeRegExp(p));
  return new RegExp(`^${escaped.join("[\\s,]+")}(?=$|[\\s,;:])`);
}

/**
 * Prefix forms accepted when stripping the wake name from an STT transcript.
 * Production wake detection runs in sherpa KWS; this list is only for command parsing.
 */
export function watchwordAliases(watchword: string): string[] {
  const base = normalizeForWatchword(watchword);
  if (!base) return [];
  const parts = base.split(/\s+/).filter(Boolean);
  const aliases = new Set<string>([base]);
  if (parts.length === 1) {
    aliases.add(parts[0]);
    if (parts[0] === "moneypenny") {
      for (const a of DEFAULT_WAKE_ALIASES) aliases.add(a);
    }
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}

function stripWatchwordPrefix(norm: string, watchword: string): { stripped: boolean; rest: string } {
  for (const alias of watchwordAliases(watchword)) {
    const match = norm.match(aliasPrefixPattern(alias));
    if (!match) continue;
    const rest = norm.slice(match[0].length).replace(/^[\s,;:]+/, "").trim();
    return { stripped: true, rest };
  }
  return { stripped: false, rest: "" };
}

/** Match wake alias anywhere (command-mode STT often bleeds the wake name back in). */
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
  const key = parts[0].toLowerCase();
  const verb = COMMAND_MODE_ALIASES[key] ?? VOICE_COMMAND_ALIASES[key] ?? key;
  parts[0] = verb;
  return normalizeVoiceTranscript(parts.join(" "));
}

/**
 * Parse a command-mode STT segment. KWS already opened the window acoustically;
 * this only normalizes the verb Moonshine heard (e.g. "honey penny pass" → pause).
 */
export function extractCommandSegment(transcript: string, watchword: string): string {
  const norm = parseNorm(transcript);
  if (!norm) return "";

  const { stripped, rest } = stripWatchwordPrefix(norm, watchword);
  if (stripped && rest) return finalizeCommandSegment(rest);

  for (const alias of watchwordAliases(watchword)) {
    const match = norm.match(aliasInfixPattern(alias));
    if (!match) continue;
    const after = norm.slice((match.index ?? 0) + match[0].length).replace(/^[\s,;:]+/, "").trim();
    if (after) return finalizeCommandSegment(after);
  }

  const tokens = norm.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const key = tokens[i].replace(/[.,!?;:'"]/g, "").toLowerCase();
    // Match a known mishear (past→pause) OR a canonical verb spoken directly —
    // so wake-bleed transcripts ("any pause", "honey penny stop") still resolve.
    const verb = COMMAND_MODE_ALIASES[key] ?? VOICE_COMMAND_ALIASES[key] ?? (PLAYBACK_VERBS.has(key) ? key : undefined);
    if (verb && PLAYBACK_VERBS.has(verb)) return verb;
  }

  return finalizeCommandSegment(norm);
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
      const command = opts.kwsDetected || opts.armed
        ? finalizeCommandSegment(rest)
        : finalizeCommand(rest);
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