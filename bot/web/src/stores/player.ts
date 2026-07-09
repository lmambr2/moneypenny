import { defineStore } from 'pinia';
import api from '../api/axios.js';

export interface Song {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string;
  platform: 'local' | 'youtube' | 'stream';
}

export type Source = 'local' | 'youtube' | 'stream';

export interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: Song | null;
  queueSize: number;
  volume: number;
  playMode: string;
  elapsed?: number;
}

export interface PlaylistItem {
  id: string;
  name: string;
  coverUrl: string;
  songCount: number;
  platform: string;
}

interface TimingState {
  serverElapsed: number;
  serverSyncTime: number;
  wasPlaying: boolean;
}

const _HOME_CACHE_TTL = 5 * 60 * 1000;

function defaultTiming(): TimingState {
  return { serverElapsed: 0, serverSyncTime: 0, wasPlaying: false };
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    bots: [] as BotStatus[],
    activeBotId: null as string | null,
    /** Per-bot queues keyed by botId */
    queues: {} as Record<string, Song[]>,
    /** Per-bot timing state keyed by botId */
    timings: {} as Record<string, TimingState>,
    theme: 'dark' as 'dark' | 'light',

    // Home page cache - simplified for new sources (local primary)
    localRecent: [] as Song[],
    localTrackCount: 0,
    youtubeTrending: [] as Song[], // could be populated via search or future endpoint
    authStatus: { local: true, youtube: true }, // local and youtube don't require login like the old services
    lastFetchTime: 0,

    // Transient notification for surfacing failures (e.g., "song not playable")
    // to a global Toast. Bumped `id` triggers re-render of the same message.
    notification: null as {
      id: number;
      message: string;
      type: 'error' | 'info';
      retryAfter?: number;
    } | null,

    // Track rate limiting for player actions (from 429 responses)
    rateLimitUntil: null as number | null,
  }),

  getters: {
    activeBot(): BotStatus | null {
      return this.bots.find((b) => b.id === this.activeBotId) ?? this.bots[0] ?? null;
    },
    currentSong(): Song | null {
      return this.activeBot?.currentSong ?? null;
    },
    isPlaying(): boolean {
      return this.activeBot?.playing ?? false;
    },
    isPaused(): boolean {
      return this.activeBot?.paused ?? false;
    },
    /** Queue for the currently active bot */
    queue(): Song[] {
      const botId = this.activeBotId ?? this.bots[0]?.id;
      if (!botId) return [];
      return this.queues[botId] ?? [];
    },
    /** Interpolated elapsed for the active bot */
    elapsed(): number {
      const botId = this.activeBotId ?? this.bots[0]?.id;
      if (!botId || !this.activeBot?.currentSong) return 0;
      const timing = this.timings[botId] ?? defaultTiming();
      const maxDuration = this.activeBot.currentSong.duration || Infinity;
      if (!timing.wasPlaying || timing.serverSyncTime === 0)
        return Math.min(timing.serverElapsed, maxDuration);
      if (this.isPaused) return Math.min(timing.serverElapsed, maxDuration);
      return Math.min(
        timing.serverElapsed + (Date.now() - timing.serverSyncTime) / 1000,
        maxDuration,
      );
    },
    /** Currently available sources. Local is primary. */
    availableSources(): Source[] {
      return ['local', 'youtube', 'stream'];
    },

    isRateLimited(): boolean {
      return !!this.rateLimitUntil && Date.now() < this.rateLimitUntil;
    },
  },

  actions: {
    _handlePlayerError(err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data || {};
      if (status === 429) {
        const retryAfter = Number(data.retryAfter || 5);
        this.rateLimitUntil = Date.now() + retryAfter * 1000;
        // notify handled by axios interceptor to avoid duplicates
        return;
      }
      // for other cases, interceptor should have notified; fallback if no response
      if (!err?.response) {
        const msg = err?.message || 'Action failed. Please try again.';
        this.notify(msg, 'error');
      }
    },

    _getTiming(botId: string): TimingState {
      if (!this.timings[botId]) {
        this.timings[botId] = defaultTiming();
      }
      return this.timings[botId];
    },

    _setTiming(botId: string, partial: Partial<TimingState>) {
      const current = this._getTiming(botId);
      this.timings[botId] = { ...current, ...partial };
    },

    getQueueForBot(botId: string): Song[] {
      return this.queues[botId] ?? [];
    },

    setActiveBotId(id: string) {
      this.activeBotId = id;
      // Fetch queue for newly active bot if we don't have it yet
      if (!this.queues[id]) {
        this.fetchQueue();
      }
    },

    updateBotStatus(botId: string, status: BotStatus) {
      const prev = this.bots.find((b) => b.id === botId);
      const prevSongId = prev?.currentSong?.id;

      const index = this.bots.findIndex((b) => b.id === botId);
      if (index >= 0) {
        this.bots[index] = status;
      } else {
        this.bots.push(status);
      }

      // Sync elapsed from server status — always per-bot
      if (status.elapsed !== undefined) {
        this._setTiming(botId, {
          serverElapsed: status.elapsed,
          serverSyncTime: Date.now(),
          wasPlaying: status.playing && !status.paused,
        });
      }

      // Song changed — reset timing for this bot
      if (status.currentSong?.id !== prevSongId) {
        this._setTiming(botId, {
          serverElapsed: status.elapsed ?? 0,
          serverSyncTime: Date.now(),
          wasPlaying: status.playing && !status.paused,
        });
      }
    },

    removeBotStatus(botId: string) {
      this.bots = this.bots.filter((b) => b.id !== botId);
      delete this.queues[botId];
      delete this.timings[botId];
    },

    setQueue(botId: string, queue: Song[]) {
      this.queues[botId] = queue;
    },

    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', this.theme);
    },

    loadTheme() {
      const saved = localStorage.getItem('theme') as 'dark' | 'light' | null;
      if (saved) this.theme = saved;
    },

    async startBotInstance(id: string) {
      try {
        await api.post(`/api/bot/${id}/start`);
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async stopBotInstance(id: string) {
      try {
        await api.post(`/api/bot/${id}/stop`);
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async fetchBots() {
      const res = await api.get('/api/bot');
      this.bots = res.data.bots;
      if (!this.activeBotId && this.bots.length > 0) {
        this.activeBotId = this.bots[0].id;
      }
      // Sync elapsed from each bot's status
      for (const bot of this.bots) {
        if (bot.elapsed !== undefined) {
          this._setTiming(bot.id, {
            serverElapsed: bot.elapsed,
            serverSyncTime: Date.now(),
            wasPlaying: bot.playing && !bot.paused,
          });
        }
      }
    },

    /** Poll server for real elapsed time for active bot */
    async syncElapsed() {
      if (!this.activeBotId || !this.isPlaying) return;
      try {
        const res = await api.get(`/api/player/${this.activeBotId}/elapsed`);
        this._setTiming(this.activeBotId, {
          serverElapsed: res.data.elapsed,
          serverSyncTime: Date.now(),
          wasPlaying: true,
        });
      } catch {
        // ignore
      }
    },

    async fetchQueue() {
      if (!this.activeBotId) return;
      try {
        const res = await api.get(`/api/player/${this.activeBotId}/queue`);
        this.queues[this.activeBotId] = res.data.queue ?? [];
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async fetchQueueForBot(botId: string) {
      try {
        const res = await api.get(`/api/player/${botId}/queue`);
        this.queues[botId] = res.data.queue ?? [];
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    _syncAfterAction() {
      if (!this.activeBotId) return;
      this._setTiming(this.activeBotId, {
        serverSyncTime: Date.now(),
        wasPlaying: true,
      });
      // Sync from server after a short delay for accuracy
      setTimeout(() => this.syncElapsed(), 500);
    },

    async playAtIndex(index: number) {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/play-at`, { index });
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async play(query: string, platform: Source = 'local') {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/play`, { query, platform });
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async playById(songId: string, platform: Source = 'local') {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/play-by-id`, { songId, platform });
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    notify(message: string, type: 'error' | 'info' = 'info', retryAfter?: number) {
      this.notification = { id: Date.now(), message, type, retryAfter };
      if (retryAfter) {
        this.rateLimitUntil = Date.now() + retryAfter * 1000;
      }
    },

    async playSong(song: Song) {
      if (!this.activeBotId) return;
      try {
        const res = await api.post(`/api/player/${this.activeBotId}/play-song`, { song });
        if (res.data?.ok === false && res.data?.message) {
          this.notify(res.data.message, 'error');
        }
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async playNextSong(song: Song) {
      if (!this.activeBotId) return;
      const res = await api.post(`/api/player/${this.activeBotId}/play-next-song`, { song });
      if (res.data?.message) {
        this.notify(res.data.message, res.data.ok === false ? 'error' : 'info');
      }
      // Refresh queue so the inserted item shows up in the side panel
      this.fetchQueue();
    },

    async addToQueue(query: string, platform: Source = 'local') {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/add`, { query, platform });
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async addToQueueById(songId: string, platform: Source = 'local') {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/add-by-id`, { songId, platform });
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async addSong(song: Song) {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/add-song`, { song });
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async playPlaylist(playlistId: string, platform: Source = 'local') {
      if (!this.activeBotId) return;
      try {
        const res = await api.post(`/api/player/${this.activeBotId}/play-playlist`, {
          playlistId,
          platform,
        });
        if (res.data?.message) {
          this.notify(res.data.message, res.data.ok === false ? 'error' : 'info');
        }
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async playAlbum(albumId: string, platform: Source = 'local') {
      if (!this.activeBotId) return;
      try {
        const res = await api.post(`/api/player/${this.activeBotId}/play-album`, {
          albumId,
          platform,
        });
        if (res.data?.message) {
          this.notify(res.data.message, res.data.ok === false ? 'error' : 'info');
        }
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async pause() {
      if (!this.activeBotId) return;
      try {
        // Freeze elapsed at current interpolated value
        this._setTiming(this.activeBotId, {
          serverElapsed: this.elapsed,
          wasPlaying: false,
        });
        await api.post(`/api/player/${this.activeBotId}/pause`);
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async resume() {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/resume`);
        this._setTiming(this.activeBotId, {
          serverSyncTime: Date.now(),
          wasPlaying: true,
        });
        setTimeout(() => this.syncElapsed(), 300);
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async next() {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/next`);
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async prev() {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/prev`);
        this._setTiming(this.activeBotId, { serverElapsed: 0 });
        this._syncAfterAction();
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async stop() {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/stop`);
        this._setTiming(this.activeBotId, {
          serverElapsed: 0,
          serverSyncTime: 0,
          wasPlaying: false,
        });
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async seek(position: number) {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/seek`, { position });
        this._setTiming(this.activeBotId, { serverElapsed: position });
        this._syncAfterAction();
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async setVolume(volume: number) {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/volume`, { volume });
        const bot = this.bots.find((b) => b.id === this.activeBotId);
        if (bot) bot.volume = volume;
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async setMode(mode: string) {
      if (!this.activeBotId) return;
      try {
        await api.post(`/api/player/${this.activeBotId}/mode`, { mode });
        const bot = this.bots.find((b) => b.id === this.activeBotId);
        if (bot) bot.playMode = mode;
      } catch (err) {
        this._handlePlayerError(err);
      }
    },

    async fetchHomeData() {
      // Simplified for new Local/YouTube/Stream world (Local is primary)
      // For a full implementation, we would call local-specific endpoints
      // (e.g. recent songs, popular local artists) and YouTube trending/search.
      // For now, we just ensure authStatus is set and avoid crashing on old CN calls.

      const authOk = true; // local + youtube are always "available"

      // Try to fetch a bit of local data via search as a stand-in for "recent"
      try {
        const [localRecentRes, statsRes] = await Promise.all([
          api.get('/api/music/search', { params: { q: '', platform: 'local', limit: 20 } }),
          api.get('/api/music/stats').catch(() => ({ data: { trackCount: 0 } })),
        ]);
        this.localRecent = localRecentRes.data?.songs ?? [];
        this.localTrackCount = statsRes.data?.trackCount ?? this.localRecent.length;
      } catch {
        this.localRecent = [];
        this.localTrackCount = 0;
      }

      // YouTube "trending" stub (in reality would use a dedicated endpoint or search "trending")
      this.youtubeTrending = [];

      this.authStatus = { local: true, youtube: true };

      if (authOk) {
        this.lastFetchTime = Date.now();
      }
    },
  },
});
