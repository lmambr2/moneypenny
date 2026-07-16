#!/usr/bin/env python3
"""
Moneypenny TurboVec vector store — drop-in replacement for Qdrant's tiny surface
used by bot/src/rag/qdrant.ts:

  GET  /collections/{name}
  PUT  /collections/{name}                    body: { vectors: { size, distance } }
  PUT  /collections/{name}/points?wait=true   body: { points: [{ id, vector, payload }] }
  POST /collections/{name}/points/search     body: { vector, limit, with_payload, filter? }
  POST /collections/{name}/points/delete      body: { filter: { must: [...] } }
  GET  /health

Vectors live in TurboQuant IdMapIndex (.tvim). Payload + string ids live in SQLite
on the same volume so classification filters and delete-by-source still work.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import struct
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import numpy as np

try:
    from turbovec import IdMapIndex
except ImportError as e:  # pragma: no cover
    raise SystemExit(
        "turbovec is required: pip install turbovec\n" + str(e)
    ) from e

DATA_DIR = Path(os.environ.get("TURBOVEC_DATA", "/data"))
PORT = int(os.environ.get("PORT", "6333"))
BIT_WIDTH = int(os.environ.get("TURBOVEC_BIT_WIDTH", "4"))
# Cosine-style: L2-normalize vectors on upsert/search (matches Qdrant Cosine usage).
NORMALIZE = os.environ.get("TURBOVEC_NORMALIZE", "1") not in ("0", "false", "False")

_lock = threading.RLock()
_indexes: dict[str, IdMapIndex] = {}
_dims: dict[str, int] = {}
_db: sqlite3.Connection | None = None


def _db_path() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR / "payloads.sqlite"


def db() -> sqlite3.Connection:
    global _db
    if _db is None:
        _db = sqlite3.connect(str(_db_path()), check_same_thread=False)
        _db.execute("PRAGMA journal_mode=WAL")
        _db.execute(
            """
            CREATE TABLE IF NOT EXISTS points (
              collection TEXT NOT NULL,
              id_str TEXT NOT NULL,
              id_u64 INTEGER NOT NULL,
              payload TEXT NOT NULL,
              PRIMARY KEY (collection, id_str)
            )
            """
        )
        _db.execute(
            "CREATE INDEX IF NOT EXISTS idx_points_src ON points(collection, json_extract(payload, '$.source'))"
        )
        _db.execute(
            """
            CREATE TABLE IF NOT EXISTS collections (
              name TEXT PRIMARY KEY,
              dim INTEGER NOT NULL
            )
            """
        )
        _db.commit()
    return _db


def str_to_u64(s: str) -> int:
    # Stable 64-bit id for string point keys (chunk ids).
    h = hashlib.blake2b(s.encode("utf-8"), digest_size=8).digest()
    return struct.unpack("<Q", h)[0]


def u64_to_sqlite(u: int) -> int:
    """SQLite INTEGER is signed int64 — store full uint64 as two's complement."""
    u = int(u) & 0xFFFFFFFFFFFFFFFF
    if u >= 0x8000000000000000:
        return u - 0x10000000000000000
    return u


def sqlite_to_u64(i: int) -> int:
    """Restore unsigned id used by TurboVec IdMapIndex."""
    i = int(i)
    if i < 0:
        return i + 0x10000000000000000
    return i


def pad_dim(dim: int) -> int:
    """TurboVec requires dim % 8 == 0 and dim >= 8."""
    if dim < 8:
        return 8
    rem = dim % 8
    return dim if rem == 0 else dim + (8 - rem)


def normalize_vec(v: list[float] | np.ndarray) -> np.ndarray:
    arr = np.asarray(v, dtype=np.float32).reshape(-1)
    if NORMALIZE:
        n = float(np.linalg.norm(arr))
        if n > 1e-12:
            arr = arr / n
    return arr


def fit_vector(v: list[float], dim: int) -> np.ndarray:
    """Pad/truncate to collection dim (multiple of 8)."""
    arr = normalize_vec(v)
    if arr.shape[0] == dim:
        return arr
    out = np.zeros(dim, dtype=np.float32)
    n = min(dim, arr.shape[0])
    out[:n] = arr[:n]
    if NORMALIZE:
        nn = float(np.linalg.norm(out))
        if nn > 1e-12:
            out = out / nn
    return out


def index_path(name: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
    return DATA_DIR / f"{safe}.tvim"


def load_or_create_index(name: str, dim: int) -> IdMapIndex:
    path = index_path(name)
    if name in _indexes:
        return _indexes[name]
    if path.exists():
        idx = IdMapIndex.load(str(path))
        _indexes[name] = idx
        _dims[name] = int(idx.dim) if idx.dim else dim
        return idx
    # Fresh index — dim must be multiple of 8
    d = pad_dim(dim)
    idx = IdMapIndex(dim=d, bit_width=BIT_WIDTH)
    _indexes[name] = idx
    _dims[name] = d
    return idx


def persist_index(name: str) -> None:
    idx = _indexes.get(name)
    if idx is None:
        return
    path = index_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    idx.write(str(path))


def ensure_collection(name: str, dim: int) -> dict[str, Any]:
    d = pad_dim(int(dim))
    conn = db()
    row = conn.execute("SELECT dim FROM collections WHERE name = ?", (name,)).fetchone()
    if row:
        existing = int(row[0])
        if existing != d:
            return {
                "status": "ok",
                "result": {"config": {"params": {"vectors": {"size": existing}}}},
                "warn": "dim mismatch",
            }
        load_or_create_index(name, existing)
        return {"status": "ok", "result": {"config": {"params": {"vectors": {"size": existing}}}}
        }
    conn.execute(
        "INSERT OR REPLACE INTO collections(name, dim) VALUES (?, ?)", (name, d)
    )
    conn.commit()
    load_or_create_index(name, d)
    persist_index(name)
    return {"status": "ok", "result": {"config": {"params": {"vectors": {"size": d}}}}
    }


def get_collection(name: str) -> dict[str, Any] | None:
    conn = db()
    row = conn.execute("SELECT dim FROM collections WHERE name = ?", (name,)).fetchone()
    if not row:
        return None
    dim = int(row[0])
    load_or_create_index(name, dim)
    return {"result": {"config": {"params": {"vectors": {"size": dim}}}}}


def upsert_points(name: str, points: list[dict[str, Any]]) -> None:
    info = get_collection(name)
    if not info:
        # Infer dim from first vector
        if not points or not points[0].get("vector"):
            raise ValueError("collection missing and no points to infer dim")
        ensure_collection(name, len(points[0]["vector"]))
    dim = _dims.get(name) or int(
        db().execute("SELECT dim FROM collections WHERE name = ?", (name,)).fetchone()[0]
    )
    idx = load_or_create_index(name, dim)
    conn = db()

    vectors: list[np.ndarray] = []
    ids: list[int] = []
    for p in points:
        id_str = str(p["id"])
        uid = str_to_u64(id_str)
        vec = fit_vector(p["vector"], dim)
        payload = p.get("payload") or {}
        # Remove existing id if re-upsert
        if uid in idx:
            idx.remove(uid)
        vectors.append(vec)
        ids.append(uid)
        conn.execute(
            """
            INSERT INTO points(collection, id_str, id_u64, payload)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(collection, id_str) DO UPDATE SET
              id_u64 = excluded.id_u64,
              payload = excluded.payload
            """,
            (name, id_str, u64_to_sqlite(uid), json.dumps(payload)),
        )

    if vectors:
        mat = np.stack(vectors, axis=0)
        id_arr = np.array(ids, dtype=np.uint64)
        idx.add_with_ids(mat, id_arr)

    conn.commit()
    persist_index(name)


def parse_filter_allowlist(name: str, filt: Any) -> np.ndarray | None:
    """Turn Qdrant-style filter into uint64 allowlist, or None = no filter."""
    if not filt:
        return None
    must = filt.get("must") if isinstance(filt, dict) else None
    if not must:
        return None

    conn = db()
    # Start with all ids; intersect constraints
    rows = conn.execute(
        "SELECT id_str, id_u64, payload FROM points WHERE collection = ?", (name,)
    ).fetchall()
    if not rows:
        return np.array([], dtype=np.uint64)

    allowed: set[int] | None = None
    for clause in must:
        if not isinstance(clause, dict):
            continue
        key = clause.get("key")
        match = clause.get("match") or {}
        keep: set[int] = set()
        if "value" in match:
            want = match["value"]
            for id_str, id_u64, payload_s in rows:
                try:
                    pl = json.loads(payload_s)
                except Exception:
                    pl = {}
                if pl.get(key) == want or str(pl.get(key)) == str(want):
                    keep.add(sqlite_to_u64(id_u64))
        elif "any" in match:
            any_vals = {str(x) for x in (match["any"] or [])}
            for id_str, id_u64, payload_s in rows:
                try:
                    pl = json.loads(payload_s)
                except Exception:
                    pl = {}
                if str(pl.get(key, "")) in any_vals:
                    keep.add(sqlite_to_u64(id_u64))
        else:
            continue
        allowed = keep if allowed is None else (allowed & keep)

    if allowed is None:
        return None
    if not allowed:
        return np.array([], dtype=np.uint64)
    return np.array(sorted(allowed), dtype=np.uint64)


def search_points(
    name: str, vector: list[float], limit: int, filt: Any = None
) -> list[dict[str, Any]]:
    info = get_collection(name)
    if not info:
        return []
    dim = _dims[name]
    idx = load_or_create_index(name, dim)
    if len(idx) == 0:
        return []

    q = fit_vector(vector, dim).reshape(1, -1)
    allow = parse_filter_allowlist(name, filt)
    k = max(1, int(limit))

    if allow is not None:
        if allow.size == 0:
            return []
        # Only ids that exist in the index
        present = [int(i) for i in allow.tolist() if int(i) in idx]
        if not present:
            return []
        allow_arr = np.array(present, dtype=np.uint64)
        k_eff = min(k, len(present))
        scores, ids = idx.search(q, k_eff, allowlist=allow_arr)
    else:
        k_eff = min(k, len(idx))
        scores, ids = idx.search(q, k_eff)

    # scores/ids shape (1, k)
    sc = np.asarray(scores).reshape(-1)
    id_row = np.asarray(ids).reshape(-1)
    conn = db()
    out: list[dict[str, Any]] = []
    for i in range(sc.shape[0]):
        # TurboVec returns uint64 ids; SQLite stores the same bits as signed int64.
        uid = int(id_row[i]) & 0xFFFFFFFFFFFFFFFF
        row = conn.execute(
            "SELECT id_str, payload FROM points WHERE collection = ? AND id_u64 = ?",
            (name, u64_to_sqlite(uid)),
        ).fetchone()
        if not row:
            continue
        id_str, payload_s = row
        try:
            payload = json.loads(payload_s)
        except Exception:
            payload = {}
        out.append({"id": id_str, "score": float(sc[i]), "payload": payload})
    return out


def delete_by_filter(name: str, filt: Any) -> int:
    info = get_collection(name)
    if not info:
        return 0
    dim = _dims[name]
    idx = load_or_create_index(name, dim)
    conn = db()

    # Support Qdrant-style: { must: [{ key: "source", match: { value: "..." } }] }
    source = None
    if isinstance(filt, dict):
        for clause in filt.get("must") or []:
            if (
                isinstance(clause, dict)
                and clause.get("key") == "source"
                and isinstance(clause.get("match"), dict)
                and "value" in clause["match"]
            ):
                source = clause["match"]["value"]
                break

    if source is None:
        # Nuclear: delete nothing if we don't understand the filter
        return 0

    rows = conn.execute(
        "SELECT id_str, id_u64 FROM points WHERE collection = ? AND json_extract(payload, '$.source') = ?",
        (name, source),
    ).fetchall()
    n = 0
    for id_str, id_u64 in rows:
        uid = sqlite_to_u64(id_u64)
        if uid in idx:
            idx.remove(uid)
        conn.execute(
            "DELETE FROM points WHERE collection = ? AND id_str = ?", (name, id_str)
        )
        n += 1
    conn.commit()
    persist_index(name)
    return n


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: Any) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Any:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        return json.loads(raw.decode() or "{}")

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[turbovec] {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self) -> None:
        u = urlparse(self.path)
        if u.path in ("/health", "/"):
            self._json(200, {"ok": True, "engine": "turbovec", "bit_width": BIT_WIDTH})
            return
        # GET /collections/{name}
        parts = [p for p in u.path.split("/") if p]
        if len(parts) == 2 and parts[0] == "collections":
            with _lock:
                info = get_collection(parts[1])
            if not info:
                self._json(404, {"status": {"error": "Not found"}})
                return
            self._json(200, info)
            return
        self._json(404, {"error": "not found"})

    def do_PUT(self) -> None:
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        try:
            body = self._read_json()
        except Exception as e:
            self._json(400, {"error": str(e)})
            return

        # PUT /collections/{name}
        if len(parts) == 2 and parts[0] == "collections":
            name = parts[1]
            size = (
                body.get("vectors", {}).get("size")
                if isinstance(body.get("vectors"), dict)
                else body.get("size")
            )
            if not size:
                self._json(400, {"error": "vectors.size required"})
                return
            with _lock:
                out = ensure_collection(name, int(size))
            self._json(200, out)
            return

        # PUT /collections/{name}/points
        if len(parts) == 3 and parts[0] == "collections" and parts[2] == "points":
            name = parts[1]
            points = body.get("points") or []
            try:
                with _lock:
                    upsert_points(name, points)
                self._json(200, {"status": "ok", "result": {"status": "completed"}})
            except Exception as e:
                traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        try:
            body = self._read_json()
        except Exception as e:
            self._json(400, {"error": str(e)})
            return

        # POST /collections/{name}/points/search
        if (
            len(parts) == 4
            and parts[0] == "collections"
            and parts[2] == "points"
            and parts[3] == "search"
        ):
            name = parts[1]
            vector = body.get("vector") or []
            limit = int(body.get("limit") or 10)
            filt = body.get("filter")
            try:
                with _lock:
                    hits = search_points(name, vector, limit, filt)
                self._json(200, {"result": hits})
            except Exception as e:
                traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        # POST /collections/{name}/points/delete
        if (
            len(parts) == 4
            and parts[0] == "collections"
            and parts[2] == "points"
            and parts[3] == "delete"
        ):
            name = parts[1]
            filt = body.get("filter")
            try:
                with _lock:
                    n = delete_by_filter(name, filt)
                self._json(200, {"result": {"status": "completed", "deleted": n}})
            except Exception as e:
                traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        self._json(404, {"error": "not found"})


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db()  # init schema
    # Preload collections
    for row in db().execute("SELECT name, dim FROM collections").fetchall():
        try:
            load_or_create_index(row[0], int(row[1]))
            print(f"[turbovec] loaded collection {row[0]} dim={row[1]}", flush=True)
        except Exception as e:
            print(f"[turbovec] failed to load {row[0]}: {e}", flush=True)
    print(
        f"[turbovec] serving on :{PORT} data={DATA_DIR} bit_width={BIT_WIDTH}",
        flush=True,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
