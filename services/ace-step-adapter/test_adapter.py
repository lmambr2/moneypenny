"""Unit tests for ACE-Step adapter mock vs non-mock worker contract."""
from __future__ import annotations

import importlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

# Load adapter as module from same dir
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def _reload_adapter(mock: str, worker: str = "", out: Path | None = None):
    os.environ["ACE_STEP_MOCK"] = mock
    os.environ["ACE_STEP_WORKER_URL"] = worker
    if out:
        os.environ["OUTPUT_DIR"] = str(out)
    if "server" in sys.modules:
        del sys.modules["server"]
    import server as adapter

    importlib.reload(adapter)
    return adapter


def test_mock_generate_writes_stub(tmp_path: Path):
    adapter = _reload_adapter("1", "", tmp_path)
    # Drive internal mock job path
    jid = "abc12345deadbeef"
    with adapter._LOCK:
        adapter._JOBS[jid] = {"id": jid, "status": "queued", "path": None, "error": None}
    adapter._run_mock_job(jid, "test prompt", 30)
    with adapter._LOCK:
        job = adapter._JOBS[jid]
    assert job["status"] == "done"
    assert job["path"]
    assert (tmp_path / Path(job["path"]).name).is_file()


def test_non_mock_without_worker_refuses(tmp_path: Path | None = None):
    """POST /v1/generate with mock off and no worker must 503 (not silent stub)."""
    out = tmp_path or Path("/tmp/ace-step-test-out")
    out.mkdir(parents=True, exist_ok=True)
    adapter = _reload_adapter("0", "", out)
    assert adapter.MOCK is False
    assert adapter.WORKER_URL == ""

    # Drive the real HTTP generate path (Handler.do_POST), not just env flags.
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), adapter.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        body = json.dumps({"prompt": "should fail", "durationSec": 30}).encode()
        req = Request(
            f"http://127.0.0.1:{port}/v1/generate",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(req, timeout=5) as resp:
                raise AssertionError(f"expected 503, got HTTP {resp.status}")
        except Exception as e:
            # urllib raises HTTPError on 4xx/5xx
            from urllib.error import HTTPError

            assert isinstance(e, HTTPError), f"expected HTTPError, got {type(e)}: {e}"
            assert e.code == 503, f"expected 503, got {e.code}"
            payload = json.loads(e.read().decode() or "{}")
            assert "WORKER" in (payload.get("error") or "").upper() or "worker" in (
                payload.get("error") or ""
            ).lower()
            assert payload.get("mock") is False
            assert payload.get("workerConfigured") is False
        # No job should have been queued into silent-stub success
        with adapter._LOCK:
            for job in adapter._JOBS.values():
                assert job.get("status") != "done", "must not write silent stub without worker"
    finally:
        httpd.shutdown()


def test_non_mock_proxies_worker(tmp_path: Path):
    """Fake upstream worker → adapter job completes with path from worker."""

    class Upstream(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(n)
            body = json.dumps({"id": "up1", "status": "queued"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith("/v1/jobs/"):
                body = json.dumps(
                    {
                        "id": "up1",
                        "status": "done",
                        "path": "generated/ace-step/from-worker.mp3",
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    port = upstream.server_address[1]
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    try:
        adapter = _reload_adapter("0", f"http://127.0.0.1:{port}", tmp_path)
        jid = "proxyjob01"
        with adapter._LOCK:
            adapter._JOBS[jid] = {"id": jid, "status": "queued", "path": None, "error": None}
        adapter._proxy_worker_job(jid, "hello", 10)
        with adapter._LOCK:
            job = adapter._JOBS[jid]
        assert job["status"] == "done"
        assert job["path"] == "generated/ace-step/from-worker.mp3"
    finally:
        upstream.shutdown()


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        test_mock_generate_writes_stub(Path(d))
        test_non_mock_without_worker_refuses()
        test_non_mock_proxies_worker(Path(d))
    print("ace-step-adapter tests OK")
