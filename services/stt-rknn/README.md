# stt-rknn — Rockchip NPU Whisper (SBC)

INT8 quant for the NPU is **baked into the `.rknn` export** (toolkit2 / zoo).  
`STT_COMPUTE_TYPE=int8` only affects the **CPU** faster-whisper fallback.

| Env | Default | Notes |
|-----|---------|--------|
| `STT_MODEL` | `base` | tiny \| base \| … ladder name |
| `STT_BACKEND` | `rknn` | falls back to faster-whisper if `.rknn` missing |
| `STT_COMPUTE_TYPE` | **`int8`** | CPU fallback only |
| `RKNN_ENCODER` / `RKNN_DECODER` | auto under `RKNN_MODELS_DIR` | `whisper-{model}-encoder/decoder.rknn` |
| `RKNN_CORE_MASK` | `auto` | Prefer `0_1_2` (all cores), then `0_1`, `0`, default |
| `RKNN_MAX_DECODE_STEPS` | `48` | Cap decoder loop (voice commands are short) |

### NPU code opts (runtime)

- Multi-core `init_runtime` with fallback chain + log of mask used  
- Precomputed Hann window, contiguous mel filters, faster \|z\|²  
- Reused mel / encoder input buffers (less alloc per utterance)  
- Bound decoder steps for command-length audio  

Export:

```bash
MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh
# → models/rknn/whisper-base-{encoder,decoder}.rknn
```

Health JSON includes `model`, `backend`, `compute`. Logs show `encoder=… decoder=…` core masks.

Bot-side selection helpers: `bot/src/voice/stt-models.ts` (`resolveSttModelSelection`).

```bash
# CPU-only unit tests (no rknnlite)
cd services/stt-rknn && python3 -m pytest test_rknn_whisper_infer.py -q
```