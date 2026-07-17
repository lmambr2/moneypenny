import type { BrainTransport, TurnRequest, TurnResult } from "./types.js";
import { BrainUnavailableError } from "./types.js";

/**
 * Run one brain turn via the configured transport.
 * Maps BrainUnavailableError to a soft TurnResult when `softFail` is true
 * (default) so music/dashboard never crash on brain outage.
 */
export async function completeTurn(
  req: TurnRequest,
  transport: BrainTransport,
  opts?: { softFail?: boolean },
): Promise<TurnResult> {
  const softFail = opts?.softFail !== false;
  try {
    return await transport.completeTurn(req);
  } catch (err) {
    if (!softFail) throw err;
    if (err instanceof BrainUnavailableError) {
      return {
        turnId: `brain-down-${Date.now().toString(36)}`,
        clientTurnId: req.clientTurnId,
        replyText: "",
        sources: [],
        toolProposals: [],
        error: err.message,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      turnId: `brain-err-${Date.now().toString(36)}`,
      clientTurnId: req.clientTurnId,
      replyText: "",
      sources: [],
      toolProposals: [],
      error: msg,
    };
  }
}
