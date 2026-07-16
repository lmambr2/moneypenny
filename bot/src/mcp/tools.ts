import type { BotConfig } from "../data/config.js";
import { profileAllows } from "./auth.js";
import { errEnvelope, okEnvelope, withBot } from "./bots.js";
import { buildPlayCommand, dispatchCommand, simpleCommand } from "./dispatch.js";
import type { McpContext, McpToolEnvelope } from "./types.js";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function platformArg(v: unknown): string | undefined {
  if (v === "local" || v === "youtube" || v === "stream") return v;
  return undefined;
}

// ─── Status ─────────────────────────────────────────────────────────────────

export async function statusHealth(
  _args: Record<string, unknown>,
  ctx: McpContext,
  appVersion = "0.1.0",
): Promise<McpToolEnvelope> {
  const bots = ctx.botManager.getAllBots();
  const summary = bots.map((b) => {
    const st = b.getStatus();
    return {
      id: st.id,
      name: st.name,
      connected: st.connected,
      playing: st.playing,
      paused: st.paused,
      queueSize: st.queueSize,
    };
  });
  return okEnvelope(ctx, "ok", {
    status: "ok",
    version: appVersion,
    mcp: { enabled: true, profile: ctx.subject.rightsProfile },
    bots: summary,
  });
}

export async function statusNowPlaying(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, (bot, botId) => {
    const st = bot.getStatus();
    const song = st.currentSong;
    return okEnvelope(
      ctx,
      song ? `Now playing: ${song.name}` : "Nothing playing",
      {
        connected: st.connected,
        playing: st.playing,
        paused: st.paused,
        volume: st.volume,
        playMode: st.playMode,
        elapsed: st.elapsed,
        queueSize: st.queueSize,
        current: song
          ? {
              id: song.id,
              title: song.name,
              artist: song.artist,
              platform: song.platform,
              url: song.url,
            }
          : null,
      },
      botId,
    );
  });
}

export async function statusQueue(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, (bot, botId) => {
    const limitRaw = args.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.min(100, Math.max(1, Math.floor(limitRaw)))
        : 30;
    const queue = bot.getQueue().slice(0, limit);
    const st = bot.getStatus();
    return okEnvelope(
      ctx,
      `Queue size ${st.queueSize}`,
      {
        size: st.queueSize,
        mode: st.playMode,
        items: queue.map((s, i) => ({
          index: i,
          id: s.id,
          title: s.name,
          artist: s.artist,
          platform: s.platform,
        })),
      },
      botId,
    );
  });
}

export async function statusRadio(
  _args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, undefined, (bot, botId) => {
    let status: unknown = null;
    try {
      status = bot.getRadioStatus();
    } catch {
      status = null;
    }
    return okEnvelope(ctx, "ok", { radio: status }, botId);
  });
}

export async function statusRag(
  _args: Record<string, unknown>,
  ctx: McpContext,
  config: BotConfig,
): Promise<McpToolEnvelope> {
  return withBot(ctx, undefined, async (bot, botId) => {
    try {
      const status = await bot.getRagStatus();
      return okEnvelope(ctx, "ok", status, botId);
    } catch {
      return okEnvelope(
        ctx,
        "ok",
        {
          configured: config.ragEnabled ?? false,
          available: false,
          vectorDbUrl: config.vectorDbUrl ?? "",
          embeddingModel: config.embeddingModel ?? "",
        },
        botId,
      );
    }
  });
}

// ─── Music ──────────────────────────────────────────────────────────────────

async function musicVerb(
  verb: "play" | "add" | "playnext",
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const query = str(args.query);
  if (!query) return errEnvelope(ctx, "VALIDATION_ERROR", "query is required");

  return withBot(ctx, args.bot_id, async (bot, botId) => {
    if (args.dry_run === true) {
      return okEnvelope(
        ctx,
        `[dry-run] would ${verb}: ${query}`,
        { dry_run: true, verb, query, platform: platformArg(args.platform) },
        botId,
      );
    }
    const cmd = buildPlayCommand(verb, query, platformArg(args.platform));
    if (!cmd) return errEnvelope(ctx, "VALIDATION_ERROR", "Invalid command", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export const musicPlay = (a: Record<string, unknown>, c: McpContext) => musicVerb("play", a, c);
export const musicAdd = (a: Record<string, unknown>, c: McpContext) => musicVerb("add", a, c);
export const musicPlayNext = (a: Record<string, unknown>, c: McpContext) =>
  musicVerb("playnext", a, c);

export async function musicSkip(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("next");
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export async function musicPause(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("pause");
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export async function musicResume(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("resume");
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export async function musicBan(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const query = str(args.query);
    const cmd = simpleCommand("ban", query);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export async function musicUnban(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const query = str(args.query);
  if (!query) return errEnvelope(ctx, "VALIDATION_ERROR", "query is required for unban");
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("unban", query);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

// ─── RAG ────────────────────────────────────────────────────────────────────

export async function ragSearch(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  if (!profileAllows(ctx.subject, "dj")) {
    return errEnvelope(ctx, "PERMISSION_DENIED", "rag_search requires dj+ profile");
  }
  const q = str(args.q) || str(args.question);
  if (!q) return errEnvelope(ctx, "VALIDATION_ERROR", "q is required");

  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const topK =
      typeof args.top_k === "number" && Number.isInteger(args.top_k) ? args.top_k : undefined;
    const allowed = Array.isArray(args.allowed_classifications)
      ? args.allowed_classifications.filter((c): c is string => typeof c === "string")
      : undefined;
    try {
      const chunks = await bot.queryRag(q, topK, allowed);
      if (chunks == null) {
        return errEnvelope(ctx, "RAG_ERROR", "Knowledge base is off or not configured", botId);
      }
      return okEnvelope(ctx, `Found ${chunks.length} chunk(s)`, { q, chunks }, botId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "query failed";
      return errEnvelope(ctx, "RAG_ERROR", msg, botId);
    }
  });
}

export async function ragAsk(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  if (!profileAllows(ctx.subject, "dj")) {
    return errEnvelope(ctx, "PERMISSION_DENIED", "rag_ask requires dj+ profile");
  }
  const question = str(args.question) || str(args.q);
  if (!question) return errEnvelope(ctx, "VALIDATION_ERROR", "question is required");

  return withBot(ctx, args.bot_id, async (bot, botId) => {
    try {
      const turn = await bot.runHarnessTurn(question, { mode: "ask" });
      if (turn.error === "LLM is not enabled") {
        return errEnvelope(ctx, "LLM_DISABLED", turn.error, botId);
      }
      const includeSources = args.include_sources !== false;
      return okEnvelope(
        ctx,
        turn.reply?.slice(0, 200) || turn.error || "ok",
        {
          reply: turn.reply,
          sources: includeSources ? turn.sources : undefined,
          error: turn.error ?? null,
          turnId: turn.id,
        },
        botId,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "ask failed";
      return errEnvelope(ctx, "RAG_ERROR", msg, botId);
    }
  });
}

export async function harnessTurn(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  if (!profileAllows(ctx.subject, "admin")) {
    return errEnvelope(ctx, "PERMISSION_DENIED", "harness_turn requires admin profile");
  }
  const question = str(args.question) || str(args.q);
  if (!question) return errEnvelope(ctx, "VALIDATION_ERROR", "question is required");
  const mode = args.mode === "intent" ? "intent" : "ask";
  const dryRun = args.dry_run === true;
  const allowDangerous = args.allow_dangerous === true;

  return withBot(ctx, args.bot_id, async (bot, botId) => {
    try {
      const turn = await bot.runHarnessTurn(question, { mode, dryRun, allowDangerous });
      if (turn.error === "LLM is not enabled") {
        return errEnvelope(ctx, "LLM_DISABLED", turn.error, botId);
      }
      return okEnvelope(ctx, turn.reply?.slice(0, 200) || "ok", { turn }, botId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "harness failed";
      return errEnvelope(ctx, "HARNESS_ERROR", msg, botId);
    }
  });
}
