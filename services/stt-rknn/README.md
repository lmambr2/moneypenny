# stt-rknn — SBC STT track (NPU)

**Dual-track Whisper:** this image is the **SBC / Orange Pi** path.

| Priority | Engine | When |
|----------|--------|------|
| 1 | **RKNN** NPU | `.rknn` encoder+decoder mounted + `rknnlite` |
| 2 | **faster-whisper** CPU | Fallback so voice works before NPU weights exist |

Same HTTP API as `stt-whisper-cpp` (Server track).

## Weights

**Product default: Whisper `base`.** Export with Rockchip
[rknn_model_zoo whisper](https://github.com/airockchip/rknn_model_zoo/tree/main/examples/whisper)
via `MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh`. Mount:

```text
/models/rknn/whisper-base-encoder.rknn
/models/rknn/whisper-base-decoder.rknn
/models/rknn/vocab_en.txt
/models/rknn/mel_80_filters.txt
```

Zoo ladder: **tiny / base / medium** (no `small`). Or set `RKNN_ENCODER` /
`RKNN_DECODER`.

Optional **SRAM** (host, when using full RKNN runtime on device):
see Rockchip `RK3588_NPU_SRAM_usage.md` (`RKNN_INTERNAL_MEM_TYPE=sram`).

## Env

| Variable | Default |
|----------|---------|
| `STT_MODEL` | **`base`** |
| `STT_BACKEND` | `rknn` |
| `STT_FALLBACK` | `faster-whisper` |
| `STT_DEVICE` | `npu` (use `cpu` to force fallback) |
| `RKNN_MODELS_DIR` | `/models/rknn` |

## Health

```json
{
  "ok": true,
  "engine": "rknn",
  "model": "base",
  "device": "npu",
  "modelLoaded": true,
  "rknnWeightsPresent": true
}
```

## Dual track

| Edition | Image | Engine |
|---------|-------|--------|
| **SBC** | **this** | RKNN base → faster-whisper fallback |
| **Server** | `services/stt-whisper-cpp` | whisper.cpp (+ Vulkan on AMD) |
