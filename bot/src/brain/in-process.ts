import type {
  BrainTransport,
  ToolProposal,
  TurnRequest,
  TurnResult,
  TurnSource,
} from "./types.js";

export interface InProcessBrainLlm {
  ask(question: string, conversationId?: string): Promise<string>;
  chatForIntent?(
    userMessage: string,
    conversationId?: string,
  ): Promise<{
    content: string | null;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }>;
}

export interface InProcessBrainDeps {
  llm: InProcessBrainLlm | null;
  retrieve?: (question: string) => Promise<
    Array<{
      text: string;
      source: string;
      score?: number;
      classification?: string;
    }>
  >;
  idFactory?: () => string;
}

let seq = 0;
function defaultId(): string {
  seq += 1;
  return `brain-${Date.now().toString(36)}-${seq}`;
}

/**
 * In-process brain: local LLM + optional RAG. Never executes tools.
 */
export function createInProcessBrain(deps: InProcessBrainDeps): BrainTransport {
  return {
    async completeTurn(req: TurnRequest): Promise<TurnResult> {
      const turnId = deps.idFactory?.() ?? defaultId();
      const text = (req.text ?? "").trim();
      const mode = req.mode === "intent" || req.mode === "delegate" ? req.mode : "ask";
      const includeSources = req.options?.includeSources !== false;
      const maxTools = Math.min(16, Math.max(0, req.options?.maxTools ?? 4));

      if (!text) {
        return emptyResult(turnId, req, "text is required");
      }

      if (!deps.llm) {
        return emptyResult(turnId, req, "LLM is not enabled");
      }

      if (mode === "delegate") {
        // Delegation stays on the bot ControlRouter path for now; brain contract
        // accepts the mode for forward-compat but does not run analyst here.
        return emptyResult(
          turnId,
          req,
          "delegate mode is not handled by the brain transport; use ControlRouter !analyst",
        );
      }

      let sources: TurnSource[] = [];
      if (includeSources && deps.retrieve) {
        try {
          const chunks = await deps.retrieve(text);
          sources = chunks.map((c) => ({
            source: c.source,
            text: c.text,
            classification: c.classification,
            score: c.score,
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return emptyResult(turnId, req, `RAG retrieval failed: ${msg}`);
        }
      }

      if (mode === "intent" && deps.llm.chatForIntent) {
        try {
          const intent = await deps.llm.chatForIntent(text, req.conversationId);
          const raw = intent.toolCalls ?? [];
          const toolProposals: ToolProposal[] = raw.slice(0, maxTools).map((tc) => ({
            name: tc.name,
            arguments:
              tc.arguments && typeof tc.arguments === "object" && !Array.isArray(tc.arguments)
                ? (tc.arguments as Record<string, unknown>)
                : {},
          }));
          return {
            turnId,
            clientTurnId: req.clientTurnId,
            replyText: intent.content?.trim() ?? "",
            sources,
            toolProposals,
            error: null,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            turnId,
            clientTurnId: req.clientTurnId,
            replyText: "",
            sources,
            toolProposals: [],
            error: `Intent failed: ${msg}`,
          };
        }
      }

      // ask (default); intent without chatForIntent falls through to ask
      try {
        const reply = await deps.llm.ask(text, req.conversationId);
        return {
          turnId,
          clientTurnId: req.clientTurnId,
          replyText: reply || "",
          sources,
          toolProposals: [],
          error: null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          turnId,
          clientTurnId: req.clientTurnId,
          replyText: "",
          sources,
          toolProposals: [],
          error: `LLM ask failed: ${msg}`,
        };
      }
    },
  };
}

function emptyResult(turnId: string, req: TurnRequest, error: string): TurnResult {
  return {
    turnId,
    clientTurnId: req.clientTurnId,
    replyText: "",
    sources: [],
    toolProposals: [],
    error,
  };
}
