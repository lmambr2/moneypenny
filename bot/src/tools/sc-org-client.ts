/**
 * Star Citizen / org status HTTP client (G2 depth).
 * Contract for a small bridge at SC_ORG_STATUS_URL — fail-open at the plugin layer.
 *
 * Expected bridge surface (any subset is fine):
 *   GET  /health              → { ok: true }
 *   GET  /status              → { status, membersOnline?, summary?, org? }
 *   GET  /members             → { members: [{ name, rank?, online? }] }
 *   GET  /fleet               → { vessels: [{ name, role? }], summary? }
 */

export interface ScOrgStatus {
  status: string;
  membersOnline?: number;
  summary?: string;
  org?: string;
  raw?: unknown;
}

export interface ScOrgMember {
  name: string;
  rank?: string;
  online?: boolean;
}

export interface ScOrgFleet {
  vessels: Array<{ name: string; role?: string }>;
  summary?: string;
}

export interface ScOrgClientOpts {
  baseUrl: string;
  orgName?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ScOrgClient {
  private base: string;
  private orgName: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: ScOrgClientOpts) {
    this.base = normalizeScOrgBaseUrl(opts.baseUrl);
    this.orgName = opts.orgName ?? "org";
    this.timeoutMs = opts.timeoutMs ?? 3_500;
    const f = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!f) throw new Error("fetch is not available");
    this.fetchImpl = f;
  }

  get configured(): boolean {
    return this.base.length > 0;
  }

  async health(): Promise<boolean> {
    try {
      const data = await this.getJson("/health");
      return !!(data as { ok?: boolean })?.ok;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ScOrgStatus> {
    const data = (await this.getJson("/status")) as Record<string, unknown>;
    return parseStatusPayload(data, this.orgName);
  }

  async getMembers(): Promise<ScOrgMember[]> {
    const data = (await this.getJson("/members")) as {
      members?: Array<Record<string, unknown>>;
    };
    const list = Array.isArray(data?.members) ? data.members : [];
    return list
      .map((m) => ({
        name: String(m.name ?? m.handle ?? "").trim(),
        rank: m.rank != null ? String(m.rank) : undefined,
        online: typeof m.online === "boolean" ? m.online : undefined,
      }))
      .filter((m) => m.name.length > 0);
  }

  async getFleet(): Promise<ScOrgFleet> {
    const data = (await this.getJson("/fleet")) as {
      vessels?: Array<Record<string, unknown>>;
      summary?: string;
    };
    const vessels = Array.isArray(data?.vessels)
      ? data.vessels
          .map((v) => ({
            name: String(v.name ?? "").trim(),
            role: v.role != null ? String(v.role) : undefined,
          }))
          .filter((v) => v.name.length > 0)
      : [];
    return { vessels, summary: data?.summary ? String(data.summary) : undefined };
  }

  /** One-line summary for !ops / status plugin. */
  async formatBrief(): Promise<string> {
    const st = await this.getStatus();
    const parts = [
      `${st.org ?? this.orgName}: ${st.status}`,
      st.membersOnline != null ? `${st.membersOnline} online` : null,
      st.summary ?? null,
    ].filter(Boolean);
    try {
      const members = await this.getMembers();
      const online = members.filter((m) => m.online).slice(0, 5);
      if (online.length) {
        parts.push(`Online: ${online.map((m) => m.name).join(", ")}`);
      }
    } catch {
      /* members optional */
    }
    return parts.join(" · ");
  }

  private async getJson(path: string): Promise<unknown> {
    if (!this.base) throw new Error("SC org status URL not configured");
    const res = await this.fetchImpl(`${this.base}${path}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Accept: "application/json" },
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

export function parseStatusPayload(data: Record<string, unknown>, defaultOrg: string): ScOrgStatus {
  return {
    status: String(data.status ?? data.state ?? "ok"),
    membersOnline:
      typeof data.membersOnline === "number"
        ? data.membersOnline
        : typeof data.online === "number"
          ? data.online
          : undefined,
    summary: data.summary != null ? String(data.summary) : undefined,
    org: data.org != null ? String(data.org) : defaultOrg,
    raw: data,
  };
}

export function formatScOrgStatusLine(st: ScOrgStatus, orgFallback = "org"): string {
  const parts = [
    `${st.org ?? orgFallback}: ${st.status}`,
    st.membersOnline != null ? `${st.membersOnline} online` : null,
    st.summary ?? null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Only http(s) bases are accepted. Rejects file:/gopher:/relative junk so a
 * mis-set Settings field cannot turn the bot into a weird scheme fetcher.
 * (Admin SSRF to LAN http remains intentional — same as llmUrl.)
 */
export function normalizeScOrgBaseUrl(raw: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/$/, "");
  if (!trimmed) return "";
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error("SC org status URL is not a valid absolute URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("SC org status URL must be http or https");
  }
  if (u.username || u.password) {
    throw new Error("SC org status URL must not embed credentials");
  }
  return `${u.origin}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;
}
