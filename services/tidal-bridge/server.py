#!/usr/bin/env python3
"""
Moneypenny Tidal bridge — resolves a Tidal track reference to a playable stream
URL for the bot's StreamProvider (DESIGN §7.3). Implements the bot's bridge
contract:  GET /resolve?uri=<tidal-url-or-id>  ->  {streamUrl,title,artist,durationSec,coverUrl}

Login is OAuth device-flow with YOUR Tidal account (needs an active HiFi sub):
on first start it logs a `link.tidal.com/XXXXX` URL — open it, authorize once,
and the session token is cached to the /data volume (auto-refreshed thereafter).
The HTTP server comes up immediately; /resolve just reports "not logged in" until
you complete the one-time auth. Unofficial API (python-tidal) — fine for a
private, self-hosted server.
"""
import json
import os
import re
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import tidalapi

SESSION_FILE = os.environ.get("TIDAL_SESSION_FILE", "/data/tidal-session.json")
PORT = int(os.environ.get("PORT", "8081"))
# LOSSLESS (FLAC) yields a single direct URL ffmpeg can play; HI_RES is segmented DASH.
QUALITY = os.environ.get("TIDAL_QUALITY", "LOSSLESS").upper()

session = tidalapi.Session()
try:
    session.audio_quality = getattr(tidalapi.Quality, {
        "LOW": "low", "HIGH": "high", "LOSSLESS": "high_lossless", "HI_RES": "hi_res_lossless",
    }.get(QUALITY, "high_lossless"))
except Exception:
    pass


def _save() -> None:
    try:
        with open(SESSION_FILE, "w") as f:
            json.dump({
                "token_type": session.token_type,
                "access_token": session.access_token,
                "refresh_token": session.refresh_token,
                "expiry_time": session.expiry_time.isoformat() if session.expiry_time else None,
            }, f)
    except Exception as e:
        print(f"[tidal-bridge] could not save session: {e}", flush=True)


def login_thread() -> None:
    # 1) try to restore a cached session
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE) as fh:
                d = json.load(fh)
            exp = datetime.fromisoformat(d["expiry_time"]) if d.get("expiry_time") else None
            if session.load_oauth_session(d["token_type"], d["access_token"], d["refresh_token"], exp):
                print("[tidal-bridge] restored cached Tidal session", flush=True)
                _save()
                return
        except Exception as e:
            print(f"[tidal-bridge] cached session invalid ({e}); re-authenticating", flush=True)
    # 2) device-flow login (prints link.tidal.com URL, blocks THIS thread only)
    print("[tidal-bridge] No valid session — starting Tidal device login below:", flush=True)
    try:
        session.login_oauth_simple()  # prints "visit link.tidal.com/XXXX ..."
        _save()
        print("[tidal-bridge] Tidal login complete; session cached.", flush=True)
    except Exception as e:
        print(f"[tidal-bridge] login failed: {e}", flush=True)


def track_id(ref: str) -> str | None:
    m = re.search(r"track[:/](\d+)", ref) or re.search(r"/(\d+)(?:\?|$)", ref)
    if m:
        return m.group(1)
    return ref if ref.strip().isdigit() else None


def playlist_id(ref: str) -> str | None:
    """Extract a Tidal playlist UUID or numeric id from a URL/uri."""
    ref = (ref or "").strip()
    m = re.search(r"playlist[/:]+([0-9a-fA-F\-]{8,})", ref) or re.search(
        r"playlists?/([0-9a-fA-F\-]+)", ref
    )
    if m:
        return m.group(1)
    # bare uuid
    if re.fullmatch(r"[0-9a-fA-F\-]{16,}", ref):
        return ref
    return None


def list_playlist_tracks(pid: str) -> list[dict]:
    """Return bridge-shaped track rows for a Tidal playlist (requires login)."""
    pl = session.playlist(pid)
    items = []
    # python-tidal: playlist.tracks() or .items()
    try:
        tracks = pl.tracks() if callable(getattr(pl, "tracks", None)) else list(pl.tracks)
    except Exception:
        tracks = getattr(pl, "items", lambda: [])()
    for t in tracks or []:
        try:
            tid = getattr(t, "id", None)
            if tid is None:
                continue
            artist = "Tidal"
            if getattr(t, "artist", None):
                artist = getattr(t.artist, "name", None) or artist
            elif getattr(t, "artists", None):
                arts = t.artists
                if arts:
                    artist = getattr(arts[0], "name", None) or artist
            cover = ""
            if getattr(t, "album", None) and hasattr(t.album, "image"):
                try:
                    cover = t.album.image(640) or ""
                except Exception:
                    cover = ""
            items.append(
                {
                    "uri": f"https://tidal.com/browse/track/{tid}",
                    "id": str(tid),
                    "title": getattr(t, "name", None) or f"Tidal {tid}",
                    "artist": artist,
                    "durationSec": int(getattr(t, "duration", 0) or 0),
                    "coverUrl": cover,
                }
            )
        except Exception:
            continue
    return items


def stream_url(track) -> str | None:
    # API shape varies across python-tidal versions — try the simple URL first,
    # then the stream manifest (BTS/LOSSLESS exposes a direct URL list).
    try:
        return track.get_url()
    except Exception:
        pass
    try:
        manifest = track.get_stream().get_stream_manifest()
        urls = getattr(manifest, "urls", None) or (manifest.get_urls() if hasattr(manifest, "get_urls") else None)
        if urls:
            return urls[0]
    except Exception as e:
        print(f"[tidal-bridge] stream extraction failed: {e}", flush=True)
    return None


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            self._json(200, {
                "ok": True,
                "loggedIn": _logged_in(),
                "playlistExpandAvailable": _logged_in(),
            })
            return
        if u.path == "/playlist":
            # Same contract as Spotify bridge: { tracks: [{ uri, title, artist, ... }] }
            if not _logged_in():
                self._json(503, {
                    "error": "Tidal not logged in — see bridge logs for link.tidal.com",
                    "tracks": [],
                })
                return
            ref = (q.get("uri") or [""])[0]
            pid = playlist_id(ref)
            if not pid:
                self._json(400, {"error": f"no Tidal playlist id in '{ref}'", "tracks": []})
                return
            try:
                tracks = list_playlist_tracks(pid)
                self._json(200, {"tracks": tracks})
            except Exception as e:
                self._json(503, {"error": str(e), "tracks": []})
            return
        if u.path != "/resolve":
            self._json(404, {"error": "not found"})
            return
        if not _logged_in():
            self._json(503, {"error": "Tidal not logged in — see the bridge logs for the link.tidal.com URL"})
            return
        ref = (q.get("uri") or [""])[0]
        tid = track_id(ref)
        if not tid:
            self._json(400, {"error": f"no Tidal track id in '{ref}'"})
            return
        try:
            t = session.track(int(tid))
            url = stream_url(t)
            if not url:
                self._json(502, {"error": "could not resolve a stream URL (try TIDAL_QUALITY=LOSSLESS)"})
                return
            self._json(200, {
                "streamUrl": url,
                "title": t.name,
                "artist": t.artist.name if getattr(t, "artist", None) else "Tidal",
                "durationSec": getattr(t, "duration", 0),
                "coverUrl": (t.album.image(640) if getattr(t, "album", None) else "") or "",
            })
        except Exception as e:
            self._json(502, {"error": str(e)})

    def log_message(self, *_a) -> None:  # quiet
        pass


def _logged_in() -> bool:
    try:
        return bool(session.check_login())
    except Exception:
        return False


if __name__ == "__main__":
    threading.Thread(target=login_thread, daemon=True).start()
    print(f"[tidal-bridge] serving on :{PORT} (quality={QUALITY})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
