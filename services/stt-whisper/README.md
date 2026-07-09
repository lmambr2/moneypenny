# stt-whisper — legacy faster-whisper image

HTTP contract compatible with `bot/src/voice/stt.ts`.

**Product dual track** (preferred):

| Edition | Directory | Engine |
|---------|-----------|--------|
| SBC | [`../stt-rknn`](../stt-rknn/) | RKNN NPU → faster-whisper fallback |
| Server | [`../stt-whisper-cpp`](../stt-whisper-cpp/) | whisper.cpp (+ Vulkan) |

This directory remains the **base compose / dev** image (`faster-whisper` only).
Edition overlays **replace** the `stt-whisper` service build with the track above.
See [docs/voice-backends.md](../../docs/voice-backends.md).

## No KWS

Enable bot `voice.textWakeFallback`.
