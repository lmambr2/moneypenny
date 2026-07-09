/**
 * LLM tag guess — text→text genre/subgenre/mood from title/artist/album
 * (docs/radio.md §9.5 AI-assisted). Not audio analysis; source "api" so
 * manual edits still win on TagStore precedence.
 */
import type { TrackTags } from "../radio/tag-store.js";

export interface TagGuessInput {
  name: string;
  artist?: string;
  album?: string;
  /** Existing overlay/embedded tags for context (may be empty). */
  existing?: Partial<Pick<TrackTags, "genre" | "subgenre" | "mood">>;
}

export type TagGuessResult = Pick<TrackTags, "genre" | "subgenre" | "mood">;

const MAX_FIELD = 48;

/** Build the one-shot prompt for askLlm. */
export function buildTagGuessPrompt(input: TagGuessInput): string {
  const lines = [
    "You tag music for a radio station library (selection filters).",
    "Guess genre, optional subgenre, and mood from the metadata below.",
    "Use short lowercase tokens (examples: ambient, synthwave, rock, lofi, electronic;",
    "moods: calm, energetic, dark, focus, bright, mellow).",
    "Do not invent long sentences. Prefer common radio/DJ tags.",
    "",
    `Title: ${input.name.trim() || "(unknown)"}`,
    `Artist: ${(input.artist ?? "").trim() || "(unknown)"}`,
    `Album: ${(input.album ?? "").trim() || "(unknown)"}`,
  ];
  const ex = input.existing;
  if (ex?.genre || ex?.subgenre || ex?.mood) {
    lines.push(
      `Existing tags: genre=${ex.genre ?? ""}; subgenre=${ex.subgenre ?? ""}; mood=${ex.mood ?? ""}`,
    );
    lines.push("Fill missing fields; refine only if existing tags are clearly wrong.");
  }
  lines.push(
    "",
    "Reply with ONLY one JSON object (no markdown fences, no commentary):",
    '{"genre":"...","subgenre":"...","mood":"..."}',
    "Omit keys you cannot guess. Empty string is not allowed.",
  );
  return lines.join("\n");
}

/** Pull a JSON object from an LLM reply (raw or fenced). */
export function parseTagGuessResponse(raw: string | null | undefined): TagGuessResult | null {
  if (!raw?.trim()) return null;
  const text = raw.trim();
  let jsonStr = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) jsonStr = fence[1].trim();
  else {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) jsonStr = text.slice(start, end + 1);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const result: TagGuessResult = {};
  const genre = cleanToken(rec.genre);
  const subgenre = cleanToken(rec.subgenre);
  const mood = cleanToken(rec.mood);
  if (genre) result.genre = genre;
  if (subgenre) result.subgenre = subgenre;
  if (mood) result.mood = mood;
  return Object.keys(result).length > 0 ? result : null;
}

function cleanToken(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t || t === "unknown" || t === "n/a" || t === "none") return undefined;
  return t.slice(0, MAX_FIELD);
}

export type AskLlm = (question: string) => Promise<string | null>;

/** Call the LLM and parse a tag guess. Returns null if LLM is down or unparseable. */
export async function guessTrackTags(
  askLlm: AskLlm,
  input: TagGuessInput,
): Promise<TagGuessResult | null> {
  const answer = await askLlm(buildTagGuessPrompt(input));
  return parseTagGuessResponse(answer);
}
