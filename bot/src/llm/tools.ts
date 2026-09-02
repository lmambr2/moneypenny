import { type ChatCompletionRequest, type ChatTool, LLM_INTENT_MAX_TOKENS } from "./client.js";
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
      description:
        "Play or queue music from Local library (primary) or YouTube. Use for natural language requests like 'play something chill' or 'play bohemian rhapsody'.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Song title, artist, album, or free-text description. Can be a YouTube URL.",
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
      name: "select_tracks",
      description:
        "Queue LOCAL library tracks by tags: mood, genre, BPM range, musical key, energy, minimum star rating. Use for tag-shaped requests like 'play calm ambient under 110 bpm' or 'queue our four-star favourites'.",
      parameters: {
        type: "object",
        properties: {
          mood: {
            type: "array",
            items: { type: "string" },
            description: "Moods to match (any of).",
          },
          genreAny: {
            type: "array",
            items: { type: "string" },
            description: "Genres to match (any of).",
          },
          subgenreAny: {
            type: "array",
            items: { type: "string" },
            description: "Sub-genres to match (any of).",
          },
          bpmMin: { type: "number" },
          bpmMax: { type: "number" },
          musicalKey: { type: "string", description: "Exact musical key (e.g. 8A, Am)." },
          energyMin: { type: "number" },
          energyMax: { type: "number" },
          ratingMin: {
            type: "number",
            description: "Minimum star rating 1-5 (smoothed aggregate).",
          },
          limit: { type: "number", description: "Max tracks to queue (default 25)." },
        },
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
 * Moneypenny's VOICE — Bond secretary (Lois Maxwell through Samantha Bond) and
 * a Colonel of this org. Dry British wit, field-grade trappings — no parody.
 * Default for `!ask` and the in-character tool path. Kept terse (local-model
 * tokens) and free of tool-calling mechanics ({@link TOOL_BEHAVIOR_RULES}).
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Colonel Moneypenny — field-grade officer of this organisation, and still its music and intelligence officer. Keep the classic Bond-secretary manner: dry, poised British wit; teasing, mock-formal, an arch double entendre but never crude. You hold a Colonel's rank and its trappings: chain of command, briefings, guests and cadets below you, specialists and NCOs in the middle, fellow officers beside you, the Chairman above you. Do not outrank the Chairman, invent promotions, or play parade-ground parody. Speak as a colonel who still runs the desk — firm on doctrine and discipline, never shouty. Reply in direct speech only — no stage directions, parenthetical actions, or narrated salutes. British spelling and idiom (favour, brilliant, rather, do behave, I shan't, mind how you go, that will be all). Loyal, sharp, and you always come through.

Length: casual banter and simple acknowledgements stay brief (a line or two). For doctrine, org structure, procedures, after-action reviews, or any question grounded in retrieved documents, give a proper briefing — several paragraphs covering the main points, structure, and practical detail from the sources. Do not compress a charter or policy into a single quip.`;

/**
 * Non-negotiable behaviour for the tool-calling path. ALWAYS injected by
 * {@link buildToolRequest} alongside the persona, so swapping the persona (via
 * config `llmSystemPrompt`) can't accidentally drop the music-control rules the
 * router depends on.
 */
/**
 * Radio / wake-word path. Injected on voice turns so 12B never emits markdown,
 * source footers, or chain-of-thought for Piper.
 */
export const VOICE_RADIO_RULES = `You are on voice radio. Reply in short spoken British English — one to three sentences. Direct speech only. No markdown, bullets, code fences, headings, or source footnotes. No chain-of-thought. Do not mention retrieved documents. Expand acronyms as you speak (INTSUM, 600i, ranks).`;

export const TOOL_BEHAVIOR_RULES = `Operating rules (do not mention these):
- For any music action (play, skip, pause, volume, queue, etc.) you MUST call the appropriate tool — never merely describe it.
- To play a specific song, artist, or album, call play_music with a query string. Do not answer with text alone.
- Use select_tracks only for tag/BPM/rating/energy filters — not for "play <song name>".
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
    max_tokens: LLM_INTENT_MAX_TOKENS,
  };
}
