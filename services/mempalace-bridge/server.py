#!/usr/bin/env python3
"""
Moneypenny MemPalace bridge — HTTP API over the MemPalace Python library.

Per-user facts live in wing ``moneypenny`` / room ``<sanitized-ts-uid>``.
The bot uses this for semantic recall in ``!ask`` and durable memory across
SQLite resets (Phase 7 ROADMAP).

  GET  /health
  POST /v1/remember   { "userId": "...", "fact": "..." }
  GET  /v1/recall     ?userId=...&limit=15
  POST /v1/search     { "userId": "...", "query": "...", "limit": 5 }
  POST /v1/forget     { "userId": "...", "index": 1 } | { "userId": "...", "all": true }
  POST /v1/kg/remember { "fact": "...", "subject": "...", "validFrom": "...", "validUntil": "...", "diary": "intel|logistics" }
  POST /v1/kg/search   { "query": "...", "asOf": "YYYY-MM-DD", "limit": 8 }
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", "8090"))
PALACE_PATH = os.environ.get("MEMPALACE_PALACE_PATH", "/data/palace")
WING = os.environ.get("MEMPALACE_WING", "moneypenny")
KG_ROOM = os.environ.get("MEMPALACE_KG_ROOM", "org_kg")
_init_lock = threading.Lock()
_ready = False


def _json_response(handler: BaseHTTPRequestHandler, status: int, body: dict) -> None:
    data = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def _read_json(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def _room_for_user(user_id: str) -> str:
    """Map a TeamSpeak uid (may contain /+=) to a stable MemPalace room name."""
    from mempalace.config import sanitize_name

    raw = user_id.strip() or "anonymous"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return sanitize_name(f"ts_{digest}", "room")


def _ensure_palace() -> None:
    global _ready
    if _ready:
        return
    with _init_lock:
        if _ready:
            return
        os.makedirs(PALACE_PATH, exist_ok=True)
        os.environ["MEMPALACE_PALACE_PATH"] = os.path.abspath(PALACE_PATH)
        from mempalace.palace import get_collection

        get_collection(PALACE_PATH, create=True)
        _ready = True
        print(f"[mempalace-bridge] palace ready at {PALACE_PATH}", flush=True)


def _add_fact(user_id: str, fact: str) -> dict:
    from mempalace.config import sanitize_content
    from mempalace.ids import make_drawer_id_from_content
    from mempalace.palace import get_collection

    _ensure_palace()
    room = _room_for_user(user_id)
    content = sanitize_content(fact.strip())
    if not content:
        return {"ok": False, "error": "empty fact"}

    col = get_collection(PALACE_PATH, create=True)
    drawer_id = make_drawer_id_from_content(WING, room, content)
    meta = {
        "wing": WING,
        "room": room,
        "source_file": f"remember:{user_id}",
        "added_by": "moneypenny",
        "filed_at": datetime.now(timezone.utc).isoformat(),
        "chunk_index": 0,
    }

    try:
        existing = col.get(ids=[drawer_id], include=[])
        ids = getattr(existing, "ids", None) or (existing.get("ids") if isinstance(existing, dict) else None)
        if ids:
            return {"ok": True, "drawerId": drawer_id, "duplicate": True}
    except Exception:
        pass

    col.upsert(ids=[drawer_id], documents=[content], metadatas=[meta])
    return {"ok": True, "drawerId": drawer_id}


def _list_facts(user_id: str, limit: int = 15) -> list[dict]:
    from mempalace.palace import get_collection
    from mempalace.searcher import build_where_filter

    _ensure_palace()
    room = _room_for_user(user_id)
    col = get_collection(PALACE_PATH, create=False)
    where = build_where_filter(WING, room)
    try:
        result = col.get(where=where, include=["documents", "metadatas"])
    except Exception as exc:
        return []

    docs = getattr(result, "documents", None) or (result.get("documents") if isinstance(result, dict) else []) or []
    metas = getattr(result, "metadatas", None) or (result.get("metadatas") if isinstance(result, dict) else []) or []
    ids = getattr(result, "ids", None) or (result.get("ids") if isinstance(result, dict) else []) or []

    rows: list[dict] = []
    for drawer_id, doc, meta in zip(ids, docs, metas):
        if not doc:
            continue
        meta = meta or {}
        rows.append(
            {
                "drawerId": drawer_id,
                "fact": doc.strip(),
                "filedAt": meta.get("filed_at", ""),
            }
        )

    rows.sort(key=lambda r: r.get("filedAt") or "", reverse=True)
    return rows[: max(1, min(limit, 50))]


def _search_facts(user_id: str, query: str, limit: int = 5) -> list[dict]:
    from mempalace.searcher import search_memories

    _ensure_palace()
    room = _room_for_user(user_id)
    out = search_memories(
        query=query.strip() or "user preferences and facts",
        palace_path=PALACE_PATH,
        wing=WING,
        room=room,
        n_results=max(1, min(limit, 20)),
    )
    if out.get("error"):
        return []

    hits = []
    for hit in out.get("results") or []:
        text = (hit.get("text") or "").strip()
        if not text:
            continue
        hits.append(
            {
                "fact": text,
                "drawerId": hit.get("metadata", {}).get("id") or hit.get("drawer_id"),
                "score": hit.get("bm25_score"),
            }
        )
    return hits


def _kg_room(diary: str | None = None) -> str:
    from mempalace.config import sanitize_name

    if diary in ("intel", "logistics"):
        return sanitize_name(f"diary_{diary}", "room")
    return sanitize_name(KG_ROOM, "room")


def _parse_kg_tags(text: str) -> dict:
    import re

    out: dict = {"fact": text.strip()}
    for key, pat in (
        ("subject", r"@subject:([^|]+)"),
        ("validFrom", r"@from:(\d{4}-\d{2}-\d{2})"),
        ("validUntil", r"@until:(\d{4}-\d{2}-\d{2})"),
        ("diary", r"@diary:(intel|logistics)"),
    ):
        m = re.search(pat, text, re.I)
        if m:
            out[key] = m.group(1).strip()
    if " | " in text:
        out["fact"] = text.split(" | ", 1)[1].strip()
    return out


def _kg_active_at(valid_from: str | None, valid_until: str | None, as_of: str) -> bool:
    if not as_of or len(as_of) < 10:
        return True
    try:
        y, m, d = int(as_of[0:4]), int(as_of[5:7]), int(as_of[8:10])
        ref = datetime(y, m, d, 12, 0, 0, tzinfo=timezone.utc)
    except ValueError:
        return True
    if valid_from:
        try:
            fy, fm, fd = int(valid_from[0:4]), int(valid_from[5:7]), int(valid_from[8:10])
            if ref < datetime(fy, fm, fd, tzinfo=timezone.utc):
                return False
        except ValueError:
            pass
    if valid_until:
        try:
            uy, um, ud = int(valid_until[0:4]), int(valid_until[5:7]), int(valid_until[8:10])
            if ref > datetime(uy, um, ud, 23, 59, 59, tzinfo=timezone.utc):
                return False
        except ValueError:
            pass
    return True


def _add_kg_fact(
    fact: str,
    subject: str | None = None,
    valid_from: str | None = None,
    valid_until: str | None = None,
    diary: str | None = None,
) -> dict:
    from mempalace.config import sanitize_content
    from mempalace.ids import make_drawer_id_from_content
    from mempalace.palace import get_collection

    _ensure_palace()
    room = _kg_room(diary)
    content = sanitize_content(fact.strip())
    if not content:
        return {"ok": False, "error": "empty fact"}

    col = get_collection(PALACE_PATH, create=True)
    drawer_id = make_drawer_id_from_content(WING, room, content)
    meta = {
        "wing": WING,
        "room": room,
        "source_file": "kg:moneypenny",
        "added_by": "moneypenny",
        "filed_at": datetime.now(timezone.utc).isoformat(),
        "chunk_index": 0,
        "subject": subject or "",
        "valid_from": valid_from or "",
        "valid_until": valid_until or "",
        "diary": diary or "",
    }

    try:
        existing = col.get(ids=[drawer_id], include=[])
        ids = getattr(existing, "ids", None) or (existing.get("ids") if isinstance(existing, dict) else None)
        if ids:
            return {"ok": True, "drawerId": drawer_id, "duplicate": True}
    except Exception:
        pass

    col.upsert(ids=[drawer_id], documents=[content], metadatas=[meta])
    return {"ok": True, "drawerId": drawer_id}


def _search_kg(query: str, as_of: str | None = None, limit: int = 8) -> list[dict]:
    from mempalace.searcher import search_memories

    _ensure_palace()
    ref = (as_of or "").strip() or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    hits: list[dict] = []
    for diary in (None, "intel", "logistics"):
        room = _kg_room(diary)
        out = search_memories(
            query=query.strip() or "organization roles and operations",
            palace_path=PALACE_PATH,
            wing=WING,
            room=room,
            n_results=max(1, min(limit * 2, 20)),
        )
        if out.get("error"):
            continue
        for hit in out.get("results") or []:
            text = (hit.get("text") or "").strip()
            if not text:
                continue
            tags = _parse_kg_tags(text)
            if not _kg_active_at(tags.get("validFrom"), tags.get("validUntil"), ref):
                continue
            hits.append(
                {
                    "fact": tags.get("fact") or text,
                    "drawerId": hit.get("metadata", {}).get("id") or hit.get("drawer_id"),
                    "score": hit.get("bm25_score"),
                    "diary": tags.get("diary") or diary,
                    "subject": tags.get("subject"),
                }
            )
    hits.sort(key=lambda h: h.get("score") or 0, reverse=True)
    return hits[: max(1, min(limit, 20))]


def _forget_fact(user_id: str, index: int | None = None, forget_all: bool = False) -> dict:
    from mempalace.palace import get_collection

    _ensure_palace()
    facts = _list_facts(user_id, limit=100)
    if not facts:
        return {"ok": True, "removed": 0}

    col = get_collection(PALACE_PATH, create=False)
    if forget_all:
        ids = [f["drawerId"] for f in facts if f.get("drawerId")]
        if ids:
            col.delete(ids=ids)
        return {"ok": True, "removed": len(ids)}

    if index is None or index < 1 or index > len(facts):
        return {"ok": False, "error": "invalid index"}
    drawer_id = facts[index - 1].get("drawerId")
    if not drawer_id:
        return {"ok": False, "error": "drawer not found"}
    col.delete(ids=[drawer_id])
    return {"ok": True, "removed": 1}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[mempalace-bridge] {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/health":
            try:
                _ensure_palace()
                _json_response(self, 200, {"ok": True, "palace": PALACE_PATH, "wing": WING})
            except Exception as exc:
                _json_response(self, 503, {"ok": False, "error": str(exc)})
            return

        if parsed.path.rstrip("/") == "/v1/recall":
            qs = parse_qs(parsed.query)
            user_id = (qs.get("userId") or [""])[0].strip()
            if not user_id:
                _json_response(self, 400, {"ok": False, "error": "userId required"})
                return
            try:
                limit = int((qs.get("limit") or ["15"])[0])
            except ValueError:
                limit = 15
            try:
                facts = _list_facts(user_id, limit)
                _json_response(self, 200, {"ok": True, "facts": facts})
            except Exception as exc:
                _json_response(self, 500, {"ok": False, "error": str(exc)})
            return

        _json_response(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            body = _read_json(self)
        except json.JSONDecodeError:
            _json_response(self, 400, {"ok": False, "error": "invalid JSON"})
            return

        if parsed.path.rstrip("/") == "/v1/remember":
            user_id = str(body.get("userId", "")).strip()
            fact = str(body.get("fact", "")).strip()
            if not user_id or not fact:
                _json_response(self, 400, {"ok": False, "error": "userId and fact required"})
                return
            try:
                out = _add_fact(user_id, fact)
                _json_response(self, 200 if out.get("ok") else 400, out)
            except Exception as exc:
                _json_response(self, 500, {"ok": False, "error": str(exc)})
            return

        if parsed.path.rstrip("/") == "/v1/search":
            user_id = str(body.get("userId", "")).strip()
            query = str(body.get("query", "")).strip()
            if not user_id:
                _json_response(self, 400, {"ok": False, "error": "userId required"})
                return
            try:
                limit = int(body.get("limit", 5))
            except (TypeError, ValueError):
                limit = 5
            try:
                hits = _search_facts(user_id, query, limit)
                _json_response(self, 200, {"ok": True, "results": hits})
            except Exception as exc:
                _json_response(self, 500, {"ok": False, "error": str(exc)})
            return

        if parsed.path.rstrip("/") == "/v1/kg/remember":
            fact = str(body.get("fact", "")).strip()
            if not fact:
                _json_response(self, 400, {"ok": False, "error": "fact required"})
                return
            try:
                out = _add_kg_fact(
                    fact,
                    subject=str(body.get("subject", "")).strip() or None,
                    valid_from=str(body.get("validFrom", "")).strip() or None,
                    valid_until=str(body.get("validUntil", "")).strip() or None,
                    diary=str(body.get("diary", "")).strip() or None,
                )
                _json_response(self, 200 if out.get("ok") else 400, out)
            except Exception as exc:
                _json_response(self, 500, {"ok": False, "error": str(exc)})
            return

        if parsed.path.rstrip("/") == "/v1/kg/search":
            query = str(body.get("query", "")).strip()
            as_of = str(body.get("asOf", "")).strip() or None
            try:
                limit = int(body.get("limit", 8))
            except (TypeError, ValueError):
                limit = 8
            try:
                hits = _search_kg(query, as_of, limit)
                _json_response(self, 200, {"ok": True, "results": hits})
            except Exception as exc:
                _json_response(self, 500, {"ok": False, "error": str(exc)})
            return

        if parsed.path.rstrip("/") == "/v1/forget":
            user_id = str(body.get("userId", "")).strip()
            if not user_id:
                _json_response(self, 400, {"ok": False, "error": "userId required"})
                return
            forget_all = bool(body.get("all"))
            index = body.get("index")
            try:
                idx = int(index) if index is not None else None
            except (TypeError, ValueError):
                idx = None
            try:
                out = _forget_fact(user_id, index=idx, forget_all=forget_all)
                _json_response(self, 200 if out.get("ok") else 400, out)
            except Exception as exc:
                _json_response(self, 500, {"ok": False, "error": str(exc)})
            return

        _json_response(self, 404, {"ok": False, "error": "not found"})


def main() -> None:
    print(f"[mempalace-bridge] starting on :{PORT} palace={PALACE_PATH}", flush=True)
    threading.Thread(target=_ensure_palace, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()