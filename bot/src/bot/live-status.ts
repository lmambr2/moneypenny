/**
 * Member-safe live station snapshot (audit D1 — pulled off BotInstance façade).
 */

import type { PlayQueue, QueuedSong } from "../audio/queue.js";
import type { BotConfig } from "../data/config.js";
import { defaultBotScope, parseBotScope, resolveScope } from "./scope.js";

export type LiveStatusSnapshot = {
  connected: boolean;
  nowPlaying: { name: string; artist?: string } | null;
  queue: Array<{ name: string; artist?: string }>;
  radio: {
    enabled: boolean;
    activeProfile: string;
    songsUntilBumper: number | null;
    cuePending: boolean;
    nextBumperHint: string;
  } | null;
  voice: { enabled: boolean; duckOnSpeech: boolean; karaokeMode: boolean };
  rag: { enabled: boolean };
  /** Human-readable station feedback (radio/voice/rag/queue). */
  feedback: string[];
  scope: ReturnType<typeof resolveScope>;
};

export type LiveStatusDeps = {
  connected: boolean;
  name: string;
  config: BotConfig;
  queue: PlayQueue;
  radio: {
    status: () => { songsUntilBumper: number | null; cuePending: boolean };
  };
};

export function buildLiveStatus(deps: LiveStatusDeps): LiveStatusSnapshot {
  const scope = resolveScope(parseBotScope(deps.config.scope ?? defaultBotScope()), {
    botName: deps.name,
  });
  const cur = deps.queue.current();
  const q = deps.queue
    .list()
    .slice(0, 20)
    .map((s: QueuedSong) => ({ name: s.name, artist: s.artist }));
  let radio: LiveStatusSnapshot["radio"] = null;
  if (deps.config.radio) {
    const st = deps.radio.status();
    const hint =
      st.songsUntilBumper == null
        ? "Radio off or no every-N clock"
        : st.songsUntilBumper === 0
          ? "Bumper due next break"
          : `Next bumper in ${st.songsUntilBumper} track(s)`;
    radio = {
      enabled: !!deps.config.radio.enabled,
      activeProfile: deps.config.radio.activeProfile,
      songsUntilBumper: st.songsUntilBumper,
      cuePending: st.cuePending,
      nextBumperHint: hint,
    };
  }
  const voice = {
    enabled: !!deps.config.voice?.enabled,
    duckOnSpeech: deps.config.voice?.duckMusicOnSpeech !== false,
    karaokeMode: deps.config.voice?.karaokeMode === true,
  };
  const rag = { enabled: !!deps.config.ragEnabled };
  const feedback: string[] = [];
  feedback.push(deps.connected ? "TeamSpeak connected." : "TeamSpeak offline.");
  if (radio?.enabled) {
    feedback.push(radio.cuePending ? "Radio: bumper pending." : `Radio: ${radio.nextBumperHint}`);
  } else {
    feedback.push("Radio off.");
  }
  if (cur) {
    feedback.push(`Playing: ${cur.name}${cur.artist ? ` — ${cur.artist}` : ""}`);
  } else if (q.length === 0) {
    feedback.push("Queue empty — !play or enable radio.");
  } else {
    feedback.push(`Queue: ${q.length} track(s) waiting.`);
  }
  if (voice.enabled) {
    feedback.push(
      voice.karaokeMode
        ? "Voice on (karaoke — music stays loud while listening)."
        : voice.duckOnSpeech
          ? "Voice on (duck while listening)."
          : "Voice on (duck off — STT under music may struggle).",
    );
  } else {
    feedback.push("Voice loop off.");
  }
  feedback.push(rag.enabled ? "Doctrine RAG on." : "Doctrine RAG off.");
  return {
    connected: deps.connected,
    nowPlaying: cur ? { name: cur.name, artist: cur.artist } : null,
    queue: q,
    radio,
    voice,
    rag,
    feedback,
    scope,
  };
}
