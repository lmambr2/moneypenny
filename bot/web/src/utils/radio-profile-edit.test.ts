import { describe, expect, it } from 'vitest';
import { emptyRadioProfileEdit, profileFromApi, profileToApi } from './radio-profile-edit.js';

describe('radio profile mood edit', () => {
  it('loads music.select.mood into the editor field', () => {
    const edit = profileFromApi('focus', {
      name: 'focus',
      music: { select: { mood: ['calm', 'focus'], bpmMax: 110 }, seedQueries: ['ambient'] },
    });
    expect(edit.moodText).toBe('calm\nfocus');
    // Other select keys stay in extra so a save does not wipe BPM.
    expect((edit.extra.music as { select?: { bpmMax?: number } })?.select?.bpmMax).toBe(110);
  });

  it('writes mood into music.select and keeps sibling select filters', () => {
    const edit = profileFromApi('focus', {
      music: { select: { mood: ['calm'], bpmMax: 110, genreAny: ['ambient'] } },
    });
    edit.moodText = 'energetic, dark';
    const out = profileToApi('focus', edit);
    const select = (out.music as { select: Record<string, unknown> }).select;
    expect(select.mood).toEqual(['energetic', 'dark']);
    expect(select.bpmMax).toBe(110);
    expect(select.genreAny).toEqual(['ambient']);
  });

  it('clears mood without deleting other select keys', () => {
    const edit = profileFromApi('focus', {
      music: { select: { mood: ['calm'], bpmMax: 110 } },
    });
    edit.moodText = '';
    const select = (profileToApi('focus', edit).music as { select: Record<string, unknown> })
      .select;
    expect(select.mood).toBeUndefined();
    expect(select.bpmMax).toBe(110);
  });

  it('omits select entirely when mood is the only filter and it is cleared', () => {
    const edit = profileFromApi('lobby', {
      music: { select: { mood: ['calm'] }, seedQueries: ['chill'] },
    });
    edit.moodText = '';
    const music = profileToApi('lobby', edit).music as { select?: unknown };
    expect(music.select).toBeUndefined();
  });

  it('empty editor save does not invent a select block', () => {
    const out = profileToApi('new', emptyRadioProfileEdit('new'));
    expect((out.music as { select?: unknown }).select).toBeUndefined();
  });
});
