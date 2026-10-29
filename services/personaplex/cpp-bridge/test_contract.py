#!/usr/bin/env python3
"""Contract: mute/reset do not unload; warm without a binary stays unloaded."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge  # noqa: E402


class Contract(unittest.TestCase):
    def setUp(self) -> None:
        os.environ.pop("MOSHI_CPP_BIN", None)
        with bridge._lock:
            bridge._stop_child()
            bridge._state["error"] = ""
            bridge._state["mute_out"] = False
            bridge._state["rtf"] = None
            bridge._state["voice"] = "NATF2"

    def test_health_shape_matches_mock(self) -> None:
        h = bridge.health_obj()
        for key in (
            "ok",
            "loaded",
            "engine",
            "realtime",
            "rtf",
            "vram_mb",
            "voice",
            "sample_rate",
            "frame_hz",
        ):
            self.assertIn(key, h)
        self.assertEqual(h["engine"], "moshicpp-vulkan")
        self.assertTrue(h["ok"])
        self.assertFalse(h["loaded"])
        self.assertEqual(h["vram_mb"], 0)

    def test_warm_without_binary_stays_unloaded(self) -> None:
        h = bridge.apply_control({"op": "warm"})
        self.assertTrue(h["ok"])
        self.assertFalse(h["loaded"])
        self.assertIn("MOSHI_CPP_BIN", h.get("error", ""))

    def test_mute_and_reset_do_not_flip_loaded(self) -> None:
        with bridge._lock:
            bridge._state["loaded"] = True
        before = bridge._state["loaded"]
        bridge.apply_control({"op": "mute_out"})
        self.assertTrue(bridge._state["mute_out"])
        self.assertEqual(bridge._state["loaded"], before)
        bridge.apply_control({"op": "reset"})
        self.assertEqual(bridge._state["loaded"], before)
        bridge.apply_control({"op": "unload"})
        h = bridge.health_obj()
        self.assertFalse(h["loaded"])
        self.assertEqual(h["vram_mb"], 0)
        self.assertFalse(bridge._state["mute_out"])

    def test_inbound_text_kind_is_not_a_control(self) -> None:
        self.assertEqual(bridge.KIND_TEXT, 0x02)
        self.assertEqual(bridge.AGENT_CAPTION, "cpp-bridge")


if __name__ == "__main__":
    unittest.main()
