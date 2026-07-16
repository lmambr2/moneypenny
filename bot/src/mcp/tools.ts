import type { BotConfig } from "../data/config.js";
import { profileAllows } from "./auth.js";
import { errEnvelope, okEnvelope, withBot } from "./bots.js";
import { checkConfirm } from "./confirm.js";
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
    const blocked = checkConfirm(ctx, "music_ban", args, botId);
    if (blocked) return blocked;
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

export async function musicStop(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const blocked = checkConfirm(ctx, "music_stop", args, botId);
    if (blocked) return blocked;
    const cmd = simpleCommand("stop");
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "admin");
  });
}

export async function musicClear(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const blocked = checkConfirm(ctx, "music_clear", args, botId);
    if (blocked) return blocked;
    const cmd = simpleCommand("clear");
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "admin");
  });
}

export async function musicVolume(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const volume = args.volume;
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 100) {
    return errEnvelope(ctx, "VALIDATION_ERROR", "volume must be a number between 0 and 100");
  }
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("vol", String(Math.round(volume)));
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    // Matches COMMAND_MANIFEST: vol is admin-tier.
    return dispatchCommand(ctx, bot, botId, cmd, "admin");
  });
}

const VALID_MODES = new Set(["seq", "loop", "random", "rloop"]);

export async function musicMode(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const mode = str(args.mode);
  if (!VALID_MODES.has(mode)) {
    return errEnvelope(ctx, "VALIDATION_ERROR", "mode must be one of: seq, loop, random, rloop");
  }
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("mode", mode);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "admin");
  });
}

export async function musicHistory(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  if (!profileAllows(ctx.subject, "readonly")) {
    return errEnvelope(ctx, "PERMISSION_DENIED", "music_history requires readonly+ profile");
  }
  return withBot(ctx, args.bot_id, (bot, botId) => {
    const limitRaw = args.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.min(200, Math.max(1, Math.floor(limitRaw)))
        : 50;
    try {
      const records = bot.getPlayHistoryRecords(limit);
      return okEnvelope(
        ctx,
        `${records.length} history item(s)`,
        {
          history: records.map((r) => ({
            id: r.songId,
            name: r.songName,
            artist: r.artist,
            album: r.album,
            platform: r.platform,
            playedAt: r.playedAt,
            coverUrl: r.coverUrl,
          })),
        },
        botId,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "history failed";
      return errEnvelope(ctx, "INTERNAL", msg, botId);
    }
  });
}

// ─── Radio ──────────────────────────────────────────────────────────────────

export async function radioSet(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  // Subcommands like "on"/"off" need admin rights tokens; profile gate at admin.
  const sub = str(args.args) || str(args.command) || str(args.subcommand);
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    if (args.dry_run === true) {
      return okEnvelope(ctx, `[dry-run] would radio ${sub || "(status)"}`, {
        dry_run: true,
        args: sub,
      }, botId);
    }
    const cmd = simpleCommand("radio", sub);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "admin");
  });
}

// ─── Doctrine / knowledge ───────────────────────────────────────────────────

export async function doctrineList(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  if (!profileAllows(ctx.subject, "dj")) {
    return errEnvelope(ctx, "PERMISSION_DENIED", "doctrine_list requires dj+ profile");
  }
  return withBot(ctx, args.bot_id, (bot, botId) => {
    try {
      const docs = bot.listDoctrineDocs();
      return okEnvelope(ctx, `${docs.length} doctrine doc(s)`, { docs }, botId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "list failed";
      return errEnvelope(ctx, "RAG_ERROR", msg, botId);
    }
  });
}

export async function doctrineReindex(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const sources = Array.isArray(args.sources)
    ? args.sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : str(args.source)
      ? [str(args.source)]
      : [];
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    if (args.dry_run === true) {
      return okEnvelope(
        ctx,
        `[dry-run] would reindex ${sources.length ? sources.join(", ") : "all"}`,
        { dry_run: true, sources },
        botId,
      );
    }
    const cmd = simpleCommand("reindex", sources.join(" "));
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "admin");
  });
}

export async function doctrineIngestStatus(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("ingeststatus");
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "admin");
  });
}

// ─── Memory ─────────────────────────────────────────────────────────────────

export async function memoryRemember(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const fact = str(args.fact) || str(args.text);
  if (!fact) return errEnvelope(ctx, "VALIDATION_ERROR", "fact is required");
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("remember", fact);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export async function memoryRecall(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("recall");
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export async function memoryForget(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const which = str(args.which) || str(args.args) || str(args.index);
  if (!which) {
    return errEnvelope(ctx, "VALIDATION_ERROR", "which is required (index or 'all')");
  }
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("forget", which);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

// ─── Harness history ────────────────────────────────────────────────────────

export async function harnessTurns(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  if (!profileAllows(ctx.subject, "admin")) {
    return errEnvelope(ctx, "PERMISSION_DENIED", "harness_turns requires admin profile");
  }
  return withBot(ctx, args.bot_id, (bot, botId) => {
    const limitRaw = args.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.min(50, Math.max(1, Math.floor(limitRaw)))
        : 30;
    try {
      const turns = bot.listHarnessTurns(limit);
      return okEnvelope(ctx, `${turns.length} turn(s)`, { turns }, botId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "list failed";
      return errEnvelope(ctx, "HARNESS_ERROR", msg, botId);
    }
  });
}

// ─── Phase 3: economy / generate / moderation ───────────────────────────────

const ECON_COMMANDS = new Set(["mine", "refine", "craft", "econ", "trade"]);

export async function econRun(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const command = str(args.command).toLowerCase();
  if (!ECON_COMMANDS.has(command)) {
    return errEnvelope(
      ctx,
      "VALIDATION_ERROR",
      "command must be one of: mine, refine, craft, econ, trade",
    );
  }
  const rest = str(args.args);
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    if (args.dry_run === true) {
      return okEnvelope(ctx, `[dry-run] would !${command} ${rest}`.trim(), {
        dry_run: true,
        command,
        args: rest,
      }, botId);
    }
    const cmd = simpleCommand(command, rest);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export async function workorderRun(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const rest = str(args.args) || str(args.command);
  // clear-all is destructive — admin profile only when args look like clear
  const needsAdmin = /\bclear\b/i.test(rest);
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    if (args.dry_run === true) {
      return okEnvelope(ctx, `[dry-run] would !workorder ${rest}`.trim(), {
        dry_run: true,
        args: rest,
      }, botId);
    }
    const cmd = simpleCommand("workorder", rest);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, needsAdmin ? "admin" : "dj");
  });
}

export async function workItems(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const cmd = simpleCommand("work-items");
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export async function generateMusic(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  const prompt = str(args.prompt) || str(args.query) || str(args.args);
  if (!prompt) return errEnvelope(ctx, "VALIDATION_ERROR", "prompt is required");
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    if (args.dry_run === true) {
      return okEnvelope(ctx, `[dry-run] would generate: ${prompt}`, {
        dry_run: true,
        prompt,
      }, botId);
    }
    const cmd = simpleCommand("generate", prompt);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    // DJ+ profile; rights engine still checks generate token via admin web mapping
    return dispatchCommand(ctx, bot, botId, cmd, "dj");
  });
}

export async function modMute(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  if (!ctx.config.enableModeration) {
    return errEnvelope(
      ctx,
      "PERMISSION_DENIED",
      "Moderation tools disabled (set MCP_ENABLE_MODERATION=1)",
    );
  }
  const target = str(args.target) || str(args.nickname) || str(args.args);
  if (!target) return errEnvelope(ctx, "VALIDATION_ERROR", "target is required");
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const blocked = checkConfirm(ctx, "mod_mute", args, botId);
    if (blocked) return blocked;
    const cmd = simpleCommand("mute", target);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "admin");
  });
}

export async function modKick(
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolEnvelope> {
  if (!ctx.config.enableModeration) {
    return errEnvelope(
      ctx,
      "PERMISSION_DENIED",
      "Moderation tools disabled (set MCP_ENABLE_MODERATION=1)",
    );
  }
  const target = str(args.target) || str(args.nickname) || str(args.args);
  if (!target) return errEnvelope(ctx, "VALIDATION_ERROR", "target is required");
  return withBot(ctx, args.bot_id, async (bot, botId) => {
    const blocked = checkConfirm(ctx, "mod_kick", args, botId);
    if (blocked) return blocked;
    const cmd = simpleCommand("kick", target);
    if (!cmd) return errEnvelope(ctx, "INTERNAL", "parse failed", botId);
    return dispatchCommand(ctx, bot, botId, cmd, "admin");
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
