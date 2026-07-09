# stt-rknn — SBC STT track (NPU)

**Dual-track Whisper:** this image is the **SBC / Orange Pi** path.

| Priority | Engine | When |
|----------|--------|------|
| 1 | **RKNN** NPU | `.rknn` encoder+decoder mounted + `rknnlite` |
| 2 | **faster-whisper** CPU | Fallback so voice works before NPU weights exist |

Same HTTP API as `stt-whisper-cpp` (Server track).

## Weights

Export Whisper **tiny** (or base) with Rockchip
[rknn_model_zoo whisper](https://github.com/airockchip/rknn_model_zoo/tree/main/examples/whisper)
(or community INT8 exports). Mount:

```text
/models/rknn/whisper-tiny-encoder.rknn
/models/rknn/whisper-tiny-decoder.rknn
```

Or set `RKNN_ENCODER` / `RKNN_DECODER`.

Optional **SRAM** (host, when using full RKNN runtime on device):
see Rockchip `RK3588_NPU_SRAM_usage.md` (`RKNN_INTERNAL_MEM_TYPE=sram`).

## Env

| Variable | Default |
|----------|---------|
| `STT_MODEL` | `tiny` |
| `STT_BACKEND` | `rknn` |
| `STT_FALLBACK` | `faster-whisper` |
| `STT_DEVICE` | `npu` (use `cpu` to force fallback) |
| `RKNN_MODELS_DIR` | `/models/rknn` |

## Pipeline status

Loading RKNNLite + graphs is implemented. The full mel→token decode loop is
**zoo-export specific** and may still fall back to CPU until the I/O tensors
match your export (see log: `mel/encoder/decoder pipeline not fully wired`).

Day-one SBC: **CPU tiny works**. Day-two: drop in `.rknn` and complete the
zoo-aligned `RknnWhisper.transcribe` path.

## Dual track

| Edition | Image | Engine |
|---------|-------|--------|
| **SBC** | **this** | RKNN → faster-whisper fallback |
| **Server** | `services/stt-whisper-cpp` | whisper.cpp (+ Vulkan on AMD) |
