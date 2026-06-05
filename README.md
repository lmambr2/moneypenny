<p align="center">
  <img src="./assets/wordmark.svg" alt="Moneypenny" width="620">
</p>

<p align="center">
  A self-hosted, NPU-accelerated <b>AI + music assistant</b> for a <b>TeamSpeak 6</b> server,<br>
  running entirely on a single <b>Orange Pi 5 Max (RK3588, 16 GB)</b>.<br>
  <br>
  <b>One repo. One <code>docker compose up</code>. No cloud.</b>
</p>

## Status

**Phases 1–3 implemented** (music, LLM Q&A + tool control, rank permissions, voice loop, watchdog, web UI); 300 unit tests passing. Voice STT/TTS sidecars are built but await on-device NPU validation. See [DESIGN.md](./DESIGN.md) for the full architecture, phased plan, hardware requirements, and security posture.

## Quick Start

One command — works on **x86-64** and the **Orange Pi (aarch64/NPU)**:

```bash
curl -fsSL https://raw.githubusercontent.com/lmambr2/moneypenny/main/install.sh | bash
```

The installer auto-detects your hardware and wires up an OpenAI-compatible LLM
backend accordingly:

| Host | LLM backend | Notes |
|------|-------------|-------|
| Orange Pi 5 Max (aarch64 + RK3588 NPU) | **rkllama**, native NPU | runs `host-setup/install-npu.sh` for you |
| x86-64 / any other Linux | **Ollama** (CPU/GPU) | pulls a small model (~2 GB) on first run |

It also installs Docker if missing (after a prompt), generates a `.env` with a
random session secret, sets up volumes, and starts the stack. Then open the
**Web UI at http://localhost:3000** and create your admin account.

Prefer to inspect first? Clone and run it locally:

```bash
git clone https://github.com/lmambr2/moneypenny.git && cd moneypenny
./install.sh --help          # see all options
./install.sh                 # auto
# ./install.sh --llm ollama --model qwen2.5:3b --with-voice
# ./install.sh --llm http://my-existing-llm:11434   # bring your own endpoint
```

<sub>The UI binds to localhost only by default. To reach it over the LAN, change the `:3000` publish to `0.0.0.0` **and** firewall it — see [DESIGN.md §11](./DESIGN.md).</sub>

## Phases

See DESIGN.md §13 for the detailed phased plan with acceptance criteria:

- **Phase 0**: Validate base fork + TS6 client playback
- **Phase 1a**: Local-first music (LocalProvider + YouTube)
- **Phase 1b**: LLM Q&A + natural language tool control
- **Phase 1c**: Rank-based permissions
- **Phase 2**: Voice loop (VAD/STT → router → TTS)
- **Phase 3**: Polish (Spotify bridge, watchdog, UI panels)

## License & Credits

Moneypenny is released under the [MIT License](./LICENSE).

It is derived from [ZHANGTIANYAO1/teamspeak-music-bot](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot) (MIT) — reworked and extended. Some subsystems reimplement patterns from OSL-3.0 / GPL-3.0 projects in spirit, without copying their source (see DESIGN.md §5).

## Hardware Target

- Orange Pi 5 Max (RK3588, 16 GB LPDDR4X)
- Active cooling mandatory for Phase 2
- NVMe for models + music library
- Ubuntu 24.04 arm64 or Armbian (vendor 6.1 kernel)
- RKNPU 0.9.8 + RKLLM 1.2.3
