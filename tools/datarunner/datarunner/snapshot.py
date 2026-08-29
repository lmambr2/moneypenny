from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def build_snapshot(
    *,
    prices: list[dict[str, Any]],
    id_terminal: int,
    terminal_name: str = "",
    snapshot_type: str = "commodity",
    game_version: str = "4.10.0",
    environment: str = "LIVE",
    screenshot: Path | None = None,
    captured_at: int | None = None,
    source: str = "datarunner",
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "source": source,
        "game_version": game_version,
        "environment": environment,
        "id_terminal": int(id_terminal),
        "terminal_name": terminal_name or None,
        "type": snapshot_type,
        "prices": prices,
        "captured_at": captured_at if captured_at is not None else int(time.time() * 1000),
    }
    if screenshot is not None and screenshot.is_file():
        body["screenshot_sha256"] = sha256_file(screenshot)
    return body


def dumps(snapshot: dict[str, Any]) -> str:
    return json.dumps(snapshot, indent=2)
