/**
 * LLM decision execution (PR-A4): ask / intent / delegate / workflow.
 * Extracted from ControlRouter so the router stays a thin orchestrator.
 */
import {
  type AnalystRequest,
  appendAnalystSaveNotice,
  parseAnalystCommand,
} from "../docs/analyst.js";
import {
  buildWorkflowTask,
  formatWorkflowFollowUp,
  parseWorkflowCommand,
  WORKFLOW_ACK_MESSAGE,
  type WorkflowRequest,
} from "../docs/workflow.js";
import {
  DELEGATE_ACK_MESSAGE,
  DELEGATE_TOOL_NAME,
  formatDelegateFollowUp,
} from "../llm/delegate.js";
import type { Logger } from "../logger.js";
import type { ClarifyService } from "./clarify-service.js";
import { clarifyPendingKey } from "./clarify-service.js";
import type { CommandRegistry } from "./registry.js";
import type { LlmAssist, LlmIntent, RouterContext, RouterDecision } from "./router.js";

export type ResolveMusicFn = (
  cmd: import("../bot/commands.js").ParsedCommand,
  context: RouterContext,
) => Promise<RouterDecision["resolvedMusic"]>;

export type ExecuteDeterministicFn = (
  decision: RouterDecision,
  context: RouterContext,
) => Promise<string | null>;

export interface LlmPathDeps {
  llm: LlmAssist;
  logger: Logger;
  registry: CommandRegistry;
  clarify: ClarifyService;
  resolveMusicForCommand: ResolveMusicFn;
  executeDeterministic: ExecuteDeterministicFn;
}

/** Handle the LLM decision: Q&A for `ask`, tool-driven control for `intent`. */
export async function executeLlmPath(
  intent: LlmIntent,
  context: RouterContext,
  deps: LlmPathDeps,
): Promise<string | null> {
  if (intent.mode === "ask") {
    if (context.canRun && !context.canRun("ask")) {
      return "You don't have permission to use 'ask'.";
    }
    if (!intent.text) return "Usage: !ask <question>";
    return deps.llm.ask(intent.text, context.conversationId, {
      allowedClassifications: context.allowedClassifications,
      userUid: context.invokerUid,
    });
  }

  if (intent.mode === "delegate") {
    if (context.canRun && !context.canRun("analyst")) {
      return "You don't have permission to use 'analyst'.";
    }
    const parsed = parseAnalystCommand({
      args: intent.text ?? "",
      flags: intent.delegateFlags ?? new Set(),
    });
    if ("error" in parsed) return parsed.error;
    if (deps.llm.isDelegateConfigured && !deps.llm.isDelegateConfigured()) {
      return "Analyst delegation is not configured. Set a delegate URL in Settings.";
    }
    return runDelegate(parsed, undefined, context, deps);
  }

  if (intent.mode === "workflow") {
    const kind = intent.workflowKind ?? "intsum";
    if (context.canRun && !context.canRun(kind)) {
      return `You don't have permission to use '${kind}'.`;
    }
    if (deps.llm.isDelegateConfigured && !deps.llm.isDelegateConfigured()) {
      return "Analyst delegation is not configured. Set a delegate URL in Settings.";
    }
    const parsed = parseWorkflowCommand(kind, {
      args: intent.text ?? "",
      flags: intent.workflowFlags ?? new Set(),
    });
    if ("error" in parsed) return parsed.error;
    return runWorkflow(parsed, context, deps);
  }

  // mode === "intent"
  return executeIntent(intent.text, context, deps);
}

async function executeIntent(
  text: string,
  context: RouterContext,
  deps: LlmPathDeps,
): Promise<string | null> {
  if (!text) return null;

  const moveClientEnabled = !context.canRun || context.canRun("moveclient");
  const result = await deps.llm.chatForIntent(text, context.conversationId, {
    moveClientEnabled,
  });
  const toolCalls = result.toolCalls ?? [];

  if (toolCalls.length === 0) {
    return result.content;
  }

  try {
    const pendingKey = clarifyPendingKey(
      context.conversationId,
      context.invokerUid,
      context.invokerName,
    );
    const decision = deps.clarify.evaluate(pendingKey, toolCalls);
    if (decision.action === "clarify") {
      return decision.question;
    }
  } catch {
    /* fail-open */
  }

  const outputs: string[] = [];
  for (const tc of toolCalls) {
    if (tc.name === DELEGATE_TOOL_NAME) {
      const task = String(tc.arguments?.task ?? "").trim();
      const extra = String(tc.arguments?.context ?? "").trim();
      if (!task) continue;
      if (context.canRun && !context.canRun("analyst")) {
        outputs.push("You don't have permission to delegate to the analyst.");
        continue;
      }
      const req: AnalystRequest = { task, save: false, classification: "restricted" };
      const out = await runDelegate(req, extra || undefined, context, deps);
      if (out) outputs.push(out);
      continue;
    }
    const cmd = deps.registry.mapToolCall(tc);
    if (!cmd) {
      deps.logger.warn({ tool: tc.name }, "LLM emitted an unknown/unmapped tool call");
      continue;
    }
    try {
      const resolvedMusic = await deps.resolveMusicForCommand(cmd, context);
      const out = await deps.executeDeterministic(
        { type: "deterministic", command: cmd, resolvedMusic },
        context,
      );
      if (out) outputs.push(out);
    } catch (err) {
      deps.logger.warn({ err, tool: tc.name }, "LLM tool execution failed");
      outputs.push(`Couldn't ${tc.name.replace(/_/g, " ")} right now.`);
    }
  }

  if (outputs.length > 0) return outputs.join("\n");
  return result.content;
}

async function runDelegate(
  req: AnalystRequest,
  extraContext: string | undefined,
  context: RouterContext,
  deps: LlmPathDeps,
): Promise<string> {
  const ctx = {
    allowedClassifications: context.allowedClassifications,
    userUid: context.invokerUid,
  };

  const finish = async (raw: string): Promise<string> => {
    let result = formatDelegateFollowUp(raw, context.invokerName);
    if (req.save) {
      const saved = await context.bot.saveAnalystDoc(raw, req.classification);
      result = appendAnalystSaveNotice(result, saved);
    }
    return result;
  };

  if (!context.postFollowUp) {
    const raw = await deps.llm.delegate(req.task, extraContext, ctx);
    return finish(raw);
  }

  void deps.llm
    .delegate(req.task, extraContext, ctx)
    .then(async (result) => {
      await context.postFollowUp!(await finish(result));
    })
    .catch(async (err) => {
      context.logger.warn({ err, task: req.task.slice(0, 80) }, "Async delegate failed");
      const msg = err instanceof Error ? err.message : "Analyst request failed.";
      try {
        await context.postFollowUp!(formatDelegateFollowUp(msg, context.invokerName));
      } catch (postErr) {
        context.logger.warn({ err: postErr }, "Failed to post delegate error follow-up");
      }
    });

  return DELEGATE_ACK_MESSAGE;
}

async function runWorkflow(
  req: WorkflowRequest,
  context: RouterContext,
  deps: LlmPathDeps,
): Promise<string> {
  const ctx = {
    allowedClassifications: context.allowedClassifications,
    userUid: context.invokerUid,
  };

  const finish = async (raw: string): Promise<string> => {
    let result = raw;
    if (req.save) {
      const saved = await context.bot.saveWorkflowDoc(req.kind, raw);
      result = saved.ok
        ? `${raw}\n\n💾 Saved to knowledge base: ${saved.source}`
        : `${raw}\n\n⚠️ Could not save: ${saved.error}`;
    }
    return result;
  };

  const generate = () => {
    if (deps.llm.generateWorkflowDoc) {
      return deps.llm.generateWorkflowDoc(req, ctx);
    }
    return deps.llm.delegate(buildWorkflowTask(req), undefined, ctx);
  };

  if (!context.postFollowUp) {
    return finish(await generate());
  }

  void generate()
    .then(async (raw) => {
      await context.postFollowUp!(
        formatWorkflowFollowUp(req.kind, await finish(raw), context.invokerName),
      );
    })
    .catch(async (err) => {
      context.logger.warn({ err, kind: req.kind }, "Async workflow failed");
      const msg = err instanceof Error ? err.message : "Document draft failed.";
      try {
        await context.postFollowUp!(formatWorkflowFollowUp(req.kind, msg, context.invokerName));
      } catch (postErr) {
        context.logger.warn({ err: postErr }, "Failed to post workflow error follow-up");
      }
    });

  return WORKFLOW_ACK_MESSAGE;
}

/** Message when LLM is not wired (parity with ControlRouter). */
export function llmUnavailableMessage(intent: LlmIntent): string {
  if (intent.mode === "ask") {
    return "The local LLM is not configured. Ask an admin to enable it.";
  }
  return `Unknown command. Try ${"!"}help.`;
}
