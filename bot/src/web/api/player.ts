import { Router, type Request, type Response } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { BotDatabase } from "../../data/database.js";
import type { MusicProvider, Song } from "../../music/provider.js";
import type { Logger } from "../../logger.js";
import { parseCommand, type ParsedCommand } from "../../bot/commands.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { requireBot } from "./bot-request.js";
import "./bot-request.js";
import type { BotInstance } from "../../bot/instance.js";
import type { QueuedSong } from "../../audio/queue.js";

const VALID_PLATFORMS = new Set(["local", "youtube", "stream"]);

function parsePlatform(platform: unknown): "local" | "youtube" | "stream" {
  if (platform === "local" || platform === "stream" || platform === "youtube") return platform;
  return "youtube";
}

function requirePlatform(platform: unknown, res: Response): "local" | "youtube" | "stream" | null {
  if (typeof platform === "string" && VALID_PLATFORMS.has(platform)) {
    return platform as "local" | "youtube" | "stream";
  }
  res.status(400).json({ error: "platform must be local, youtube, or stream", code: "VALIDATION_ERROR" });
  return null;
}

/** Load songs into the queue and start playback with retry-skip on resolve failures. */
async function loadAndPlay(
  bot: BotInstance,
  songs: Song[],
  platform: MusicProvider["platform"],
  maxRetries = 20,
): Promise<{ started: boolean; playing: QueuedSong | null; count: number }> {
  const queue = bot.getQueueManager();
  queue.clear();
  for (const song of songs) {
    queue.add({ ...song, platform });
  }
  const mode = queue.getMode();
  const first =
    mode === "random" || mode === "rloop"
      ? queue.playAt(Math.floor(Math.random() * queue.size()))
      : queue.play();
  let started = first ? await bot.resolveAndPlay(first) : false;
  if (first && !started) {
    started = await bot.playNext(maxRetries);
  }
  return { started, playing: queue.current(), count: songs.length };
}

export function createPlayerRouter(
  botManager: BotManager,
  logger: Logger,
  database?: BotDatabase,
): Router {
  const router = Router();

  router.use("/:botId", (req, res, next) => {
    const bot = botManager.getBot(req.params.botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    req.bot = bot;
    next();
  });

  // Rate limit player actions to prevent abuse/DoS (generous for UI use)
  const playerLimit = createRateLimit({
    capacity: 60,
    refillPerSec: 5,
    message: (waitSec) => `Player actions rate limited. Please wait ${waitSec}s before issuing more commands.`,
  });
  router.use(playerLimit);

  /** Map API platform string to the corresponding command flag. */
  const platformFlag = (platform: unknown): string => {
    if (platform === "youtube") return "-y";
    if (platform === "stream") return "-s";
    if (platform === "local") return "-l";
    return "";
  };

  const permissionDenied = (res: Response, message: string) => {
    res.status(403).json({ error: message, code: "PERMISSION_DENIED" });
  };

  const denyUnless = async (bot: BotInstance, req: Request, res: Response, command: string): Promise<boolean> => {
    if (!req.user || await bot.canWebUserRunCommand(req.user, command)) return true;
    permissionDenied(res, `You don't have permission to use '${command}'.`);
    return false;
  };

  const runRoutedCommand = async (
    bot: BotInstance,
    req: Request,
    res: Response,
    cmd: ParsedCommand,
  ): Promise<void> => {
    const { message, denied } = await bot.executeRoutedCommand(
      cmd,
      req.user ? { webUser: req.user } : undefined,
    );
    if (denied) {
      permissionDenied(res, message ?? "Permission denied");
      return;
    }
    res.json({ message });
  };

  router.post("/:botId/play", async (req, res) => {
    try {
      const bot = requireBot(req);
      const { query, platform } = req.body;
      if (!query) {
        res.status(400).json({ error: "query is required", code: "VALIDATION_ERROR" });
        return;
      }
      const cmd = parseCommand(`!play ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command", code: "VALIDATION_ERROR" });
        return;
      }
      await runRoutedCommand(bot, req, res, cmd);
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  router.post("/:botId/add", async (req, res) => {
    try {
      const bot = requireBot(req);
      const { query, platform } = req.body;
      if (!query || typeof query !== "string" || !query.trim()) {
        res.status(400).json({ error: "query is required", code: "VALIDATION_ERROR" });
        return;
      }
      const cmd = parseCommand(`!add ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command", code: "VALIDATION_ERROR" });
        return;
      }
      await runRoutedCommand(bot, req, res, cmd);
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  const simpleCommand = (cmdStr: string) => async (req: Request, res: Response) => {
    try {
      const bot = requireBot(req);
      const cmd = parseCommand(cmdStr, "!")!;
      await runRoutedCommand(bot, req, res, cmd);
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  };

  router.post("/:botId/pause", simpleCommand("!pause"));
  router.post("/:botId/resume", simpleCommand("!resume"));
  router.post("/:botId/next", simpleCommand("!next"));
  router.post("/:botId/prev", simpleCommand("!prev"));
  router.post("/:botId/stop", requireAdmin, simpleCommand("!stop"));
  router.post("/:botId/clear", requireAdmin, simpleCommand("!clear"));

  router.post("/:botId/volume", async (req, res) => {
    try {
      const bot = requireBot(req);
      if (!await denyUnless(bot, req, res, "vol")) return;
      const { volume } = req.body;
      // Reject bad input with a proper 4xx instead of letting cmdVol
      // return a "Usage:" string inside a 200 body — API clients can't
      // detect that failure mode, and the UI would silently swallow it.
      if (
        typeof volume !== "number" ||
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > 100
      ) {
        res
          .status(400)
          .json({ error: "volume must be a number between 0 and 100" });
        return;
      }
      const cmd = parseCommand(`!vol ${Math.round(volume)}`, "!")!;
      await runRoutedCommand(bot, req, res, cmd);
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  const VALID_MODES = new Set(["seq", "loop", "random", "rloop"]);

  router.post("/:botId/mode", requireAdmin, async (req, res) => {
    try {
      const bot = requireBot(req);
      const { mode } = req.body;
      if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
        res
          .status(400)
          .json({ error: "mode must be one of: seq, loop, random, rloop" });
        return;
      }
      const cmd = parseCommand(`!mode ${mode}`, "!")!;
      await runRoutedCommand(bot, req, res, cmd);
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  // Get current elapsed time (ground truth from server)
  router.get("/:botId/elapsed", (req, res) => {
    const bot = requireBot(req);
    res.json({ elapsed: bot.getPlayer().getElapsed() });
  });

  // Seek to position
  router.post("/:botId/seek", requireAdmin, async (req, res) => {
    try {
      const bot = requireBot(req);
      const { position } = req.body; // seconds
      // typeof NaN === "number" and NaN < 0 is false, so a plain range
      // check lets NaN/Infinity through and later corrupts seekOffset.
      if (typeof position !== "number" || !Number.isFinite(position) || position < 0) {
        res
          .status(400)
          .json({ error: "position must be a finite non-negative number" });
        return;
      }
      bot.getPlayer().seek(position);
      res.json({ message: `Seeked to ${Math.floor(position)}s`, seekOffset: position });
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  router.get("/:botId/queue", (req, res) => {
    const bot = requireBot(req);
    res.json({ queue: bot.getQueue(), status: bot.getStatus() });
  });

  router.delete("/:botId/queue/:index", requireAdmin, async (req, res) => {
    try {
      const bot = requireBot(req);
      const cmd = parseCommand(`!remove ${req.params.index}`, "!")!;
      await runRoutedCommand(bot, req, res, cmd);
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  // Jump to a specific index in the queue (without clearing it)
  router.post("/:botId/play-at", requireAdmin, async (req, res) => {
    try {
      const bot = requireBot(req);
      if (!await denyUnless(bot, req, res, "play")) return;
      const { index } = req.body;
      if (typeof index !== "number" || index < 0) {
        res.status(400).json({ error: "index is required", code: "VALIDATION_ERROR" });
        return;
      }
      const queue = bot.getQueueManager();
      // Validate the index BEFORE stopping current playback — otherwise an
      // invalid index silently kills the user's current song and leaves the
      // queue idle.
      if (index >= queue.size()) {
        res.status(400).json({ error: "Invalid queue index", code: "VALIDATION_ERROR" });
        return;
      }
      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();
      const song = queue.playAt(index);
      if (!song) {
        res.status(400).json({ error: "Invalid queue index", code: "VALIDATION_ERROR" });
        return;
      }
      const ok = await bot.resolveAndPlay(song);
      if (!ok) {
        res.json({ message: `Cannot play: ${song.name}` });
        return;
      }
      res.json({ message: `Now playing: ${song.name} - ${song.artist}` });
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  // Music-request endpoints (play/queue a specific song, playlist, or album) are
  // available to any authenticated user — same capability as /play and /add, and
  // what the web UI uses for normal playback. Only disruptive/curational controls
  // (stop, clear, mode, seek, remove, play-at, profile) require admin; volume uses rank gating.
  router.post("/:botId/playlist", async (req, res) => {
    try {
      const bot = requireBot(req);
      const { playlistId, platform } = req.body;
      const cmd = parseCommand(
        `!playlist ${platformFlag(platform)} ${playlistId}`.trim(),
        "!"
      )!;
      await runRoutedCommand(bot, req, res, cmd);
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  // Play a playlist by ID — stores metadata only, resolves URL for first song
  // Respects current play mode (random = pick random first song)
  router.post("/:botId/play-playlist", async (req, res) => {
    try {
      const bot = requireBot(req);
      if (!await denyUnless(bot, req, res, "playlist")) return;
      const { playlistId, platform } = req.body;
      // Use the bot's own provider lookup — it already knows about youtube,
      // which the router's constructor params did not.
      const provider = bot.getProviderFor(parsePlatform(platform));

      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();

      const songs = await provider.getPlaylistSongs(playlistId);
      if (songs.length === 0) {
        res.json({ message: "Playlist is empty" });
        return;
      }

      const { started, playing, count } = await loadAndPlay(bot, songs, provider.platform);
      const loadedMsg = `${count} tracks loaded`;
      if (started && playing) {
        res.json({ ok: true, message: `${loadedMsg}, now playing: ${playing.name}` });
      } else {
        res.json({ ok: false, message: `${loadedMsg}, but playback could not start.` });
      }
    } catch (err) {
      logger.error({ err }, "Play playlist failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play an album by ID — mirrors play-playlist but calls getAlbumSongs
  router.post("/:botId/play-album", async (req, res) => {
    try {
      const bot = requireBot(req);
      if (!await denyUnless(bot, req, res, "album")) return;
      const { albumId, platform } = req.body;
      const provider = bot.getProviderFor(parsePlatform(platform));

      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();

      const songs = await provider.getAlbumSongs(albumId);
      if (songs.length === 0) {
        res.json({ message: "Album is empty" });
        return;
      }

      const { started, playing, count } = await loadAndPlay(bot, songs, provider.platform);
      const loadedMsg = `${count} tracks loaded`;
      if (started && playing) {
        res.json({ ok: true, message: `${loadedMsg}, now playing: ${playing.name}` });
      } else {
        res.json({ ok: false, message: `${loadedMsg}, but playback could not start.` });
      }
    } catch (err) {
      logger.error({ err }, "play-album failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a single song by ID — resolves URL on demand
  router.post("/:botId/play-song", async (req, res) => {
    try {
      const bot = requireBot(req);
      if (!await denyUnless(bot, req, res, "play")) return;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required", code: "VALIDATION_ERROR" });
        return;
      }
      if (!requirePlatform(song.platform, res)) return;
      const queue = bot.getQueueManager();
      queue.clear();
      queue.add(song);
      queue.play();

      bot.getPlayer().resetFailures();
      const ok = await bot.resolveAndPlay(queue.current()!);
      if (!ok) {
        res.json({ ok: false, message: `Cannot play "${song.name || song.id}" (source or region restriction)` });
        return;
      }

      res.json({ ok: true, message: `Now playing: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` });
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  // Insert a single song to play right after the current one.
  // If nothing is playing, behaves like /play-song (start immediately).
  router.post("/:botId/play-next-song", async (req, res) => {
    try {
      const bot = requireBot(req);
      if (!await denyUnless(bot, req, res, "play")) return;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required", code: "VALIDATION_ERROR" });
        return;
      }
      if (!requirePlatform(song.platform, res)) return;
      const queue = bot.getQueueManager();
      const wasIdle = bot.getPlayer().getState() === "idle";
      // Capture the slot addNext WILL insert at, before mutating the queue.
      // addNext pushes when currentIndex<0 (slot = size); otherwise splices
      // at currentIndex+1. Using size-1 after addNext was wrong when the
      // queue had stale currentIndex>=0 while the player was idle (e.g.,
      // after natural track end without queue.clear()).
      const insertedAt =
        queue.getCurrentIndex() < 0 ? queue.size() : queue.getCurrentIndex() + 1;
      queue.addNext(song);

      if (wasIdle) {
        // Promote the just-added song to current and start it.
        queue.playAt(insertedAt);
        bot.getPlayer().resetFailures();
        const ok = await bot.resolveAndPlay(queue.current()!);
        if (!ok) {
          res.json({ ok: false, message: `Cannot play "${song.name || song.id}" (source or region restriction)` });
          return;
        }
        res.json({ ok: true, message: `Now playing: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` });
        return;
      }

      res.json({ ok: true, message: `Added next: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` });
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  router.post("/:botId/add-song", async (req, res) => {
    try {
      const bot = requireBot(req);
      if (!await denyUnless(bot, req, res, "add")) return;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required", code: "VALIDATION_ERROR" });
        return;
      }
      if (!requirePlatform(song.platform, res)) return;
      const queue = bot.getQueueManager();
      const wasIdle = bot.getPlayer().getState() === "idle";
      queue.add(song);

      // If nothing was playing, start this newly-added song immediately.
      if (wasIdle) {
        queue.playAt(queue.size() - 1);
        bot.getPlayer().resetFailures();
        await bot.resolveAndPlay(queue.current()!);
        res.json({ message: `Now playing: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` });
        return;
      }

      res.json({ message: `Added to queue: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'} (position ${queue.size()})` });
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  // Add a song to queue by ID — metadata only
  router.post("/:botId/add-by-id", async (req, res) => {
    try {
      const bot = requireBot(req);
      if (!await denyUnless(bot, req, res, "add")) return;
      const { songId, platform } = req.body;
      const provider = bot.getProviderFor(parsePlatform(platform));

      const song = await provider.getSongDetail(songId);
      if (!song) {
        res.json({ message: "Song not found" });
        return;
      }

      const queue = bot.getQueueManager();
      queue.add({ ...song, platform: provider.platform });

      // If nothing is playing, start the first song
      if (bot.getPlayer().getState() === "idle") {
        const first = queue.play();
        if (first) await bot.resolveAndPlay(first);
      }

      res.json({ message: `Added: ${song.name} - ${song.artist} (position ${queue.size()})` });
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  // --- Profile config endpoints ---

  router.get("/:botId/profile", (req, res) => {
    const bot = requireBot(req);
    res.json(bot.getProfileManager().getConfig());
  });

  router.put("/:botId/profile", requireAdmin, (req, res) => {
    try {
      const bot = requireBot(req);
      const pm = bot.getProfileManager();
      pm.updateConfig(req.body);
      if (database) {
        database.saveProfileConfig(bot.id, pm.getConfig());
      }
      res.json(pm.getConfig());
    } catch (err) {
      logger.error({ err }, "Player API error");
      res.status(500).json({ error: "internal error" });
    }
  });

  router.get("/:botId/history", (req, res) => {
    if (!database) {
      res.json({ history: [] });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const botId = String(req.params.botId);
    const records = database.getPlayHistory(botId, limit);
    const history = records.map((r) => ({
      id: r.songId,
      name: r.songName,
      artist: r.artist,
      album: r.album,
      duration: 0,
      coverUrl: r.coverUrl,
      platform: r.platform,
      playedAt: r.playedAt,
    }));
    res.json({ history });
  });

  return router;
}
