# Moneypenny

> A self-hosted, NPU-accelerated **AI + music assistant** for a **TeamSpeak 6** server, running entirely on a single **Orange Pi 5 Max (RK3588, 16 GB)**.

One repo. One `docker compose up`. No cloud.

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
