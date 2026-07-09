"""Pure helpers for Tidal playlist expansion (no live API)."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

HERE = Path(__file__).resolve().parent


def _load():
    # Avoid importing tidalapi at module import if missing — inject fake
    sys.modules.setdefault("tidalapi", MagicMock())
    spec = importlib.util.spec_from_file_location("tidal_bridge_server", HERE / "server.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


def test_playlist_id_from_url():
    m = _load()
    assert m.playlist_id("https://tidal.com/browse/playlist/abc-def-12345678") == "abc-def-12345678"
    assert m.playlist_id("tidal:playlist:deadbeef-cafe-babe-0001") == "deadbeef-cafe-babe-0001"
    assert m.playlist_id("not-a-playlist") is None


def test_list_playlist_tracks_shapes_rows():
    m = _load()
    track = MagicMock()
    track.id = 42
    track.name = "Neon"
    track.duration = 180
    track.artist = MagicMock(name="artist")
    track.artist.name = "Cats"
    track.album = MagicMock()
    track.album.image = MagicMock(return_value="http://cover")
    pl = MagicMock()
    pl.tracks = MagicMock(return_value=[track])
    m.session.playlist = MagicMock(return_value=pl)
    rows = m.list_playlist_tracks("pid")
    assert len(rows) == 1
    assert rows[0]["title"] == "Neon"
    assert "42" in rows[0]["uri"]
    assert rows[0]["artist"] == "Cats"


if __name__ == "__main__":
    test_playlist_id_from_url()
    test_list_playlist_tracks_shapes_rows()
    print("tidal playlist tests OK")
