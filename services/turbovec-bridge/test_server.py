"""
Unit + integration tests for turbovec-bridge (services/turbovec-bridge/server.py).

Run from this directory (venv with turbovec recommended for round-trip):

  python3 -m venv .venv && .venv/bin/pip install 'turbovec>=0.8.0,<0.9' numpy pytest
  .venv/bin/python -m pytest -q test_server.py

Pure helpers (u64↔SQLite, pad_dim, normalize) run without TurboVec.
ANN round-trip tests skip cleanly if `turbovec` is not installed.
"""
from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

import numpy as np
import pytest

import server as tv

try:
    from turbovec import IdMapIndex  # noqa: F401

    HAS_TURBOVEC = True
except ImportError:
    HAS_TURBOVEC = False


# ─── Pure helpers (no TurboVec required) ─────────────────────────────────────


class TestU64Sqlite:
    def test_roundtrip_low_and_high_bit(self):
        samples = [
            0,
            1,
            2**63 - 1,
            2**63,  # high bit set — previously broke SQLite INTEGER
            2**64 - 1,
            0xDEADBEEFCAFEBABE,
        ]
        for u in samples:
            signed = tv.u64_to_sqlite(u)
            assert -(2**63) <= signed <= 2**63 - 1, u
            assert tv.sqlite_to_u64(signed) == (u & 0xFFFFFFFFFFFFFFFF)

    def test_sqlite_accepts_high_bit_via_mapping(self):
        """Prove raw u64 fails SQLite and mapped signed form succeeds."""
        u = 2**63 + 12345
        with tempfile.TemporaryDirectory() as td:
            db = sqlite3.connect(str(Path(td) / "t.sqlite"))
            db.execute("CREATE TABLE t (id INTEGER)")
            with pytest.raises(OverflowError):
                db.execute("INSERT INTO t(id) VALUES (?)", (u,))
            signed = tv.u64_to_sqlite(u)
            db.execute("INSERT INTO t(id) VALUES (?)", (signed,))
            got = db.execute("SELECT id FROM t").fetchone()[0]
            assert tv.sqlite_to_u64(got) == u
            db.close()

    def test_str_to_u64_stable(self):
        a = tv.str_to_u64("0533a324-23fa-3592-74aa-fe71faaf8888")
        b = tv.str_to_u64("0533a324-23fa-3592-74aa-fe71faaf8888")
        assert a == b
        assert 0 <= a < 2**64
        # Different strings almost always different ids
        assert tv.str_to_u64("other") != a


class TestPadNormalize:
    def test_pad_dim(self):
        assert tv.pad_dim(1) == 8
        assert tv.pad_dim(8) == 8
        assert tv.pad_dim(768) == 768
        assert tv.pad_dim(769) == 776

    def test_normalize_unit(self):
        v = tv.normalize_vec([3.0, 4.0])
        assert abs(float(np.linalg.norm(v)) - 1.0) < 1e-5

    def test_fit_vector_pad_and_trunc(self):
        short = tv.fit_vector([1.0, 0.0], 8)
        assert short.shape == (8,)
        assert abs(float(np.linalg.norm(short)) - 1.0) < 1e-5
        long = tv.fit_vector([1.0] * 16, 8)
        assert long.shape == (8,)


# ─── Integration (TurboVec required) ─────────────────────────────────────────


@pytest.fixture
def data_dir(tmp_path: Path):
    tv.configure_data_dir(tmp_path)
    yield tmp_path
    # Reset so later tests don't share state accidentally
    tv.configure_data_dir(tmp_path / "_done")


@pytest.mark.skipif(not HAS_TURBOVEC, reason="turbovec not installed")
class TestRoundTrip:
    def test_high_bit_id_upsert_search_delete(self, data_dir: Path):
        """
        Real path that failed on Pi: blake2b→u64 with high bit + SQLite insert.
        Uses a string id known to hash into the high half when possible, and
        also forces storage path via u64_to_sqlite under upsert_points.
        """
        dim = 8
        name = "moneypenny_docs"
        tv.ensure_collection(name, dim)

        # String id from production log that triggered the bug path
        id_hi = "0533a324-23fa-3592-74aa-fe71faaf8888"
        uid = tv.str_to_u64(id_hi)
        # Even if this particular hash is low-bit, insert a second synthetic
        # point path by using many random-looking ids until one has high bit.
        id_force = id_hi
        for i in range(200):
            cand = f"chunk-{i}-highbit-probe"
            if tv.str_to_u64(cand) >= 2**63:
                id_force = cand
                break

        vec_a = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        vec_b = [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]

        tv.upsert_points(
            name,
            [
                {
                    "id": id_force,
                    "vector": vec_a,
                    "payload": {"source": "TRAINING.md", "text": "alpha", "classification": "secret"},
                },
                {
                    "id": "other-source-id",
                    "vector": vec_b,
                    "payload": {"source": "other.md", "text": "beta"},
                },
            ],
        )

        # SQLite must hold signed form for high-bit ids
        if tv.str_to_u64(id_force) >= 2**63:
            row = tv.db().execute(
                "SELECT id_u64 FROM points WHERE collection=? AND id_str=?",
                (name, id_force),
            ).fetchone()
            assert row is not None
            assert row[0] < 0  # signed negative for high bit

        hits = tv.search_points(name, vec_a, limit=5)
        assert any(h["id"] == id_force for h in hits), hits
        hit = next(h for h in hits if h["id"] == id_force)
        assert hit["payload"]["source"] == "TRAINING.md"

        # Filter by classification
        filt = {"must": [{"key": "classification", "match": {"value": "secret"}}]}
        fhits = tv.search_points(name, vec_a, limit=5, filt=filt)
        assert all(h["payload"].get("classification") == "secret" for h in fhits)
        assert any(h["id"] == id_force for h in fhits)

        # Delete-by-source (bot re-ingest path)
        n = tv.delete_by_filter(
            name,
            {"must": [{"key": "source", "match": {"value": "TRAINING.md"}}]},
        )
        assert n >= 1
        after = tv.search_points(name, vec_a, limit=5)
        assert not any(h["id"] == id_force for h in after)
        # Other source remains
        other = tv.search_points(name, vec_b, limit=5)
        assert any(h["id"] == "other-source-id" for h in other)

        # raw high u64 must not be insertable without mapping (regression guard)
        assert tv.u64_to_sqlite(2**63) == -(2**63)

    def test_empty_and_missing_collection_safe(self, data_dir: Path):
        assert tv.search_points("no_such_collection", [1.0] * 8, 3) == []
        assert tv.delete_by_filter(
            "no_such_collection",
            {"must": [{"key": "source", "match": {"value": "x.md"}}]},
        ) == 0

        tv.ensure_collection("empty_col", 8)
        assert tv.search_points("empty_col", [1.0] * 8, 3) == []
        assert tv.search_points("empty_col", [], 3) == []  # empty query vector
        assert (
            tv.delete_by_filter(
                "empty_col",
                {"must": [{"key": "source", "match": {"value": "missing.md"}}]},
            )
            == 0
        )

    def test_health_shape_constants(self):
        # Module-level engine identity used by /health handler
        assert tv.BIT_WIDTH in (2, 3, 4)
