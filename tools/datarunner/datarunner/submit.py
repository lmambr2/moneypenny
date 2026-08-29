"""Destination routing: uex | moneypenny | both. Moneypenny never depends on UEX."""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from datarunner.config import RunnerConfig

USER_AGENT = "Moneypenny-DataRunner/0.1 (+https://github.com/lmambr2/moneypenny)"


class SubmitError(RuntimeError):
    def __init__(self, dest: str, message: str, status: int | None = None):
        super().__init__(message)
        self.dest = dest
        self.status = status


def _http_json(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout: int = 60,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    hdrs = {"Content-Type": "application/json", "User-Agent": USER_AGENT, **headers}
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            body = json.loads(raw) if raw else {}
            return {"ok": True, "status": getattr(resp, "status", 200), "body": body}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")[:500]
        raise SubmitError("http", f"{err.code} {detail}", err.code) from err


def submit_moneypenny(cfg: RunnerConfig, snapshot: dict[str, Any]) -> dict[str, Any]:
    if not cfg.moneypenny_token:
        raise SubmitError("moneypenny", "MONEYPENNY_INGEST_TOKEN (or ECONOMY_INGEST_TOKEN) is empty")
    url = f"{cfg.moneypenny_url}/api/economy/ingest/terminal-snapshot"
    return _http_json(
        url,
        snapshot,
        {"Authorization": f"Bearer {cfg.moneypenny_token}"},
    )


def submit_uex(
    cfg: RunnerConfig,
    snapshot: dict[str, Any],
    screenshot: Path | None = None,
) -> dict[str, Any]:
    if snapshot.get("type") == "fuel":
        raise SubmitError(
            "uex",
            "UEX data_submit has no fuel type — skip UEX (Moneypenny-local only)",
        )
    if not cfg.uex_secret_key:
        raise SubmitError("uex", "UEX_SECRET_KEY is empty")
    if not cfg.uex_api_token:
        raise SubmitError("uex", "UEX_API_TOKEN / UEX_API_KEY is empty")
    prices = []
    for row in snapshot.get("prices") or []:
        item = {k: v for k, v in row.items() if v is not None}
        prices.append(item)
    payload: dict[str, Any] = {
        "id_terminal": snapshot["id_terminal"],
        "type": snapshot.get("type") or "commodity",
        "is_production": 1 if cfg.uex_is_production else 0,
        "prices": prices,
        "game_version": snapshot.get("game_version") or cfg.game_version,
    }
    if snapshot.get("terminal_name"):
        payload["details"] = str(snapshot["terminal_name"])
    if screenshot is not None and screenshot.is_file():
        raw = screenshot.read_bytes()
        if len(raw) > 10 * 1024 * 1024:
            raise SubmitError("uex", "screenshot exceeds UEX 10 MB limit")
        payload["screenshot"] = base64.b64encode(raw).decode("ascii")
    url = f"{cfg.uex_api_base}/2.0/data_submit"
    return _http_json(
        url,
        payload,
        {
            "Authorization": f"Bearer {cfg.uex_api_token}",
            "secret-key": cfg.uex_secret_key,
        },
    )


def submit_snapshot(
    cfg: RunnerConfig,
    snapshot: dict[str, Any],
    screenshot: Path | None = None,
) -> dict[str, Any]:
    """
    Route by DESTINATION. For `both`, UEX failure is recorded but does not
    undo a Moneypenny success.
    """
    dest = cfg.destination
    out: dict[str, Any] = {"destination": dest, "moneypenny": None, "uex": None}
    if dest in ("moneypenny", "both"):
        out["moneypenny"] = submit_moneypenny(cfg, snapshot)
    if dest in ("uex", "both"):
        try:
            out["uex"] = submit_uex(cfg, snapshot, screenshot)
        except SubmitError as err:
            out["uex"] = {"ok": False, "error": str(err), "status": err.status}
            if dest == "uex":
                raise
    return out
