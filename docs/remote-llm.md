# Remote LLM (Phase 4) — split-brain on the Pi

Point **chat / tool-calling / roast grading** at a faster LAN host while keeping
**embeddings + Qdrant** on the Pi. The bot already supports different URLs for
`llmUrl` and `embeddingUrl` in Settings → AI & Permissions.

## When to use this

On-device benchmarks (Orange Pi 5 Max, 2026-06):

| Backend | Model | Decode tok/s |
|---------|-------|--------------|
| Pi CPU (ollama) | Gemma 4 E2B QAT | ~11 |
| LAN workstation (Ryzen 9800X3D) | Gemma 4 12B QAT Q4 | TBD |

Decode on the RK3588 is memory-bandwidth-bound; a bigger remote CPU box is the
practical lever for `!ask`, fuzzy music intent, roast grading, and voice LLM
replies.

## Split-brain layout

```
Pi (docker)                         LAN workstation (e.g. llm-box)
├─ bot ──chat/tools──► http://192.168.x.x:11434  (gemma-4-12B QAT)
├─ ollama ─embed────► http://ollama:11434        (embeddinggemma, 621 MB)
└─ qdrant            (vectors stay on Pi)
```

Embeddings are small, frequent, and already tuned for `embeddinggemma` on the Pi.
Chat payloads are larger and benefit most from the remote box.

## Workstation prep

**Requires Ollama ≥ 0.30** (Gemma 4 `gemma4` architecture). If `ollama --version`
shows 0.23.x from `/usr/local/bin/ollama`, run
`sudo ./scripts/upgrade-ollama-for-gemma4.sh` on the workstation (uses the pacman
`/usr/bin/ollama` binary).

1. Install [Ollama](https://ollama.com) and pull a tool-capable model:

   ```bash
   ollama pull hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL
   ```

2. Confirm Ollama listens on the LAN (default on Linux is `*:11434`):

   ```bash
   ss -tlnp | grep 11434
   curl http://127.0.0.1:11434/api/tags
   ```

3. **Firewall:** allow TCP `11434` from the Pi's IP only (UFW example):

   ```bash
   sudo ufw allow from 192.168.x.x to any port 11434 proto tcp
   ```

4. Verify tool-calling (required for spoken/chat music control):

   ```bash
   curl http://127.0.0.1:11434/v1/chat/completions -d '{
     "model":"hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL",
     "messages":[{"role":"user","content":"play jazz"}],
     "tools":[{"type":"function","function":{"name":"play_music","description":"Play","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}],
     "tool_choice":"auto"
   }'
   ```

## Pi configuration

Settings → AI & Permissions (or `bot/data/config.json`):

```json
{
  "llmEnabled": true,
  "llmUrl": "http://192.168.x.x:11434",
  "llmModel": "hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL",
  "embeddingUrl": "http://ollama:11434",
  "embeddingModel": "embeddinggemma",
  "ragEnabled": true
}
```

Use the workstation's **LAN IP**, not `localhost` — the bot runs inside Docker.

Test from the bot container:

```bash
docker exec moneypenny-bot-1 node -e \
  "fetch('http://192.168.x.x:11434/api/tags').then(r=>r.json()).then(console.log)"
```

Save settings (hot-reloads) or restart the bot. Check **LLM status** in Settings;
run `!ask` — first reply should be seconds, not a minute.

## Analyst delegation (DESIGN §R1)

The bot can route heavy work to a **second** LAN host while keeping fast chat on
the primary:

| Role | Typical host | Model |
|------|--------------|-------|
| Fast chat / tools | LAN workstation | Gemma 4 12B QAT |
| Analyst delegate | LAN workstation (same or second host) | Gemma 4 31B QAT |
| Fallback + embed | Pi ollama | Gemma E2B + embeddinggemma |

Settings → **Delegate analyst URL/model**, or `config.json`:

```json
{
  "llmDelegateUrl": "http://192.168.x.x:11434",
  "llmDelegateModel": "hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL"
}
```

Pull the analyst model on the delegate host (same Ollama box as chat is fine —
Ollama swaps models on demand):

```bash
ollama pull hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL
```

Users invoke via `!analyst <task>` / `!agent <task>`, or the fast model can emit
the `delegate_to_agent` tool during fuzzy intent. RAG context is injected on the
delegate path the same way as `!ask`.

Delegate calls are **async** (DESIGN §R1b): the bot acks immediately
("Analyst on it — I'll post the result here when ready.") and posts the full
answer when the heavy model finishes (up to ~5 min). Music/control and quick
`!ask` are unaffected. Voice-initiated analyst tasks use the same pattern (spoken
ack, text follow-up in channel).

**Rights:** `!analyst` / `!agent` are **not** in the default public set — only
server-groups granted `@analyst` (admins by default) may invoke them or trigger
`delegate_to_agent` from fuzzy intent.

## Pi local fallback (Gemma E2B on ollama)

When the LAN workstation is off or unreachable, the bot falls back to the Pi's
local ollama (Gemma 4 E2B QAT) without changing Settings manually.

Settings → fallback fields (filled by the **Remote chat + local embeddings**
preset):

- **Fallback chat URL:** `http://ollama:11434`
- **Fallback model:** `hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL`

The bot tries the primary LAN host first; on connection/timeout errors it retries
once on Pi ollama (~10 tok/s — slower than the LAN box but Gemma-native and
offline-resilient).

Check status in Settings → **Check** — shows primary vs fallback reachability.

Optional: NotPunchnox/rkllama (operator `.rkllm` on the NPU, default slot `models/npu-llm/`) remains available via
the **Local — RKLLama (NPU)** preset if you explicitly want the NPU path.

## Fallback to all-local

To revert to all-local inference, restore the **Local Ollama (Pi)** preset:

- `llmUrl`: `http://ollama:11434`
- `llmModel`: `hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL`
- `embeddingUrl`: `http://ollama:11434`

## Security notes

- Ollama has **no built-in auth**. Bind to LAN only; do not port-forward `:11434`
  to the public internet.
- The Moneypenny web UI stays localhost-only on the Pi by default (DESIGN §11).