#!/usr/bin/env python3
"""
Moneypenny Spotify bridge (librespot-compatible contract).

Implements the bot StreamProvider bridge shape (DESIGN §7.3 / R-R6):

  GET /health
  GET /resolve?uri=<spotify-track-uri-or-url>
      → { streamUrl, title?, artist?, durationSec?, coverUrl? }
  GET /playlist?uri=<spotify-playlist-uri-or-url>
      → { tracks: [{ uri, title, artist, durationSec?, coverUrl? }] }

Audio path:
  - When LIBRESPOT_HTTP_BASE is set (e.g. go-librespot / spotifyd HTTP plugin
    exposing per-track streams), /resolve returns that stream URL.
  - Without a live librespot process, /resolve and /playlist return clear
    503 unavailable — the bot fails open (metadata→search or skip).

Premium Spotify account required for real audio. This sidecar never embeds
GPL code; it only speaks HTTP to operator-supplied librespot.

Env:
  PORT                 default 8082
  LIBRESPOT_HTTP_BASE  optional base for track audio, e.g. http://librespot:24879
  SPOTIFY_CLIENT_ID    optional Web API for metadata/playlist expansion
  SPOTIFY_CLIENT_SECRET
  SPOTIFY_REFRESH_TOKEN  or SPOTIFY_ACCESS_TOKEN
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8082"))
LIBRESPOT = os.environ.get("LIBRESPOT_HTTP_BASE", "").rstrip("/")
CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "").strip()
ACCESS_TOKEN = os.environ.get("SPOTIFY_ACCESS_TOKEN", "").strip()
REFRESH_TOKEN = os.environ.get("SPOTIFY_REFRESH_TOKEN", "").strip()


def _json(handler: BaseHTTPRequestHandler, code: int, obj: dict) -> None:
    body = json.dumps(obj).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def track_id(ref: str) -> str | None:
    ref = ref.strip()
    m = re.search(r"spotify:track:([A-Za-z0-9]+)", ref)
    if m:
        return m.group(1)
    m = re.search(r"open\.spotify\.com/track/([A-Za-z0-9]+)", ref)
    if m:
        return m.group(1)
    return None


def playlist_id(ref: str) -> str | None:
    ref = ref.strip()
    m = re.search(r"spotify:playlist:([A-Za-z0-9]+)", ref)
    if m:
        return m.group(1)
    m = re.search(r"open\.spotify\.com/playlist/([A-Za-z0-9]+)", ref)
    if m:
        return m.group(1)
    return None


def _api_token() -> str | None:
    global ACCESS_TOKEN
    if ACCESS_TOKEN:
        return ACCESS_TOKEN
    if not (CLIENT_ID and CLIENT_SECRET and REFRESH_TOKEN):
        return None
    data = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "refresh_token": REFRESH_TOKEN,
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
        }
    ).encode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=data,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read().decode())
            ACCESS_TOKEN = payload.get("access_token") or ""
            return ACCESS_TOKEN or None
    except Exception as e:
        print(f"[spotify-bridge] token refresh failed: {e}", flush=True)
        return None


def _api_get(path: str) -> dict | None:
    tok = _api_token()
    if not tok:
        return None
    req = urllib.request.Request(
        f"https://api.spotify.com/v1{path}",
        headers={"Authorization": f"Bearer {tok}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"[spotify-bridge] API {path} failed: {e}", flush=True)
        return None


def librespot_stream_url(tid: str) -> str | None:
    if not LIBRESPOT:
        return None
    # Common go-librespot / custom HTTP plugin patterns
    candidates = [
        f"{LIBRESPOT}/track/{tid}",
        f"{LIBRESPOT}/stream/{tid}",
        f"{LIBRESPOT}/audio/{tid}",
    ]
    for url in candidates:
        try:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=5) as resp:
                if 200 <= resp.status < 400:
                    return url
        except Exception:
            continue
    # Prefer first candidate even if HEAD fails — ffmpeg will probe
    return candidates[0]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[spotify-bridge] {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self) -> None:
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == "/health":
            _json(
                self,
                200,
                {
                    "ok": True,
                    "engine": "spotify-bridge",
                    "librespot": bool(LIBRESPOT),
                    "webApi": bool(CLIENT_ID and (ACCESS_TOKEN or REFRESH_TOKEN)),
                },
            )
            return

        if u.path == "/resolve":
            ref = (q.get("uri") or [""])[0]
            tid = track_id(ref)
            if not tid:
                _json(self, 400, {"error": f"no Spotify track id in '{ref}'"})
                return
            stream = librespot_stream_url(tid)
            meta = _api_get(f"/tracks/{tid}") or {}
            if not stream:
                _json(
                    self,
                    503,
                    {
                        "error": "librespot unavailable — set LIBRESPOT_HTTP_BASE or run go-librespot",
                        "title": meta.get("name"),
                        "artist": (meta.get("artists") or [{}])[0].get("name"),
                    },
                )
                return
            artists = meta.get("artists") or []
            _json(
                self,
                200,
                {
                    "streamUrl": stream,
                    "title": meta.get("name") or f"Spotify {tid}",
                    "artist": artists[0].get("name") if artists else "Spotify",
                    "durationSec": int((meta.get("duration_ms") or 0) / 1000) or None,
                    "coverUrl": ((meta.get("album") or {}).get("images") or [{}])[0].get("url"),
                },
            )
            return

        if u.path == "/playlist":
            ref = (q.get("uri") or [""])[0]
            pid = playlist_id(ref)
            if not pid:
                _json(self, 400, {"error": f"no Spotify playlist id in '{ref}'"})
                return
            data = _api_get(f"/playlists/{pid}/tracks?limit=100")
            if data is None:
                _json(
                    self,
                    503,
                    {
                        "error": "Spotify Web API unavailable — set SPOTIFY_CLIENT_ID/SECRET + refresh token",
                        "tracks": [],
                    },
                )
                return
            tracks = []
            for item in data.get("items") or []:
                t = item.get("track") or {}
                if not t.get("id"):
                    continue
                arts = t.get("artists") or []
                tracks.append(
                    {
                        "uri": t.get("uri") or f"spotify:track:{t['id']}",
                        "title": t.get("name"),
                        "artist": arts[0].get("name") if arts else "Spotify",
                        "durationSec": int((t.get("duration_ms") or 0) / 1000) or None,
                        "coverUrl": ((t.get("album") or {}).get("images") or [{}])[0].get("url"),
                    }
                )
            _json(self, 200, {"tracks": tracks})
            return

        _json(self, 404, {"error": "not found"})


def main() -> None:
    print(
        f"[spotify-bridge] :{PORT} librespot={bool(LIBRESPOT)} webApi={bool(CLIENT_ID)}",
        flush=True,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
