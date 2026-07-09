#!/usr/bin/env python3
"""
Moneypenny STT — whisper.cpp track (Server edition / AMD Vulkan).

Same HTTP contract as services/stt-whisper and stt-rknn:
  GET  /health
  POST /asr
  POST /asr/stream
  DELETE /asr/stream

Env:
  STT_MODEL       tiny|base|small|medium|large-v3|large-v3-turbo (ggml name)
  STT_MODEL_PATH  explicit path to ggml-*.bin (overrides STT_MODEL download name)
  STT_DEVICE      auto|cpu|vulkan|cuda  (maps to whisper-cli flags)
  WHISPER_BIN     path to whisper-cli (default: whisper-cli)
  STT_MODELS_DIR  directory for ggml weights (default /models)
  STT_EAGER_LOAD  1 = verify binary + model path on start
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PORT = int(os.environ.get("PORT", "9000"))
STT_MODEL = os.environ.get("STT_MODEL", "small").strip()
STT_MODEL_PATH = os.environ.get("STT_MODEL_PATH", "").strip()
STT_DEVICE = os.environ.get("STT_DEVICE", "auto").strip().lower()
WHISPER_BIN = os.environ.get("WHISPER_BIN", "whisper-cli").strip()
MODELS_DIR = Path(os.environ.get("STT_MODELS_DIR", "/models"))
MAX_PCM_BYTES = int(os.environ.get("MAX_PCM_BYTES", str(25 * 1024 * 1024)))
MIN_SPEECH_PEAK = float(os.environ.get("MIN_SPEECH_PEAK", "0.01"))
SILENCE_TAIL_S = float(os.environ.get("SILENCE_TAIL_S", "0.8"))
MAX_UTTERANCE_S = float(os.environ.get("MAX_UTTERANCE_S", "12"))
TARGET_SR = 16000
ENGINE = "whisper-cpp"

_READY = False
_STREAMS: dict[str, dict[str, Any]] = {}
_STREAM_LOCK = threading.Lock()
_TX_LOCK = threading.Lock()


def _resolve_device() -> str:
    if STT_DEVICE != "auto":
        return STT_DEVICE
    # Prefer Vulkan when ICD present (AMD Server); else CPU.
    if Path("/usr/share/vulkan/icd.d").exists() or Path("/etc/vulkan/icd.d").exists():
        # Don't assume AMD only — if any ICD exists, try vulkan.
        return "vulkan"
    return "cpu"


def _model_filename(name: str) -> str:
    # Official ggml naming: ggml-tiny.bin, ggml-large-v3.bin, …
    n = name.lower().replace("openai/whisper-", "").replace("whisper-", "")
    if n.startswith("ggml-") and n.endswith(".bin"):
        return n
    return f"ggml-{n}.bin"


def resolve_model_path() -> Path:
    if STT_MODEL_PATH:
        p = Path(STT_MODEL_PATH)
        if not p.is_file():
            raise FileNotFoundError(f"STT_MODEL_PATH not found: {p}")
        return p
    p = MODELS_DIR / _model_filename(STT_MODEL)
    if p.is_file():
        return p
    # Also accept bare name in models dir
    alt = MODELS_DIR / STT_MODEL
    if alt.is_file():
        return alt
    raise FileNotFoundError(
        f"Model not found: {p}. Download ggml weights into {MODELS_DIR} "
        f"(e.g. ggml-{STT_MODEL}.bin) or set STT_MODEL_PATH."
    )


def ensure_ready() -> None:
    global _READY
    if _READY:
        return
    # Binary present?
    try:
        subprocess.run(
            [WHISPER_BIN, "-h"],
            capture_output=True,
            timeout=30,
            check=False,
        )
    except FileNotFoundError as e:
        raise RuntimeError(f"whisper-cli not found ({WHISPER_BIN})") from e
    resolve_model_path()
    _READY = True
    print(
        f"[stt-whisper-cpp] ready bin={WHISPER_BIN} model={resolve_model_path()} "
        f"device={_resolve_device()}",
        flush=True,
    )


def pcm_s16le_to_float(pcm: bytes, sample_rate: int, channels: int):
    import numpy as np

    if len(pcm) < 2:
        return np.zeros(0, dtype=np.float32), sample_rate
    n = len(pcm) // 2
    samples = np.frombuffer(pcm, dtype=np.int16, count=n).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if sample_rate != TARGET_SR and len(samples) > 0:
        duration = len(samples) / float(sample_rate)
        new_len = max(1, int(duration * TARGET_SR))
        x_old = np.linspace(0, 1, num=len(samples), endpoint=False)
        x_new = np.linspace(0, 1, num=new_len, endpoint=False)
        samples = np.interp(x_new, x_old, samples).astype(np.float32)
        sample_rate = TARGET_SR
    return samples, sample_rate


def peak_float(audio) -> float:
    import numpy as np

    if audio is None or len(audio) == 0:
        return 0.0
    return float(np.max(np.abs(audio)))


def _write_wav(path: Path, audio, sample_rate: int) -> None:
    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())


def transcribe_audio(audio, sample_rate: int = TARGET_SR) -> str:
    import numpy as np

    if audio is None or len(audio) < int(0.1 * sample_rate):
        return ""
    ensure_ready()
    model = resolve_model_path()
    device = _resolve_device()
    with tempfile.TemporaryDirectory(prefix="mp-stt-") as td:
        wav = Path(td) / "utt.wav"
        _write_wav(wav, audio, sample_rate)
        cmd = [
            WHISPER_BIN,
            "-m",
            str(model),
            "-f",
            str(wav),
            "-l",
            "en",
            "-nt",  # no timestamps in stdout
            "-np",  # no prints progress noise where supported
        ]
        # Device flags (whisper.cpp versions differ slightly; ignore unknown via fallback).
        env = os.environ.copy()
        if device in ("vulkan", "cuda"):
            # GPU path when binary was built with GGML_VULKAN / CUDA.
            env.setdefault("GGML_VK_VISIBLE_DEVICES", "0")
        else:
            cmd += ["--no-gpu"]
        with _TX_LOCK:
            try:
                proc = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=120,
                    env=env,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                return ""
            if proc.returncode != 0:
                # Minimal retry (flag differences across whisper.cpp versions).
                retry = [WHISPER_BIN, "-m", str(model), "-f", str(wav), "-l", "en", "-nt"]
                if device == "cpu":
                    retry += ["--no-gpu"]
                proc = subprocess.run(
                    retry,
                    capture_output=True,
                    text=True,
                    timeout=120,
                    env=env,
                    check=False,
                )
        out = (proc.stdout or "").strip()
        if not out and proc.stderr:
            # Some builds print transcript to stderr with -nt
            err_lines = [
                ln.strip()
                for ln in proc.stderr.splitlines()
                if ln.strip() and not ln.strip().startswith("[")
            ]
            out = " ".join(err_lines).strip()
        # whisper-cli often prefixes with whitespace / quotes
        return " ".join(out.split()).strip().strip('"')


def _stream_state(client_id: str) -> dict[str, Any]:
    with _STREAM_LOCK:
        st = _STREAMS.get(client_id)
        if st is None:
            st = {
                "chunks": [],
                "last_voice": 0.0,
                "started": 0.0,
                "speaking": False,
            }
            _STREAMS[client_id] = st
        return st


def feed_stream(
    client_id: str, pcm: bytes, sample_rate: int, channels: int
) -> dict[str, Any]:
    import numpy as np

    audio, sr = pcm_s16le_to_float(pcm, sample_rate, channels)
    st = _stream_state(client_id)
    now = time.time()
    if st["started"] == 0.0 and len(audio):
        st["started"] = now
    pk = peak_float(audio)
    if pk >= MIN_SPEECH_PEAK:
        st["last_voice"] = now
        st["speaking"] = True
        st["chunks"].append(audio)
    elif st["speaking"] and len(audio):
        st["chunks"].append(audio)

    duration = sum(len(c) for c in st["chunks"]) / float(sr or TARGET_SR)
    silence = (now - st["last_voice"]) if st["last_voice"] else 0.0
    should_final = st["speaking"] and (
        (st["last_voice"] and silence >= SILENCE_TAIL_S and duration >= 0.25)
        or duration >= MAX_UTTERANCE_S
    )
    # Stay passive until final — no KWS command mode (see stt-rknn comment).
    if not should_final:
        return {
            "partial": "",
            "final": None,
            "speaking": st["speaking"],
            "listening": "passive",
            "keyword": None,
            "commandFinal": False,
        }
    full = np.concatenate(st["chunks"]) if st["chunks"] else np.zeros(0, dtype=np.float32)
    text = ""
    try:
        text = transcribe_audio(full, sr)
    except Exception:
        traceback.print_exc()
    with _STREAM_LOCK:
        _STREAMS.pop(client_id, None)
    return {
        "partial": "",
        "final": text or None,
        "speaking": False,
        "listening": "passive",
        "keyword": None,
        "commandFinal": bool(text),
        "commandSource": "asr",
    }


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.split("?")[0] == "/health":
            model_ok = False
            try:
                resolve_model_path()
                model_ok = True
            except Exception:
                pass
            self._json(
                200,
                {
                    "ok": True,
                    "engine": ENGINE,
                    "family": "whisper",
                    "track": "server",
                    "model": STT_MODEL,
                    "device": _resolve_device(),
                    "streaming": True,
                    "modelLoaded": _READY and model_ok,
                    "kws": False,
                    "textWakeRequired": True,
                },
            )
            return
        self._json(404, {"error": "not found"})

    def do_DELETE(self) -> None:
        if self.path.split("?")[0] == "/asr/stream":
            cid = self.headers.get("X-Client-Id", "").strip()
            if cid:
                with _STREAM_LOCK:
                    _STREAMS.pop(cid, None)
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > MAX_PCM_BYTES:
            self._json(413, {"error": f"payload too large (max {MAX_PCM_BYTES} bytes)"})
            return
        pcm = self.rfile.read(length) if length else b""
        sr = int(self.headers.get("X-Sample-Rate", "16000") or 16000)
        ch = int(self.headers.get("X-Channels", "1") or 1)
        if path == "/asr/stream":
            cid = self.headers.get("X-Client-Id", "").strip() or "0"
            try:
                out = feed_stream(cid, pcm, sr, ch)
            except Exception as e:
                traceback.print_exc()
                self._json(500, {"error": str(e)})
                return
            self._json(200, out)
            return
        if path != "/asr":
            self._json(404, {"error": "not found"})
            return
        try:
            audio, asr = pcm_s16le_to_float(pcm, sr, ch)
            text = transcribe_audio(audio, asr)
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": str(e)})
            return
        self._json(200, {"text": text})

    def log_message(self, *_a) -> None:
        pass


if __name__ == "__main__":
    if os.environ.get("STT_EAGER_LOAD", "1") not in ("0", "false", "no"):
        try:
            ensure_ready()
        except Exception:
            traceback.print_exc()
            print(
                "[stt-whisper-cpp] eager load failed — place ggml model in "
                f"{MODELS_DIR} or set STT_MODEL_PATH",
                flush=True,
            )
    print(f"[stt-whisper-cpp] :{PORT} model={STT_MODEL} device={_resolve_device()}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
