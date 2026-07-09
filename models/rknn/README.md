# RKNN Whisper weights (SBC STT track)

Place Rockchip **encoder + decoder** `.rknn` pairs here (mounted as
`/models/rknn` in `stt-rknn`):

```text
whisper-tiny-encoder.rknn
whisper-tiny-decoder.rknn
```

## Export

1. Follow Rockchip [rknn_model_zoo whisper](https://github.com/airockchip/rknn_model_zoo/tree/main/examples/whisper)
   on an x86 conversion host with `rknn-toolkit2`.
2. Target **RK3588**, INT8, model size **tiny** (or **base** if memory allows).
3. Copy both graphs into this directory (or set `RKNN_ENCODER` / `RKNN_DECODER`).

## Runtime

- Service: `services/stt-rknn`
- Without weights: automatic **faster-whisper CPU** fallback (`STT_FALLBACK`)
- Optional on-chip SRAM (host env for full RKNN apps):
  `RKNN_INTERNAL_MEM_TYPE=sram` — see Rockchip `RK3588_NPU_SRAM_usage.md`

## Status

Loader + fallback ship. Full mel→token path is zoo-export specific; when
weights are present the service loads RKNNLite and runs the wired pipeline
(or falls back if I/O shapes differ). See `services/stt-rknn/README.md`.
