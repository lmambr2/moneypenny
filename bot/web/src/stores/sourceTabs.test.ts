import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTabSource, saveTabSource } from './sourceTabs.js';

function mockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  } satisfies Storage;
}

describe('sourceTabs persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', mockLocalStorage());
  });

  it('loadTabSource returns fallback when unset', () => {
    expect(loadTabSource('home.recommend')).toBe('local');
    expect(loadTabSource('home.daily', 'youtube')).toBe('youtube');
  });

  it('round-trips a saved source', () => {
    saveTabSource('library.user', 'stream');
    expect(loadTabSource('library.user')).toBe('stream');
  });

  it('ignores corrupted localStorage values', () => {
    localStorage.setItem('source-tabs', 'not-json');
    expect(loadTabSource('home.user', 'youtube')).toBe('youtube');

    localStorage.setItem('source-tabs', 'null');
    expect(loadTabSource('home.user', 'stream')).toBe('stream');

    localStorage.setItem('source-tabs', '[]');
    expect(loadTabSource('home.user')).toBe('local');
  });

  it('rejects invalid source strings in storage', () => {
    localStorage.setItem('source-tabs', JSON.stringify({ 'home.recommend': 'spotify' }));
    expect(loadTabSource('home.recommend', 'youtube')).toBe('youtube');
  });
});
