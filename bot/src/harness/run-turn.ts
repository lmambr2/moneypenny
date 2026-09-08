import {
  type BrainTransport,
  completeTurn,
  disposeToolProposals,
  resolveBrainTransport,
  type TurnMode,
} from "../brain/index.js";
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
 * Run one harness cockpit turn via brain transport (Phase D).
 * Brain proposes tools; this layer disposes them with executeTool (rights/dry-run).
 * Failures surface as `error` + reply text — never throw into the music path.
 */
export async function runHarnessTurn(
  question: string,
  mode: HarnessMode,
  deps: RunHarnessTurnDeps,
): Promise<HarnessTurn> {
  const user = question.trim();
  const at = deps.now?.() ?? Date.now();
  const id = deps.idFactory?.() ?? defaultId();
  const harnessMode: HarnessMode = mode === "intent" ? "intent" : "ask";

  if (!user) {
    return push(
      {
        id,
        at,
        user: "",
        reply: "",
        sources: [],
        tools: [],
        error: "question is required",
        mode: harnessMode,
      },
      deps,
    );
  }

  if (!deps.llm && !deps.brain) {
    return push(
      {
        id,
        at,
        user,
        reply: "",
        sources: [],
        tools: [],
        error: "LLM is not enabled",
        mode: harnessMode,
      },
      deps,
    );
  }

  const brain: BrainTransport =
    deps.brain ??
    resolveBrainTransport({
      brainUrl: deps.brainUrl,
      inProcess: {
        llm: deps.llm,
        retrieve: deps.retrieve,
        idFactory: () => id,
      },
      fetchImpl: deps.fetchImpl,
    });

  const turnMode: TurnMode = harnessMode === "intent" ? "intent" : "ask";
  const maxTools = 8;
  const maxRounds = 4;
  const tools: HarnessToolRecord[] = [];
  const replyParts: string[] = [];
  let sources: ReturnType<typeof mapSources> = [];
  let lastError: string | undefined;
  let lastTurnId = id;
  let toolResults:
    | Array<{ name: string; ok: boolean; result?: string; error?: string }>
    | undefined;

  for (let round = 0; round < maxRounds && tools.length < maxTools; round++) {
    const result = await completeTurn(
      {
        clientTurnId: id,
        channel: deps.channel ?? "dashboard",
        text: user,
        conversationId: deps.conversationId,
        mode: turnMode,
        toolResults,
        options: { includeSources: true, maxTools: maxTools - tools.length },
      },
      brain,
    );
    lastTurnId = result.turnId || lastTurnId;
    if (result.sources.length) sources = mapSources(result.sources);
    if (result.replyText.trim()) replyParts.push(result.replyText.trim());

    if (
      result.error &&
      result.toolProposals.length === 0 &&
      !result.replyText &&
      tools.length === 0
    ) {
      return push(
        {
          id: lastTurnId,
          at,
          user,
          reply: "",
          sources,
          tools: [],
          error: result.error,
          mode: harnessMode,
        },
        deps,
      );
    }
    if (result.error) lastError = result.error;

    if (result.toolProposals.length === 0) break;

    let disposed: HarnessToolRecord[];
    if (!deps.executeTool) {
      disposed = result.toolProposals.map((p) => ({
        name: p.name,
        args: p.arguments ?? {},
        ok: false,
        error: "no tool executor",
      }));
    } else {
      const raw = await disposeToolProposals(result.toolProposals, deps.executeTool);
      disposed = raw.map((t) => ({
        name: t.name,
        args: t.args,
        ok: t.ok,
        result: t.result,
        error: t.error,
      }));
    }
    tools.push(...disposed);
    if (!deps.executeTool) break;
    toolResults = disposed.map((t) => ({
      name: t.name,
      ok: t.ok,
      result: t.result,
      error: t.error,
    }));
  }

  for (const t of tools) {
    if (t.result) replyParts.push(t.result);
    else if (t.error) replyParts.push(`${t.name}: ${t.error}`);
  }

  const reply =
    replyParts.join("\n") ||
    (tools.length ? "(tools ran; no text)" : lastError ? "" : "(no response)");

  const turn: HarnessTurn = {
    id: lastTurnId,
    at,
    user,
    reply,
    sources,
    tools,
    mode: harnessMode,
    ...(lastError ? { error: lastError } : {}),
  };

  return push(turn, deps);
}

function mapSources(
  sources: Array<{ source: string; text?: string; classification?: string; score?: number }>,
): HarnessSource[] {
  return sources.map((s) => ({
    source: s.source,
    text: s.text,
    classification: s.classification,
    score: s.score,
  }));
}

function push(turn: HarnessTurn, deps: RunHarnessTurnDeps): HarnessTurn {
  deps.store?.push(turn);
  return turn;
}
