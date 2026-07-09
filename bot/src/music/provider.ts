export interface Song {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number; // seconds
  coverUrl: string;
  platform: "local" | "youtube" | "stream";
}

export interface SongWithUrl extends Song {
  url: string;
}

export interface Playlist {
  id: string;
  name: string;
  coverUrl: string;
  songCount: number;
  platform: "local" | "youtube" | "stream";
}

export interface PlaylistDetail {
  id: string;
  name: string;
  description: string;
  coverUrl: string;
  songCount: number;
}

export interface Album {
  id: string;
  name: string;
  artist: string;
  coverUrl: string;
  songCount: number;
  platform: "local" | "youtube" | "stream";
}

export interface LyricLine {
  time: number; // seconds
  text: string;
  translation?: string;
}

export interface SearchResult {
  songs: Song[];
  playlists: Playlist[];
  albums: Album[];
}

export interface AuthStatus {
  loggedIn: boolean;
  nickname?: string;
  avatarUrl?: string;
}

export interface MusicProvider {
  readonly platform: "local" | "youtube" | "stream";

  search(query: string, limit?: number): Promise<SearchResult>;
  getSongUrl(songId: string, quality?: string): Promise<string | null>;
  setQuality(quality: string): void;
  getQuality(): string;
  getSongDetail(songId: string): Promise<Song | null>;
  getPlaylistSongs(playlistId: string): Promise<Song[]>;
  getRecommendPlaylists(): Promise<Playlist[]>;
  getAlbumSongs(albumId: string): Promise<Song[]>;
  getLyrics(songId: string): Promise<LyricLine[]>;
  /** Provider availability for the web UI (e.g. yt-dlp reachable). */
  getAuthStatus(): Promise<AuthStatus>;

  /** Optional: certainty-based resolution (implemented by LocalProvider) */
  resolve?(input: string): Promise<{ type: "song" | "playlist"; item: Song | Playlist } | null>;

  /** Optional: force re-index after external file changes or host-side adds (LocalProvider). Returns the new track count. */
  refresh?(): Promise<number>;

  /** Optional: upload a file into the local music library (web UI). Returns the indexed Song. Web uploads are isolated under the `uploads/` subdir. */
  uploadSong?(originalFilename: string, data: Buffer): Promise<Song>;

  /** Optional: delete a local library track by opaque id (admin web UI). */
  deleteSong?(songId: string): Promise<{ deleted: true; name: string }>;

  /** Optional: user-owned playlists for name-based !playlist resolution. */
  getUserPlaylists?(): Promise<Playlist[]>;
}
