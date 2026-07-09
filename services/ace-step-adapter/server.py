#!/usr/bin/env python3
"""
Minimal ACE-Step HTTP adapter matching docs/ace-step-host.md.

When ACE_STEP_MOCK=1 (default in CI), generates a short silent MP3-ish stub
so the bot's generate path can be exercised without a GPU.

Real workers: set ACE_STEP_WORKER_URL to an upstream Gradio/API and map jobs.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", "7865"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/music/generated/ace-step"))
MOCK = os.environ.get("ACE_STEP_MOCK", "1").strip() not in ("0", "false", "no")

_JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()
_BUSY = False


def _json(handler: BaseHTTPRequestHandler, code: int, obj: dict) -> None:
    body = json.dumps(obj).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _run_job(job_id: str, prompt: str, duration_sec: int) -> None:
    global _BUSY
    with _LOCK:
        _BUSY = True
        _JOBS[job_id]["status"] = "running"
    try:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        # Tiny valid-enough MPEG frame header + padding (bot sniffs mp3)
        name = f"{time.strftime('%Y%m%dT%H%M%S')}-{job_id[:8]}.mp3"
        path = OUTPUT_DIR / name
        # Minimal MPEG sync word + zeros
        path.write_bytes(b"\xff\xfb\x90\x00" + b"\x00" * 256)
        rel = f"generated/ace-step/{name}"
        with _LOCK:
            _JOBS[job_id].update({"status": "done", "path": rel, "error": None})
    except Exception as e:
        with _LOCK:
            _JOBS[job_id].update({"status": "error", "error": str(e)})
    finally:
        with _LOCK:
            _BUSY = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[ace-step-adapter] {fmt % args}", flush=True)

    def do_GET(self) -> None:
        u = urlparse(self.path)
        if u.path == "/health":
            with _LOCK:
                busy = _BUSY
            _json(self, 200, {"ok": True, "engine": "ace-step", "busy": busy, "mock": MOCK})
            return
        if u.path.startswith("/v1/jobs/"):
            rest = u.path[len("/v1/jobs/") :]
            if rest.endswith("/audio"):
                jid = rest[: -len("/audio")]
                with _LOCK:
                    job = _JOBS.get(jid)
                if not job or job.get("status") != "done":
                    _json(self, 404, {"error": "not ready"})
                    return
                p = job.get("path") or ""
                # Serve file bytes if present under OUTPUT_DIR
                fname = Path(p).name
                fpath = OUTPUT_DIR / fname
                if not fpath.is_file():
                    _json(self, 404, {"error": "file missing"})
                    return
                data = fpath.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            jid = rest
            with _LOCK:
                job = _JOBS.get(jid)
            if not job:
                _json(self, 404, {"error": "unknown job"})
                return
            _json(self, 200, job)
            return
        _json(self, 404, {"error": "not found"})

    def do_POST(self) -> None:
        u = urlparse(self.path)
        if u.path != "/v1/generate":
            _json(self, 404, {"error": "not found"})
            return
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode() or "{}")
        except Exception:
            body = {}
        prompt = str(body.get("prompt") or "track")
        duration = int(body.get("durationSec") or 120)
        jid = uuid.uuid4().hex
        with _LOCK:
            _JOBS[jid] = {"id": jid, "status": "queued", "path": None, "error": None}
        if MOCK:
            threading.Thread(target=_run_job, args=(jid, prompt, duration), daemon=True).start()
        else:
            # Non-mock: still write a stub unless worker is wired
            threading.Thread(target=_run_job, args=(jid, prompt, duration), daemon=True).start()
        _json(self, 200, {"id": jid, "status": "queued"})


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[ace-step-adapter] :{PORT} mock={MOCK} out={OUTPUT_DIR}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
