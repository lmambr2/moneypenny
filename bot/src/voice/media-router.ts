import { type ParsedCommand, parseCommand } from "../bot/commands.js";

/**
 * Deterministic media-verb matcher that runs *before* the LLM.
 * Spoken "Moneypenny skip" / "please pause" / "volume 40" must not spend a
 * 12B forward pass. Known first-word commands still go through parseCommand;
 * this catches polite/padded phrasings the STT + parser miss.
 */

const POLITE = "(?:(?:please|just|can you|could you|would you|moneypenny)\\s+)*";
const MUSIC = "(?:\\s+(?:the\\s+)?(?:music|playback|song|track|one))?";

const SKIP_RE = new RegExp(
  `^${POLITE}(?:skip|next)(?:\\s+(?:this|the)?\\s*(?:song|track|one)?)?$`,
  "i",
);
const PAUSE_RE = new RegExp(`^${POLITE}(?:pause|hold)${MUSIC}$`, "i");
const RESUME_RE = new RegExp(`^${POLITE}(?:resume|unpause|continue)${MUSIC}$`, "i");
const STOP_RE = new RegExp(`^${POLITE}(?:stop|halt|shut up)${MUSIC}$`, "i");
const VOL_RE = new RegExp(
  `^${POLITE}(?:(?:set\\s+)?(?:the\\s+)?(?:volume|vol)\\s+(?:to\\s+)?(\\d{1,3})|(?:volume|vol)\\s+(\\d{1,3}))$`,
  "i",
);

function cmd(name: string, args = ""): ParsedCommand {
  const rawArgs = args ? args.split(/\s+/).filter(Boolean) : [];
  return { name, args, rawArgs, flags: new Set() };
}

/**
 * If `text` is a padded play/pause/skip/volume/stop/next, return the
 * deterministic command. Otherwise null (caller may still parseCommand / LLM).
 */
export function matchVoiceMediaCommand(
  text: string,
  aliases: Record<string, string> = {},
): ParsedCommand | null {
  const t = text
    .trim()
    .replace(/[.!?,;:]+$/u, "")
    .trim();
  if (!t) return null;

  // Prefer the shared parser when the first word is already a known command
  // (or alias) — that path owns flags/args. Only intercept padded phrasing.
  const parsed = parseCommand(`!${t}`, "!", aliases);
  if (parsed) {
    const name = parsed.name;
    if (
      name === "skip" ||
      name === "next" ||
      name === "pause" ||
      name === "resume" ||
      name === "stop"
    ) {
      return parsed;
    }
    if (name === "vol" || name === "volume") {
      return name === "volume" ? cmd("vol", parsed.args) : parsed;
    }
    if (name === "play" && parsed.args?.trim()) return parsed;
  }

  if (SKIP_RE.test(t)) return cmd("skip");
  if (PAUSE_RE.test(t)) return cmd("pause");
  if (RESUME_RE.test(t)) return cmd("resume");
  if (STOP_RE.test(t)) return cmd("stop");
  const vol = t.match(VOL_RE);
  if (vol) {
    const n = Number.parseInt(vol[1] || vol[2] || "", 10);
    if (Number.isFinite(n)) return cmd("vol", String(Math.max(0, Math.min(100, n))));
  }
  return null;
}
