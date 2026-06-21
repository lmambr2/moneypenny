import type { AudioPlayer } from "../../audio/player.js";
import type { TS3Client, TS3TextMessage } from "../../ts-protocol/client.js";
import type { Logger } from "../../logger.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { IdlePoller } from "./idle-poller.js";
import type { TextMessageHandler } from "../control/text-handler.js";
import type { VoiceSession } from "../voice/session.js";

export interface PlayerEventBindings {
  player: AudioPlayer;
  tsClient: TS3Client;
  voice: VoiceSession;
  logger: Logger;
  playNext: () => Promise<boolean>;
}

export function bindPlayerEvents(deps: PlayerEventBindings): void {
  deps.player.on("frame", (opusFrame: Buffer) => {
    deps.tsClient.sendVoiceData(opusFrame);
  });

  deps.player.on("trackEnd", () => {
    void deps.voice.handleTrackEnd(() => deps.playNext()).then((resumed) => {
      if (resumed) return;
      deps.logger.debug("Track ended, advancing queue");
      deps.playNext().catch((err) => {
        deps.logger.error({ err }, "playNext failed after trackEnd");
      });
    });
  });

  deps.player.on("error", (err: Error) => {
    deps.voice.onPlayerError();
    deps.logger.error({ err }, "Player error");
    deps.playNext().catch((err2) => {
      deps.logger.error({ err: err2 }, "playNext failed after player error");
    });
  });
}

export interface TsEventBindings {
  tsClient: TS3Client;
  text: TextMessageHandler;
  idlePoller: IdlePoller;
  knowledge: KnowledgeService;
  player: AudioPlayer;
  voice: VoiceSession;
  logger: Logger;
  setConnected: (v: boolean) => void;
  isDisconnectEmitted: () => boolean;
  setDisconnectEmitted: (v: boolean) => void;
  emitDisconnected: () => void;
}

export function bindTsEvents(deps: TsEventBindings): void {
  deps.tsClient.on("textMessage", (msg: TS3TextMessage) => {
    deps.text.handle(msg).catch((err) => {
      deps.logger.error({ err }, "Unhandled error in text message handler");
    });
  });

  deps.tsClient.on("disconnected", () => {
    // Always reset local state — covers the case where connect() never
    // completed (hanging handshake → 60s library idle timeout) and
    // connected was never flipped to true. Previously this handler
    // short-circuited on !connected, leaving player stuck as "playing".
    deps.setConnected(false);
    deps.player.stop();
    deps.voice.cleanup();
    if (deps.isDisconnectEmitted()) return;
    deps.setDisconnectEmitted(true);
    deps.emitDisconnected();
  });

  deps.tsClient.on("connected", () => {
    deps.idlePoller.start();
    deps.knowledge.startFileDropWatcher();
  });
}