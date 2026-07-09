# Spotify / librespot bridge

Optional StreamProvider bridge for Spotify track + playlist expansion (R-R6).

## Contract

| Endpoint | Response |
|----------|----------|
| `GET /health` | `{ ok, engine, librespot, webApi }` |
| `GET /resolve?uri=` | `{ streamUrl, title, artist, … }` or 503 |
| `GET /playlist?uri=` | `{ tracks: [{ uri, title, artist, … }] }` or 503 |

Point Moneypenny at it:

```bash
STREAM_BRIDGE_URL=http://spotify-bridge:8082
# or Settings → stream bridge URL
```

## Real audio (librespot)

1. Run [go-librespot](https://github.com/devgianlu/go-librespot) (or equivalent) with an HTTP audio plugin on the LAN.
2. Set `LIBRESPOT_HTTP_BASE=http://librespot:24879` (path patterns tried: `/track/{id}`, `/stream/{id}`, `/audio/{id}`).
3. Premium account required.

## Playlist metadata

Set Spotify Web API credentials for `/playlist` expansion:

- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN` (or short-lived `SPOTIFY_ACCESS_TOKEN`)

Without credentials, `/playlist` returns **503** with empty tracks — bot fails open.

## Compose

```bash
docker compose --profile spotify up -d spotify-bridge
```

See root `docker-compose.yml` profile `spotify`.
