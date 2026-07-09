#!/usr/bin/env python3
"""
Moneypenny STT — RKNN track (SBC edition / Rockchip NPU).

Same HTTP contract as stt-whisper-cpp / legacy stt-whisper.

Env:
  STT_BACKEND     rknn (default) | faster-whisper (force CPU fallback)
  STT_FALLBACK    faster-whisper | none   (used if RKNN fails to load)
  STT_MODEL       tiny|base|…  (ladder name; RKNN uses converted pair)
  STT_DEVICE      npu|cpu
  RKNN_ENCODER    path to encoder .rknn
  RKNN_DECODER    path to decoder .rknn
  RKNN_MODELS_DIR directory with whisper-*-encoder/decoder.rknn

Until .rknn weights are mounted, falls back to faster-whisper STT_MODEL on CPU
so voice-edge still works day-one.
"""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PORT = int(os.environ.get("PORT", "9000"))
STT_MODEL = os.environ.get("STT_MODEL", "tiny").strip()
STT_DEVICE = os.environ.get("STT_DEVICE", "npu").strip().lower()
STT_BACKEND = os.environ.get("STT_BACKEND", "rknn").strip().lower()
STT_FALLBACK = os.environ.get("STT_FALLBACK", "faster-whisper").strip().lower()
STT_COMPUTE = os.environ.get("STT_COMPUTE_TYPE", "int8")
RKNN_ENCODER = os.environ.get("RKNN_ENCODER", "").strip()
RKNN_DECODER = os.environ.get("RKNN_DECODER", "").strip()
RKNN_MODELS_DIR = Path(os.environ.get("RKNN_MODELS_DIR", "/models/rknn"))
MAX_PCM_BYTES = int(os.environ.get("MAX_PCM_BYTES", str(25 * 1024 * 1024)))
MIN_SPEECH_PEAK = float(os.environ.get("MIN_SPEECH_PEAK", "0.01"))
SILENCE_TAIL_S = float(os.environ.get("SILENCE_TAIL_S", "0.8"))
MAX_UTTERANCE_S = float(os.environ.get("MAX_UTTERANCE_S", "12"))
TARGET_SR = 16000

_ENGINE = "rknn"
_MODEL = None  # faster-whisper model or RknnWhisper handle
_MODEL_LOCK = threading.Lock()
_STREAMS: dict[str, dict[str, Any]] = {}
_STREAM_LOCK = threading.Lock()


class RknnWhisperNotReady(RuntimeError):
    pass


def _find_rknn_pair() -> tuple[Path, Path]:
    if RKNN_ENCODER and RKNN_DECODER:
        enc, dec = Path(RKNN_ENCODER), Path(RKNN_DECODER)
        if enc.is_file() and dec.is_file():
            return enc, dec
        raise FileNotFoundError(f"RKNN_ENCODER/DECODER not found: {enc} {dec}")
    # Convention from Rockchip model zoo / community exports
    candidates = [
        (
            RKNN_MODELS_DIR / f"whisper-{STT_MODEL}-encoder.rknn",
            RKNN_MODELS_DIR / f"whisper-{STT_MODEL}-decoder.rknn",
        ),
        (
            RKNN_MODELS_DIR / f"{STT_MODEL}-encoder.rknn",
            RKNN_MODELS_DIR / f"{STT_MODEL}-decoder.rknn",
        ),
        (
            RKNN_MODELS_DIR / "whisper_encoder.rknn",
            RKNN_MODELS_DIR / "whisper_decoder.rknn",
        ),
    ]
    for enc, dec in candidates:
        if enc.is_file() and dec.is_file():
            return enc, dec
    raise FileNotFoundError(
        f"No RKNN Whisper pair under {RKNN_MODELS_DIR} for model={STT_MODEL}. "
        "Export via Rockchip rknn_model_zoo whisper example, or set "
        "RKNN_ENCODER / RKNN_DECODER."
    )


class RknnWhisper:
    """Minimal RKNN Whisper runner.

    Full encoder/decoder mel pipeline is model-zoo specific. This class loads
    RKNNLite modules when present; if the runtime or graphs are incomplete it
    raises so the service can fall back to faster-whisper.
    """

    def __init__(self, encoder: Path, decoder: Path):
        try:
            from rknnlite.api import RKNNLite  # type: ignore
        except ImportError as e:
            raise RknnWhisperNotReady(
                "rknnlite not installed — build services/stt-rknn on aarch64 "
                "with Rockchip rknn-toolkit-lite2"
            ) from e
        self._RKNNLite = RKNNLite
        self.enc_path = encoder
        self.dec_path = decoder
        self.encoder = RKNNLite()
        self.decoder = RKNNLite()
        ret = self.encoder.load_rknn(str(encoder))
        if ret != 0:
            raise RknnWhisperNotReady(f"encoder load_rknn failed: {ret}")
        ret = self.decoder.load_rknn(str(decoder))
        if ret != 0:
            raise RknnWhisperNotReady(f"decoder load_rknn failed: {ret}")
        # core_mask: NPU cores — try all three on RK3588
        core = getattr(RKNNLite, "NPU_CORE_0_1_2", 0)
        ret = self.encoder.init_runtime(core_mask=core)
        if ret != 0:
            ret = self.encoder.init_runtime()
        if ret != 0:
            raise RknnWhisperNotReady(f"encoder init_runtime failed: {ret}")
        ret = self.decoder.init_runtime(core_mask=core)
        if ret != 0:
            ret = self.decoder.init_runtime()
        if ret != 0:
            raise RknnWhisperNotReady(f"decoder init_runtime failed: {ret}")
        print(f"[stt-rknn] loaded encoder={encoder} decoder={decoder}", flush=True)

    def transcribe(self, audio, sample_rate: int) -> str:
        """
        Placeholder for full mel→encoder→decoder loop.

        Rockchip zoo demos own the exact I/O tensors. Until a zoo-compatible
        pipeline is wired here, we refuse so fallback can run.
        """
        raise RknnWhisperNotReady(
            "RKNN runtime loaded but mel/encoder/decoder pipeline not fully "
            "wired for this export yet — using STT_FALLBACK. See "
            "services/stt-rknn/README.md (Rockchip whisper model zoo)."
        )


def get_model():
    global _MODEL, _ENGINE
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL

        want_rknn = STT_BACKEND in ("rknn", "rknpu", "npu") and STT_DEVICE != "cpu"
        if want_rknn:
            try:
                enc, dec = _find_rknn_pair()
                _MODEL = RknnWhisper(enc, dec)
                _ENGINE = "rknn"
                print("[stt-rknn] backend=rknn (NPU)", flush=True)
                return _MODEL
            except Exception as e:
                print(f"[stt-rknn] RKNN unavailable: {e}", flush=True)
                if STT_FALLBACK in ("none", "off", "0"):
                    raise

        if STT_FALLBACK in ("faster-whisper", "faster_whisper", "cpu", "") or not want_rknn:
            from faster_whisper import WhisperModel

            print(
                f"[stt-rknn] backend=faster-whisper fallback model={STT_MODEL} device=cpu",
                flush=True,
            )
            _MODEL = WhisperModel(STT_MODEL, device="cpu", compute_type=STT_COMPUTE or "int8")
            _ENGINE = "faster-whisper-fallback"
            print("[stt-rknn] faster-whisper ready (CPU fallback)", flush=True)
            return _MODEL

        raise RuntimeError("No STT backend available")


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


def transcribe_audio(audio, sample_rate: int = TARGET_SR) -> str:
    import numpy as np

    if audio is None or len(audio) < int(0.1 * sample_rate):
        return ""
    model = get_model()
    if isinstance(model, RknnWhisper):
        try:
            return model.transcribe(audio, sample_rate)
        except RknnWhisperNotReady as e:
            print(f"[stt-rknn] {e} — loading CPU fallback for this process", flush=True)
            global _MODEL, _ENGINE
            with _MODEL_LOCK:
                _MODEL = None
                _ENGINE = "faster-whisper-fallback"
            from faster_whisper import WhisperModel

            _MODEL = WhisperModel(STT_MODEL, device="cpu", compute_type=STT_COMPUTE or "int8")
            model = _MODEL
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
            rknn_pair = False
            try:
                _find_rknn_pair()
                rknn_pair = True
            except Exception:
                pass
            self._json(
                200,
                {
                    "ok": True,
                    "engine": _ENGINE if ready else f"{STT_BACKEND}(loading)",
                    "family": "whisper",
                    "track": "sbc",
                    "model": STT_MODEL,
                    "device": STT_DEVICE,
                    "streaming": True,
                    "modelLoaded": ready,
                    "rknnWeightsPresent": rknn_pair,
                    "fallback": STT_FALLBACK,
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
            get_model()
        except Exception:
            traceback.print_exc()
            print("[stt-rknn] eager load failed — will retry on first request", flush=True)
    print(f"[stt-rknn] :{PORT} model={STT_MODEL} backend={STT_BACKEND}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
