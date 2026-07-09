# RKNN Whisper weights (SBC STT track)

Place Rockchip **encoder + decoder** `.rknn` pairs here (mounted as
`/models/rknn` in `stt-rknn`).

**Product default: Whisper `base` on RK3588 NPU.**

```text
whisper-base-encoder.rknn   # ~43 MB — openai whisper base, 20s export
whisper-base-decoder.rknn   # ~153 MB
vocab_en.txt
mel_80_filters.txt
```

Optional (lighter / heavier; zoo supports tiny / base / medium — **not** small):

```text
whisper-tiny-encoder.rknn
whisper-tiny-decoder.rknn
# or whisper-medium-*
```

Built on a workstation via `models/convert/export-whisper-rknn.sh` (rknn-toolkit2).

## Export

```bash
# Recommended product weights
MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh

# Lighter / heavier
MODEL_TYPE=tiny ./models/convert/export-whisper-rknn.sh
MODEL_TYPE=medium ./models/convert/export-whisper-rknn.sh
```

1. Needs Rockchip [rknn_model_zoo whisper](https://github.com/airockchip/rknn_model_zoo/tree/main/examples/whisper)
   + `rknn-toolkit2` on an x86 conversion host (script vendors/clones zoo as needed).
2. Target **RK3588**, static 20s chunk export.
3. Copy both graphs + `vocab_en.txt` + `mel_80_filters.txt` into this directory
   (or set `RKNN_ENCODER` / `RKNN_DECODER`).

### Deploy to Pi

```bash
rsync -avP models/rknn/whisper-base-*.rknn models/rknn/vocab_en.txt \
  models/rknn/mel_80_filters.txt dietpi@opi5:~/moneypenny/models/rknn/

# If stt-whisper uses the whisper-models volume, copy in:
ssh dietpi@opi5 'docker run --rm \
  -v moneypenny_whisper-models:/models \
  -v /home/dietpi/moneypenny/models/rknn:/src:ro alpine \
  sh -c "mkdir -p /models/rknn && cp -av /src/whisper-base-*.rknn \
    /src/vocab_en.txt /src/mel_80_filters.txt /models/rknn/"'

# .env on Pi
# STT_MODEL=base
# STT_DEVICE=npu
# STT_BACKEND=rknn
# STT_FALLBACK=faster-whisper
```

## Runtime

- Service: `services/stt-rknn`
- Env defaults: `STT_MODEL=base`, `STT_BACKEND=rknn`, `STT_DEVICE=npu`
- Without weights: automatic **faster-whisper CPU** fallback (`STT_FALLBACK`)
- Optional on-chip SRAM: `RKNN_INTERNAL_MEM_TYPE=sram` — see Rockchip
  `RK3588_NPU_SRAM_usage.md`

## Health

```bash
curl -s http://127.0.0.1:9000/health
# {"ok":true,"engine":"rknn","model":"base","device":"npu","modelLoaded":true,...}
```

See `services/stt-rknn/README.md`.
