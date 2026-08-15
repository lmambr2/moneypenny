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

/**
 * True when the chat payload is (or is mostly) an image / binary paste rather
 * than roastable prose. TeamSpeak clients sometimes paste pictures as
 * data-URLs, raw base64, or [img]…[/img] — those must never reach the LLM.
 */
export function looksLikeImageOrBinaryPayload(raw: string): boolean {
  const s = raw.replace(/\r\n/g, "\n").trim();
  if (!s) return false;

  // Explicit media markers (case-insensitive).
  if (/data:image\//i.test(s)) return true;
  if (/\[img[\s=\]]/i.test(s)) return true;
  if (/\b(?:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml)|application\/octet-stream)\b/i.test(s)) {
    return true;
  }

  // Common base64 magic for image formats (with optional data-url wrapper stripped).
  const compact = s.replace(/\s+/g, "");
  const b64Body = compact.replace(/^data:[^;]+;base64,/i, "");
  if (/^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|Qk[0-9A-Za-z]|PHN2Zy|AAABAA)/.test(b64Body)) {
    return true;
  }

  // Long high-entropy base64-ish blob with little real prose.
  if (b64Body.length >= 48) {
    const b64Chars = (b64Body.match(/[A-Za-z0-9+/=]/g) ?? []).length;
    const ratio = b64Chars / b64Body.length;
    if (ratio >= 0.92) {
      const spaces = (s.match(/\s/g) ?? []).length;
      const wordTokens = s.split(/\s+/).filter((w) => /[a-zA-Z]{3,}/.test(w));
      // Real chat has words/spaces; raw image data does not.
      if (spaces / Math.max(s.length, 1) < 0.06 && wordTokens.length < 4) return true;
    }
    // Any single run of 80+ base64 chars is almost never a chat message.
    if (/[A-Za-z0-9+/]{80,}={0,2}/.test(b64Body)) return true;
  }

  return false;
}

/**
 * Strip TS BBCode / collapse whitespace; cap length for the grader.
 * Returns "" when the line is image/binary raw data (not roastable text).
 */
/** Strip a chat prefix + ask/analyst verb so we store the question, not `!ask`. */
export function roastQuestionFromInput(raw: string, prefix = "!"): string {
  let t = sanitizeRoastCapture(raw, 280);
  if (!t) return "";
  if (prefix && t.startsWith(prefix)) t = t.slice(prefix.length).trim();
  t = t.replace(/^(ask|analyst|agent|intsum|aar)\b[\s,:]*/i, "").trim();
  return t;
}

export function formatRoastExchange(userName: string, question: string, reply: string): string {
  return `${userName}: ${question}\nMoneypenny: ${reply}`;
}

/** Skip transport acks, usage, and the reel itself — those are not roastable. */
export function isRoastableBotReply(reply: string): boolean {
  const t = reply.replace(/\s+/g, " ").trim();
  if (t.length < 8) return false;
  if (/^🔥\s*Roast reel/i.test(t)) return false;
  return !/^(usage:|unknown command|you don't have permission|the local llm is not|analyst delegation is not|analyst on it|drafting —|error:|now playing|paused|resumed|stopped|skipped|added |up next|volume set|nothing is playing|queue |already paused|already playing|nothing to resume)/i.test(
    t,
  );
}

export function sanitizeRoastCapture(raw: string, maxLen = 400): string {
  if (looksLikeImageOrBinaryPayload(raw)) return "";

  let t = raw
    .replace(/\r\n/g, "\n")
    .replace(/\[img[^\]]*\][\s\S]*?\[\/img\]/gi, " ") // drop image embeds entirely
    .replace(/\[\/?[a-z0-9=_\-#]+\]/gi, " ") // [url] [b] etc.
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Re-check after stripping — leftover base64 body with tags removed.
  if (looksLikeImageOrBinaryPayload(t)) return "";

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
    this.recordQuote(msg.invokerUid, msg.invokerName || "someone", text);
  }

  /**
   * Capture a user question to Moneypenny plus her reply (chat `!ask` / voice /
   * fuzzy `!…`). Attributed to the human so opt-out still purges the pair.
   */
  captureExchange(opts: {
    userUid?: string;
    userName?: string;
    question: string;
    reply: string;
  }): void {
    if (!this.deps.config.roastEnabled) return;
    const uid = opts.userUid?.trim();
    if (!uid) return;
    const question = sanitizeRoastCapture(opts.question, 280);
    const reply = sanitizeRoastCapture(opts.reply, 280);
    if (!question || question.length < 3) return;
    if (!isRoastableBotReply(reply)) return;
    const name = (opts.userName || "someone").trim() || "someone";
    const text = formatRoastExchange(name, question, reply);
    this.recordQuote(uid, name, text);
  }

  private recordQuote(userUid: string, userName: string, text: string): void {
    try {
      if (this.deps.store.isOptedOut(userUid)) return;
      if (this.deps.store.hasRecentDuplicate(userUid, text, ROAST_DEDUPE_WINDOW_MS)) return;
      this.deps.store.add(userUid, userName, text);
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
      "a chat line — or a user/Moneypenny Q&A exchange — is, from 0 (forgettable) " +
      "to 10 (maximally cringe). Include how dim the question is AND how arch or " +
      "savage her reply is. Reply with ONLY a JSON object: " +
      '{"score": <integer 0-10>, "reason": "<short reason>"}.';
    for (const q of batch) {
      try {
        // Legacy rows may still hold image/base64 pastes from before the filter.
        if (looksLikeImageOrBinaryPayload(q.text)) {
          this.deps.store.setGrade(q.id, 0, "non-text (image/binary)");
          continue;
        }
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
