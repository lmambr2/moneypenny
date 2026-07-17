/**
 * Brain turn contract (docs/brain-boundary.md) — Phase D.
 * Brain *proposes*; bot *disposes* (executes tools with rights).
 */

export type TurnChannel = "dashboard" | "teamspeak" | "voice";
export type TurnMode = "ask" | "intent" | "delegate";

export interface TurnSubject {
  uid?: string;
  serverGroups?: string[];
  allowedClassifications?: string[];
}

export interface TurnRequest {
  /** Recommended for dedup / dashboard correlation. */
  clientTurnId?: string;
  channel: TurnChannel;
  text: string;
  conversationId?: string;
  subject?: TurnSubject;
  /** Default `ask` (no tools). `intent` may return tool proposals. */
  mode?: TurnMode;
  options?: {
    includeSources?: boolean;
    maxTools?: number;
  };
}

export interface TurnSource {
  source: string;
  text?: string;
  classification?: string;
  score?: number;
}

export interface ToolProposal {
  name: string;
  arguments: Record<string, unknown>;
  reason?: string;
}

export interface TurnResult {
  turnId: string;
  clientTurnId?: string;
  /** Safe to show; may be empty if only tools proposed. */
  replyText: string;
  sources: TurnSource[];
  /** Not executed — bot maps name→command, re-checks rights, executes. */
  toolProposals: ToolProposal[];
  /** Soft failure; HTTP may still be 200 when partial answer exists. */
  error: string | null;
}

export interface BrainTransport {
  completeTurn(req: TurnRequest): Promise<TurnResult>;
}

export class BrainUnavailableError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 503) {
    super(message);
    this.name = "BrainUnavailableError";
    this.statusCode = statusCode;
  }
}
