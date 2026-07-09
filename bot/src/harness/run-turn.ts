import type {
  HarnessMode,
  HarnessSource,
  HarnessToolRecord,
  HarnessTurn,
  RunHarnessTurnDeps,
} from "./types.js";

let seq = 0;
function defaultId(): string {
  seq += 1;
  return `h-${Date.now().toString(36)}-${seq}`;
}

/**
 * Run one harness cockpit turn: retrieve sources, ask or intent+tools, assemble
 * a structured turn record. Failures surface as `error` + reply text — never throw
 * into the music path.
 */
export async function runHarnessTurn(
  question: string,
  mode: HarnessMode,
  deps: RunHarnessTurnDeps,
): Promise<HarnessTurn> {
  const user = question.trim();
  const at = deps.now?.() ?? Date.now();
  const id = deps.idFactory?.() ?? defaultId();

  if (!user) {
    const empty: HarnessTurn = {
      id,
      at,
      user: "",
      reply: "",
      sources: [],
      tools: [],
      error: "question is required",
      mode,
    };
    deps.store?.push(empty);
    return empty;
  }

  if (!deps.llm) {
    const off: HarnessTurn = {
      id,
      at,
      user,
      reply: "",
      sources: [],
      tools: [],
      error: "LLM is not enabled",
      mode,
    };
    deps.store?.push(off);
    return off;
  }

  let sources: HarnessSource[] = [];
  if (deps.retrieve) {
    try {
      const chunks = await deps.retrieve(user);
      sources = chunks.map((c) => ({
        source: c.source,
        text: c.text,
        classification: c.classification,
        score: c.score,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fail: HarnessTurn = {
        id,
        at,
        user,
        reply: "",
        sources: [],
        tools: [],
        error: `RAG retrieval failed: ${msg}`,
        mode,
      };
      deps.store?.push(fail);
      return fail;
    }
  }

  if (mode === "intent" && deps.llm.chatForIntent) {
    try {
      const intent = await deps.llm.chatForIntent(user, deps.conversationId);
      const tools: HarnessToolRecord[] = [];
      const calls = intent.toolCalls ?? [];
      for (const tc of calls) {
        const args =
          tc.arguments && typeof tc.arguments === "object" && !Array.isArray(tc.arguments)
            ? (tc.arguments as Record<string, unknown>)
            : {};
        if (!deps.executeTool) {
          tools.push({
            name: tc.name,
            args,
            ok: false,
            error: "no tool executor",
          });
          continue;
        }
        try {
          const r = await deps.executeTool(tc.name, args);
          tools.push({
            name: tc.name,
            args,
            ok: r.ok,
            result: r.result,
            error: r.error,
          });
        } catch (err) {
          tools.push({
            name: tc.name,
            args,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const replyParts: string[] = [];
      if (intent.content?.trim()) replyParts.push(intent.content.trim());
      for (const t of tools) {
        if (t.result) replyParts.push(t.result);
        else if (t.error) replyParts.push(`${t.name}: ${t.error}`);
      }
      const turn: HarnessTurn = {
        id,
        at,
        user,
        reply: replyParts.join("\n") || (tools.length ? "(tools ran; no text)" : "(no response)"),
        sources,
        tools,
        mode: "intent",
      };
      deps.store?.push(turn);
      return turn;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fail: HarnessTurn = {
        id,
        at,
        user,
        reply: "",
        sources,
        tools: [],
        error: `Intent failed: ${msg}`,
        mode: "intent",
      };
      deps.store?.push(fail);
      return fail;
    }
  }

  // ask mode (default)
  try {
    const reply = await deps.llm.ask(user, deps.conversationId);
    const turn: HarnessTurn = {
      id,
      at,
      user,
      reply: reply || "(no response)",
      sources,
      tools: [],
      mode: "ask",
    };
    deps.store?.push(turn);
    return turn;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fail: HarnessTurn = {
      id,
      at,
      user,
      reply: "",
      sources,
      tools: [],
      error: `LLM ask failed: ${msg}`,
      mode: "ask",
    };
    deps.store?.push(fail);
    return fail;
  }
}
