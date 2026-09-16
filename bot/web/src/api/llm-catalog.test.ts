import { describe, expect, it } from 'vitest';
import { formatModelCtx, formatModelLabel, modelAliases } from './llm-catalog.js';

describe('llm catalog helpers', () => {
  it('formats context windows', () => {
    expect(formatModelCtx(32768)).toBe('32k ctx');
    expect(formatModelCtx(undefined)).toBe('');
  });

  it('lists aliases that share a root', () => {
    const catalog = {
      url: 'http://127.0.0.1:8080',
      available: true,
      models: [
        { id: 'Qwen3.8', root: '/m/x', maxModelLen: 32768 },
        { id: 'Qwen3.6', root: '/m/x', maxModelLen: 32768 },
        { id: 'other', root: '/m/y' },
      ],
    };
    expect(modelAliases(catalog, 'Qwen3.8').map((m) => m.id)).toEqual(['Qwen3.6']);
    expect(formatModelLabel(catalog.models[0]!)).toBe('Qwen3.8 · 32k ctx');
  });
});
