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
 * Default system prompt for the Moneypenny music + Q&A persona (Phase 1b).
 * Keep it terse — NPU tokens are precious.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Moneypenny, a helpful local music bot for a TeamSpeak server.
- Be concise and friendly.
- For any music action (play, skip, pause, volume, queue, etc.) you MUST call the appropriate tool instead of just describing it.
- Prefer the Local music library. Only use YouTube when the user explicitly asks or the song is not local.
- Never invent tool names. Only use the provided tools.
- If the user asks a general knowledge question that is not music control, answer directly without tools.
- Current date: ${new Date().toISOString().slice(0, 10)}.`;

/**
 * Helper to build a chat request that includes the music control tools.
 */
export function buildToolRequest(messages: ChatCompletionRequest["messages"], opts: { systemPrompt?: string } = {}): ChatCompletionRequest {
  return {
    messages: opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, ...messages]
      : messages,
    tools: MUSIC_CONTROL_TOOLS as any,
    tool_choice: "auto",
    temperature: 0.1,
    max_tokens: 400,
  };
}
