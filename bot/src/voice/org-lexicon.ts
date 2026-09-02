/**
 * Org lexicon for STT (Whisper initial prompt) and TTS (speakable expansions).
 * Keep this list short — Whisper's prompt budget is small, and TTS replacements
 * must not mangle ordinary English.
 */

/** Whisper initial prompt / hotword hint (ship names, ranks, aliases). */
export const WHISPER_INITIAL_PROMPT =
  "Moneypenny, skip, pause, resume, volume, next, stop. " +
  "INTSUM, AAR, 600i, 890 Jump, Talon, Colonel, Captain, Lieutenant, Chairman. " +
  "quantum, jump point, hangar, callsign.";

export interface SpeakExpansion {
  /** Whole-token match (word boundary). */
  token: string;
  spoken: string;
}

/**
 * TTS expansions. Order matters: longer tokens first so "890 Jump" wins over "890".
 * Case-insensitive whole-token replace.
 */
export const SPEAK_EXPANSIONS: readonly SpeakExpansion[] = [
  { token: "890 Jump", spoken: "eight-ninety Jump" },
  { token: "600i", spoken: "six-hundred-i" },
  { token: "INTSUM", spoken: "int-sum" },
  { token: "AAR", spoken: "after-action review" },
  { token: "QRF", spoken: "Q-R-F" },
  { token: "SOP", spoken: "S-O-P" },
  { token: "NCO", spoken: "N-C-O" },
  { token: "ROE", spoken: "R-O-E" },
  { token: "COL", spoken: "Colonel" },
  { token: "Col.", spoken: "Colonel" },
  { token: "CPT", spoken: "Captain" },
  { token: "Capt.", spoken: "Captain" },
  { token: "LT", spoken: "Lieutenant" },
  { token: "Lt.", spoken: "Lieutenant" },
  { token: "SGT", spoken: "Sergeant" },
  { token: "NCOIC", spoken: "N-C-O-I-C" },
];

const TOKEN_RE = new RegExp(
  `\\b(${SPEAK_EXPANSIONS.map((e) => e.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "gi",
);

const SPOKEN_BY_LOWER = new Map(SPEAK_EXPANSIONS.map((e) => [e.token.toLowerCase(), e.spoken]));

/** Expand org tokens into speakable English for Piper/Kokoro. */
export function applySpeakLexicon(text: string): string {
  if (!text) return text;
  return text.replace(TOKEN_RE, (m) => SPOKEN_BY_LOWER.get(m.toLowerCase()) ?? m);
}
