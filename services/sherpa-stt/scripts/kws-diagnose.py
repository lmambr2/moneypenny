#!/usr/bin/env python3
"""Quick KWS sanity check inside the sherpa-stt container."""
from __future__ import annotations

import os
import sys
import wave

import numpy as np
import sherpa_onnx

MODEL = os.environ.get(
    "KWS_MODEL_DIR",
    "/models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
)
KEYWORDS = os.environ.get("KEYWORDS_FILE", "/app/keywords/moneypenny.txt")


def spot(wav_path: str, keywords_file: str, threshold: float, score: float, trailing: int) -> str | None:
    kws = sherpa_onnx.KeywordSpotter(
        tokens=f"{MODEL}/tokens.txt",
        encoder=f"{MODEL}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        decoder=f"{MODEL}/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        joiner=f"{MODEL}/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        keywords_file=keywords_file,
        num_threads=2,
        keywords_threshold=threshold,
        keywords_score=score,
        num_trailing_blanks=trailing,
    )
    with wave.open(wav_path) as f:
        sr = f.getframerate()
        samples = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float32) / 32768

    stream = kws.create_stream()
    stream.accept_waveform(sr, samples)
    stream.accept_waveform(sr, np.zeros(int(0.66 * sr), dtype=np.float32))

    while kws.is_ready(stream):
        kws.decode_stream(stream)
        result = (kws.get_result(stream) or "").strip()
        if result:
            kws.reset_stream(stream)
            return result
    return None


def main() -> None:
    bundled = f"{MODEL}/test_wavs/0.wav"
    test_kw = f"{MODEL}/test_wavs/test_keywords.txt"

    print("=== bundled LIGHT_UP wav + test keywords ===")
    hit = spot(bundled, test_kw, 0.15, 2.5, 8)
    print("result:", hit or "NO HIT")
    if not hit:
        print("FAIL: KWS engine not detecting bundled sample")
        sys.exit(1)

    print("\n=== bundled wav + moneypenny keywords (expect miss) ===")
    print("result:", spot(bundled, KEYWORDS, 0.15, 2.5, 8) or "NO HIT")

    print("\n=== moneypenny keywords sweep on bundled wav ===")
    for th in (0.25, 0.15, 0.10, 0.05):
        for score in (1.0, 2.5, 4.0):
            hit = spot(bundled, KEYWORDS, th, score, 8)
            print(f"  th={th} score={score} -> {hit or 'miss'}")


if __name__ == "__main__":
    main()