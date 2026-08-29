# `@moneypenny/audio-native` (PR-B4)

Rust **N-API** bindings for:

- **Opus** encode/decode (system `libopus`) plus inbound `decodeVoice`
- **PCM** peak / RMS / scale / mix / playback duck (`pcmApplyPlaybackGain`)
- **Voice-frame helper** (`NativeVoiceFrame`) — one-pass inspect + STT normalize
- **Energy VAD** helpers (`pcmRms`, `isSpeechFrame`)

The bot prefers this package when the `.node` addon is present. Opus encode
has no JS fallback (the image must ship the addon). PCM mix/duck/STT prep
falls back to TypeScript if the addon is missing.

## Build

```bash
# needs: rustc, cargo, pkg-config, libopus-dev
./scripts/build-audio-native.sh          # host triple
./scripts/build-audio-native.sh --with-arm64   # if aarch64-linux-gnu-gcc present

# or from bot/
npm run build:native
npm run build:native:arm64   # cross — needs aarch64 linker + rust target
npm run test -w @moneypenny/audio-native
```

Produces `audio-native.<platform>.node` next to `index.cjs` (e.g.
`linux-x64-gnu`, `linux-arm64-gnu` for the Pi).

### SBC / arm64 (preferred: build on device)

x86 hosts cannot emit a working `linux-arm64-gnu` `.node` without a full
aarch64 cross toolchain + matching libopus. On the **Orange Pi / arm64 Docker**:

```bash
# On the Pi (native arch) — simplest:
cd bot && npm run build:native

# Or qemu/buildx arm64 container (slow; needs binfmt):
docker run --platform linux/arm64 --rm -v "$PWD":/src -w /src/bot/packages/audio-native \
  rust:1-bookworm bash -lc '
    apt-get update && apt-get install -y nodejs npm pkg-config libopus-dev
    npm i && npx napi build --platform --release
  '
```

`bot/Dockerfile` builds native for the **image** arch (`TARGETARCH`). Prefer
`docker compose build` on the Pi for SBC so `audio-native.linux-arm64-gnu.node`
is produced in-image. Missing addon → **no Opus** (encode throws); PCM helpers
fall back to TypeScript.

## API

```js
const {
  NativeOpus,
  NativeVoiceFrame,
  pcmRms,
  pcmApplyPlaybackGain,
  nativeAudioBackend,
} = require("@moneypenny/audio-native");

const codec = new NativeOpus(48000, 2); // TS music defaults
const opus = codec.encode(pcmS16le);
const pcm = codec.decode(opus);
const ducked = pcmApplyPlaybackGain(pcm, 40, true, 15, 0);
const stt = new NativeVoiceFrame().process(inboundPcm);
```
