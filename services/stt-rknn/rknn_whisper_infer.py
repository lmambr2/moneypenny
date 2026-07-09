"""Rockchip zoo-compatible Whisper mel→encoder→decoder for RKNNLite.

Ported from airockchip/rknn_model_zoo examples/whisper/python/whisper.py
for 20s / tiny (or base) exports.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

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
    return mels


def log_mel_spectrogram(audio: np.ndarray, filters: np.ndarray) -> np.ndarray:
    """audio: float32 mono @ 16kHz → (80, T) log-mel matching openai-whisper."""
    # Reflect-pad like torch.stft center=True
    pad = N_FFT // 2
    audio = np.pad(audio, (pad, pad), mode="reflect")
    window = np.hanning(N_FFT).astype(np.float32)
    # Frames
    n_frames = 1 + (len(audio) - N_FFT) // HOP_LENGTH
    if n_frames < 1:
        return np.zeros((N_MELS, 0), dtype=np.float32)
    frames = np.lib.stride_tricks.as_strided(
        audio,
        shape=(n_frames, N_FFT),
        strides=(audio.strides[0] * HOP_LENGTH, audio.strides[0]),
        writeable=False,
    ).copy()
    frames *= window
    # rfft
    stft = np.fft.rfft(frames, n=N_FFT, axis=1)
    magnitudes = (np.abs(stft[:, :-1]) ** 2).T  # (freq, time) — drop last like whisper
    # filters is (80, 201); rfft bins for n=400 is 201; whisper uses [..., :-1] → 200
    # openai whisper: stft[..., :-1] so 200 bins; mel filter matrix is 80x201 in zoo file
    # Align: use first 200 columns of filters if needed
    fbins = magnitudes.shape[0]
    filt = filters[:, :fbins]
    mel_spec = filt @ magnitudes
    log_spec = np.log10(np.maximum(mel_spec, 1e-10))
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    log_spec = (log_spec + 4.0) / 4.0
    return log_spec.astype(np.float32)


def pad_or_trim_mel(audio_array: np.ndarray) -> np.ndarray:
    x_mel = np.zeros((N_MELS, MAX_LENGTH), dtype=np.float32)
    real_length = min(audio_array.shape[1], MAX_LENGTH)
    x_mel[:, :real_length] = audio_array[:, :real_length]
    return x_mel


def decode_tokens(decoder_infer, out_encoder: np.ndarray, vocab: dict[str, str]) -> str:
    tokens = [50258, TASK_EN, 50359, 50363]
    max_tokens = 12
    tokens = tokens * int(max_tokens / 4)
    next_token = 50258
    tokens_str = ""
    pop_id = max_tokens

    while next_token != END_TOKEN:
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
        self.encoder = RKNNLite()
        self.decoder = RKNNLite()
        if self.encoder.load_rknn(str(encoder_path)) != 0:
            raise RuntimeError(f"load_rknn encoder failed: {encoder_path}")
        if self.decoder.load_rknn(str(decoder_path)) != 0:
            raise RuntimeError(f"load_rknn decoder failed: {decoder_path}")
        core = getattr(RKNNLite, "NPU_CORE_0_1_2", None)
        if core is not None:
            ret_e = self.encoder.init_runtime(core_mask=core)
            ret_d = self.decoder.init_runtime(core_mask=core)
        else:
            ret_e = self.encoder.init_runtime()
            ret_d = self.decoder.init_runtime()
        if ret_e != 0:
            ret_e = self.encoder.init_runtime()
        if ret_d != 0:
            ret_d = self.decoder.init_runtime()
        if ret_e != 0 or ret_d != 0:
            raise RuntimeError(f"init_runtime failed enc={ret_e} dec={ret_d}")

    def transcribe(self, audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> str:
        if audio is None or len(audio) < int(0.1 * sample_rate):
            return ""
        if sample_rate != SAMPLE_RATE:
            # linear resample
            duration = len(audio) / float(sample_rate)
            new_len = max(1, int(duration * SAMPLE_RATE))
            x_old = np.linspace(0, 1, num=len(audio), endpoint=False)
            x_new = np.linspace(0, 1, num=new_len, endpoint=False)
            audio = np.interp(x_new, x_old, audio).astype(np.float32)
        # Cap to 20s
        if len(audio) > N_SAMPLES:
            audio = audio[:N_SAMPLES]
        mel = log_mel_spectrogram(audio.astype(np.float32), self.filters)
        x_mel = pad_or_trim_mel(mel)
        x_mel = np.expand_dims(x_mel, 0)  # (1, 80, 2000)
        out_enc = self.encoder.inference(inputs=[x_mel])[0]
        return decode_tokens(
            lambda tokens, enc: self.decoder.inference(
                inputs=[np.asarray([tokens], dtype=np.int64), enc]
            )[0],
            out_enc,
            self.vocab,
        )
