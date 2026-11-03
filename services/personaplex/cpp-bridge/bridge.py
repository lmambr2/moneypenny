#!/usr/bin/env python3
"""
PersonaPlex cpp-bridge (PR-D1.5 / A1).

Same bytes as services/personaplex/server.py (the mock):

  GET  /health
  POST /v1/control   {op: prompt|voice|reset|mute_out|unload|warm}
  WS   /v1/pcm       kind byte + payload

engine is moshicpp-vulkan. vram_mb is this child process's VmRSS, never
card-total. mute_out / reset / a closed socket do not flip loaded.
unload kills the moshi.cpp process group and leaves HTTP up.
warm starts MOSHI_CPP_BIN when it is executable; otherwise loaded stays false
so scripts/duplex-rtf.sh fails closed (stay cascaded).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import signal
import struct
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8999"))
VOICE = os.environ.get("TALKER_VOICE", "NATF2")
ENGINE = "moshicpp-vulkan"
RTF_REALTIME = 1.15
KIND_PCM = 0x01
KIND_TEXT = 0x02
KIND_CONTROL = 0x03
KIND_META = 0x04
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
AGENT_CAPTION = "cpp-bridge"

_lock = threading.Lock()
_state = {
    "loaded": False,
    "mute_out": False,
    "voice": VOICE,
    "proc": None,  # subprocess.Popen | None
    "error": "",
    "rtf": None,  # measured only; unset → not realtime
}


def _child_vram_mb(proc: subprocess.Popen | None) -> int:
    if proc is None or proc.poll() is not None:
        return 0
    try:
        with open(f"/proc/{proc.pid}/status", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    kb = int(line.split()[1])
                    return max(0, int(round(kb / 1024)))
    except (OSError, ValueError, IndexError):
        return 0
    return 0


def _refresh_child() -> None:
    proc = _state["proc"]
    if isinstance(proc, subprocess.Popen) and proc.poll() is not None:
        _state["proc"] = None
        _state["loaded"] = False
        if not _state["error"]:
            _state["error"] = "moshi.cpp exited"


def health_obj() -> dict:
    with _lock:
        _refresh_child()
        proc = _state["proc"] if isinstance(_state["proc"], subprocess.Popen) else None
        alive = proc is not None and proc.poll() is None
        loaded = bool(_state["loaded"]) and alive
        vram = _child_vram_mb(proc) if loaded else 0
        rtf_raw = _state["rtf"]
        rtf = float(rtf_raw) if isinstance(rtf_raw, (int, float)) else 0.0
        realtime = loaded and isinstance(rtf_raw, (int, float)) and rtf <= RTF_REALTIME
        out = {
            "ok": True,
            "loaded": loaded,
            "engine": ENGINE,
            "realtime": realtime,
            "rtf": rtf if loaded else 0.0,
            "vram_mb": vram,
            "voice": _state["voice"],
            "sample_rate": 24000,
            "frame_hz": 12.5,
        }
        if _state["error"] and not loaded:
            out["error"] = _state["error"]
        return out


def _stop_child() -> None:
    proc = _state["proc"]
    _state["proc"] = None
    _state["loaded"] = False
    _state["mute_out"] = False
    if not isinstance(proc, subprocess.Popen):
        return
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            proc.kill()
        proc.wait(timeout=2)


def _start_child() -> str:
    """Return an error string, or '' when the process is up."""
    bin_path = os.environ.get("MOSHI_CPP_BIN", "").strip()
    if not bin_path or not os.path.isfile(bin_path) or not os.access(bin_path, os.X_OK):
        return "MOSHI_CPP_BIN missing or not executable"
    model = os.environ.get("MOSHI_MODEL", "").strip()
    cmd = [bin_path]
    if model:
        cmd.extend(["--model", model])
    extra = os.environ.get("MOSHI_CPP_ARGS", "").strip()
    if extra:
        cmd.extend(extra.split())
    try:
        proc = subprocess.Popen(
            cmd,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as exc:
        return str(exc)
    _state["proc"] = proc
    _state["loaded"] = True
    _state["error"] = ""
    rtf_env = os.environ.get("MOSHI_RTF", "").strip()
    if rtf_env:
        try:
            _state["rtf"] = float(rtf_env)
        except ValueError:
            _state["rtf"] = None
    else:
        _state["rtf"] = None
    return ""


def apply_control(body: dict) -> dict:
    op = str(body.get("op") or "")
    with _lock:
        if op == "unload":
            _state["error"] = ""
            _stop_child()
        elif op == "warm":
            _stop_child()
            err = _start_child()
            if err:
                _state["loaded"] = False
                _state["proc"] = None
                _state["error"] = err
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
                    rtf = float(_state["rtf"] or 0)
                if muted:
                    meta = json.dumps(
                        {"speaking": False, "rtf": rtf, "backchannel": False}
                    ).encode()
                    self.wfile.write(kind_frame(KIND_META, meta))
                    continue
                self.wfile.write(kind_frame(KIND_PCM, payload))
                self.wfile.write(kind_frame(KIND_TEXT, AGENT_CAPTION.encode()))
                meta = json.dumps({"speaking": True, "rtf": rtf, "backchannel": False}).encode()
                self.wfile.write(kind_frame(KIND_META, meta))
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def log_message(self, *_a) -> None:
        pass


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[personaplex-cpp] :{PORT} engine={ENGINE} voice={VOICE!r}", flush=True)
    httpd.serve_forever()
