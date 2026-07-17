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
