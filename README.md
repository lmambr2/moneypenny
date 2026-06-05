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

**Design v2 / pre-implementation.** See [DESIGN.md](./DESIGN.md) for the full architecture, phased build plan, hardware requirements, model recommendations, and security posture.

## Quick Start (once implemented)

```bash
# 1. Prep the Orange Pi host (NPU drivers + RKLLM runtime)
sudo ./host-setup/install-npu.sh

# 2. Bring everything up
docker compose --profile core up -d

# Web UI: http://<lan-ip>:3000
```

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
