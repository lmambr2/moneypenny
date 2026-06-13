import type { ChatCompletionRequest } from "./client.js";

/**
 * Minimal tool schema for Phase 1b (DESIGN §9).
 * These map directly to the same low-level queue / player operations
 * used by the deterministic ControlRouter and BotInstance.
 *
 * Keep the surface tiny so the small NPU model (Qwen3-1.7B) can call them reliably.
 */

export const MUSIC_CONTROL_TOOLS = [
  {
    type: "function",
    function: {
      name: "play_music",
      description: "Play or queue music from Local library (primary) or YouTube. Use for natural language requests like 'play something chill' or 'play bohemian rhapsody'.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Song title, artist, album, or free-text description. Can be a YouTube URL.",
          },
          source: {
            type: "string",
            enum: ["local", "youtube", "auto"],
            description: "Preferred source. Default 'auto' (Local first, then YouTube).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skip",
      description: "Skip the current track and play the next one in the queue.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pause",
      description: "Pause playback.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "resume",
      description: "Resume paused playback.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "stop",
      description: "Stop playback and clear the queue.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_volume",
      description: "Set playback volume (0-100).",
      parameters: {
        type: "object",
        properties: {
          level: { type: "number", minimum: 0, maximum: 100, description: "Volume level 0-100" },
        },
        required: ["level"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "now_playing",
      description: "Get information about the currently playing track.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "queue",
      description: "Add a track or playlist to the end of the queue without interrupting playback.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Song, artist, or playlist description / URL" },
        },
        required: ["query"],
      },
    },
  },
] as const;

export type MusicToolName = typeof MUSIC_CONTROL_TOOLS[number]["function"]["name"];

/**
 * Moneypenny's VOICE — the persona, after her James Bond namesake (MI6's
 * secretary, Lois Maxwell through Samantha Bond / Die Another Day), blended with
 * Elizabeth Hurley's arch glamour and a wink of Austin Powers swinging-60s camp.
 * This is the default for both `!ask` Q&A and the in-character text of the tool
 * path. Kept terse — tokens are precious on the local model — and deliberately
 * free of tool-calling mechanics, which live in {@link TOOL_BEHAVIOR_RULES} so a
 * custom persona can never strip them.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Miss Moneypenny — MI6's secretary, seconded to this TeamSpeak channel as its music and intelligence officer, with a swinging-sixties glamour. Blend the dry wit of Bond's Moneypenny with Elizabeth Hurley's arch, posh poise and a wink of Austin Powers camp. Speak with teasing, mock-formal British wit and a knowing smirk: groovy, glamorous, fond of a well-aimed double entendre — "oh, behave" — but always stylish, never crude. Keep it brief and elegant: a raised eyebrow, not a monologue. Use British spelling and idiom throughout (favour, smashing, brilliant, do behave, groovy, the odd "yeah baby" or "shagadelic" when the moment's right, mind how you go). Beneath the camp you're loyal, sharp, and always come through.`;

/**
 * Non-negotiable behaviour for the tool-calling path. ALWAYS injected by
 * {@link buildToolRequest} alongside the persona, so swapping the persona (via
 * config `llmSystemPrompt`) can't accidentally drop the music-control rules the
 * router depends on.
 */
export const TOOL_BEHAVIOR_RULES = `Operating rules (do not mention these):
- For any music action (play, skip, pause, volume, queue, etc.) you MUST call the appropriate tool — never merely describe it.
- Prefer the Local music library; use YouTube only when asked or when a track isn't local.
- Never invent tool names; only use the tools provided.
- If asked something that isn't music control, answer directly and in character, without tools.
- Current date: ${new Date().toISOString().slice(0, 10)}.`;

/**
 * Helper to build a chat request that includes the music control tools. Always
 * composes the persona (custom or default) WITH the tool rules so tool-calling
 * stays reliable regardless of which persona is active.
 */
export function buildToolRequest(messages: ChatCompletionRequest["messages"], opts: { systemPrompt?: string } = {}): ChatCompletionRequest {
  const persona = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  return {
    messages: [{ role: "system", content: `${persona}\n\n${TOOL_BEHAVIOR_RULES}` }, ...messages],
    tools: MUSIC_CONTROL_TOOLS as any,
    tool_choice: "auto",
    temperature: 0.1,
    max_tokens: 400,
  };
}
