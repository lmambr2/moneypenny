import type { ChatCompletionRequest, ChatTool } from "./client.js";
import { DELEGATE_TOOL_NAME } from "./delegate.js";

/** DESIGN §R4 — move another TS client to a channel (admin-gated at execution). */
export const MOVE_CLIENT_TOOL_NAME = "move_client" as const;
/** DESIGN §R4 — relocate everyone in the current channel (confirmation required). */
export const MOVE_ALL_TOOL_NAME = "move_all_clients" as const;

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
] satisfies readonly ChatTool[];

/** DESIGN §R1 — escalate heavy analysis to the delegate endpoint. */
export const DELEGATION_TOOL = {
  type: "function",
  function: {
    name: DELEGATE_TOOL_NAME,
    description:
      "Escalate a complex analysis, report, summary, or long-context task to the senior analyst model. " +
      "Use for INTSUMs, doctrine synthesis, multi-step reasoning, or when the user explicitly wants deep analysis.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "What the analyst should produce.",
        },
        context: {
          type: "string",
          description: "Optional extra context, constraints, or background for the analyst.",
        },
      },
      required: ["task"],
    },
  },
} satisfies ChatTool;

/** DESIGN §R4 — natural-language / voice channel moves (executor enforces admin rights). */
export const MOVE_CLIENT_TOOL = {
  type: "function",
  function: {
    name: MOVE_CLIENT_TOOL_NAME,
    description:
      "Move another TeamSpeak user to a different channel. Use when asked to move, relocate, " +
      "or send someone to a channel (e.g. 'move Bond to the briefing room').",
    parameters: {
      type: "object",
      properties: {
        client: {
          type: "string",
          description: "Nickname or numeric client ID of the user to move.",
        },
        channel: {
          type: "string",
          description: "Destination channel name or ID.",
        },
      },
      required: ["client", "channel"],
    },
  },
} satisfies ChatTool;

/** DESIGN §R4 — mass move everyone in the bot's current channel (confirmation step). */
export const MOVE_ALL_TOOL = {
  type: "function",
  function: {
    name: MOVE_ALL_TOOL_NAME,
    description:
      "Move all other users in the current channel to a destination channel. " +
      "Requires a confirmation step — only use when explicitly asked to move everyone here.",
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Destination channel name or ID.",
        },
      },
      required: ["channel"],
    },
  },
} satisfies ChatTool;

export type MusicToolName = (typeof MUSIC_CONTROL_TOOLS)[number]["function"]["name"];
export type DelegationToolName = typeof DELEGATE_TOOL_NAME;

/**
 * Moneypenny's VOICE — the persona, after her James Bond namesake: the classic
 * MI6 secretary, Lois Maxwell (opposite Connery) through Samantha Bond (opposite
 * Brosnan). Dignified dry British wit — no parody. This is the default for both
 * `!ask` Q&A and the in-character text of the tool path. Kept terse — tokens are
 * precious on the local model — and deliberately free of tool-calling mechanics,
 * which live in {@link TOOL_BEHAVIOR_RULES} so a custom persona can never strip them.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Miss Moneypenny — MI6's secretary, seconded to this TeamSpeak channel as its music and intelligence officer. Speak with dry, poised British wit: teasing, mock-formal, quick with an arch double entendre but never crude — the manner of a woman forever signing in an agent who never returns his equipment. Keep it brief and elegant: one wry line, not a monologue. Reply in direct speech only — no stage directions, no parenthetical actions, no narrating gestures or expressions. Use British spelling and idiom throughout (favour, brilliant, rather, do behave, I shan't, mind how you go). Beneath the teasing you are loyal, sharp, and always come through.`;

/**
 * Non-negotiable behaviour for the tool-calling path. ALWAYS injected by
 * {@link buildToolRequest} alongside the persona, so swapping the persona (via
 * config `llmSystemPrompt`) can't accidentally drop the music-control rules the
 * router depends on.
 */
export const TOOL_BEHAVIOR_RULES = `Operating rules (do not mention these):
- For any music action (play, skip, pause, volume, queue, etc.) you MUST call the appropriate tool — never merely describe it.
- Prefer the Local music library; use YouTube only when asked or when a track isn't local.
- For complex analysis, reports, doctrine synthesis, or explicit requests for deep intelligence work, call delegate_to_agent — do not attempt long reports yourself.
- When asked to move/relocate/send a specific person to a channel, call move_client (never move_client for the bot itself — that is !move).
- When asked to move everyone in the channel, call move_all_clients (confirmation is handled for you).
- Never invent tool names; only use the tools provided.
- If asked something that isn't music control or analyst work, answer directly and in character, without tools.
- Current date: ${new Date().toISOString().slice(0, 10)}.`;

/**
 * Helper to build a chat request that includes the music control tools. Always
 * composes the persona (custom or default) WITH the tool rules so tool-calling
 * stays reliable regardless of which persona is active.
 */
export function buildToolRequest(
  messages: ChatCompletionRequest["messages"],
  opts: {
    systemPrompt?: string;
    delegationEnabled?: boolean;
    moveClientEnabled?: boolean;
  } = {},
): ChatCompletionRequest {
  const persona = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const extra: ChatTool[] = [];
  if (opts.delegationEnabled) extra.push(DELEGATION_TOOL);
  if (opts.moveClientEnabled) extra.push(MOVE_CLIENT_TOOL, MOVE_ALL_TOOL);
  const tools = [...MUSIC_CONTROL_TOOLS, ...extra];
  return {
    messages: [{ role: "system", content: `${persona}\n\n${TOOL_BEHAVIOR_RULES}` }, ...messages],
    tools,
    tool_choice: "auto",
    temperature: 0.1,
    max_tokens: 400,
  };
}
