# Moneypenny station control

Use the `moneypenny` MCP server when the user asks about music, the TeamSpeak
bot, doctrine/RAG, radio, or station ops.

## Tool policy

1. Prefer `status_*` (now playing, queue, health) before mutating.
2. Explicit song/URL requests → `music_play` / `music_add` (not free-form chat).
3. Org/doctrine questions → `rag_ask` (not general web search). Chunk-only → `rag_search`.
4. Do not invent ban/unban/stop/clear — confirm with the user first.
5. Prefer structured `music_*` over `harness_turn` when the song is already known.
6. `harness_turn` with `mode=intent` only for fuzzy NL music when structured tools are a poor fit.
7. Never claim a track is playing without checking `status_now_playing`.
8. Volume/mode/stop/clear/radio power → admin tools (`music_volume`, `music_mode`,
   `music_stop`, `music_clear`, `radio_set`). Reindex → `doctrine_reindex`.
9. Private facts → `memory_remember` / `memory_recall` / `memory_forget` (MCP subject).

## Auth

Tools require a Bearer token configured on the MCP server (`MCP_TOKEN` on the bot).
If tools fail with Unauthorized, the token or URL is wrong — do not retry with guesses.
