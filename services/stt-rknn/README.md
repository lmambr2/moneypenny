# stt-rknn — Rockchip NPU Whisper (SBC)

INT8 quant path is the product default for RKNN exports and CPU fallback:

| Env | Default | Notes |
|-----|---------|--------|
| `STT_MODEL` | `base` | tiny \| base \| … ladder name |
| `STT_BACKEND` | `rknn` | falls back to faster-whisper if `.rknn` missing |
| `STT_COMPUTE_TYPE` | **`int8`** | INT8 quant for CPU fallback; RKNN pair is W8A8 export |
| `RKNN_ENCODER` / `RKNN_DECODER` | auto under `RKNN_MODELS_DIR` | `whisper-{model}-encoder/decoder.rknn` |

Export:

```bash
MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh
# → models/rknn/whisper-base-{encoder,decoder}.rknn
```

Health JSON includes `model`, `backend`, `compute` so Settings / ops can confirm INT8.

Bot-side selection helpers: `bot/src/voice/stt-models.ts` (`resolveSttModelSelection`).
