import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BotStatus, usePlayerStore } from './player.js';

function sampleBot(overrides: Partial<BotStatus> = {}): BotStatus {
  return {
    id: 'bot-1',
    name: 'Test',
    connected: true,
    playing: true,
    paused: false,
    currentSong: {
      id: 's1',
      name: 'Track',
      artist: 'Artist',
      album: '',
      duration: 120,
      coverUrl: '',
      platform: 'local',
    },
    queueSize: 1,
    volume: 50,
    playMode: 'seq',
    elapsed: 10,
    ...overrides,
  };
}

describe('usePlayerStore', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('activeBot follows activeBotId', () => {
    const store = usePlayerStore();
    store.bots = [sampleBot(), sampleBot({ id: 'bot-2', name: 'Other' })];
    store.activeBotId = 'bot-2';
    expect(store.activeBot?.id).toBe('bot-2');
  });

  it('elapsed interpolates forward while playing', () => {
    const store = usePlayerStore();
    const bot = sampleBot();
    store.bots = [bot];
    store.activeBotId = bot.id;
    store.updateBotStatus(bot.id, bot);
    vi.advanceTimersByTime(2000);
    expect(store.elapsed).toBeGreaterThan(11);
    expect(store.elapsed).toBeLessThan(13);
  });

  it('_handlePlayerError sets rateLimitUntil on 429', () => {
    const store = usePlayerStore();
    const before = Date.now();
    store._handlePlayerError({
      response: { status: 429, data: { retryAfter: 5 } },
    });
    expect(store.rateLimitUntil).toBeGreaterThanOrEqual(before + 5000);
    expect(store.isRateLimited).toBe(true);
    store.rateLimitUntil = Date.now() - 1;
    expect(store.isRateLimited).toBe(false);
  });

  it('availableSources lists local, youtube, stream', () => {
    const store = usePlayerStore();
    expect(store.availableSources).toEqual(['local', 'youtube', 'stream']);
  });
});
