import type { TS3Client, TS3TextMessage } from "@moneypenny/ts6-client";
import type { BotConfig } from "../../data/config.js";
import type { RoastQuote, RoastStore } from "../../data/roast.js";
import type { LlmModule } from "../../llm/index.js";
import type { Logger } from "../../logger.js";

export const ROAST_REEL_SIZE = 5;
export const ROAST_MIN_GRADED_FOR_AUTO = 3;
export const ROAST_MAX_PER_USER = 2;
export const ROAST_DEDUPE_WINDOW_MS = 5 * 60_000;

export function parseRoastGrade(raw: string): { score: number; reason: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { score?: unknown; reason?: unknown };
    const score = Number(o.score);
    if (!Number.isFinite(score)) return null;
    return { score, reason: String(o.reason ?? "").slice(0, 280) };
  } catch {
    return null;
  }
}

/** Pick reel lines: min score, diversity (max per user), highest cringe first. */
export function selectReelQuotes(
  quotes: RoastQuote[],
  opts: { limit?: number; minScore?: number; maxPerUser?: number } = {},
): RoastQuote[] {
  const limit = opts.limit ?? ROAST_REEL_SIZE;
  const minScore = opts.minScore ?? 4;
  const maxPerUser = opts.maxPerUser ?? ROAST_MAX_PER_USER;
  const sorted = quotes
    .filter((q) => q.score != null && q.score >= minScore)
    .sort((a, b) => b.score! - a.score! || b.createdAt - a.createdAt);

  const picked: RoastQuote[] = [];
  const perUser = new Map<string, number>();
  for (const q of sorted) {
    const n = perUser.get(q.userUid) ?? 0;
    if (n >= maxPerUser) continue;
    picked.push(q);
    perUser.set(q.userUid, n + 1);
    if (picked.length >= limit) break;
  }
  return picked;
}

export function formatRoastReel(quotes: RoastQuote[]): string | null {
  if (quotes.length === 0) return null;
  const lines = quotes.map(
    (q, i) =>
      `${i + 1}. ${q.userName} (${q.score}/10): "${q.text}"${q.reason ? ` — ${q.reason}` : ""}`,
  );
  return `🔥 Roast reel — today's greatest hits 🔥\n${lines.join("\n")}`;
}

export function roastCooldownRemainingMs(lastRoastAt: number, cooldownMinutes: number): number {
  const cooldownMs = cooldownMinutes * 60_000;
  return Math.max(0, cooldownMs - (Date.now() - lastRoastAt));
}

/** Strip TS BBCode / collapse whitespace; cap length for the grader. */
export function sanitizeRoastCapture(raw: string, maxLen = 400): string {
  let t = raw
    .replace(/\r\n/g, "\n")
    .replace(/\[\/?[a-z0-9=_\-#]+\]/gi, " ") // [url] [b] etc.
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > maxLen) t = t.slice(0, maxLen).trimEnd();
  return t;
}

export interface RoastServiceDeps {
  store: RoastStore;
  config: BotConfig;
  llm: () => LlmModule | null;
  tsClient: Pick<TS3Client, "sendTextMessage" | "getClientId">;
  logger: Logger;
}

/** Roast capture, LLM grading, and compilation reel (ROADMAP Phase 8). */
export class RoastService {
  private lastRoastAt = 0;
  private compiling = false;

  constructor(private deps: RoastServiceDeps) {
    this.lastRoastAt = deps.store.getLastRoastAt();
  }

  captureLine(msg: TS3TextMessage): void {
    if (!this.deps.config.roastEnabled) return;
    if (msg.targetMode === 1) return;
    if (msg.invokerId === String(this.deps.tsClient.getClientId())) return;
    const text = sanitizeRoastCapture(msg.message ?? "");
    if (!text || text.length < 3) return;
    if (text.startsWith(this.deps.config.commandPrefix)) return;
    if (!msg.invokerUid) return;
    try {
      if (this.deps.store.isOptedOut(msg.invokerUid)) return;
      if (this.deps.store.hasRecentDuplicate(msg.invokerUid, text, ROAST_DEDUPE_WINDOW_MS)) return;
      this.deps.store.add(msg.invokerUid, msg.invokerName || "someone", text);
    } catch (err) {
      this.deps.logger.debug({ err }, "Roast capture failed");
    }
  }

  async runTick(humanCount: number): Promise<void> {
    if (!this.deps.config.roastEnabled || this.compiling) return;
    this.compiling = true;
    try {
      await this.gradeBatch();
      await this.maybePost(humanCount);
    } catch (err) {
      this.deps.logger.debug({ err }, "Roast tick failed");
    } finally {
      this.compiling = false;
    }
  }

  buildReel(): string | null {
    const minScore = this.deps.config.roastMinScore ?? 4;
    const picks = selectReelQuotes(this.deps.store.top(40), {
      limit: ROAST_REEL_SIZE,
      minScore,
      maxPerUser: ROAST_MAX_PER_USER,
    });
    return formatRoastReel(picks);
  }

  async handleCommand(): Promise<string> {
    if (!this.deps.config.roastEnabled) {
      return "The roast is switched off. An admin can enable it in Settings.";
    }
    const reel = this.buildReel();
    if (reel) return reel;

    const minScore = this.deps.config.roastMinScore ?? 4;
    const stats = this.deps.store.stats(minScore);
    const pending = stats.ungraded;
    if (pending > 0) {
      return (
        `Nothing roast-worthy graded yet — ${pending} line${pending === 1 ? "" : "s"} still in the queue` +
        (stats.highEnough ? ` (${stats.highEnough} already ≥${minScore}).` : ".")
      );
    }

    if (stats.highEnough === 0) {
      return (
        `Nothing scored ${minScore}+ yet — keep chatting` +
        (stats.graded ? ` (${stats.graded} graded under the bar).` : ".")
      );
    }

    const remain = roastCooldownRemainingMs(
      this.lastRoastAt,
      this.deps.config.roastCooldownMinutes,
    );
    if (remain > 0) {
      const mins = Math.ceil(remain / 60_000);
      return `No reel ready (need score ≥${minScore}). Next auto reel in ~${mins} min.`;
    }

    return "Nothing roast-worthy graded yet — give it time.";
  }

  handleOptOut(invokerUid?: string): string {
    if (!invokerUid) return "Couldn't identify you — opt-out not applied.";
    const removed = this.deps.store.optOut(invokerUid);
    return `You're out of the roast. Purged ${removed} captured line${removed === 1 ? "" : "s"} and stopped recording you. Use !roastin to rejoin.`;
  }

  handleOptIn(invokerUid?: string): string {
    if (!invokerUid) return "Couldn't identify you — opt-in not applied.";
    if (!this.deps.store.isOptedOut(invokerUid)) {
      return "You're already in the roast — keep chatting (or !roastout to leave).";
    }
    this.deps.store.optIn(invokerUid);
    return "Welcome back to the roast. New lines will be captured; purged history stays gone.";
  }

  private async gradeBatch(): Promise<void> {
    const llm = this.deps.llm();
    if (!llm) return;
    const batch = this.deps.store.ungraded(5);
    if (batch.length === 0) return;
    const system =
      "You are a ruthless but witty roast judge. Score how cringe or embarrassing " +
      "a single chat line is, from 0 (forgettable) to 10 (maximally cringe). Reply " +
      'with ONLY a JSON object: {"score": <integer 0-10>, "reason": "<short reason>"}.';
    for (const q of batch) {
      try {
        const out = await llm.complete(
          `Chat line from ${q.userName}: ${JSON.stringify(q.text)}`,
          system,
        );
        if (!out) {
          this.deps.logger.debug({ id: q.id }, "Roast grader got no LLM response — skipping");
          continue;
        }
        const parsed = parseRoastGrade(out);
        if (parsed) this.deps.store.setGrade(q.id, parsed.score, parsed.reason);
        else this.deps.store.setGrade(q.id, 0, "ungradeable");
      } catch (err) {
        this.deps.logger.debug({ err, id: q.id }, "Roast grade failed for one line");
      }
    }
  }

  private async maybePost(humanCount: number): Promise<void> {
    if (humanCount < this.deps.config.roastMinPresent) return;

    const minScore = this.deps.config.roastMinScore ?? 4;
    if (this.deps.store.gradedCount(minScore) < ROAST_MIN_GRADED_FOR_AUTO) return;

    const remain = roastCooldownRemainingMs(
      this.lastRoastAt,
      this.deps.config.roastCooldownMinutes,
    );
    if (remain > 0) return;

    const picks = selectReelQuotes(this.deps.store.top(40), {
      limit: ROAST_REEL_SIZE,
      minScore,
      maxPerUser: ROAST_MAX_PER_USER,
    });
    const reel = formatRoastReel(picks);
    if (!reel) return;

    await this.deps.tsClient.sendTextMessage(reel);
    this.lastRoastAt = Date.now();
    this.deps.store.setLastRoastAt(this.lastRoastAt);
    this.deps.store.removeByIds(picks.map((q) => q.id));
  }
}
