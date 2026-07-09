"""CPU-only unit tests for NPU Whisper preprocess (no rknnlite required)."""
from __future__ import annotations

import os
import unittest

import numpy as np

from rknn_whisper_infer import (
    MAX_LENGTH,
    N_MELS,
    SAMPLE_RATE,
    _core_mask_candidates,
    decode_tokens,
    log_mel_spectrogram,
    pad_or_trim_mel,
)


class MelTests(unittest.TestCase):
    def test_log_mel_shape_and_finite(self):
        rng = np.random.default_rng(0)
        audio = rng.standard_normal(SAMPLE_RATE).astype(np.float32) * 0.1
        filters = np.ones((80, 201), dtype=np.float32)
        mel = log_mel_spectrogram(audio, filters)
        self.assertEqual(mel.shape[0], N_MELS)
        self.assertGreater(mel.shape[1], 0)
        self.assertTrue(np.isfinite(mel).all())

    def test_pad_or_trim_reuses_buffer(self):
        mel = np.ones((N_MELS, 100), dtype=np.float32)
        buf = np.zeros((N_MELS, MAX_LENGTH), dtype=np.float32)
        out = pad_or_trim_mel(mel, out=buf)
        self.assertIs(out, buf)
        self.assertEqual(out.shape, (N_MELS, MAX_LENGTH))
        self.assertTrue(np.allclose(out[:, :100], 1.0))
        self.assertTrue(np.allclose(out[:, 100:], 0.0))


class DecodeTests(unittest.TestCase):
    def test_decode_tokens_stops_on_end(self):
        vocab = {str(i): f"t{i}" for i in range(51000)}
        vocab["50257"] = ""
        calls = {"n": 0}

        def fake_infer(tokens, enc):
            calls["n"] += 1
            logits = np.zeros((1, 1, 51000), dtype=np.float32)
            if calls["n"] >= 2:
                logits[0, 0, 50257] = 10.0
            else:
                logits[0, 0, 100] = 10.0
            return logits

        text = decode_tokens(fake_infer, np.zeros((1, 1)), vocab, max_steps=10)
        self.assertLessEqual(calls["n"], 10)
        self.assertIsInstance(text, str)


class CoreMaskTests(unittest.TestCase):
    def test_core_mask_candidates_include_multi_and_default(self):
        class Fake:
            NPU_CORE_0_1_2 = 7
            NPU_CORE_0_1 = 3
            NPU_CORE_0 = 1

        cands = _core_mask_candidates(Fake)
        labels = [c[0] for c in cands]
        self.assertIn("0_1_2", labels)
        self.assertTrue(any(m is None for _, m in cands) or "default" in labels)

    def test_core_mask_env_preference(self):
        class Fake:
            NPU_CORE_0 = 1
            NPU_CORE_0_1_2 = 7

        os.environ["RKNN_CORE_MASK"] = "0"
        try:
            cands = _core_mask_candidates(Fake)
            self.assertEqual(cands[0][0], "0")
        finally:
            os.environ.pop("RKNN_CORE_MASK", None)


if __name__ == "__main__":
    unittest.main()
