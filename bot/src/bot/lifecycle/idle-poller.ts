import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { TS3Client } from "@moneypenny/ts6-client";

export type ChannelClient = Awaited<ReturnType<TS3Client["getClientsInChannel"]>>[number];

export interface IdlePollerDeps {
  config: BotConfig;
  logger: Logger;
  tsClient: Pick<TS3Client, "getClientsInChannel" | "getClientId">;
  isConnected: () => boolean;
  onDisconnect: () => void;
  onPoll: (clients: ChannelClient[], humanCount: number) => void;
  pollIntervalMs?: number;
}

/**
 * Humans present for radio gates / idle disconnect.
 * - Skip TS query clients (`type === 1`)
 * - Skip our own full-client clid (bot is type 0 like listeners)
 * Do **not** use `length - 1` — if the bot is missing from the list, that
 * undercounts and permanently blocks scheduled bumpers (minPresent).
 */
export function countChannelHumans(
  clients: Array<{ id?: number; type?: number }>,
  selfClientId = 0,
): number {
  return clients.filter((c) => {
    if (c.type === 1) return false; // query / server
    if (selfClientId > 0 && c.id === selfClientId) return false;
    return true;
  }).length;
}

/**
 * Channel presence poller: refreshes voice client cache, runs roast ticks,
 * and disconnects after idleTimeoutMinutes when the channel is empty.
 */
export class IdlePoller {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pollChainActive = false;

  constructor(private deps: IdlePollerDeps) {}

  start(): void {
    if (this.pollChainActive) return;
    this.pollChainActive = true;
    const interval = this.deps.pollIntervalMs ?? 30_000;
    const poll = async () => {
      if (!this.pollChainActive) return;
      if (this.deps.isConnected()) {
        try {
          const clients = await this.deps.tsClient.getClientsInChannel();
          const selfId =
            typeof this.deps.tsClient.getClientId === "function"
              ? this.deps.tsClient.getClientId()
              : 0;
          const humanCount = countChannelHumans(clients, selfId);
          this.deps.onPoll(clients, humanCount);
          if (humanCount <= 0) {
            this.scheduleIdleCheck();
          } else {
            this.cancelIdleTimer();
          }
        } catch {
          /* ignore transient TS errors */
        }
      }
      if (this.pollChainActive) {
        setTimeout(poll, interval);
      }
    };
    setTimeout(poll, interval);
  }

  stop(): void {
    this.pollChainActive = false;
    this.cancelIdleTimer();
  }

  updateIdleTimeout(minutes: number): void {
    this.deps.config.idleTimeoutMinutes = minutes;
    if (minutes === 0) this.cancelIdleTimer();
  }

  scheduleIdleCheck(): void {
    if (this.idleTimer !== null) return;
    const minutes = this.deps.config.idleTimeoutMinutes ?? 0;
    if (!this.deps.isConnected() || minutes <= 0) return;
    this.idleTimer = setTimeout(
      () => {
        if (!this.deps.isConnected()) return;
        this.deps.logger.info(
          { idleMinutes: minutes },
          "Channel empty, disconnecting due to idle timeout",
        );
        this.deps.onDisconnect();
      },
      minutes * 60 * 1000,
    );
  }

  cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
