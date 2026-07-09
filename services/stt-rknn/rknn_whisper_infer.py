"""Rockchip zoo-compatible Whisper mel→encoder→decoder for RKNNLite.

Ported from airockchip/rknn_model_zoo examples/whisper/python/whisper.py
for 20s / tiny (or base) exports.

NPU opts (this module):
  - Multi-core init with fallback chain (0_1_2 → 0_1 → 0 → default)
  - Precomputed Hann window + contiguous mel filters
  - Faster power spectrum (no abs/complex-magnitude)
  - Reused mel / encoder input buffers (no per-call expand_dims alloc storm)
  - Decoder step cap for short voice commands
  - RKNN_CORE_MASK env override
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

import numpy as np

SAMPLE_RATE = 16000
N_FFT = 400
HOP_LENGTH = 160
CHUNK_LENGTH = 20  # must match export (we use 20s)
N_SAMPLES = CHUNK_LENGTH * SAMPLE_RATE
MAX_LENGTH = CHUNK_LENGTH * 100  # mel frames
N_MELS = 80
TASK_EN = 50259
END_TOKEN = 50257
TIMESTAMP_BEGIN = 50364
# Voice commands are short — cap decoder steps (safety + latency).
MAX_DECODE_STEPS = int(os.environ.get("RKNN_MAX_DECODE_STEPS", "48"))

# Precomputed Hann window (same every call).
_WINDOW = np.hanning(N_FFT).astype(np.float32)


def read_vocab(vocab_path: Path) -> dict[str, str]:
    vocab: dict[str, str] = {}
    with open(vocab_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.strip().split(" ", 1)
            if not parts:
                continue
            key = parts[0]
            value = parts[1] if len(parts) > 1 else ""
            vocab[key] = value
    return vocab


def mel_filters(filters_path: Path) -> np.ndarray:
    mels = np.loadtxt(str(filters_path), dtype=np.float32).reshape((80, 201))
    # Contiguous for matmul performance.
    return np.ascontiguousarray(mels, dtype=np.float32)


def log_mel_spectrogram(audio: np.ndarray, filters: np.ndarray) -> np.ndarray:
    """audio: float32 mono @ 16kHz → (80, T) log-mel matching openai-whisper."""
    audio = np.ascontiguousarray(audio, dtype=np.float32)
    # Reflect-pad like torch.stft center=True
    pad = N_FFT // 2
    audio = np.pad(audio, (pad, pad), mode="reflect")
    n_frames = 1 + (len(audio) - N_FFT) // HOP_LENGTH
    if n_frames < 1:
        return np.zeros((N_MELS, 0), dtype=np.float32)

    # Sliding windows; one copy so we can apply the window in-place.
    # hop = HOP_LENGTH samples between frame starts.
    frames = np.lib.stride_tricks.as_strided(
        audio,
        shape=(n_frames, N_FFT),
        strides=(audio.strides[0] * HOP_LENGTH, audio.strides[0]),
        writeable=False,
    )
    frames = np.multiply(frames, _WINDOW, dtype=np.float32)

    stft = np.fft.rfft(frames, n=N_FFT, axis=1)
    # Drop last bin like openai-whisper stft[..., :-1]
    stft = stft[:, :-1]
    # |z|^2 without abs() → fewer temps
    magnitudes = (stft.real * stft.real + stft.imag * stft.imag).T  # (freq, time)

    fbins = magnitudes.shape[0]
    filt = filters[:, :fbins]
    mel_spec = filt @ magnitudes
    # In-place friendly path for log + dynamic range compress
    np.maximum(mel_spec, 1e-10, out=mel_spec)
    log_spec = np.log10(mel_spec)
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    log_spec = (log_spec + 4.0) * 0.25
    return np.ascontiguousarray(log_spec, dtype=np.float32)


def pad_or_trim_mel(audio_array: np.ndarray, out: np.ndarray | None = None) -> np.ndarray:
    """Write mel into fixed (80, MAX_LENGTH) buffer (reused by ZooRknnWhisper)."""
    if out is None or out.shape != (N_MELS, MAX_LENGTH):
        out = np.zeros((N_MELS, MAX_LENGTH), dtype=np.float32)
    else:
        out.fill(0.0)
    real_length = min(audio_array.shape[1], MAX_LENGTH)
    if real_length > 0:
        out[:, :real_length] = audio_array[:, :real_length]
    return out


def decode_tokens(
    decoder_infer: Callable[[list[int], np.ndarray], np.ndarray],
    out_encoder: np.ndarray,
    vocab: dict[str, str],
    max_steps: int = MAX_DECODE_STEPS,
) -> str:
    tokens = [50258, TASK_EN, 50359, 50363]
    max_tokens = 12
    tokens = tokens * int(max_tokens / 4)
    next_token = 50258
    tokens_str = ""
    pop_id = max_tokens
    steps = 0

    while next_token != END_TOKEN and steps < max_steps:
        steps += 1
        out_decoder = decoder_infer(tokens, out_encoder)
        # out shape (1, seq, vocab)
        next_token = int(out_decoder[0, -1].argmax())
        next_token_str = vocab.get(str(next_token), "")
        tokens.append(next_token)
        if next_token == END_TOKEN:
            tokens.pop(-1)
            break
        if next_token > TIMESTAMP_BEGIN:
            continue
        if pop_id > 4:
            pop_id -= 1
        tokens.pop(pop_id)
        tokens_str += next_token_str

    result = tokens_str.replace("\u0120", " ").replace("<|endoftext|>", "").replace("\n", "")
    return result.strip()


def _core_mask_candidates(rknn_lite_cls: Any) -> list[tuple[str, Any | None]]:
    """Ordered list of (label, mask|None) to try for init_runtime."""
    env = os.environ.get("RKNN_CORE_MASK", "auto").strip().lower()
    named = {
        "0_1_2": "NPU_CORE_0_1_2",
        "012": "NPU_CORE_0_1_2",
        "all": "NPU_CORE_0_1_2",
        "0_1": "NPU_CORE_0_1",
        "01": "NPU_CORE_0_1",
        "0": "NPU_CORE_0",
        "1": "NPU_CORE_1",
        "2": "NPU_CORE_2",
        "auto": None,
    }
    out: list[tuple[str, Any | None]] = []

    def add(label: str, attr: str | None) -> None:
        if attr is None:
            out.append((label, None))
            return
        m = getattr(rknn_lite_cls, attr, None)
        if m is not None:
            out.append((label, m))

    if env and env not in ("auto", "default", ""):
        attr = named.get(env)
        if attr:
            add(env, attr)
        elif env.isdigit():
            add(env, f"NPU_CORE_{env}")
        # still fall through to full chain after preferred

    # Preferred production chain for RK3588 Whisper
    for label, attr in (
        ("0_1_2", "NPU_CORE_0_1_2"),
        ("0_1", "NPU_CORE_0_1"),
        ("0", "NPU_CORE_0"),
        ("auto", "NPU_CORE_AUTO"),
        ("default", None),
    ):
        if not any(x[0] == label for x in out):
            add(label, attr)

    if not any(m is None for _, m in out):
        out.append(("default", None))
    return out


def init_rknn_runtime(rknn: Any, rknn_lite_cls: Any, role: str) -> str:
    """init_runtime with multi-core preference. Returns mask label used."""
    last_err = -1
    for label, mask in _core_mask_candidates(rknn_lite_cls):
        if mask is None:
            ret = rknn.init_runtime()
        else:
            ret = rknn.init_runtime(core_mask=mask)
        if ret == 0:
            print(f"[stt-rknn] {role} NPU runtime ok core_mask={label}", flush=True)
            return label
        last_err = ret
    raise RuntimeError(f"init_runtime failed for {role} last_ret={last_err}")


class ZooRknnWhisper:
    def __init__(
        self,
        encoder_path: Path,
        decoder_path: Path,
        vocab_path: Path,
        mel_filters_path: Path,
    ):
        from rknnlite.api import RKNNLite  # type: ignore

        self.vocab = read_vocab(vocab_path)
        self.filters = mel_filters(mel_filters_path)
        # Reused every transcribe — (1, 80, 2000) encoder input
        self._mel_plane = np.zeros((N_MELS, MAX_LENGTH), dtype=np.float32)
        self._mel_batch = np.zeros((1, N_MELS, MAX_LENGTH), dtype=np.float32)

        self.encoder = RKNNLite()
        self.decoder = RKNNLite()
        if self.encoder.load_rknn(str(encoder_path)) != 0:
            raise RuntimeError(f"load_rknn encoder failed: {encoder_path}")
        if self.decoder.load_rknn(str(decoder_path)) != 0:
            raise RuntimeError(f"load_rknn decoder failed: {decoder_path}")

        self._enc_core = init_rknn_runtime(self.encoder, RKNNLite, "encoder")
        self._dec_core = init_rknn_runtime(self.decoder, RKNNLite, "decoder")
        print(
            f"[stt-rknn] NPU cores encoder={self._enc_core} decoder={self._dec_core} "
            f"max_decode_steps={MAX_DECODE_STEPS}",
            flush=True,
        )

    def _decoder_infer(self, tokens: list[int], enc: np.ndarray) -> np.ndarray:
        tok = np.asarray([tokens], dtype=np.int64)
        return self.decoder.inference(inputs=[tok, enc])[0]

    def transcribe(self, audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> str:
        if audio is None or len(audio) < int(0.1 * sample_rate):
            return ""
        if not isinstance(audio, np.ndarray):
            audio = np.asarray(audio, dtype=np.float32)
        elif audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        if sample_rate != SAMPLE_RATE:
            # linear resample (commands are short — cost is small)
            duration = len(audio) / float(sample_rate)
            new_len = max(1, int(duration * SAMPLE_RATE))
            x_old = np.linspace(0, 1, num=len(audio), endpoint=False)
            x_new = np.linspace(0, 1, num=new_len, endpoint=False)
            audio = np.interp(x_new, x_old, audio).astype(np.float32)

        # Cap to 20s (export length)
        if len(audio) > N_SAMPLES:
            audio = audio[:N_SAMPLES]

        mel = log_mel_spectrogram(audio, self.filters)
        pad_or_trim_mel(mel, out=self._mel_plane)
        self._mel_batch[0] = self._mel_plane

        out_enc = self.encoder.inference(inputs=[self._mel_batch])[0]
        return decode_tokens(self._decoder_infer, out_enc, self.vocab, max_steps=MAX_DECODE_STEPS)
