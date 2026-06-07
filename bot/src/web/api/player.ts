import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { BotDatabase } from "../../data/database.js";
import type { MusicProvider } from "../../music/provider.js";
import type { Logger } from "../../logger.js";
import { parseCommand } from "../../bot/commands.js";

export function createPlayerRouter(
  botManager: BotManager,
  logger: Logger,
  database?: BotDatabase,
  localProvider?: MusicProvider,
  youtubeProvider?: MusicProvider,
): Router {
  const router = Router();

  router.use("/:botId", (req, res, next) => {
    const bot = botManager.getBot(req.params.botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    (req as any).bot = bot;
    next();
  });

  /** Map API platform string to the corresponding command flag. */
  const platformFlag = (platform: unknown): string => {
    if (platform === "youtube") return "-y";
    return "";
  };

  router.post("/:botId/play", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      if (!query) {
        res.status(400).json({ error: "query is required" });
        return;
      }
      const cmd = parseCommand(`!play ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/add", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      const cmd = parseCommand(`!add ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const simpleCommand = (cmdStr: string) => async (req: any, res: any) => {
    try {
      const bot = req.bot;
      const cmd = parseCommand(cmdStr, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  };

  router.post("/:botId/pause", simpleCommand("!pause"));
  router.post("/:botId/resume", simpleCommand("!resume"));
  router.post("/:botId/next", simpleCommand("!next"));
  router.post("/:botId/prev", simpleCommand("!prev"));
  router.post("/:botId/stop", simpleCommand("!stop"));
  router.post("/:botId/clear", simpleCommand("!clear"));

  router.post("/:botId/volume", async (req, res) => {
    try {
      const bot = (req as any).bot;
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
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const VALID_MODES = new Set(["seq", "loop", "random", "rloop"]);

  router.post("/:botId/mode", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { mode } = req.body;
      if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
        res
          .status(400)
          .json({ error: "mode must be one of: seq, loop, random, rloop" });
        return;
      }
      const cmd = parseCommand(`!mode ${mode}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get current elapsed time (ground truth from server)
  router.get("/:botId/elapsed", (req, res) => {
    const bot = (req as any).bot;
    res.json({ elapsed: bot.getPlayer().getElapsed() });
  });

  // Seek to position
  router.post("/:botId/seek", async (req, res) => {
    try {
      const bot = (req as any).bot;
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/queue", (req, res) => {
    const bot = (req as any).bot;
    res.json({ queue: bot.getQueue(), status: bot.getStatus() });
  });

  router.delete("/:botId/queue/:index", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const cmd = parseCommand(`!remove ${req.params.index}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Jump to a specific index in the queue (without clearing it)
  router.post("/:botId/play-at", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { index } = req.body;
      if (typeof index !== "number" || index < 0) {
        res.status(400).json({ error: "index is required" });
        return;
      }
      const queue = bot.getQueueManager();
      // Validate the index BEFORE stopping current playback — otherwise an
      // invalid index silently kills the user's current song and leaves the
      // queue idle.
      if (index >= queue.size()) {
        res.status(400).json({ error: "Invalid queue index" });
        return;
      }
      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();
      const song = queue.playAt(index);
      if (!song) {
        res.status(400).json({ error: "Invalid queue index" });
        return;
      }
      const ok = await bot.resolveAndPlay(song);
      if (!ok) {
        res.json({ message: `Cannot play: ${song.name}` });
        return;
      }
      res.json({ message: `Now playing: ${song.name} - ${song.artist}` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/playlist", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { playlistId, platform } = req.body;
      const cmd = parseCommand(
        `!playlist ${platformFlag(platform)} ${playlistId}`.trim(),
        "!"
      )!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a playlist by ID — stores metadata only, resolves URL for first song
  // Respects current play mode (random = pick random first song)
  router.post("/:botId/play-playlist", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { playlistId, platform } = req.body;
      // Use the bot's own provider lookup — it already knows about youtube,
      // which the router's constructor params did not.
      const provider = bot.getProviderFor(
        platform === "local" || platform === "stream" || platform === "youtube"
          ? platform
          : "youtube"
      );

      // Stop current playback
      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();

      const songs = await provider.getPlaylistSongs(playlistId);
      if (songs.length === 0) {
        res.json({ message: "Playlist is empty" });
        return;
      }

      // QQ-specific optimization: many users' QQ playlists contain a
      // large fraction of songs that return result=104003 (region/copyright
      // restricted). Batch-resolve URLs once and only queue the playable
      // ones, otherwise the playback retry loop wastes time guessing.
      let queueable: { id: string }[] = songs;
      const totalCount = songs.length;
      const qqLike = provider as { getPlayableSongIds?: (ids: string[]) => Promise<Set<string> | null> };
      if (typeof qqLike.getPlayableSongIds === "function") {
        const playable = await qqLike.getPlayableSongIds(songs.map((s: { id: string }) => s.id));
        if (playable !== null) {
          // Authoritative answer from upstream — even an empty set means
          // "we know none are playable", short-circuit immediately rather
          // than wasting 20+ retries.
          queueable = songs.filter((s: { id: string }) => playable.has(s.id));
        }
        // If null, the batch endpoint itself errored — fall through to
        // the sequential retry path, which still has a chance.
      }
      if (queueable.length === 0) {
        res.json({ ok: false, message: `Playlist has ${totalCount} tracks but none could be played (region or source restrictions)` });
        return;
      }

      const queue = bot.getQueueManager();
      queue.clear();
      for (const song of queueable) {
        queue.add({ ...song, platform: provider.platform });
      }

      // Use queue.play() for sequential, or pick random index for random modes
      const mode = queue.getMode();
      let first;
      if (mode === "random" || mode === "rloop") {
        const idx = Math.floor(Math.random() * queue.size());
        first = queue.playAt(idx);
      } else {
        first = queue.play();
      }

      // If the first picked song can't resolve (e.g., QQ song with no
      // streaming entitlement → result 104003), fall back to playNext's
      // retry-skip behavior. Use a higher retry budget than the default
      // trackEnd auto-advance because user-initiated playlist plays
      // commonly have long contiguous runs of unplayable songs.
      let started = first ? await bot.resolveAndPlay(first) : false;
      if (first && !started) {
        started = await bot.playNext(20);
      }

      const playing = queue.current();
      const loadedMsg = queueable.length < totalCount
        ? `${queueable.length}/${totalCount} tracks loaded (some skipped due to restrictions)`
        : `${queueable.length} tracks loaded`;
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
      const bot = (req as any).bot;
      const { albumId, platform } = req.body;
      const provider = bot.getProviderFor(
        platform === "local" || platform === "stream" || platform === "youtube"
          ? platform
          : "youtube"
      );

      // Stop current playback
      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();

      const songs = await provider.getAlbumSongs(albumId);
      if (songs.length === 0) {
        res.json({ message: "Album is empty" });
        return;
      }

      // QQ-specific optimization: batch-resolve playable IDs to avoid
      // wasting retries on region/copyright-restricted tracks.
      let queueable: { id: string }[] = songs;
      const totalCount = songs.length;
      const qqLike = provider as { getPlayableSongIds?: (ids: string[]) => Promise<Set<string> | null> };
      if (typeof qqLike.getPlayableSongIds === "function") {
        const playable = await qqLike.getPlayableSongIds(songs.map((s: { id: string }) => s.id));
        if (playable !== null) {
          queueable = songs.filter((s: { id: string }) => playable.has(s.id));
        }
      }
      if (queueable.length === 0) {
        res.json({ ok: false, message: `Album has ${totalCount} tracks but none could be played (region or source restrictions)` });
        return;
      }

      const queue = bot.getQueueManager();
      queue.clear();
      for (const song of queueable) {
        queue.add({ ...song, platform: provider.platform });
      }

      const mode = queue.getMode();
      let first;
      if (mode === "random" || mode === "rloop") {
        const idx = Math.floor(Math.random() * queue.size());
        first = queue.playAt(idx);
      } else {
        first = queue.play();
      }

      let started = first ? await bot.resolveAndPlay(first) : false;
      if (first && !started) {
        started = await bot.playNext(20);
      }

      const playing = queue.current();
      const loadedMsg = queueable.length < totalCount
        ? `${queueable.length}/${totalCount} tracks loaded (some skipped due to restrictions)`
        : `${queueable.length} tracks loaded`;
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
      const bot = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Insert a single song to play right after the current one.
  // If nothing is playing, behaves like /play-song (start immediately).
  router.post("/:botId/play-next-song", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/add-song", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Add a song to queue by ID — metadata only
  router.post("/:botId/add-by-id", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { songId, platform } = req.body;
      const provider = bot.getProviderFor(
        platform === "local" || platform === "stream" || platform === "youtube"
          ? platform
          : "youtube"
      );

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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Profile config endpoints ---

  router.get("/:botId/profile", (req, res) => {
    const bot = (req as any).bot;
    res.json(bot.getProfileManager().getConfig());
  });

  router.put("/:botId/profile", (req, res) => {
    try {
      const bot = (req as any).bot;
      const pm = bot.getProfileManager();
      pm.updateConfig(req.body);
      if (database) {
        database.saveProfileConfig(bot.id, pm.getConfig());
      }
      res.json(pm.getConfig());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/history", (req, res) => {
    if (!database) {
      res.json({ history: [] });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const records = database.getPlayHistory(req.params.botId, limit);
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
