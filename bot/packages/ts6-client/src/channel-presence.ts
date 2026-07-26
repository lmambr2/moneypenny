/**
 * Pure helpers for "who is in my channel" (radio presence gate).
 * TeamSpeak clientlist channel ids are bigint; the library's in-memory map can
 * lag (e.g. join returns "already member" without updating channelID → 0n),
 * which previously filtered everyone out and blocked scheduled bumpers.
 */

export function asChannelId(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.trim() !== "") {
    try {
      return BigInt(v.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function sameChannelId(a: unknown, b: unknown): boolean {
  return asChannelId(a) === asChannelId(b);
}

/**
 * Pick the bot's channel id: prefer self-row from clientlist, then library map,
 * then optional HTTP-resolved cid.
 */
export function resolveOwnChannelId(opts: {
  selfClientId: number;
  libraryChannelId?: unknown;
  allClients?: Array<{ id?: number; channelID?: unknown }>;
  httpChannelId?: unknown;
}): bigint {
  const selfId = opts.selfClientId;
  if (selfId > 0 && opts.allClients?.length) {
    const self = opts.allClients.find((c) => c.id === selfId);
    const fromList = asChannelId(self?.channelID);
    if (fromList !== 0n) return fromList;
  }
  const fromLib = asChannelId(opts.libraryChannelId);
  if (fromLib !== 0n) return fromLib;
  const fromHttp = asChannelId(opts.httpChannelId);
  if (fromHttp !== 0n) return fromHttp;
  return 0n;
}

/** Clients currently in `myChannelId` (includes the bot row if present). */
export function filterClientsInChannel<T extends { id?: number; channelID?: unknown }>(
  all: T[],
  myChannelId: bigint,
): T[] {
  if (myChannelId === 0n) return [];
  return all.filter((c) => sameChannelId(c.channelID, myChannelId));
}

/** A channel and how many humans are sitting in it. */
export interface ChannelPopulation {
  channelId: bigint;
  humans: number;
}

export interface BusiestChannelOpts {
  /** The bot's own clid — never counted as company. */
  selfClientId?: number;
  /** Channel the bot is in now; excluded so "move" always means a real move. */
  currentChannelId?: unknown;
  /** Channels the bot must never follow people into (AFK, and similar). */
  excludeChannelIds?: readonly bigint[];
}

/**
 * Tally humans per channel across the whole server.
 *
 * Query clients (`type === 1`) are serverquery/HTTP sessions, not people, and
 * the bot's own row is not company either — counting either would make the bot
 * think an empty channel is occupied.
 */
export function tallyChannelPopulations<
  T extends { id?: number; type?: number; channelID?: unknown },
>(all: readonly T[], selfClientId = 0): ChannelPopulation[] {
  const counts = new Map<string, ChannelPopulation>();
  for (const c of all) {
    if (c.type === 1) continue;
    if (selfClientId > 0 && c.id === selfClientId) continue;
    const channelId = asChannelId(c.channelID);
    if (channelId === 0n) continue; // unknown channel — cannot follow into it
    const key = channelId.toString();
    const row = counts.get(key);
    if (row) row.humans += 1;
    else counts.set(key, { channelId, humans: 1 });
  }
  return [...counts.values()];
}

/**
 * Pick the channel the bot should follow people into, or null to stay put.
 *
 * Returns the most-populated eligible channel. Ties break toward the lowest
 * channel id purely so the choice is deterministic — otherwise two equally
 * busy channels could make the bot hop back and forth on every poll.
 */
export function pickBusiestChannel<T extends { id?: number; type?: number; channelID?: unknown }>(
  all: readonly T[],
  opts: BusiestChannelOpts = {},
): bigint | null {
  const current = asChannelId(opts.currentChannelId);
  const excluded = new Set((opts.excludeChannelIds ?? []).map((id) => id.toString()));

  const eligible = tallyChannelPopulations(all, opts.selfClientId ?? 0).filter((p) => {
    if (p.humans <= 0) return false;
    if (current !== 0n && p.channelId === current) return false;
    return !excluded.has(p.channelId.toString());
  });
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (b.humans !== a.humans) return b.humans - a.humans;
    return a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0;
  });
  return eligible[0]?.channelId ?? null;
}
