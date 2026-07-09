/**
 * Voice under music + progressive enhancement (V1 / H4).
 * Pure helpers for smoke tests and admin check API — no live TS required.
 */

import { extractWatchwordCommand } from "./watchword.js";

export interface UnderMusicConfig {
  duckMusicOnSpeech: boolean;
  duckMusicVolume: number;
  listenWindowMs: number;
  textWakeFallback: boolean;
  watchword: string;
}

export interface UnderMusicPlan {
  duckActive: boolean;
  duckLevel: number;
  listenWindowMs: number;
  /** How wake is accepted when KWS is unavailable. */
  progressiveWake: "text-fallback" | "kws-only" | "armed-followup";
  textFallbackAlwaysWorks: boolean;
  notes: string[];
}

export function defaultUnderMusicConfig(partial?: Partial<UnderMusicConfig>): UnderMusicConfig {
  return {
    duckMusicOnSpeech: partial?.duckMusicOnSpeech !== false,
    duckMusicVolume: clamp(
      partial?.duckMusicVolume === undefined ||
        partial.duckMusicVolume === 2 ||
        partial.duckMusicVolume === 25
        ? 20
        : partial.duckMusicVolume,
      0,
      100,
    ),
    listenWindowMs: Math.max(15_000, partial?.listenWindowMs ?? 15_000),
    textWakeFallback: partial?.textWakeFallback !== false,
    watchword: (partial?.watchword ?? "moneypenny").toLowerCase(),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Operator-facing plan: duck + listen window + progressive text wake. */
export function planUnderMusicCapture(cfg: UnderMusicConfig): UnderMusicPlan {
  const notes: string[] = [];
  if (cfg.duckMusicOnSpeech) {
    notes.push(`Music ducks to volume ${cfg.duckMusicVolume} while listening.`);
  } else {
    notes.push("Duck is off — STT under DJ load will struggle.");
  }
  notes.push(`Post-wake listen window ${cfg.listenWindowMs}ms (min 15s).`);
  if (cfg.textWakeFallback) {
    notes.push("Text wake fallback ON — “Moneypenny pause” works without KWS (Whisper path).");
  } else {
    notes.push("Text wake fallback OFF — requires KWS or armed follow-up.");
  }
  notes.push("Typed/chat commands always work as text fallback for transport.");

  return {
    duckActive: cfg.duckMusicOnSpeech,
    duckLevel: cfg.duckMusicVolume,
    listenWindowMs: cfg.listenWindowMs,
    progressiveWake: cfg.textWakeFallback ? "text-fallback" : "kws-only",
    textFallbackAlwaysWorks: true,
    notes,
  };
}

export interface UnderMusicTurnResult {
  transcript: string;
  matched: boolean;
  command: string;
  path: "text-wake" | "kws" | "armed" | "none";
  /** Would music be ducked for this capture path? */
  wouldDuck: boolean;
  /** Safe chat/text equivalent when voice fails. */
  textFallbackCommand: string | null;
}

/**
 * Simulate one under-music voice turn using the real watchword extractor.
 * Progressive: text wake works without KWS; armed follow-ups work after wake.
 */
export function simulateUnderMusicTurn(
  transcript: string,
  cfg: UnderMusicConfig,
  opts?: { kwsDetected?: boolean; armed?: boolean },
): UnderMusicTurnResult {
  const text = transcript.trim();
  const match = extractWatchwordCommand(text, cfg.watchword, {
    textWakeFallback: cfg.textWakeFallback,
    kwsDetected: opts?.kwsDetected,
    armed: opts?.armed,
  });

  let path: UnderMusicTurnResult["path"] = "none";
  if (match.matched) {
    if (opts?.kwsDetected) path = "kws";
    else if (opts?.armed && !cfg.textWakeFallback) path = "armed";
    else if (opts?.armed && !text.toLowerCase().includes(cfg.watchword)) path = "armed";
    else if (cfg.textWakeFallback) path = "text-wake";
    else path = "armed";
  }

  const command = match.matched ? match.command.trim() : "";
  const wouldDuck = cfg.duckMusicOnSpeech && match.matched;
  // Progressive text fallback: bare transport verbs via chat always work.
  const textFallbackCommand =
    command ||
    (opts?.armed ? text : null) ||
    (!match.matched && /^(pause|skip|stop|resume|next|prev)\b/i.test(text) ? text : null);

  return {
    transcript: text,
    matched: match.matched,
    command,
    path,
    wouldDuck,
    textFallbackCommand: textFallbackCommand?.trim() || null,
  };
}

export interface UnderMusicSmokeCase {
  id: string;
  transcript: string;
  kwsDetected?: boolean;
  armed?: boolean;
  expectMatched: boolean;
  expectCommandIncludes?: string;
  expectPath?: UnderMusicTurnResult["path"];
}

/** Default smoke cases for V1 under-music reliability (unit-driven). */
export const UNDER_MUSIC_SMOKE_CASES: UnderMusicSmokeCase[] = [
  {
    id: "text-wake-pause",
    transcript: "Moneypenny pause",
    expectMatched: true,
    expectCommandIncludes: "pause",
    expectPath: "text-wake",
  },
  {
    id: "text-wake-skip",
    transcript: "Moneypenny skip",
    expectMatched: true,
    expectCommandIncludes: "skip",
    expectPath: "text-wake",
  },
  {
    id: "armed-followup",
    transcript: "pause",
    armed: true,
    expectMatched: true,
    expectCommandIncludes: "pause",
    expectPath: "armed",
  },
  {
    id: "banter-no-wake",
    transcript: "I need to pause and think",
    expectMatched: false,
    expectPath: "none",
  },
  {
    id: "kws-path",
    transcript: "skip",
    kwsDetected: true,
    expectMatched: true,
    expectCommandIncludes: "skip",
    expectPath: "kws",
  },
];

export interface UnderMusicSmokeReport {
  ok: boolean;
  plan: UnderMusicPlan;
  results: Array<UnderMusicTurnResult & { id: string; pass: boolean; reason?: string }>;
}

export function runUnderMusicSmoke(
  cfg?: Partial<UnderMusicConfig>,
  cases: UnderMusicSmokeCase[] = UNDER_MUSIC_SMOKE_CASES,
): UnderMusicSmokeReport {
  const full = defaultUnderMusicConfig(cfg);
  const plan = planUnderMusicCapture(full);
  const results = cases.map((c) => {
    // Armed-only cases should not require text wake on the bare verb path.
    const caseCfg =
      c.armed && !c.transcript.toLowerCase().includes(full.watchword)
        ? { ...full, textWakeFallback: false }
        : full;
    const r = simulateUnderMusicTurn(c.transcript, caseCfg, {
      kwsDetected: c.kwsDetected,
      armed: c.armed,
    });
    let pass = r.matched === c.expectMatched;
    let reason: string | undefined;
    if (pass && c.expectCommandIncludes) {
      pass = r.command.toLowerCase().includes(c.expectCommandIncludes.toLowerCase());
      if (!pass) reason = `command "${r.command}" missing "${c.expectCommandIncludes}"`;
    }
    if (pass && c.expectPath) {
      pass = r.path === c.expectPath;
      if (!pass) reason = `path ${r.path} !== ${c.expectPath}`;
    }
    if (!pass && !reason) reason = `matched=${r.matched} expected=${c.expectMatched}`;
    return { id: c.id, ...r, pass, reason };
  });
  return {
    ok: results.every((r) => r.pass),
    plan,
    results,
  };
}
