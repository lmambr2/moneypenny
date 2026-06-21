#!/usr/bin/env python3
"""
Moneypenny STT mock — HTTP sidecar for voice smoke tests (Phase 2 scaffolding).

Implements the contract expected by bot/src/voice/stt.ts (SherpaSttClient):
  GET  /health       -> { ok: true }
  POST /asr          -> { text }  (batch)
  POST /asr/stream   -> { partial, final, speaking }
  DELETE /asr/stream -> reset per-client state
"""
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MOCK_TEXT = os.environ.get("MOCK_STT_TEXT", "skip")
PORT = int(os.environ.get("PORT", "9000"))
MIN_PCM_BYTES = int(os.environ.get("MIN_PCM_BYTES", "64"))
STREAM_FINAL_BYTES = int(os.environ.get("STREAM_FINAL_BYTES", "16000"))
MAX_PCM_BYTES = int(os.environ.get("MAX_PCM_BYTES", str(25 * 1024 * 1024)))

_STREAM_BYTES: dict[str, int] = {}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        import json

        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True, "mock": True, "streaming": True, "defaultText": MOCK_TEXT})
            return
        self._json(404, {"error": "not found"})

    def do_DELETE(self) -> None:
        if self.path == "/asr/stream":
            client_id = self.headers.get("X-Client-Id", "").strip()
            if client_id:
                _STREAM_BYTES.pop(client_id, None)
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/asr/stream":
            client_id = self.headers.get("X-Client-Id", "").strip() or "0"
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length > MAX_PCM_BYTES:
                self._json(413, {"error": f"payload too large (max {MAX_PCM_BYTES} bytes)"})
                return
            pcm = self.rfile.read(length) if length else b""
            override = self.headers.get("X-Test-Transcript", "").strip()
            total = _STREAM_BYTES.get(client_id, 0) + len(pcm)
            _STREAM_BYTES[client_id] = total
            speaking = total >= MIN_PCM_BYTES
            final = None
            if total >= STREAM_FINAL_BYTES:
                final = override or MOCK_TEXT
                _STREAM_BYTES.pop(client_id, None)
                speaking = False
            self._json(200, {"partial": "", "final": final, "speaking": speaking})
            return

        if self.path != "/asr":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > MAX_PCM_BYTES:
            self._json(413, {"error": f"payload too large (max {MAX_PCM_BYTES} bytes)"})
            return
        pcm = self.rfile.read(length) if length else b""
        override = self.headers.get("X-Test-Transcript", "").strip()
        if len(pcm) < MIN_PCM_BYTES:
            text = ""
        elif override:
            text = override
        else:
            text = MOCK_TEXT
        self._json(200, {"text": text})

    def log_message(self, *_a) -> None:
        pass


if __name__ == "__main__":
    print(f"[stt-mock] serving on :{PORT} (default transcript={MOCK_TEXT!r})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()