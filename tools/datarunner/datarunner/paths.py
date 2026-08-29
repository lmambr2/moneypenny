"""Resolve Wine/Proton/LUG screenshot directories. Never hardcode C:\\."""

from __future__ import annotations

import os
from pathlib import Path

LUG_CONF_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "starcitizen-lug"
DEFAULT_PREFIX = Path.home() / "Games" / "star-citizen"
GAME_REL = Path("drive_c/Program Files/Roberts Space Industries/StarCitizen")


def _read_conf(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def wine_prefix() -> Path | None:
    conf = _read_conf(LUG_CONF_DIR / "winedir.conf")
    if conf:
        p = Path(conf).expanduser()
        if p.is_dir():
            return p
    if DEFAULT_PREFIX.is_dir():
        return DEFAULT_PREFIX
    umu = Path.home() / "Games" / "umu" / "umu-starcitizen"
    return umu if umu.is_dir() else None


def screenshot_candidates(prefix: Path | None = None) -> list[Path]:
    root = prefix or wine_prefix()
    if root is None:
        return []
    game = root / GAME_REL
    out: list[Path] = []
    if not game.is_dir():
        return out
    for env in ("LIVE", "PTU", "EPTU", "HOTFIX", "TECH-PREVIEW"):
        env_dir = game / env
        if not env_dir.is_dir():
            continue
        for name in ("ScreenShots", "Screenshots", "screenshots"):
            p = env_dir / name
            if p.is_dir():
                out.append(p)
    return out


def resolve_watch_dir(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        return p
    env = (os.environ.get("DATARUNNER_SCREENSHOT_DIR") or "").strip()
    if env:
        p = Path(env).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        return p
    found = screenshot_candidates()
    if found:
        return found[0]
    raise FileNotFoundError(
        "No screenshot directory. Pass --dir, set DATARUNNER_SCREENSHOT_DIR, "
        "or install Star Citizen via LUG Helper (winedir.conf)."
    )
