/**
 * Claim-check RAG (P1): extract claims → score support → optional re-retrieve + revise.
 * Fail-open: any error returns the original draft.
 */

export interface ClaimCheckOpts {
  enabled?: boolean;
  maxClaims?: number;
  maxExtraRetrieves?: number;
  revise?: boolean;
  timeoutMs?: number;
}

export interface ClaimCheckDeps {
  /** Re-retrieve for an unsupported claim (same clearance as original turn). */
  retrieve?: (claim: string) => Promise<Array<{ text: string; source: string }>>;
  /** Optional revise pass. */
  revise?: (draft: string, extraContext: string) => Promise<string>;
  logger?: {
    warn: (obj: unknown, msg: string) => void;
    debug?: (obj: unknown, msg: string) => void;
  };
}

export interface ClaimCheckResult {
  ran: boolean;
  draft: string;
  fixedClaims: number;
  unsupported: string[];
  timedOut: boolean;
  extraSources: string[];
}

const DEFAULTS = {
  maxClaims: 5,
  maxExtraRetrieves: 3,
  revise: true,
  timeoutMs: 4_000,
};

/** Split draft into candidate factual sentences (heuristic — no LLM required). */
export function extractClaimsHeuristic(draft: string, maxClaims: number): string[] {
  const cleaned = draft
    .replace(/📎 Sources:.*$/s, "")
    .replace(/\(no response\)/gi, "")
    .trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 400);
  // Prefer sentences that look factual (digits, proper nouns, or "is/are/was").
  const scored = parts.map((s) => {
    let score = 0;
    if (/\d/.test(s)) score += 2;
    if (/\b(is|are|was|were|has|have|will|must|should)\b/i.test(s)) score += 1;
    if (/[A-Z][a-z]+/.test(s)) score += 1;
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((x) => x.score > 0)
    .slice(0, maxClaims)
    .map((x) => x.s);
}

/** Token-overlap support: claim is supported if enough content words appear in sources. */
export function scoreSupport(
  claim: string,
  sourceTexts: string[],
): "supported" | "weak" | "missing" {
  const words = claim
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (words.length === 0) return "supported";
  const blob = sourceTexts.join("\n").toLowerCase();
  if (!blob.trim()) return "missing";
  let hits = 0;
  for (const w of words) {
    if (blob.includes(w)) hits += 1;
  }
  const ratio = hits / words.length;
  if (ratio >= 0.45) return "supported";
  if (ratio >= 0.2) return "weak";
  return "missing";
}

export async function runClaimCheck(
  draft: string,
  sourceTexts: string[],
  opts: ClaimCheckOpts,
  deps: ClaimCheckDeps,
): Promise<ClaimCheckResult> {
  const base: ClaimCheckResult = {
    ran: false,
    draft,
    fixedClaims: 0,
    unsupported: [],
    timedOut: false,
    extraSources: [],
  };
  if (!opts.enabled) return base;

  const maxClaims = opts.maxClaims ?? DEFAULTS.maxClaims;
  const maxExtra = opts.maxExtraRetrieves ?? DEFAULTS.maxExtraRetrieves;
  const doRevise = opts.revise !== false;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;

  const work = async (): Promise<ClaimCheckResult> => {
    const claims = extractClaimsHeuristic(draft, maxClaims);
    if (claims.length === 0) return { ...base, ran: true };

    const unsupported: string[] = [];
    const extraChunks: Array<{ text: string; source: string }> = [];
    let retrieves = 0;

    for (const claim of claims) {
      const support = scoreSupport(claim, [...sourceTexts, ...extraChunks.map((c) => c.text)]);
      if (support === "supported") continue;
      unsupported.push(claim);
      if (deps.retrieve && retrieves < maxExtra) {
        retrieves += 1;
        try {
          const more = await deps.retrieve(claim);
          for (const m of more) extraChunks.push(m);
        } catch (err) {
          deps.logger?.warn({ err }, "claim-check retrieve₂ failed");
        }
      }
    }

    let out = draft;
    let fixed = 0;
    if (doRevise && deps.revise && extraChunks.length > 0 && unsupported.length > 0) {
      try {
        const ctx = extraChunks.map((c) => `[${c.source}] ${c.text}`).join("\n\n");
        const revised = await deps.revise(draft, ctx);
        if (revised?.trim()) {
          out = revised.trim();
          fixed = unsupported.filter(
            (c) => scoreSupport(c, [ctx, ...sourceTexts]) === "supported",
          ).length;
          // Re-score after revise
          const still = unsupported.filter(
            (c) => scoreSupport(c, [out, ctx, ...sourceTexts]) === "missing",
          );
          return {
            ran: true,
            draft: out,
            fixedClaims: Math.max(fixed, unsupported.length - still.length),
            unsupported: still,
            timedOut: false,
            extraSources: [...new Set(extraChunks.map((c) => c.source).filter(Boolean))],
          };
        }
      } catch (err) {
        deps.logger?.warn({ err }, "claim-check revise failed — keeping draft");
      }
    }

    return {
      ran: true,
      draft: out,
      fixedClaims: fixed,
      unsupported,
      timedOut: false,
      extraSources: [...new Set(extraChunks.map((c) => c.source).filter(Boolean))],
    };
  };

  try {
    return await Promise.race([
      work(),
      new Promise<ClaimCheckResult>((resolve) => {
        setTimeout(() => resolve({ ...base, ran: true, timedOut: true }), timeoutMs);
      }),
    ]);
  } catch (err) {
    deps.logger?.warn({ err }, "claim-check failed open");
    return base;
  }
}
