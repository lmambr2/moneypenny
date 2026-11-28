# PersonaPlex adapter (Talker)

Bot talks **only** to this adapter on `:8999` (`ws://…/v1/pcm`, `GET /health`).
Official Moshi (`python -m moshi.server` on `:8998`) is NVIDIA CUDA and is
**not** a product path on AMD hosts.

| Image | `engine` | When |
|---|---|---|
| This mock (`voice-duplex-dev`) | `mock` | CI + contract tests. No GPU. |
| cpp-bridge (`cpp-bridge/bridge.py`, compose `docker-compose.server.amd.yml`) | `moshicpp-vulkan` | AMD infer card. **GA gated on `scripts/duplex-rtf.sh`.** Warm without `MOSHI_CPP_BIN` stays `loaded=false`. |
| NVIDIA moshi.server | `moshi-cuda` | Not used here (no NVIDIA GPU) |

Mock `unload` → `{ ok:true, loaded:false, realtime:false, vram_mb:0 }`.
`warm` → `loaded:true` plus a fake working set. `0x02` outbound is **agent**
caption (`mock-agent`), never user ASR.

```bash
docker compose -f docker-compose.yml --profile voice-duplex-dev up -d --build personaplex-mock
./scripts/voice-smoke.sh --duplex-mock
./scripts/duplex-rtf.sh   # mock exits 2 — not a GPU measurement
```
