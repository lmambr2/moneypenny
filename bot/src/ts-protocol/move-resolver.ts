import { extractFileRows } from "./client.js";

export interface QueryClient {
  clid: number;
  nickname: string;
}

export interface QueryChannel {
  cid: number;
  name: string;
}

export type ResolveResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Pull row arrays from TS6 HTTP Query JSON envelopes (same shape as ftgetfilelist). */
export function extractQueryRows(body: unknown): Record<string, unknown>[] {
  return extractFileRows(body);
}

/** Map clid → server-group IDs from a TS6 `clientlist … -groups` response. */
export function serverGroupsByClidFromRows(rows: Record<string, unknown>[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const row of rows) {
    const clid = rowClid(row);
    if (clid == null) continue;
    const raw = String(row.client_servergroups ?? "");
    out.set(
      clid,
      raw
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    );
  }
  return out;
}

function rowNickname(row: Record<string, unknown>): string {
  const n = row.client_nickname ?? row.nickname ?? row.name;
  return n != null ? String(n) : "";
}

function rowChannelName(row: Record<string, unknown>): string {
  const n = row.channel_name ?? row.name;
  return n != null ? String(n) : "";
}

function rowClid(row: Record<string, unknown>): number | null {
  const raw = row.clid ?? row.client_id;
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function rowCid(row: Record<string, unknown>): number | null {
  const raw = row.cid ?? row.channel_id;
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

export function parseClientRows(rows: Record<string, unknown>[]): QueryClient[] {
  const out: QueryClient[] = [];
  for (const row of rows) {
    const clid = rowClid(row);
    const nickname = rowNickname(row);
    if (clid == null || !nickname) continue;
    out.push({ clid, nickname });
  }
  return out;
}

export function parseChannelRows(rows: Record<string, unknown>[]): QueryChannel[] {
  const out: QueryChannel[] = [];
  for (const row of rows) {
    const cid = rowCid(row);
    const name = rowChannelName(row);
    if (cid == null || !name) continue;
    out.push({ cid, name });
  }
  return out;
}

/** Resolve a client by numeric clid, exact nickname, or unique nickname prefix. */
export function resolveClientQuery(
  query: string,
  clients: QueryClient[],
): ResolveResult<QueryClient> {
  const q = query.trim();
  if (!q) return { ok: false, error: "Client name or ID required." };

  if (/^\d+$/.test(q)) {
    const clid = Number.parseInt(q, 10);
    const hit = clients.find((c) => c.clid === clid);
    if (!hit) return { ok: false, error: `No client with ID ${clid}.` };
    return { ok: true, value: hit };
  }

  const lower = q.toLowerCase();
  const exact = clients.filter((c) => c.nickname.toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, value: exact[0]! };
  if (exact.length > 1) {
    return { ok: false, error: `Multiple clients named "${q}" — use a client ID.` };
  }

  const prefix = clients.filter((c) => c.nickname.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return { ok: true, value: prefix[0]! };
  if (prefix.length > 1) {
    const names = prefix.map((c) => c.nickname).join(", ");
    return {
      ok: false,
      error: `Ambiguous client "${q}" (${names}) — be more specific or use a client ID.`,
    };
  }

  return { ok: false, error: `No client matching "${q}".` };
}

/** Resolve a channel by numeric cid or exact / unique-prefix channel name. */
export function resolveChannelQuery(
  query: string,
  channels: QueryChannel[],
): ResolveResult<QueryChannel> {
  const q = query.trim();
  if (!q) return { ok: false, error: "Channel name or ID required." };

  if (/^\d+$/.test(q)) {
    const cid = Number.parseInt(q, 10);
    const hit = channels.find((c) => c.cid === cid);
    if (!hit) return { ok: false, error: `No channel with ID ${cid}.` };
    return { ok: true, value: hit };
  }

  const lower = q.toLowerCase();
  const exact = channels.filter((c) => c.name.toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, value: exact[0]! };
  if (exact.length > 1) {
    return { ok: false, error: `Multiple channels named "${q}" — use a channel ID.` };
  }

  const prefix = channels.filter((c) => c.name.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return { ok: true, value: prefix[0]! };
  if (prefix.length > 1) {
    const names = prefix.map((c) => c.name).join(", ");
    return {
      ok: false,
      error: `Ambiguous channel "${q}" (${names}) — be more specific or use a channel ID.`,
    };
  }

  return { ok: false, error: `Channel not found: ${q}` };
}
