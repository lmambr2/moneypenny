/**
 * H6 — channel/server scope (minimal usable ship).
 * Queue/player remain one stream; config documents which channel/server the
 * bot is intended to serve so status APIs are not a silent global assumption.
 */

export interface BotScopeConfig {
  /**
   * Preferred TeamSpeak channel name or id for presence/radio context.
   * Empty = follow wherever the bot currently sits.
   */
  channelHint: string;
  /**
   * Human label for this bot instance's server (multi-server ops).
   * Empty = use bot name / default.
   */
  serverLabel: string;
  /** Optional virtual server id string for docs/ops (not auto-switched yet). */
  virtualServerId: string;
}

export function defaultBotScope(): BotScopeConfig {
  return {
    channelHint: "",
    serverLabel: "",
    virtualServerId: "",
  };
}

export function parseBotScope(raw: unknown): BotScopeConfig {
  const d = defaultBotScope();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const o = raw as Record<string, unknown>;
  return {
    channelHint: typeof o.channelHint === "string" ? o.channelHint.trim() : d.channelHint,
    serverLabel: typeof o.serverLabel === "string" ? o.serverLabel.trim() : d.serverLabel,
    virtualServerId:
      typeof o.virtualServerId === "string" ? o.virtualServerId.trim() : d.virtualServerId,
  };
}

export interface ResolvedScope {
  channelHint: string | null;
  serverLabel: string;
  virtualServerId: string | null;
  /** True when operator pinned a channel hint (not free-roam). */
  channelPinned: boolean;
}

export function resolveScope(
  scope: BotScopeConfig,
  opts?: { botName?: string; currentChannelName?: string | null },
): ResolvedScope {
  const hint = scope.channelHint.trim();
  return {
    channelHint: hint || null,
    serverLabel: scope.serverLabel.trim() || opts?.botName?.trim() || "default",
    virtualServerId: scope.virtualServerId.trim() || null,
    channelPinned: hint.length > 0,
  };
}
