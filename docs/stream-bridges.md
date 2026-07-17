# Stream bridges (Spotify / Tidal)

Optional Docker sidecars for **real** Spotify and Tidal streaming. Without a
bridge, Spotify/Tidal links fall back to YouTube search (or fail closed).

## Compose

| Service | Profile | Internal URL | Notes |
|---------|---------|--------------|--------|
| `tidal-bridge` | `stream` | `http://tidal-bridge:8081` | Device OAuth once; session volume |
| `spotify-bridge` | `stream` + `spotify` | `http://spotify-bridge:8082` | Premium + token env; optional librespot |

```bash
# Tidal
docker compose --profile stream up -d tidal-bridge
docker compose logs -f tidal-bridge   # open link.tidal.com URL once

# Spotify
docker compose --profile stream --profile spotify up -d spotify-bridge
# set SPOTIFY_* tokens / LIBRESPOT_HTTP_BASE per services/spotify-bridge/README.md
```

## Bot env

```bash
# Single bridge for both platforms (legacy):
STREAM_BRIDGE_URL=http://tidal-bridge:8081

# Prefer per-platform (bot uses these when set):
TIDAL_BRIDGE_URL=http://tidal-bridge:8081
SPOTIFY_BRIDGE_URL=http://spotify-bridge:8082
```

Settings → **Stream bridge URL** still maps to `streamBridgeUrl` /
`STREAM_BRIDGE_URL`. Per-platform env overrides apply at process start.

## Operator checks

- Settings → Stream bridge **Check** (generic bridge status)
- Play a Tidal/Spotify URL in chat or Library; logs should show stream resolve
  not YouTube fallback when the bridge is healthy
- Fail-open: if the bridge is down, transport continues; resolve may fail that
  track only

## Security

- Bridges stay on the compose network (Tidal has no host publish by default)
- Spotify publishes `127.0.0.1:8082` for local debug only
