import type Database from "better-sqlite3";
import type { Logger } from "../../logger.js";
import type { MusicProvider } from "../../music/provider.js";
import {
  YtLibrary,
  type YtLibraryLocalSource,
  type YtLibraryYoutubeSource,
} from "../../music/ytlibrary.js";

/** Wire YouTube → permanent local library (ROADMAP adjacent feature). */
export function createYtLibrary(opts: {
  db: Database.Database;
  localProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  logger: Logger;
}): YtLibrary {
  const localYt = opts.localProvider as unknown as YtLibraryLocalSource;
  const youtubeYt = opts.youtubeProvider as unknown as YtLibraryYoutubeSource;
  return new YtLibrary({
    db: opts.db,
    musicDir: localYt.getMusicDir?.() ?? (process.env.MUSIC_DIR || "/music"),
    download: (id, dir, base) => youtubeYt.downloadAudioMp3(id, dir, base),
    refresh: () => localYt.refresh?.() ?? Promise.resolve(),
    logger: opts.logger,
  });
}
