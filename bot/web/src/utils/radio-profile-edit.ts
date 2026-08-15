/**
 * Dashboard-editable slice of a RadioProfile. Unknown fields stay in `extra`
 * and are re-merged on save so select/relay/weights survive a Settings edit.
 */

export interface RadioProfileEdit {
  name: string;
  seedQueriesText: string;
  /** Auto-DJ tag filter: one mood per line (or comma-separated). */
  moodText: string;
  bumperTopicsText: string;
  bumperTone: string;
  shuffle: boolean;
  aceStepAutoFill: boolean;
  playlistRefsText: string;
  seedSourceLocal: boolean;
  seedSourceYoutube: boolean;
  seedSourceStream: boolean;
  seedExternalPct: number;
  extra: Record<string, unknown>;
}

/** Display rounding of the bot default ⅔ external ratio. */
export const DEFAULT_SEED_EXTERNAL_PCT = Math.round((2 / 3) * 100);

export function emptyRadioProfileEdit(name: string): RadioProfileEdit {
  return {
    name,
    seedQueriesText: '',
    moodText: '',
    bumperTopicsText: '',
    bumperTone: '',
    shuffle: true,
    aceStepAutoFill: false,
    playlistRefsText: '',
    seedSourceLocal: true,
    seedSourceYoutube: true,
    seedSourceStream: false,
    seedExternalPct: DEFAULT_SEED_EXTERNAL_PCT,
    extra: {},
  };
}

export function linesToText(arr: unknown): string {
  if (!Array.isArray(arr)) return '';
  return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join('\n');
}

export function textToLines(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function playlistRefsToText(refs: unknown): string {
  if (!Array.isArray(refs)) return '';
  return refs
    .map((r) => {
      if (!r || typeof r !== 'object') return '';
      const platform = String((r as { platform?: string }).platform ?? '').trim();
      const ref = String((r as { ref?: string }).ref ?? '').trim();
      if (!platform || !ref) return '';
      return `${platform}:${ref}`;
    })
    .filter(Boolean)
    .join('\n');
}

function textToPlaylistRefs(
  text: string,
): { platform: 'local' | 'youtube' | 'spotify' | 'tidal'; ref: string }[] {
  const allowed = new Set(['local', 'youtube', 'spotify', 'tidal']);
  const out: { platform: 'local' | 'youtube' | 'spotify' | 'tidal'; ref: string }[] = [];
  for (const line of text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const platform = line.slice(0, idx).trim().toLowerCase();
    const ref = line.slice(idx + 1).trim();
    if (!allowed.has(platform) || !ref) continue;
    out.push({ platform: platform as 'local' | 'youtube' | 'spotify' | 'tidal', ref });
  }
  return out;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? { ...(v as Record<string, unknown>) }
    : {};
}

export function profileFromApi(key: string, raw: unknown): RadioProfileEdit {
  const p = asObject(raw);
  const music = asObject(p.music);
  const bumper = asObject(p.bumper);
  const select = asObject(music.select);
  const {
    seedQueries: _s,
    playlistRefs: _pl,
    shuffle: _sh,
    aceStepAutoFill: _ace,
    seedSources: _ss,
    seedExternalRatio: _ser,
    select: _sel,
    ...musicRest
  } = music;
  const { mood: _mood, ...selectRest } = select;
  if (Object.keys(selectRest).length) musicRest.select = selectRest;
  const { topics: _t, tone: _tone, ...bumperRest } = bumper;
  const { name: _n, music: _m, bumper: _b, ...topRest } = p;
  const sources = Array.isArray(music.seedSources)
    ? (music.seedSources as string[])
    : ['local', 'youtube'];
  const extRatio =
    typeof music.seedExternalRatio === 'number' && Number.isFinite(music.seedExternalRatio)
      ? music.seedExternalRatio
      : 2 / 3;
  return {
    name: typeof p.name === 'string' && p.name.trim() ? p.name : key,
    seedQueriesText: linesToText(music.seedQueries),
    moodText: linesToText(select.mood),
    bumperTopicsText: linesToText(bumper.topics),
    bumperTone: typeof bumper.tone === 'string' ? bumper.tone : '',
    shuffle: music.shuffle !== false,
    aceStepAutoFill: music.aceStepAutoFill === true,
    playlistRefsText: playlistRefsToText(music.playlistRefs),
    seedSourceLocal: sources.includes('local'),
    seedSourceYoutube: sources.includes('youtube'),
    seedSourceStream: sources.includes('stream'),
    seedExternalPct: Math.round(Math.min(1, Math.max(0, extRatio)) * 100),
    extra: {
      ...topRest,
      ...(Object.keys(musicRest).length ? { music: musicRest } : {}),
      ...(Object.keys(bumperRest).length ? { bumper: bumperRest } : {}),
    },
  };
}

export function profileToApi(key: string, edit: RadioProfileEdit): Record<string, unknown> {
  const seeds = textToLines(edit.seedQueriesText);
  const moods = textToLines(edit.moodText);
  const topics = textToLines(edit.bumperTopicsText);
  const refs = textToPlaylistRefs(edit.playlistRefsText);
  const tone = edit.bumperTone.trim();
  const extraMusic = asObject(edit.extra.music);
  const extraBumper = asObject(edit.extra.bumper);
  const { music: _em, bumper: _eb, ...topExtra } = edit.extra;
  const extraSelect = asObject(extraMusic.select);
  const music: Record<string, unknown> = {
    ...extraMusic,
    shuffle: edit.shuffle,
  };
  if (edit.aceStepAutoFill) music.aceStepAutoFill = true;
  else delete music.aceStepAutoFill;
  if (seeds.length) music.seedQueries = seeds;
  else delete music.seedQueries;
  if (refs.length) music.playlistRefs = refs;
  else delete music.playlistRefs;
  const seedSources: string[] = [];
  if (edit.seedSourceLocal) seedSources.push('local');
  if (edit.seedSourceYoutube) seedSources.push('youtube');
  if (edit.seedSourceStream) seedSources.push('stream');
  music.seedSources = seedSources.length > 0 ? seedSources : ['local', 'youtube'];
  const rawPct = edit.seedExternalPct as unknown;
  const pct = Number(rawPct);
  if (
    rawPct === '' ||
    rawPct === null ||
    !Number.isFinite(pct) ||
    pct === DEFAULT_SEED_EXTERNAL_PCT
  ) {
    delete music.seedExternalRatio;
  } else {
    music.seedExternalRatio = Math.min(1, Math.max(0, pct / 100));
  }
  const select: Record<string, unknown> = { ...extraSelect };
  if (moods.length) select.mood = moods;
  else delete select.mood;
  if (Object.keys(select).length) music.select = select;
  else delete music.select;
  const bumper: Record<string, unknown> = { ...extraBumper };
  if (topics.length) bumper.topics = topics;
  else delete bumper.topics;
  if (tone) bumper.tone = tone;
  else delete bumper.tone;
  return {
    ...topExtra,
    name: edit.name.trim() || key,
    music,
    ...(Object.keys(bumper).length ? { bumper } : {}),
  };
}
