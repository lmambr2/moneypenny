import type { TS3TextMessage, TS3Client } from "../../ts-protocol/client.js";
import type { Logger } from "../../logger.js";
import type { RightsEngine, Subject } from "../../rights/index.js";

/**
 * Doctrine classification ladder (Phase 6 rank-gating). `unclassified` is always
 * readable; higher levels are granted via the rights model as `doctrine:<level>`.
 */
export const DOCTRINE_LEVELS = ["unclassified", "restricted", "confidential", "secret"] as const;

/** Stable conversation key for LLM history (DESIGN §9). */
export function conversationKey(msg: TS3TextMessage): string {
  return msg.targetMode === 1 ? `dm:${msg.invokerUid}` : "channel";
}

/** Best-effort match between a TS nickname and a web login username. */
export function nicknameMatchesUsername(nickname: string, username: string): boolean {
  const nick = nickname.trim().toLowerCase();
  const user = username.trim().toLowerCase();
  if (!nick || !user) return false;
  if (nick === user) return true;
  const words = nick.split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";
  if (first === user || nick.includes(user) || user.includes(first)) return true;
  return words.some(
    (w) => w === user || (w.length >= 3 && user.includes(w)) || (user.length >= 3 && w.includes(user)),
  );
}

/**
 * Resolve the acting user's rights subject by matching their UID against clients
 * in the bot's channel. Falls back to lowest privilege on error.
 */
export async function resolveSubject(
  uid: string,
  tsClient: Pick<TS3Client, "getClientsInChannel" | "getServerGroupsForClient">,
  logger: Logger,
  fallbackGroups?: string[],
  invokerClid?: number,
): Promise<Subject> {
  try {
    const clients = await tsClient.getClientsInChannel();
    let me = clients.find((c) => c.uid === uid);
    if (!me && invokerClid != null && Number.isFinite(invokerClid)) {
      me = clients.find((c) => c.id === invokerClid);
    }
    let groups = me?.serverGroups ?? [];
    if (!groups.length && fallbackGroups?.length) groups = fallbackGroups;
    if (!groups.length && invokerClid != null && Number.isFinite(invokerClid)) {
      groups = await tsClient.getServerGroupsForClient(invokerClid);
    }
    if (me || groups.length) {
      return { uid: me?.uid ?? uid, serverGroups: groups, nickname: me?.nickname };
    }
  } catch (err) {
    logger.warn({ err, uid }, "Failed to resolve rights subject — defaulting to lowest privilege");
  }
  return { uid, serverGroups: fallbackGroups ?? [] };
}

/**
 * Web UI subject: admins inherit configured TS admin groups; members are matched
 * to a client in the bot's channel by nickname so rank gating follows TS rank.
 */
export async function resolveWebSubject(
  user: { id: string; username: string; role: "admin" | "member" },
  tsClient: Pick<TS3Client, "getClientsInChannel">,
  adminGroups: string[],
  logger: Logger,
): Promise<Subject> {
  if (user.role === "admin") {
    return {
      uid: `web:${user.id}`,
      serverGroups: adminGroups.map(String),
      nickname: user.username,
    };
  }
  try {
    const clients = await tsClient.getClientsInChannel();
    const match = clients.find((c) => nicknameMatchesUsername(c.nickname, user.username));
    if (match) {
      return {
        uid: match.uid,
        serverGroups: (match.serverGroups ?? []).map(String),
        nickname: match.nickname,
      };
    }
  } catch (err) {
    logger.debug({ err, username: user.username }, "Web subject: TS channel lookup failed");
  }
  return { uid: `web:${user.id}`, serverGroups: [], nickname: user.username };
}

/** Doctrine classifications the subject may retrieve (Phase 6 rank-gating). */
export function allowedClassificationsFor(
  subject: Subject,
  engine: RightsEngine | null,
): string[] | undefined {
  if (!engine) return undefined;
  return DOCTRINE_LEVELS.filter(
    (level) => level === "unclassified" || engine.can(subject, `doctrine:${level}`),
  );
}