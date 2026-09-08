# PersonaPlex adapter (Talker)

Bot talks **only** to this adapter on `:8999` (`ws://…/v1/pcm`, `GET /health`).
Official Moshi (`python -m moshi.server` on `:8998`) is NVIDIA CUDA and is
**not** a product path on AMD hosts.

| Image | `engine` | When |
|---|---|---|
| This mock (`voice-duplex-dev`) | `mock` | CI + contract tests. No GPU. |
| cpp-bridge (later, PR-D1.5 / A1) | `moshicpp-vulkan` | AMD R9700 q4_k — **GA gated on `scripts/duplex-rtf.sh`** |
| NVIDIA moshi.server | `moshi-cuda` | Not used here (no NVIDIA GPU) |

Mock `unload` → `{ ok:true, loaded:false, realtime:false, vram_mb:0 }`.
`warm` → `loaded:true` plus a fake working set. `0x02` outbound is **agent**
caption (`mock-agent`), never user ASR.

```bash
docker compose -f docker-compose.yml --profile voice-duplex-dev up -d --build personaplex-mock
./scripts/voice-smoke.sh --duplex-mock
./scripts/duplex-rtf.sh   # mock exits 2 — not a GPU measurement
```
