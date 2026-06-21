#!/usr/bin/env python3
"""
Moneypenny sherpa-onnx STT sidecar — HTTP wrapper for voice (Phase 2).

Two-phase voice pipeline (production):
  passive  — KWS only; channel banter is not transcribed or routed.
  command  — after KWS fires, Silero VAD + Moonshine decode command audio only.

Contract (matches bot/src/voice/stt.ts / probe.ts):
  GET  /health       -> { ok, engine, modelDir, streaming, sampleRate, kws }
  POST /asr          -> { text }  (offline batch — smoke tests)
  POST /asr/stream   -> { partial, final, speaking, listening, keyword?, commandFinal? }
                     headers: X-Client-Id, X-Sample-Rate, X-Channels
  DELETE /asr/stream -> drop per-client streaming state (optional)
"""
from __future__ import annotations

import json
import os
import struct
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

import numpy as np

PORT = int(os.environ.get("PORT", "9000"))
MODEL_DIR = os.environ.get("MODEL_DIR", "/models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27")
KWS_MODEL_DIR = os.environ.get("KWS_MODEL_DIR", "")
KEYWORDS_FILE = os.environ.get("KEYWORDS_FILE", "/app/keywords/moneypenny.txt")
# Closed-vocab KWS for playback verbs (pause/skip/…) used in command mode — far
# more reliable than Moonshine on short, quiet command words. Empty/missing →
# command-mode falls back to full ASR (prior behavior).
COMMAND_KEYWORDS_FILE = os.environ.get("COMMAND_KEYWORDS_FILE", "/app/keywords/commands.txt")
KWS_THRESHOLD = float(os.environ.get("KWS_THRESHOLD", "0.10"))
COMMAND_KWS_THRESHOLD = float(os.environ.get("COMMAND_KWS_THRESHOLD", "0.04"))
COMMAND_KWS_TAIL_S = float(os.environ.get("COMMAND_KWS_TAIL_S", "1.5"))
KWS_SCORE = float(os.environ.get("KWS_SCORE", "3.0"))
KWS_TRAILING_BLANKS = int(os.environ.get("KWS_TRAILING_BLANKS", "8"))
KWS_TAIL_PAD_S = float(os.environ.get("KWS_TAIL_PAD_S", "0.5"))
PCM_BOOST_TARGET = float(os.environ.get("PCM_BOOST_TARGET", "0.35"))
PCM_BOOST_MIN_PEAK = float(os.environ.get("PCM_BOOST_MIN_PEAK", "0.004"))
VAD_MODEL = os.environ.get("VAD_MODEL", "/models/silero_vad.onnx")
NUM_THREADS = int(os.environ.get("NUM_THREADS", "4"))
MIN_PCM_BYTES = int(os.environ.get("MIN_PCM_BYTES", "320"))
MAX_PCM_BYTES = int(os.environ.get("MAX_PCM_BYTES", str(25 * 1024 * 1024)))
TARGET_SAMPLE_RATE = 16000
PARTIAL_DECODE_INTERVAL_S = float(os.environ.get("PARTIAL_DECODE_INTERVAL_S", "999"))
COMMAND_PARTIAL_DECODE_INTERVAL_S = float(
    os.environ.get("COMMAND_PARTIAL_DECODE_INTERVAL_S", "0.35")
)
SESSION_IDLE_S = float(os.environ.get("SESSION_IDLE_S", "30"))
COMMAND_WINDOW_S = float(os.environ.get("COMMAND_WINDOW_S", "15"))

_RECOGNIZER = None
_KWS = None
_CMD_KWS = None
_VAD_CONFIG = None
_COMMAND_VAD_CONFIG = None
_STREAMING_ENABLED = False
_KWS_ENABLED = False
_CMD_KWS_ENABLED = False
_STREAM_LOCK = threading.Lock()

# Detected command-KWS keyword id (@PAUSE → "PAUSE") → bot command verb.
CMD_KW_MAP = {
    "PAUSE": "pause", "RESUME": "resume", "SKIP": "skip",
    "STOP": "stop", "NEXT": "next", "PLAY": "play",
}
_DECODE_LOCK = threading.Lock()
_KWS_LOCK = threading.Lock()
_STREAMS: dict[str, "_StreamSession"] = {}


def _load_recognizer():
    import sherpa_onnx

    model_dir = MODEL_DIR
    tokens = f"{model_dir}/tokens.txt"

    encoder_v2 = f"{model_dir}/encoder_model.ort"
    decoder_v2 = f"{model_dir}/decoder_model_merged.ort"
    if os.path.isfile(encoder_v2) and os.path.isfile(decoder_v2):
        return sherpa_onnx.OfflineRecognizer.from_moonshine_v2(
            encoder=encoder_v2,
            decoder=decoder_v2,
            tokens=tokens,
            num_threads=NUM_THREADS,
        )

    preprocessor = f"{model_dir}/preprocess.onnx"
    encoder = f"{model_dir}/encode.int8.onnx"
    uncached = f"{model_dir}/uncached_decode.int8.onnx"
    cached = f"{model_dir}/cached_decode.int8.onnx"
    if os.path.isfile(preprocessor):
        return sherpa_onnx.OfflineRecognizer.from_moonshine(
            tokens=tokens,
            preprocessor=preprocessor,
            encoder=encoder,
            uncached_decoder=uncached,
            cached_decoder=cached,
            num_threads=NUM_THREADS,
        )

    sense_voice = f"{model_dir}/model.int8.onnx"
    if os.environ.get("MODEL", "").lower() == "sense-voice" or os.path.isfile(sense_voice):
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=sense_voice,
            tokens=tokens,
            num_threads=NUM_THREADS,
        )

    raise RuntimeError(f"no supported ASR model found in {model_dir}")


def _make_vad_config(
    *,
    min_silence: float,
    min_speech: float,
    max_speech: float,
    threshold: float = 0.5,
):
    import sherpa_onnx

    if not os.path.isfile(VAD_MODEL):
        return None
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = VAD_MODEL
    config.silero_vad.threshold = threshold
    config.silero_vad.min_silence_duration = min_silence
    config.silero_vad.min_speech_duration = min_speech
    config.silero_vad.max_speech_duration = max_speech
    config.sample_rate = TARGET_SAMPLE_RATE
    return config


def _load_vad_config():
    return _make_vad_config(min_silence=0.05, min_speech=0.15, max_speech=8.0)


def _load_command_vad_config():
    # Short follow-ups ("pause") after wake — endpoint quickly once the verb lands.
    return _make_vad_config(min_silence=0.12, min_speech=0.04, max_speech=4.0, threshold=0.25)


def _load_kws(
    keywords_file: str = KEYWORDS_FILE,
    *,
    label: str = "KWS",
    threshold: Optional[float] = None,
):
    import sherpa_onnx

    model_dir = KWS_MODEL_DIR
    if not model_dir:
        return None

    encoder = f"{model_dir}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
    decoder = f"{model_dir}/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
    joiner = f"{model_dir}/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
    tokens = f"{model_dir}/tokens.txt"

    for path in (encoder, decoder, joiner, tokens):
        if not os.path.isfile(path):
            print(f"[sherpa-stt] {label} disabled — missing {path}", flush=True)
            return None

    if not os.path.isfile(keywords_file):
        print(f"[sherpa-stt] {label} disabled — missing keywords {keywords_file}", flush=True)
        return None

    return sherpa_onnx.KeywordSpotter(
        tokens=tokens,
        encoder=encoder,
        decoder=decoder,
        joiner=joiner,
        keywords_file=keywords_file,
        num_threads=NUM_THREADS,
        keywords_threshold=KWS_THRESHOLD if threshold is None else threshold,
        keywords_score=KWS_SCORE,
        num_trailing_blanks=KWS_TRAILING_BLANKS,
        provider="cpu",
    )


def get_recognizer():
    global _RECOGNIZER, _KWS, _CMD_KWS, _VAD_CONFIG, _COMMAND_VAD_CONFIG
    global _STREAMING_ENABLED, _KWS_ENABLED, _CMD_KWS_ENABLED
    if _RECOGNIZER is None:
        _RECOGNIZER = _load_recognizer()
        _VAD_CONFIG = _load_vad_config()
        _COMMAND_VAD_CONFIG = _load_command_vad_config()
        _STREAMING_ENABLED = _VAD_CONFIG is not None
        _KWS = _load_kws(KEYWORDS_FILE, label="wake-KWS")
        _KWS_ENABLED = _KWS is not None
        try:
            _CMD_KWS = _load_kws(
                COMMAND_KEYWORDS_FILE,
                label="command-KWS",
                threshold=COMMAND_KWS_THRESHOLD,
            )
            _CMD_KWS_ENABLED = _CMD_KWS is not None
        except Exception as exc:  # noqa: BLE001
            print(f"[sherpa-stt] command-KWS disabled — {exc}", flush=True)
            _CMD_KWS = None
            _CMD_KWS_ENABLED = False
    return _RECOGNIZER


def get_kws():
    get_recognizer()
    return _KWS


def get_command_kws():
    get_recognizer()
    return _CMD_KWS


def boost_samples(samples: np.ndarray) -> np.ndarray:
    """Normalize quiet TeamSpeak PCM so KWS can trigger (Moonshine is more forgiving)."""
    if samples.size == 0:
        return samples
    peak = float(np.max(np.abs(samples)))
    if peak < PCM_BOOST_MIN_PEAK:
        return samples
    gain = min(PCM_BOOST_TARGET / peak, 40.0)
    if gain <= 1.05:
        return samples
    return np.clip(samples * gain, -1.0, 1.0).astype(np.float32)


def pcm_to_float32(pcm: bytes, sample_rate: int, channels: int) -> tuple[np.ndarray, int]:
    if len(pcm) < 2:
        return np.array([], dtype=np.float32), sample_rate
    count = len(pcm) // 2
    samples = np.array(struct.unpack(f"<{count}h", pcm), dtype=np.float32) / 32768.0
    ch = max(1, channels)
    if ch > 1:
        frames = len(samples) // ch
        if frames == 0:
            return np.array([], dtype=np.float32), sample_rate
        samples = samples[: frames * ch].reshape(frames, ch).mean(axis=1)
    if sample_rate != TARGET_SAMPLE_RATE and len(samples) > 0:
        duration = len(samples) / sample_rate
        dst_len = max(1, int(duration * TARGET_SAMPLE_RATE))
        idx = np.linspace(0, len(samples) - 1, dst_len)
        samples = np.interp(idx, np.arange(len(samples)), samples).astype(np.float32)
        sample_rate = TARGET_SAMPLE_RATE
    return boost_samples(samples.astype(np.float32)), sample_rate


def transcribe_pcm(pcm: bytes, sample_rate: int, channels: int) -> str:
    if len(pcm) < MIN_PCM_BYTES:
        return ""
    samples, rate = pcm_to_float32(pcm, sample_rate, channels)
    if samples.size == 0:
        return ""
    recognizer = get_recognizer()
    stream = recognizer.create_stream()
    stream.accept_waveform(rate, samples)
    recognizer.decode_stream(stream)
    return (stream.result.text or "").strip()


def _as_float32(samples) -> np.ndarray:
    """Silero VAD segments may be plain lists — normalize before decode."""
    if isinstance(samples, np.ndarray):
        return samples.astype(np.float32, copy=False)
    return np.asarray(samples, dtype=np.float32)


def _decode_text(recognizer, samples, sample_rate: int = TARGET_SAMPLE_RATE) -> str:
    arr = _as_float32(samples)
    if arr.size == 0:
        return ""
    with _DECODE_LOCK:
        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, arr)
        recognizer.decode_stream(stream)
        return (stream.result.text or "").strip()


def _decode_kws(kws, stream) -> Optional[str]:
    detected: Optional[str] = None
    with _KWS_LOCK:
        while kws.is_ready(stream):
            kws.decode_stream(stream)
            result = (kws.get_result(stream) or "").strip()
            if result:
                detected = result
                kws.reset_stream(stream)
                break
    return detected


def _command_kws_window(samples: np.ndarray) -> np.ndarray:
    """Recent speech only — wake-word audio at the start of the accum confuses verb KWS."""
    tail = int(COMMAND_KWS_TAIL_S * TARGET_SAMPLE_RATE)
    if len(samples) > tail:
        return samples[-tail:]
    return samples


def _command_kws_hit(samples: np.ndarray) -> Optional[str]:
    """Spot a playback verb on a contiguous audio window (fresh stream + tail pad)."""
    kws = get_command_kws()
    if kws is None or samples.size == 0:
        return None
    window = _command_kws_window(samples)
    stream = kws.create_stream()
    stream.accept_waveform(TARGET_SAMPLE_RATE, window)
    tail = np.zeros(int(KWS_TAIL_PAD_S * TARGET_SAMPLE_RATE), dtype=np.float32)
    stream.accept_waveform(TARGET_SAMPLE_RATE, tail)
    hit = _decode_kws(kws, stream)
    return CMD_KW_MAP.get(hit.upper()) if hit else None


def _command_kws_response(cmd_verb: str, *, keyword: Optional[str] = None) -> dict:
    out = {
        "partial": "",
        "final": cmd_verb,
        "speaking": False,
        "listening": "command",
        "commandFinal": True,
        "commandSource": "kws",
    }
    if keyword:
        out["keyword"] = keyword
    return out


class _StreamSession:
    def __init__(self, client_id: str) -> None:
        import sherpa_onnx

        get_recognizer()
        assert _VAD_CONFIG is not None
        self.client_id = client_id
        self.mode = "passive"
        self.command_until = 0.0
        self._init_command_vad()
        self.buffer = np.array([], dtype=np.float32)
        self.offset = 0
        self.started = False
        self.started_time: Optional[float] = None
        self.last_partial = ""
        self.last_active = time.monotonic()
        self.kws_stream = get_kws().create_stream() if _KWS_ENABLED else None
        self.cmd_kws_accum = np.array([], dtype=np.float32)

    def _init_command_vad(self) -> None:
        import sherpa_onnx

        config = _COMMAND_VAD_CONFIG or _VAD_CONFIG
        assert config is not None
        self.vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30)
        self.window_size = config.silero_vad.window_size

    def _touch(self) -> None:
        self.last_active = time.monotonic()

    def _feed_kws(self, samples: np.ndarray, sample_rate: int) -> Optional[str]:
        kws = get_kws()
        if kws is None or self.kws_stream is None or samples.size == 0:
            return None
        self.kws_stream.accept_waveform(sample_rate, samples)
        return _decode_kws(kws, self.kws_stream)

    def _reset_command_kws_accum(self) -> None:
        self.cmd_kws_accum = np.array([], dtype=np.float32)

    def _try_command_kws(self, samples: np.ndarray) -> Optional[str]:
        """Rolling window + tail pad — short verbs span multiple 80ms bot chunks."""
        if samples.size == 0 or not _CMD_KWS_ENABLED:
            return None
        max_samples = int(2.5 * TARGET_SAMPLE_RATE)
        self.cmd_kws_accum = np.concatenate([self.cmd_kws_accum, samples])
        if len(self.cmd_kws_accum) > max_samples:
            self.cmd_kws_accum = self.cmd_kws_accum[-max_samples:]
        return _command_kws_hit(self.cmd_kws_accum)

    def _flush_kws_tail(self) -> Optional[str]:
        kws = get_kws()
        if kws is None or self.kws_stream is None:
            return None
        tail = np.zeros(int(KWS_TAIL_PAD_S * TARGET_SAMPLE_RATE), dtype=np.float32)
        self.kws_stream.accept_waveform(TARGET_SAMPLE_RATE, tail)
        return _decode_kws(kws, self.kws_stream)

    def _check_command_timeout(self) -> None:
        if self.mode == "command" and time.monotonic() > self.command_until:
            self._exit_command_mode()

    def _enter_command_mode(self) -> None:
        self.mode = "command"
        self.command_until = time.monotonic() + COMMAND_WINDOW_S
        self._reset_command_buffer()
        self._reset_command_kws_accum()

    def _exit_command_mode(self) -> None:
        self.mode = "passive"
        self.command_until = 0.0
        self._reset_command_buffer()

    def _reset_command_buffer(self) -> None:
        self.buffer = np.array([], dtype=np.float32)
        self.offset = 0
        self.started = False
        self.started_time = None
        self.last_partial = ""
        self._init_command_vad()

    def extend_command_mode(self) -> None:
        if self.mode != "command":
            self._enter_command_mode()
        else:
            self.command_until = time.monotonic() + COMMAND_WINDOW_S
        self._touch()

    def clear_command_buffer(self) -> None:
        if self.mode != "command":
            return
        self._reset_command_buffer()
        self.command_until = time.monotonic() + COMMAND_WINDOW_S
        self._touch()

    def feed(self, samples: np.ndarray) -> dict:
        self._touch()
        self._check_command_timeout()

        keyword: Optional[str] = None
        kw = self._feed_kws(samples, TARGET_SAMPLE_RATE)
        if kw:
            keyword = kw
            self._enter_command_mode()

        if self.mode != "command":
            out = {"partial": "", "final": None, "speaking": False, "listening": "passive"}
            if keyword:
                out["keyword"] = keyword
                out["listening"] = "command"
            return out

        # Closed-vocab KWS for playback verbs first — short-circuits VAD+ASR on hit.
        # On miss, fall through so trailing audio in the wake chunk ("…penny pause")
        # is not dropped (early-return used to lose the verb on one-shot phrases).
        cmd_verb = self._try_command_kws(samples)
        if cmd_verb:
            self._reset_command_kws_accum()
            self._reset_command_buffer()
            self.command_until = time.monotonic() + COMMAND_WINDOW_S
            return _command_kws_response(cmd_verb)

        recognizer = get_recognizer()
        partial = ""
        final: Optional[str] = None
        speaking = self.started

        self.buffer = np.concatenate([self.buffer, samples])
        while self.offset + self.window_size < len(self.buffer):
            self.vad.accept_waveform(self.buffer[self.offset : self.offset + self.window_size])
            if not self.started and self.vad.is_speech_detected():
                self.started = True
                self.started_time = time.monotonic()
                speaking = True
            self.offset += self.window_size

        if not self.started:
            max_keep = 10 * self.window_size
            if len(self.buffer) > max_keep:
                self.offset -= len(self.buffer) - max_keep
                self.buffer = self.buffer[-max_keep:]

        partial_interval = (
            COMMAND_PARTIAL_DECODE_INTERVAL_S
            if self.mode == "command"
            else PARTIAL_DECODE_INTERVAL_S
        )
        if (
            self.started
            and self.started_time is not None
            and time.monotonic() - self.started_time > partial_interval
        ):
            text = _decode_text(recognizer, self.buffer)
            if text:
                partial = text
                self.last_partial = text
                cmd_verb = _command_kws_hit(_command_kws_window(self.buffer))
                if cmd_verb:
                    self._reset_command_kws_accum()
                    self._reset_command_buffer()
                    self.command_until = time.monotonic() + COMMAND_WINDOW_S
                    return _command_kws_response(cmd_verb)
            self.started_time = time.monotonic()

        while not self.vad.empty():
            segment = _as_float32(self.vad.front.samples)
            self.vad.pop()
            cmd_verb = _command_kws_hit(segment)
            if cmd_verb:
                self._reset_command_kws_accum()
                self._reset_command_buffer()
                self.command_until = time.monotonic() + COMMAND_WINDOW_S
                return _command_kws_response(cmd_verb)
            text = _decode_text(recognizer, segment)
            if text:
                final = text
            self._flush_kws_tail()
            self._reset_command_buffer()
            speaking = False
            if final:
                # Stay in command mode for the full window so wake-then-command
                # and multi-retry cadences keep working (do not drop to passive).
                self.command_until = time.monotonic() + COMMAND_WINDOW_S

        if partial:
            speaking = True
        elif final:
            speaking = False
        elif self.started:
            speaking = True

        out: dict = {"partial": partial, "final": final, "speaking": speaking, "listening": "command"}
        if keyword:
            out["keyword"] = keyword
        if final is not None:
            out["commandFinal"] = True
            out["commandSource"] = "asr"
        return out

    def reset(self) -> None:
        self._exit_command_mode()
        self._touch()


def _get_stream(client_id: str) -> _StreamSession:
    with _STREAM_LOCK:
        _purge_idle_streams_locked()
        session = _STREAMS.get(client_id)
        if session is None:
            session = _StreamSession(client_id)
            _STREAMS[client_id] = session
        return session


def _drop_stream(client_id: str) -> None:
    with _STREAM_LOCK:
        _STREAMS.pop(client_id, None)


def _purge_idle_streams_locked() -> None:
    now = time.monotonic()
    stale = [cid for cid, s in _STREAMS.items() if now - s.last_active > SESSION_IDLE_S]
    for cid in stale:
        _STREAMS.pop(cid, None)


def feed_stream(client_id: str, pcm: bytes, sample_rate: int, channels: int) -> dict:
    get_recognizer()
    if not _STREAMING_ENABLED:
        text = transcribe_pcm(pcm, sample_rate, channels)
        return {
            "partial": text,
            "final": text or None,
            "speaking": bool(text),
            "listening": "command",
            "commandFinal": bool(text),
        }
    samples, _ = pcm_to_float32(pcm, sample_rate, channels)
    if samples.size == 0:
        return {"partial": "", "final": None, "speaking": False, "listening": "passive"}
    session = _get_stream(client_id)
    with _STREAM_LOCK:
        return session.feed(samples)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            get_recognizer()
            self._json(
                200,
                {
                    "ok": True,
                    "engine": "sherpa-onnx",
                    "modelDir": MODEL_DIR,
                    "streaming": _STREAMING_ENABLED,
                    "kws": _KWS_ENABLED,
                    "keywordsFile": KEYWORDS_FILE if _KWS_ENABLED else None,
                    "commandKws": _CMD_KWS_ENABLED,
                    "commandKeywordsFile": COMMAND_KEYWORDS_FILE if _CMD_KWS_ENABLED else None,
                    "commandWindowS": COMMAND_WINDOW_S,
                    "sampleRate": TARGET_SAMPLE_RATE,
                },
            )
            return
        self._json(404, {"error": "not found"})

    def do_DELETE(self) -> None:
        if self.path == "/asr/stream":
            client_id = self.headers.get("X-Client-Id", "").strip()
            if not client_id:
                self._json(400, {"error": "X-Client-Id required"})
                return
            _drop_stream(client_id)
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/asr/stream":
            client_id = self.headers.get("X-Client-Id", "").strip()
            if not client_id:
                self._json(400, {"error": "X-Client-Id required"})
                return
            try:
                sample_rate = int(self.headers.get("X-Sample-Rate", str(TARGET_SAMPLE_RATE)))
                channels = int(self.headers.get("X-Channels", "1"))
            except ValueError:
                self._json(400, {"error": "invalid sample-rate or channels"})
                return
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length > MAX_PCM_BYTES:
                self._json(413, {"error": f"payload too large (max {MAX_PCM_BYTES} bytes)"})
                return
            pcm = self.rfile.read(length) if length else b""
            command_mode = self.headers.get("X-Command-Mode", "").strip().lower()
            if command_mode in ("extend", "clear"):
                session = _get_stream(client_id)
                with _STREAM_LOCK:
                    if command_mode == "extend":
                        session.extend_command_mode()
                    else:
                        session.clear_command_buffer()
                    listening = session.mode
                self._json(200, {"ok": True, "listening": listening})
                return
            try:
                out = feed_stream(client_id, pcm, sample_rate, channels)
                self._json(200, out)
            except Exception as exc:  # noqa: BLE001
                print(f"[sherpa-stt] /asr/stream error client={client_id}: {exc}", flush=True)
                traceback.print_exc()
                self._json(500, {"error": str(exc)})
            return

        if self.path != "/asr":
            self._json(404, {"error": "not found"})
            return
        try:
            sample_rate = int(self.headers.get("X-Sample-Rate", str(TARGET_SAMPLE_RATE)))
            channels = int(self.headers.get("X-Channels", "1"))
        except ValueError:
            self._json(400, {"error": "invalid sample-rate or channels"})
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > MAX_PCM_BYTES:
            self._json(413, {"error": f"payload too large (max {MAX_PCM_BYTES} bytes)"})
            return
        pcm = self.rfile.read(length) if length else b""
        try:
            text = transcribe_pcm(pcm, sample_rate, channels)
            self._json(200, {"text": text})
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"error": str(exc)})

    def log_message(self, *_a) -> None:
        pass


if __name__ == "__main__":
    print(f"[sherpa-stt] loading model from {MODEL_DIR} …", flush=True)
    get_recognizer()
    print(
        f"[sherpa-stt] streaming={'on' if _STREAMING_ENABLED else 'off'} "
        f"vad={VAD_MODEL if _STREAMING_ENABLED else 'n/a'} "
        f"kws={'on' if _KWS_ENABLED else 'off'} "
        f"commandWindow={COMMAND_WINDOW_S}s",
        flush=True,
    )
    print(f"[sherpa-stt] serving on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()