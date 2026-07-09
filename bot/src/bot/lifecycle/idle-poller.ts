import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { TS3Client } from "../../ts-protocol/client.js";

export type ChannelClient = Awaited<ReturnType<TS3Client["getClientsInChannel"]>>[number];

export interface IdlePollerDeps {
  config: BotConfig;
  logger: Logger;
  tsClient: Pick<TS3Client, "getClientsInChannel">;
  isConnected: () => boolean;
  onDisconnect: () => void;
  onPoll: (clients: ChannelClient[], humanCount: number) => void;
  pollIntervalMs?: number;
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
          const humanCount = clients.length - 1;
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
