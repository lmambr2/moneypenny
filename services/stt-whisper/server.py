#!/usr/bin/env python3
"""
Moneypenny multi-size Whisper STT — same HTTP contract as sherpa-stt / stt-mock.

  GET  /health
  POST /asr          batch
  POST /asr/stream   accumulate PCM → final when silence / max window
  DELETE /asr/stream

Env:
  STT_MODEL     tiny | base | small | medium | large-v3 | large-v3-turbo | distil-large-v3
  STT_DEVICE    auto | cpu | cuda
  STT_COMPUTE_TYPE  default int8 (cpu) / float16 (cuda)
  STT_BACKEND   faster-whisper (default) | rknn (planned — raises until implemented)

Canonical Moneypenny STT path (edge tiny → server large-v3). See README.md.
"""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

PORT = int(os.environ.get("PORT", "9000"))
STT_MODEL = os.environ.get("STT_MODEL", "tiny")
STT_DEVICE = os.environ.get("STT_DEVICE", "auto")
STT_COMPUTE = os.environ.get("STT_COMPUTE_TYPE", "")
STT_BACKEND = os.environ.get("STT_BACKEND", "faster-whisper").strip().lower()
MAX_PCM_BYTES = int(os.environ.get("MAX_PCM_BYTES", str(25 * 1024 * 1024)))
MIN_SPEECH_PEAK = float(os.environ.get("MIN_SPEECH_PEAK", "0.01"))  # float PCM peak
SILENCE_TAIL_S = float(os.environ.get("SILENCE_TAIL_S", "0.8"))
MAX_UTTERANCE_S = float(os.environ.get("MAX_UTTERANCE_S", "12"))
TARGET_SR = 16000

_MODEL = None
_MODEL_LOCK = threading.Lock()
_STREAMS: dict[str, dict[str, Any]] = {}
_STREAM_LOCK = threading.Lock()


def _pick_device() -> str:
    if STT_DEVICE != "auto":
        return STT_DEVICE
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _compute_type(device: str) -> str:
    if STT_COMPUTE:
        return STT_COMPUTE
    return "float16" if device == "cuda" else "int8"


def get_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        if STT_BACKEND in ("rknn", "rknpu", "npu"):
            raise RuntimeError(
                "STT_BACKEND=rknn is not implemented yet — use faster-whisper "
                "(STT_MODEL=tiny on Pi). See services/stt-whisper/README.md"
            )
        if STT_BACKEND not in ("faster-whisper", "faster_whisper", "cpu", "cuda", ""):
            raise RuntimeError(f"Unknown STT_BACKEND={STT_BACKEND!r}")
        from faster_whisper import WhisperModel

        device = _pick_device()
        ctype = _compute_type(device)
        print(
            f"[stt-whisper] backend=faster-whisper model={STT_MODEL} device={device} compute={ctype}",
            flush=True,
        )
        _MODEL = WhisperModel(STT_MODEL, device=device, compute_type=ctype)
        print("[stt-whisper] model ready", flush=True)
        return _MODEL


def pcm_s16le_to_float(pcm: bytes, sample_rate: int, channels: int) -> tuple[Any, int]:
    import numpy as np

    if len(pcm) < 2:
        return np.zeros(0, dtype=np.float32), sample_rate
    n = len(pcm) // 2
    samples = np.frombuffer(pcm, dtype=np.int16, count=n).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if sample_rate != TARGET_SR and len(samples) > 0:
        # Linear resample (good enough for command ASR).
        duration = len(samples) / float(sample_rate)
        new_len = max(1, int(duration * TARGET_SR))
        x_old = np.linspace(0, 1, num=len(samples), endpoint=False)
        x_new = np.linspace(0, 1, num=new_len, endpoint=False)
        samples = np.interp(x_new, x_old, samples).astype(np.float32)
        sample_rate = TARGET_SR
    return samples, sample_rate


def peak_float(audio: Any) -> float:
    import numpy as np

    if audio is None or len(audio) == 0:
        return 0.0
    return float(np.max(np.abs(audio)))


def transcribe_audio(audio: Any, sample_rate: int = TARGET_SR) -> str:
    import numpy as np

    if audio is None or len(audio) < int(0.1 * sample_rate):
        return ""
    model = get_model()
    segments, _info = model.transcribe(
        audio,
        language="en",
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    parts = [s.text.strip() for s in segments if s.text and s.text.strip()]
    return " ".join(parts).strip()


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

    if not should_final:
        return {
            "partial": "",
            "final": None,
            "speaking": st["speaking"],
            "listening": "command",
            "keyword": None,
            "commandFinal": False,
        }

    # Finalize
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
            ready = _MODEL is not None
            self._json(
                200,
                {
                    "ok": True,
                    "engine": STT_BACKEND or "faster-whisper",
                    "family": "whisper",
                    "model": STT_MODEL,
                    "device": _pick_device(),
                    "streaming": True,
                    "modelLoaded": ready,
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
    # Eager load so first request isn't a multi-minute surprise on large models.
    if os.environ.get("STT_EAGER_LOAD", "1") not in ("0", "false", "no"):
        try:
            get_model()
        except Exception:
            traceback.print_exc()
            print("[stt-whisper] eager load failed — will retry on first request", flush=True)
    print(f"[stt-whisper] :{PORT} model={STT_MODEL}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
