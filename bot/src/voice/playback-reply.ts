/**
 * After voice TTS, `trackEnd` uses `savedMusic` to restore interrupted playback.
 * Pause/stop should drop that handoff (PlaybackEngine keeps a separate operator
 * pause checkpoint so resume can re-seek the same song). Resume/skip need the
 * speak() handoff so music restarts after the spoken ack.
 */
export function voiceReplyClearsSavedMusic(reply: string | null): boolean {
  if (!reply) return false;
  const r = reply.toLowerCase().trim();
  if (r.startsWith("stopped")) return true;
  return r === "paused" || r === "paused.";
}

/** Executor started playback (voice should disarm — no follow-up capture). */
export function isPlaybackStartReply(reply: string | null): boolean {
  if (!reply) return false;
  return reply.toLowerCase().includes("now playing");
}

/** Short phrase spoken immediately while music resolve runs. */
export function voicePlayPendingAck(): string {
  return "On it.";
}

/** Executor replies for transport commands. */
export function isPlaybackControlReply(reply: string | null): boolean {
  if (!reply) return false;
  const r = reply.toLowerCase();
  return r === "paused" || r === "resumed" || r.startsWith("stopped") || r.startsWith("skipped");
}

/** Short phrase Kokoro speaks for transport acks (not the full executor string). */
export function voiceSpokenAck(reply: string | null): string | null {
  if (!reply) return null;
  const r = reply.toLowerCase().trim();
  if (r === "paused" || r === "paused.") return "Paused.";
  if (r === "resumed" || r === "playback resumed." || r === "playback resumed") return "Resumed.";
  if (r.startsWith("stopped")) return "Stopped.";
  if (r.startsWith("skipped")) return "Skipped.";
  return null;
}

/** Speak short transport acks and radio-length spoken replies (sentence-chunked). */
export function shouldSpeakVoiceReply(reply: string, maxChars = 900): boolean {
  if (voiceSpokenAck(reply)) return true;
  return reply.length <= maxChars;
}
