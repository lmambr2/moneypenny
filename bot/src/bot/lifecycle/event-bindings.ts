import type { AudioPlayer } from "../../audio/player.js";
import type { TS3Client, TS3TextMessage } from "../../ts-protocol/client.js";
import type { Logger } from "../../logger.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { IdlePoller } from "./idle-poller.js";
import type { TextMessageHandler } from "../control/text-handler.js";
import type { PokeHandler } from "../control/poke-handler.js";
import type { VoiceSession } from "../voice/session.js";
import type { RadioDirector } from "../../radio/index.js";
import type { TS3Poke } from "../../ts-protocol/client.js";

export interface PlayerEventBindings {
  player: AudioPlayer;
  tsClient: TS3Client;
  voice: VoiceSession;
  radio: RadioDirector;
  logger: Logger;
  playNext: () => Promise<boolean>;
  /**
   * Optional second sink for volume-adjusted PCM (Icecast tee R-R6).
   * Called for every frame while the player is running; must never throw.
   */
  onPcm?: (pcm: Buffer) => void;
}

export function bindPlayerEvents(deps: PlayerEventBindings): void {
  deps.player.on("frame", (opusFrame: Buffer) => {
    deps.tsClient.sendVoiceData(opusFrame);
  });

  // Program PCM → Icecast tee (and any other secondary sink). Fail-open.
  deps.player.on("pcm", (pcm: Buffer) => {
    if (!deps.onPcm) return;
    try {
      deps.onPcm(pcm);
    } catch (err) {
      deps.logger.debug?.({ err }, "onPcm sink failed (ignored)");
    }
  });

  deps.player.on("trackEnd", () => {
    // Voice keeps precedence: if it resumed its saved music, we're done. Otherwise
    // the radio director decides — inject a bumper or advance the queue. While
    // radio is disabled onTrackBoundary() just calls playNext(), byte-identical
    // to the previous bare-playNext path (docs/radio.md §5.1).
    void deps.voice.handleTrackEnd(() => deps.playNext()).then((resumed) => {
      if (resumed) return;
      deps.logger.debug("Track ended, advancing queue");
      deps.radio.onTrackBoundary().catch((err) => {
        deps.logger.error({ err }, "radio.onTrackBoundary failed after trackEnd");
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
  poke: PokeHandler;
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

  deps.tsClient.on("poke", (poke: TS3Poke) => {
    deps.poke.handle(poke).catch((err) => {
      deps.logger.error({ err }, "Unhandled error in poke handler");
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