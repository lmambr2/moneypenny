#!/usr/bin/env python3
"""
PersonaPlex adapter mock — same bytes as the product Talker (PR-D1).

GET  /health
POST /v1/control   {op: prompt|voice|reset|mute_out|unload|warm}
WS   /v1/pcm       binary: kind + payload

  C→S 0x01 PCM16LE user audio
  C→S 0x03 UTF-8 JSON control
  C→S 0x02 FORBIDDEN (ignored — never treated as user ASR)
  S→C 0x01 PCM16LE **agent** audio (24 kHz mono)
  S→C 0x02 UTF-8 **agent** inner monologue (captions only)
  S→C 0x04 JSON {speaking, rtf, backchannel}

vram_mb is this process's fake working set, never card-total.
unload → ok=true loaded=false vram_mb=0 (HTTP stays).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8999"))
VOICE = os.environ.get("MOCK_VOICE", "NATF2")
WORKING_SET_MB = int(os.environ.get("MOCK_WORKING_SET_MB", "64"))
RTF_REALTIME = 1.15

KIND_PCM = 0x01
KIND_TEXT = 0x02
KIND_CONTROL = 0x03
KIND_META = 0x04

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
AGENT_CAPTION = "mock-agent"

_lock = threading.Lock()
_state = {
    "loaded": os.environ.get("MOCK_LOADED", "1") not in ("0", "false", "False"),
    "mute_out": False,
    "rtf": float(os.environ.get("MOCK_RTF", "0.5")),
    "voice": VOICE,
}


def health_obj() -> dict:
    with _lock:
        loaded = bool(_state["loaded"])
        rtf = float(_state["rtf"])
        vram = WORKING_SET_MB if loaded else 0
        realtime = loaded and rtf <= RTF_REALTIME
        return {
            "ok": True,
            "loaded": loaded,
            "engine": "mock",
            "realtime": realtime,
            "rtf": rtf if loaded else 0.0,
            "vram_mb": vram,
            "voice": _state["voice"],
            "sample_rate": 24000,
            "frame_hz": 12.5,
        }


def apply_control(body: dict) -> dict:
    op = str(body.get("op") or "")
    with _lock:
        if op == "unload":
            _state["loaded"] = False
            _state["mute_out"] = False
        elif op == "warm":
            _state["loaded"] = True
            _state["mute_out"] = False
        elif op == "mute_out":
            _state["mute_out"] = True
        elif op == "reset":
            pass
        elif op == "voice":
            v = body.get("voice")
            if isinstance(v, str) and v.strip():
                _state["voice"] = v.strip()
        elif op == "prompt":
            pass
        elif op == "rtf":
            try:
                _state["rtf"] = float(body.get("rtf"))
            except (TypeError, ValueError):
                pass
    return health_obj()


def ws_accept(key: str) -> str:
    digest = hashlib.sha1((key + WS_GUID).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii")


def ws_encode(payload: bytes, opcode: int = 2) -> bytes:
    n = len(payload)
    header = bytes([0x80 | opcode])
    if n < 126:
        header += bytes([n])
    elif n < 65536:
        header += bytes([126]) + struct.pack("!H", n)
    else:
        header += bytes([127]) + struct.pack("!Q", n)
    return header + payload


def ws_read_frame(rfile):
    hdr = rfile.read(2)
    if not hdr or len(hdr) < 2:
        return None
    opcode = hdr[0] & 0x0F
    masked = (hdr[1] & 0x80) != 0
    length = hdr[1] & 0x7F
    if length == 126:
        ext = rfile.read(2)
        if len(ext) < 2:
            return None
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = rfile.read(8)
        if len(ext) < 8:
            return None
        length = struct.unpack("!Q", ext)[0]
    mask = b""
    if masked:
        mask = rfile.read(4)
        if len(mask) < 4:
            return None
    data = rfile.read(length) if length else b""
    if len(data) < length:
        return None
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def kind_frame(kind: int, payload: bytes) -> bytes:
    return ws_encode(bytes([kind]) + payload, opcode=2)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/health":
            self._json(200, health_obj())
            return
        if self.headers.get("Upgrade", "").lower() == "websocket" and self.path.split("?", 1)[
            0
        ] in ("/v1/pcm", "/v1/pcm/"):
            self._ws()
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] not in ("/v1/control", "/v1/control/"):
            self._json(404, {"error": "not found"})
            return
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode() or "{}")
            if not isinstance(body, dict):
                raise ValueError("object required")
        except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
            self._json(400, {"error": "invalid json"})
            return
        self._json(200, apply_control(body))

    def _ws(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            self._json(400, {"error": "missing Sec-WebSocket-Key"})
            return
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", ws_accept(key))
        self.end_headers()
        try:
            while True:
                frame = ws_read_frame(self.rfile)
                if frame is None:
                    break
                opcode, data = frame
                if opcode == 0x8:
                    self.wfile.write(ws_encode(b"", opcode=0x8))
                    break
                if opcode == 0x9:
                    self.wfile.write(ws_encode(data, opcode=0xA))
                    continue
                if opcode not in (0x1, 0x2) or not data:
                    continue
                kind = data[0]
                payload = data[1:]
                if kind == KIND_TEXT:
                    # Forbidden inbound — never user ASR.
                    continue
                if kind == KIND_CONTROL:
                    try:
                        body = json.loads(payload.decode() or "{}")
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        body = {}
                    if isinstance(body, dict):
                        apply_control(body)
                    continue
                if kind != KIND_PCM:
                    continue
                h = health_obj()
                if not h["loaded"]:
                    continue
                with _lock:
                    muted = bool(_state["mute_out"])
                    rtf = float(_state["rtf"])
                if muted:
                    meta = json.dumps(
                        {"speaking": False, "rtf": rtf, "backchannel": False}
                    ).encode()
                    self.wfile.write(kind_frame(KIND_META, meta))
                    continue
                # Echo as **agent** PCM + caption. Caption is never the user.
                self.wfile.write(kind_frame(KIND_PCM, payload))
                self.wfile.write(kind_frame(KIND_TEXT, AGENT_CAPTION.encode()))
                meta = json.dumps(
                    {"speaking": True, "rtf": rtf, "backchannel": False}
                ).encode()
                self.wfile.write(kind_frame(KIND_META, meta))
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def log_message(self, *_a) -> None:
        pass


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(
        f"[personaplex-mock] :{PORT} engine=mock voice={VOICE!r} loaded={_state['loaded']}",
        flush=True,
    )
    httpd.serve_forever()
