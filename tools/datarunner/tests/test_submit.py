from __future__ import annotations

from typing import Any

import pytest

from datarunner.config import RunnerConfig
from datarunner.submit import SubmitError, submit_snapshot
import datarunner.submit as submit_mod


def _cfg(**kwargs: Any) -> RunnerConfig:
    env = {
        "DATARUNNER_DESTINATION": "moneypenny",
        "MONEYPENNY_INGEST_URL": "http://127.0.0.1:3000",
        "MONEYPENNY_INGEST_TOKEN": "tok",
        "UEX_API_BASE": "https://api.uexcorp.uk",
        "UEX_API_TOKEN": "bearer",
        "UEX_SECRET_KEY": "secret",
    }
    env.update({k: str(v) for k, v in kwargs.items()})
    import os

    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        return RunnerConfig.from_env()
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


SNAP = {
    "id_terminal": 89,
    "type": "commodity",
    "game_version": "4.10.0",
    "prices": [{"name": "Agricium", "price_sell": 12000}],
}


def test_moneypenny_dest_never_calls_uex(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_http(url: str, payload: dict[str, Any], headers: dict[str, str], timeout: int = 60):
        calls.append(url)
        return {"ok": True, "status": 201, "body": {}}

    monkeypatch.setattr(submit_mod, "_http_json", fake_http)
    cfg = _cfg(DATARUNNER_DESTINATION="moneypenny")
    out = submit_snapshot(cfg, SNAP)
    assert out["destination"] == "moneypenny"
    assert out["uex"] is None
    assert len(calls) == 1
    assert "uexcorp" not in calls[0]
    assert calls[0].endswith("/api/economy/ingest/terminal-snapshot")


def test_both_keeps_moneypenny_when_uex_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_http(url: str, payload: dict[str, Any], headers: dict[str, str], timeout: int = 60):
        if "uexcorp" in url:
            raise SubmitError("uex", "nope", 401)
        return {"ok": True, "status": 201, "body": {"snapshot": {"id": 1}}}

    monkeypatch.setattr(submit_mod, "_http_json", fake_http)
    cfg = _cfg(DATARUNNER_DESTINATION="both")
    out = submit_snapshot(cfg, SNAP)
    assert out["moneypenny"]["ok"] is True
    assert out["uex"]["ok"] is False


def test_uex_only_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_http(url: str, payload: dict[str, Any], headers: dict[str, str], timeout: int = 60):
        raise SubmitError("uex", "nope", 401)

    monkeypatch.setattr(submit_mod, "_http_json", fake_http)
    cfg = _cfg(DATARUNNER_DESTINATION="uex")
    with pytest.raises(SubmitError):
        submit_snapshot(cfg, SNAP)
