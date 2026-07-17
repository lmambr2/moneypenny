# `@moneypenny/audio-native` (PR-B4)

Rust **N-API** bindings for:

- **Opus** encode/decode (system `libopus`)
- **Energy VAD** helpers (`pcmRms`, `isSpeechFrame`)

The bot prefers this package when the `.node` addon is present; otherwise it
falls back to `@discordjs/opus` and pure-TS `rms16`.

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

### SBC / arm64 without cross toolchain

Build on the Pi (or arm64 Docker) so the triple matches:

```bash
docker run --platform linux/arm64 --rm -v "$PWD":/src -w /src/bot/packages/audio-native \
  rust:1-bookworm bash -lc '
    apt-get update && apt-get install -y nodejs npm pkg-config libopus-dev
    npm i && npx napi build --platform --release
  '
```

Copy `*.node` into the image / deploy tree; the loader picks the matching triple.

## API

```js
const { NativeOpus, pcmRms, isSpeechFrame, nativeAudioBackend } = require("@moneypenny/audio-native");

const codec = new NativeOpus(48000, 2); // TS music defaults
const opus = codec.encode(pcmS16le);
const pcm = codec.decode(opus);
```
