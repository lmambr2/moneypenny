/**
 * Talker–Reasoner text split (K13). User commands come from Whisper only.
 * Moshi 0x02 is her inner monologue and is never a command.
 */

/** Agent caption. Always null — callers must not route this string. */
export function userTextFromAgentMonologue(_text: string): null {
  return null;
}

/** Whisper final / typed text. Empty after trim is not a turn. */
export function acceptUserAsr(text: string): string {
  return text.trim();
}
