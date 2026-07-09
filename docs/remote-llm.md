# Remote LLM (Phase 4) — split-brain across editions

Point **chat / tool-calling / roast grading** at a faster host while keeping
**embeddings + Qdrant** on the bot host. Different URLs for `llmUrl` and
`embeddingUrl` in Settings → AI & Permissions.

This is the **recommended production topology**: **SBC edition** on the Orange
Pi + **Server** Ollama (or full Server edition) on the LAN. See
[editions.md](./editions.md).

## When to use this

On-device benchmarks (Orange Pi 5 Max, 2026-06):

| Backend | Model | Decode tok/s |
|---------|-------|--------------|
| SBC CPU (ollama) | Gemma 4 E2B QAT | ~10–11 |
| Server / LAN workstation | Gemma 4 12B QAT Q4 | much faster (host-dependent) |

Decode on the RK3588 is memory-bandwidth-bound; NPU does **not** fix day-to-day
chat. A Server edition (or bare Ollama on x86) is the lever for `!ask`, fuzzy
music intent, roast grading, and voice LLM replies.

## Split-brain layout (Topology A)

```
SBC edition (docker)                Server / LAN Ollama
├─ bot ──chat/tools──► http://192.168.x.x:11434  (gemma-4-12B QAT)
├─ ollama ─embed────► http://ollama:11434        (embeddinggemma)
├─ qdrant            (vectors stay on SBC)
└─ stt-whisper tiny + piper-tts
```

Embeddings stay on the SBC. Chat uses the Server.

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

## SBC configuration

After `./install.sh --edition sbc --with-rag` (or release tarball), set
Settings → AI & Permissions (or `bot/data/config.json`):

```json
{
  "llmEnabled": true,
  "llmUrl": "http://192.168.x.x:11434",
  "llmModel": "hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL",
  "llmFallbackUrl": "http://ollama:11434",
  "llmFallbackModel": "hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL",
  "embeddingUrl": "http://ollama:11434",
  "embeddingModel": "embeddinggemma",
  "ragEnabled": true
}
```

Use the Server's **LAN IP**, not `localhost` — the bot runs inside Docker.

Or install with external LLM from day one:

```bash
./install.sh --edition sbc --with-rag --with-voice \
  --llm http://192.168.x.x:11434 \
  --model hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL
```

Test from the bot container:

```bash
docker exec moneypenny-bot-1 node -e \
  "fetch('http://192.168.x.x:11434/api/tags').then(r=>r.json()).then(console.log)"
```

Save settings (hot-reloads) or restart the bot. Check **LLM status** in Settings;
run `!ask` — first reply should be seconds, not a minute.

## Analyst delegation (DESIGN §R1) — **opt-in 31B**

| Role | Typical host | Model | Default |
|------|--------------|-------|---------|
| Fast chat / tools | Server / LAN | Gemma 4 **12B** QAT | **On** |
| Analyst delegate | Same host (or second) | Gemma 4 **31B** QAT | **Off** |
| Fallback + embed | SBC / bot host | E2B + embeddinggemma | as configured |

**Do not leave 12B and 31B both loaded unless VRAM can hold them.**

| VRAM (ballpark, Q4) | Policy |
|---------------------|--------|
| **&lt; ~20 GB** | 12B only. Do not enable analyst 31B (or use a second machine). |
| **~20–24 GB** | Enable 31B only if you accept Ollama **swapping** (12B unloads during `!analyst`). |
| **≥ ~28–32 GB** | Safe to enable both resident if you want zero swap (optional). |

In the web UI: **Settings → AI → “Enable heavy analyst model (31B)”** (off by default).
That toggle writes `llmDelegateUrl` / `llmDelegateModel`; when off, both are cleared
so `!analyst` does not call a heavy model.

```json
{
  "llmDelegateUrl": "http://192.168.x.x:11434",
  "llmDelegateModel": "hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL"
}
```

Pull 31B **only after** enabling the toggle (not part of default install):

```bash
ollama pull hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL
```

**Ollama tips (same GPU as 12B):** keep `OLLAMA_MAX_LOADED_MODELS=1` if you want
strict non-competition (swap on demand), or `2` only when VRAM truly fits both.
Short `keep_alive` on the 31B side reduces lingering VRAM use after analyst jobs.

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