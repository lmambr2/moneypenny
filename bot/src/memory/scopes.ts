/**
 * Memory scope model (feature-roadmap H3).
 * Private per-user facts and org KG must never cross into radio broadcast.
 */

export type MemoryScopeId = "private" | "org";

export interface MemoryScopeDescriptor {
  id: MemoryScopeId;
  label: string;
  commands: string[];
  injectIntoAsk: string;
  broadcastOk: boolean;
  notes: string;
}

/** Canonical scope catalog for dashboard + docs. */
export function describeMemoryScopes(opts?: {
  memoryEnabled?: boolean;
  kgEnabled?: boolean;
  memoryBroadcastOptIn?: boolean;
}): MemoryScopeDescriptor[] {
  const memOn = !!opts?.memoryEnabled;
  const kgOn = !!opts?.kgEnabled;
  const broadcastOn = !!opts?.memoryBroadcastOptIn;

  return [
    {
      id: "private",
      label: "Per-user private",
      commands: ["!remember", "!recall", "!forget"],
      injectIntoAsk: memOn
        ? "Injected into that user's !ask only"
        : "Stored, but injection is off in Settings",
      broadcastOk: false,
      notes:
        "Never used for radio memory bumpers. Scoped by TeamSpeak uid. MemPalace rooms stay personal.",
    },
    {
      id: "org",
      label: "Org knowledge graph",
      commands: ["!kg remember|who|list|forget", "!diary", "POST /api/bot/org-kg"],
      injectIntoAsk: kgOn
        ? "Injected into everyone's !ask when KG is on"
        : "Stored, but org injection is off in Settings",
      broadcastOk: broadcastOn,
      notes: broadcastOn
        ? "Radio memory bumper may speak org facts (opt-in)."
        : "Radio memory bumper blocked until “Org memory on air” is enabled.",
    },
  ];
}

/**
 * Guard for broadcast paths. Returns false if the source string looks like a
 * private memory room (defense-in-depth for bumper / radio code).
 */
export function isBroadcastSafeSource(source: string): boolean {
  const s = source.toLowerCase();
  if (!s.trim()) return false;
  if (s.includes("your memory")) return false;
  if (s.includes("mempalace") && s.includes("user")) return false;
  if (s.includes("private")) return false;
  if (s.includes("!remember")) return false;
  // Org sources
  if (s.includes("org knowledge") || s.includes("org memory") || s.includes("org kg")) return true;
  // Prefix must be an org token (`org …` / `org:`), not any word starting "org".
  if (/^org[\s:([]/.test(s)) return true;
  // Doctrine / files are fine for doctrine bumper, not for "memory" bumper
  return false;
}

/** Facts eligible for org memory bumper material. */
export function filterOrgBroadcastFacts(
  hits: Array<{ fact: string; source?: string }>,
): Array<{ fact: string }> {
  return hits
    .filter((h) => {
      if (h.source != null && !isBroadcastSafeSource(h.source)) return false;
      return !!h.fact?.trim();
    })
    .map((h) => ({ fact: h.fact.trim() }));
}

export interface MemoryScopesSnapshot {
  scopes: MemoryScopeDescriptor[];
  privateCount?: number;
  orgCount?: number;
  isolationRule: string;
}

export function buildScopesSnapshot(opts: {
  memoryEnabled?: boolean;
  kgEnabled?: boolean;
  memoryBroadcastOptIn?: boolean;
  privateCount?: number;
  orgCount?: number;
}): MemoryScopesSnapshot {
  return {
    scopes: describeMemoryScopes(opts),
    privateCount: opts.privateCount,
    orgCount: opts.orgCount,
    isolationRule: "Private !remember rooms never feed radio memory bumpers. Org KG only (opt-in).",
  };
}
