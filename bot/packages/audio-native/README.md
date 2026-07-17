# `@moneypenny/audio-native` (PR-B4)

Rust **N-API** bindings for:

- **Opus** encode/decode (system `libopus`)
- **Energy VAD** helpers (`pcmRms`, `isSpeechFrame`)

The bot prefers this package when the `.node` addon is present; otherwise it
falls back to `@discordjs/opus` and pure-TS `rms16`.

## Build

```bash
# needs: rustc, cargo, pkg-config, libopus-dev
cd bot
npm run build -w @moneypenny/audio-native
npm run test -w @moneypenny/audio-native
```

Produces `audio-native.<platform>.node` next to `index.cjs`.

## API

```js
const { NativeOpus, pcmRms, isSpeechFrame, nativeAudioBackend } = require("@moneypenny/audio-native");

const codec = new NativeOpus(48000, 2); // TS music defaults
const opus = codec.encode(pcmS16le);
const pcm = codec.decode(opus);
```
