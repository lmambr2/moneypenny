import express from "express";
import type { BotManager } from "../../bot/manager.js";
import {
  completeTurn,
  disposeToolProposals,
  resolveBrainTransport,
  type TurnMode,
  type TurnRequest,
} from "../../brain/index.js";
import { requireAdmin } from "../../web/middleware/requireAdmin.js";
import { createRequireAuth } from "../../web/middleware/requireAuth.js";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/**
 * Phase D — `POST /v1/turn` (docs/brain-boundary.md).
 * Admin session auth. Brain proposes; optional `executeTools: true` disposes on bot.
 * Music transport is never blocked by this route (caller is dashboard/agent).
 */
export const registerBrainTurn: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options, sessions, logger } = ctx;
  const requireAuth = createRequireAuth(sessions);

  app.post(
    "/v1/turn",
    express.json({ limit: "256kb" }),
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const body = req.body ?? {};
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        res.status(400).json({ error: "text is required" });
        return;
      }

      const mode: TurnMode = body.mode === "intent" || body.mode === "delegate" ? body.mode : "ask";
      const channel =
        body.channel === "teamspeak" || body.channel === "voice" || body.channel === "dashboard"
          ? body.channel
          : "dashboard";

      const turnReq: TurnRequest = {
        clientTurnId: typeof body.clientTurnId === "string" ? body.clientTurnId : undefined,
        channel,
        text,
        conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
        subject:
          body.subject && typeof body.subject === "object"
            ? {
                uid: typeof body.subject.uid === "string" ? body.subject.uid : undefined,
                serverGroups: Array.isArray(body.subject.serverGroups)
                  ? body.subject.serverGroups.filter((g: unknown) => typeof g === "string")
                  : undefined,
                allowedClassifications: Array.isArray(body.subject.allowedClassifications)
                  ? body.subject.allowedClassifications.filter(
                      (g: unknown) => typeof g === "string",
                    )
                  : undefined,
              }
            : undefined,
        mode,
        options: {
          includeSources: body.options?.includeSources !== false,
          maxTools: typeof body.options?.maxTools === "number" ? body.options.maxTools : undefined,
        },
      };

      const bot = pickBot(options.botManager);
      if (!bot) {
        res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
        return;
      }

      try {
        const transport = resolveBrainTransport({
          brainUrl: process.env.BRAIN_URL,
          inProcess: {
            llm: bot.getLlmModuleForBrain(),
            retrieve: (q) => bot.retrieveForBrain(q),
          },
        });

        const result = await completeTurn(turnReq, transport);

        // Default: return proposals only (brain proposes). Opt-in dispose for harness-like use.
        if (body.executeTools === true && result.toolProposals.length > 0) {
          const disposed = await disposeToolProposals(result.toolProposals, (name, args) =>
            bot.disposeBrainTool(name, args, {
              dryRun: body.dryRun === true,
              allowDangerous: body.allowDangerous === true,
            }),
          );
          res.json({
            ...result,
            disposedTools: disposed,
          });
          return;
        }

        if (result.error === "LLM is not enabled") {
          res.status(409).json({ ...result, code: "LLM_DISABLED" });
          return;
        }

        res.json(result);
      } catch (err) {
        logger.error({ err }, "POST /v1/turn failed");
        res.status(503).json({
          turnId: `err-${Date.now()}`,
          clientTurnId: turnReq.clientTurnId,
          replyText: "",
          sources: [],
          toolProposals: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
};

function pickBot(botManager: BotManager) {
  return botManager.getAllBots()[0] ?? null;
}
