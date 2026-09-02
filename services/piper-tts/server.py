#!/usr/bin/env python3
"""
Moneypenny Piper TTS — OpenAI-compatible /v1/audio/speech.

Matches bot/src/voice/tts.ts (KokoroTtsClient):
  POST /v1/audio/speech  { input, voice?, response_format? } -> audio/wav bytes
  GET  /health           { ok, engine, voice }

Engines (first available wins):
  1. piper CLI  (PIPER_BIN + PIPER_MODEL)
  2. espeak-ng  (fallback for empty hosts / CI)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8880"))
PIPER_BIN = os.environ.get("PIPER_BIN", "piper")
PIPER_MODEL = os.environ.get("PIPER_MODEL", "")  # default path to .onnx
PIPER_VOICE = os.environ.get("PIPER_VOICE", "en_GB-cori-high")
PIPER_MODELS_DIR = os.environ.get("PIPER_MODELS_DIR", "/models")
DEFAULT_FORMAT = os.environ.get("TTS_FORMAT", "wav")
ESPEAK = os.environ.get("ESPEAK_BIN", "espeak-ng")


def _engine() -> str:
    if _resolve_model(None) and shutil.which(PIPER_BIN):
        return "piper"
    if shutil.which(ESPEAK):
        return "espeak"
    return "none"


def _resolve_model(voice: str | None) -> str | None:
    """Pick onnx for the requested voice id, else PIPER_MODEL, else first .onnx in models dir."""
    v = (voice or PIPER_VOICE or "").strip()
    # `voice` is request-supplied. Reject anything that could climb out of the
    # models dir before it is ever joined to a path — "../../x" would otherwise
    # resolve outside PIPER_MODELS_DIR and load an arbitrary .onnx file.
    if v and (Path(v).is_absolute() or set(Path(v).parts) & {"..", "/"} or "/" in v or "\\" in v):
        v = ""
    candidates: list[Path] = []
    if v:
        candidates.append(Path(PIPER_MODELS_DIR) / f"{v}.onnx")
    if PIPER_MODEL:
        candidates.append(Path(PIPER_MODEL))
    models_dir = Path(PIPER_MODELS_DIR)
    if models_dir.is_dir():
        # Prefer product default if present; high → medium fail-open.
        candidates.append(models_dir / f"{PIPER_VOICE}.onnx")
        if PIPER_VOICE.endswith("-high"):
            candidates.append(models_dir / f"{PIPER_VOICE[: -len('high')]}medium.onnx")
        candidates.append(models_dir / "en_GB-cori-medium.onnx")
        candidates.extend(sorted(models_dir.glob("*.onnx")))
    for p in candidates:
        if p.is_file():
            return str(p)
    return None


def synthesize(text: str, voice: str | None = None) -> tuple[bytes, str]:
    text = (text or "").strip()
    if not text:
        raise ValueError("empty input")
    eng = _engine()
    if eng == "piper":
        return _synth_piper(text, voice), "wav"
    if eng == "espeak":
        return _synth_espeak(text, voice or PIPER_VOICE), "wav"
    raise RuntimeError(
        "No TTS engine: install piper with PIPER_MODEL=.onnx or espeak-ng"
    )


def _synth_piper(text: str, voice: str | None = None) -> bytes:
    model = _resolve_model(voice)
    if not model:
        raise RuntimeError("no piper model file found under PIPER_MODELS_DIR / PIPER_MODEL")
    with tempfile.TemporaryDirectory(prefix="piper-") as td:
        out = Path(td) / "out.wav"
        cmd = [
            PIPER_BIN,
            "--model",
            model,
            "--output_file",
            str(out),
        ]
        proc = subprocess.run(
            cmd,
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=120,
            check=False,
        )
        if proc.returncode != 0 or not out.is_file():
            err = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace")[:500]
            raise RuntimeError(f"piper failed ({model}): {err}")
        return out.read_bytes()


def _synth_espeak(text: str, voice: str) -> bytes:
    # Prefer GB for Moneypenny defaults; map US labels explicitly.
    v = "en-gb"
    vl = (voice or "").lower()
    if "en_us" in vl or "us-" in vl or "lessac" in vl or "amy" in vl:
        v = "en-us"
    elif "en_gb" in vl or "british" in vl or vl.startswith("bf_") or "southern" in vl or "alba" in vl:
        v = "en-gb"
    with tempfile.TemporaryDirectory(prefix="espeak-") as td:
        out = Path(td) / "out.wav"
        proc = subprocess.run(
            [ESPEAK, "-v", v, "-w", str(out), text],
            capture_output=True,
            timeout=60,
            check=False,
        )
        if proc.returncode != 0 or not out.is_file():
            err = (proc.stderr or b"").decode("utf-8", "replace")[:300]
            raise RuntimeError(f"espeak failed: {err}")
        return out.read_bytes()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, code: int, data: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.split("?")[0] in ("/health", "/v1/health"):
            resolved = _resolve_model(PIPER_VOICE)
            self._json(
                200,
                {
                    "ok": _engine() != "none",
                    "engine": _engine(),
                    "voice": PIPER_VOICE,
                    "model": resolved or PIPER_MODEL or None,
                },
            )
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        if path not in ("/v1/audio/speech", "/audio/speech"):
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > 256 * 1024:
            self._json(413, {"error": "payload too large"})
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return
        text = body.get("input") or body.get("text") or ""
        voice = body.get("voice") or PIPER_VOICE
        fmt = (body.get("response_format") or DEFAULT_FORMAT).lower()
        try:
            audio, out_fmt = synthesize(str(text), str(voice) if voice else None)
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": str(e)})
            return
        ctype = "audio/wav" if out_fmt == "wav" else f"audio/{out_fmt}"
        if fmt not in ("wav", "wave", "") and fmt != out_fmt:
            # Client asked for mp3 etc. — still return wav (ffmpeg in bot handles decode).
            pass
        self._bytes(200, audio, ctype)

    def log_message(self, *_a) -> None:
        pass


if __name__ == "__main__":
    eng = _engine()
    print(f"[piper-tts] :{PORT} engine={eng} voice={PIPER_VOICE}", flush=True)
    if eng == "none":
        print("[piper-tts] WARN: no piper model and no espeak-ng — /speech will 500", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
