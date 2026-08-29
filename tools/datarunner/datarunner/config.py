from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

Destination = Literal["uex", "moneypenny", "both"]
OcrDevice = Literal["auto", "cpu", "cuda", "rocm", "openvino", "intel"]


def _strip(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


@dataclass(frozen=True)
class RunnerConfig:
    destination: Destination
    screenshot_dir: str | None
    moneypenny_url: str
    moneypenny_token: str
    uex_api_base: str
    uex_api_token: str
    uex_secret_key: str
    uex_is_production: bool
    game_version: str
    environment: Literal["LIVE", "PTU"]
    ocr_device: OcrDevice
    terminal_id: int | None
    terminal_name: str
    snapshot_type: str
    yes: bool

    @staticmethod
    def from_env(**overrides: object) -> RunnerConfig:
        dest = str(overrides.get("destination") or _strip("DATARUNNER_DESTINATION", "moneypenny"))
        dest = dest.lower()
        if dest not in ("uex", "moneypenny", "both"):
            raise ValueError("DATARUNNER_DESTINATION must be uex | moneypenny | both")
        env = str(overrides.get("environment") or _strip("DATARUNNER_ENVIRONMENT", "LIVE")).upper()
        if env not in ("LIVE", "PTU"):
            env = "LIVE"
        device = str(overrides.get("ocr_device") or _strip("OCR_DEVICE", "auto")).lower()
        if device == "intel":
            device = "openvino"
        if device not in ("auto", "cpu", "cuda", "rocm", "openvino"):
            device = "auto"
        term_raw = overrides.get("terminal_id")
        if term_raw is None:
            term_raw = _strip("DATARUNNER_TERMINAL_ID") or None
        terminal_id = int(term_raw) if term_raw not in (None, "") else None
        yes = bool(overrides.get("yes", False))
        return RunnerConfig(
            destination=dest,  # type: ignore[arg-type]
            screenshot_dir=(
                str(overrides["screenshot_dir"])
                if overrides.get("screenshot_dir")
                else (_strip("DATARUNNER_SCREENSHOT_DIR") or None)
            ),
            moneypenny_url=_strip(
                "MONEYPENNY_INGEST_URL",
                "http://127.0.0.1:3000",
            ).rstrip("/"),
            moneypenny_token=_strip("MONEYPENNY_INGEST_TOKEN") or _strip("ECONOMY_INGEST_TOKEN"),
            uex_api_base=_strip("UEX_API_BASE", "https://api.uexcorp.uk").rstrip("/"),
            uex_api_token=_strip("UEX_API_TOKEN") or _strip("UEX_API_KEY"),
            uex_secret_key=_strip("UEX_SECRET_KEY"),
            uex_is_production=_strip("UEX_IS_PRODUCTION", "0") in ("1", "true", "yes"),
            game_version=_strip("DATARUNNER_GAME_VERSION", "4.10.0"),
            environment=env,  # type: ignore[arg-type]
            ocr_device=device,  # type: ignore[arg-type]
            terminal_id=terminal_id,
            terminal_name=str(overrides.get("terminal_name") or _strip("DATARUNNER_TERMINAL_NAME")),
            snapshot_type=str(overrides.get("snapshot_type") or _strip("DATARUNNER_TYPE", "commodity")),
            yes=yes,
        )
