# Phase 8 — Roast (community layer)

**Status: shipped.** Capture channel chat → LLM cringe-grade → auto-post a
“greatest hits” reel when enough people are present. SQLite only (no RAG /
MemPalace required).

---

## Enable

1. Settings → **AI assistant** on (grading uses the chat LLM).
2. Settings → **Roast (community layer)** on.
3. Tune:
   - **Min. people present** (default 3) for auto-fire
   - **Cooldown** minutes between auto reels (default 180)
   - **Min. score** for reel inclusion (default 4 / 10)

---

## Commands

| Command | Effect |
|---------|--------|
| `!roast` | Show current reel, or status (queue / cooldown) |
| `!roastout` | Opt out + purge your captured lines |
| `!roastin` | Opt back in (history stays purged) |

Voice (watchword): “Moneypenny roast”, “roastout”, “roastin”.

---

## How it works

1. **Capture** — channel chat (not PMs, not `!commands` themselves) **and**
   ask/analyst/intent exchanges: the question plus Moneypenny’s reply, as one
   quote attributed to the human (`Alice: …` / `Moneypenny: …`). Voice ask
   turns count too. Opt-out still purges the pair.
   BBCode/URLs stripped; short/spam-deduped; max ~400 chars (exchanges ~280+280).
2. **Grade** — idle poller batches ungraded lines through the LLM
   (`{"score":0-10,"reason":"…"}`). The judge scores the question *and* how
   arch her reply was.
3. **Auto reel** — when humans ≥ min present, enough lines ≥ min score, and
   cooldown elapsed → post reel and **consume** those quotes (next reel is fresh).
4. **Manual** — `!roast` always shows the best remaining picks (or a status line).

---

## Smoke checklist

```text
# Admin: enable roast + LLM in Settings
# 3+ people in channel; chat naturally a bit
!roast
# After grading has run (wait a minute or two of idle):
!roast          # may show reel or queue status
!roastout       # purge yourself
!roastin        # rejoin
```

---

## Privacy

- Opt-out is immediate and purges stored lines for that TS uid.
- Captured text is stored in the bot SQLite DB (`bot/data`).
- Voice **ask / analyst / question** turns are captured as the same
  question+reply pair (not raw STT of skip/pause).

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Never grades | LLM enabled + reachable; bot idle poller running |
| Never auto-posts | Min people present; cooldown; enough scores ≥ min |
| `!roast` empty | Chat more, or `!ask` her something; wait for grade batch |
| Still captured after opt-out | Must use `!roastout` with a real TS uid (not guest) |
