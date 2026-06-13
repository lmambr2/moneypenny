# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - Grok Build (all roadmap phases)

### Added / Implemented (skipped ahead from Phase 5)

- **Phase 5: Vector store + embeddings** — ChromaDB sidecar (`--profile rag`). TS client in `bot/src/rag/chroma.ts`. Embeddings via extended `LlmClient` (ollama first, OpenAI compat fallback).
- **Phase 6: Document RAG (doctrine/INTSUMs)** — Full MVP. `!reindex`, automatic chunking by headings, stable citation IDs, retrieval injected into every `!ask` + fuzzy intent with `[source#section]` citations. Sample `doctrine/example-doctrine.md`. Config + settings hooks.
- **Phase 7: Long-term memory (MemPalace)** — New `bot/src/memory/mem-palace.ts`. Per-user semantic + temporal facts. `!remember <fact>`, `!recall <query>`. Memory context auto-injected into LLM prompts alongside RAG. Uses same Chroma backend.
- **Phase 8 (roast)** — Was already solid MVP; now benefits from unified memory/RAG context. Capture, LLM grading (0-10 cringe), auto-reel on 3+ present, opt-out/purge, cooldown. All on SQLite (no new infra).
- **Phase 4** — Already flexible via `llmUrl`; remote big models (vLLM etc.) now have RAG + memory context too.

All changes pushed to `dev` branch. "Make it so, Number One."

See ROADMAP.md and DESIGN.md for full status (Phases 5-7 marked implemented MVP).

### Fixed
- Previous Chinese characters in TS (Grok Build round 1).

## Previous
- See git history.