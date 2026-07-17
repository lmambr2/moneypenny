/**
 * Light RAG / org-memory eval loop (feature-roadmap R3).
 * Scripted queries → expect non-empty doctrine and/or org memory hits.
 * Injectable stores — no live vector store/MemPalace required for CI.
 */

export type EvalExpect = "doctrine" | "org_memory" | "either" | "both";

export interface EvalCase {
  id: string;
  query: string;
  expect: EvalExpect;
  /** Optional substring that should appear in some hit text/source. */
  expectIncludes?: string;
  minDoctrineHits?: number;
  minOrgHits?: number;
}

export interface EvalHit {
  text: string;
  source: string;
  score?: number;
  classification?: string;
}

export interface EvalLoopDeps {
  queryDoctrine?: (q: string) => Promise<EvalHit[]>;
  queryOrgMemory?: (q: string) => Promise<Array<{ fact: string }>>;
}

export interface EvalCaseResult {
  id: string;
  query: string;
  pass: boolean;
  doctrineHits: number;
  orgHits: number;
  reason?: string;
  samples: string[];
}

export interface EvalReport {
  ok: boolean;
  passed: number;
  failed: number;
  results: EvalCaseResult[];
  /** P5 — optional module axes (populated when suites run with fixtures). */
  axes?: {
    retrievalPrecision?: number;
    unsupportedClaimRate?: number;
    injectionDedupRate?: number;
    latencyMs?: number;
  };
}

/**
 * P5 skeleton: compute simple axes from injectable measurements (no live vector store).
 */
export function computeMemoryAxes(input: {
  goldHits?: number;
  topKHits?: number;
  unsupportedClaims?: number;
  totalClaims?: number;
  skippedDedup?: number;
  candidates?: number;
  latencyMs?: number;
}): NonNullable<EvalReport["axes"]> {
  const axes: NonNullable<EvalReport["axes"]> = {};
  if (input.goldHits !== undefined && input.topKHits !== undefined && input.topKHits > 0) {
    axes.retrievalPrecision = input.goldHits / input.topKHits;
  }
  if (input.totalClaims !== undefined && input.totalClaims > 0) {
    axes.unsupportedClaimRate = (input.unsupportedClaims ?? 0) / input.totalClaims;
  }
  if (input.candidates !== undefined && input.candidates > 0) {
    axes.injectionDedupRate = (input.skippedDedup ?? 0) / input.candidates;
  }
  if (input.latencyMs !== undefined) axes.latencyMs = input.latencyMs;
  return axes;
}

/** Default starter cases — operators extend with corpus-specific queries. */
export const DEFAULT_EVAL_CASES: EvalCase[] = [
  {
    id: "doctrine-ops",
    query: "ops briefing priorities",
    expect: "doctrine",
    minDoctrineHits: 1,
  },
  {
    id: "doctrine-combat",
    query: "combat doctrine engagement ROE",
    expect: "doctrine",
    minDoctrineHits: 1,
  },
  {
    id: "org-fc",
    query: "fleet commander",
    expect: "org_memory",
    minOrgHits: 1,
  },
  {
    id: "either-station",
    query: "station welcome",
    expect: "either",
  },
];

export async function runEvalCase(c: EvalCase, deps: EvalLoopDeps): Promise<EvalCaseResult> {
  const doctrine = deps.queryDoctrine ? await deps.queryDoctrine(c.query) : [];
  const org = deps.queryOrgMemory ? await deps.queryOrgMemory(c.query) : [];
  const doctrineHits = doctrine.length;
  const orgHits = org.length;
  const samples = [
    ...doctrine.slice(0, 2).map((h) => `[doc:${h.source}] ${h.text.slice(0, 80)}`),
    ...org.slice(0, 2).map((h) => `[org] ${h.fact.slice(0, 80)}`),
  ];

  const minDoc = c.minDoctrineHits ?? 1;
  const minOrg = c.minOrgHits ?? 1;
  let pass = false;
  let reason: string | undefined;

  switch (c.expect) {
    case "doctrine":
      pass = doctrineHits >= minDoc;
      if (!pass) reason = `doctrine hits ${doctrineHits} < ${minDoc}`;
      break;
    case "org_memory":
      pass = orgHits >= minOrg;
      if (!pass) reason = `org hits ${orgHits} < ${minOrg}`;
      break;
    case "either":
      pass = doctrineHits >= 1 || orgHits >= 1;
      if (!pass) reason = "no doctrine or org hits";
      break;
    case "both":
      pass = doctrineHits >= minDoc && orgHits >= minOrg;
      if (!pass) reason = `need both (doc=${doctrineHits}, org=${orgHits})`;
      break;
  }

  if (pass && c.expectIncludes) {
    const blob = [...doctrine.map((h) => h.text + h.source), ...org.map((h) => h.fact)]
      .join("\n")
      .toLowerCase();
    if (!blob.includes(c.expectIncludes.toLowerCase())) {
      pass = false;
      reason = `missing expected substring "${c.expectIncludes}"`;
    }
  }

  // Empty-rewrite catch: hits exist but all text empty → fail
  if (pass && c.expect === "doctrine" && doctrine.every((h) => !h.text.trim())) {
    pass = false;
    reason = "doctrine hits have empty text (empty rewrite risk)";
  }

  return {
    id: c.id,
    query: c.query,
    pass,
    doctrineHits,
    orgHits,
    reason,
    samples,
  };
}

export async function runEvalLoop(
  cases: EvalCase[],
  deps: EvalLoopDeps,
  axesInput?: Parameters<typeof computeMemoryAxes>[0],
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    results.push(await runEvalCase(c, deps));
  }
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  return {
    ok: failed === 0,
    passed,
    failed,
    results,
    axes: axesInput ? computeMemoryAxes(axesInput) : undefined,
  };
}
