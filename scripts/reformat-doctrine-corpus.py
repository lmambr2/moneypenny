#!/usr/bin/env python3
"""
Reformat doctrine Markdown for RAG + humans.

Aligned with bot/src/rag/chunk.ts (heading-first sections, then size cap):

  - Normalize YAML frontmatter (classification / tags / valid_until)
  - Promote *real* section titles → ## headings
  - Roman-numeral chapters (I. Title) → ## Title
  - Numbered SOP titles (1. PURPOSE) → ## Purpose
  - ALL-CAPS banners → ## Title Case
  - Bullet-ize clear "Label: body" training lines
  - Do NOT promote short list items, manning lines, or classification stamps

Usage:
  python3 scripts/reformat-doctrine-corpus.py /path/to/bot/data/doctrine
  python3 scripts/reformat-doctrine-corpus.py /path/to/doctrine --dry-run
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

FM_RE = re.compile(r"^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?", re.M)
META_KEY_RE = re.compile(
    r"^(classification|tags|valid_until|validuntil)\s*:\s*(.*)$", re.I
)
ROMAN_RE = re.compile(
    r"^((?:X{0,3})(?:IX|IV|V?I{0,3}))\.\s+([A-Z].{3,80})$"
)
NUM_TITLE_RE = re.compile(
    r"^(\d{1,2})\.\s+([A-Z][A-Za-z0-9 /&\-']{2,60})$"
)

# Operator product docs already structured — leave alone.
SKIP_SUFFIXES = (
    "ops/rag-ingestion-cheatsheet.md",
    "ops-rank-gating.md",
)

# Never promote these (stamps, list fragments, etc.)
DENY_HEADING = re.compile(
    r"(?i)^("
    r"cui\b|noforn\b|top secret|secret|restricted|unclassified|"
    r"end of statement|approved for public release|"
    r"\d+x\s|"  # 1x Polaris…
    r"standard manning|reduced manning|"
    r"command ship|heavy strike|operational anchor|"
    r"escort support|shield pressure|"
    r"screening|interception|reconnaissance|rapid response|"
    r"effective:|"
    r"distance control|speed management|smart boost management|"  # list pillars mid-prose
    r".*crew$|.*gunners?$|.*fighters?$"
    r")$"
)


def parse_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    text = raw.lstrip("\ufeff")
    m = FM_RE.match(text)
    if m:
        fields: dict[str, str] = {}
        for line in m.group(1).splitlines():
            km = META_KEY_RE.match(line.strip())
            if km:
                key = km.group(1).lower().replace("validuntil", "valid_until")
                fields[key] = km.group(2).strip()
        return fields, text[m.end() :]

    lines = text.splitlines()
    fields = {}
    i = 0
    while i < len(lines):
        t = lines[i].strip()
        if not t:
            i += 1
            continue
        if t.startswith("#"):
            break
        km = META_KEY_RE.match(t)
        if not km:
            break
        key = km.group(1).lower().replace("validuntil", "valid_until")
        fields[key] = km.group(2).strip()
        i += 1
    while i < len(lines) and not lines[i].strip():
        i += 1
    return fields, "\n".join(lines[i:])


def format_frontmatter(fields: dict[str, str]) -> str:
    classification = re.sub(
        r"\s+", "", (fields.get("classification") or "unclassified").strip().lower()
    ) or "unclassified"
    tags = fields.get("tags", "").strip()
    valid = fields.get("valid_until", "").strip()
    lines = ["---", f"classification: {classification}"]
    if tags:
        lines.append(f"tags: {tags}")
    if valid:
        lines.append(f"valid_until: {valid}")
    lines += ["---", ""]
    return "\n".join(lines)


def title_case_banner(s: str) -> str:
    small = {"a", "an", "the", "and", "or", "of", "to", "in", "for", "on", "with", "vs", "the"}
    words = s.strip().split()
    out = []
    for i, w in enumerate(words):
        # Keep acronyms / codes
        if re.fullmatch(r"[A-Z0-9]{2,}(?:/[A-Z0-9]+)*", w):
            out.append(w)
            continue
        low = w.lower()
        if i > 0 and low in small:
            out.append(low)
        elif w.isupper() and len(w) > 1:
            out.append(w[:1] + w[1:].lower())
        else:
            out.append(w)
    return " ".join(out)


def is_all_caps_banner(t: str) -> bool:
    letters = [c for c in t if c.isalpha()]
    if len(letters) < 4:
        return False
    return sum(1 for c in letters if c.isupper()) / len(letters) > 0.9


def looks_like_heading(line: str, prev: str, nxt: str | None) -> bool:
    t = line.strip()
    if not t or t.startswith("#") or t.startswith("---"):
        return False
    if t.startswith(("-", "*", ">", "|", "(")):
        return False
    if len(t) > 85 or len(t) < 3:
        return False
    if DENY_HEADING.match(t):
        return False
    if "//" in t and len(t) < 40:  # CUI // NOFORN
        return False
    if t.count(":") >= 1 and not NUM_TITLE_RE.match(t):
        # "Shields: Maximize…" is body
        if len(t) > 25:
            return False

    # Strong signals
    if ROMAN_RE.match(t):
        return True
    if NUM_TITLE_RE.match(t) and is_all_caps_banner(NUM_TITLE_RE.match(t).group(2)):
        return True
    if NUM_TITLE_RE.match(t):
        # "1. PURPOSE" yes; "1. Laser Repeaters" yes if short title
        rest = NUM_TITLE_RE.match(t).group(2)
        if len(rest.split()) <= 6:
            return True
    if is_all_caps_banner(t) and not t.endswith((".", "!", "?")):
        return True

    words = t.split()
    if t.endswith((".", "?", "!", ",", ";")):
        return False
    # Prefer when previous line empty (section break)
    if prev.strip() != "":
        return False

    # Known single-/multi-word section titles (Purpose, Mission, Composition…)
    if re.search(
        r"(?i)^(purpose|mission|composition|doctrine|overview|procedure|"
        r"requirements?|notes?|summary|background|scope|responsibilities|"
        r"core functions|guiding principles|reporting and oversight|"
        r"reporting|personnel requirement|standard doctrine|"
        r"charter and mission statement|"
        r"flexible squadron|wolfpack squadron|"
        r"the infinity turn.*|the sliding strafe.*|"
        r"power management.*|why pledge.*|what do i.*|"
        r"logistics.*|security.*|aerospace.*|ground.*|"
        r"support.*|leadership.*|casualty states)$",
        t,
    ):
        return True

    if not (2 <= len(words) <= 10):
        return False
    caps = sum(1 for w in words if w[:1].isupper())
    if caps < len(words) * 0.7:
        return False
    # Next should be empty or a longer paragraph (not another short title-only list)
    if nxt is not None:
        ns = nxt.strip()
        if ns and len(ns) < 40 and not ns[0].islower():
            return False
    # Default soft promote only if next is substantial prose
    if nxt and len(nxt.strip()) > 60:
        return True
    return False


def promote_heading(line: str) -> str:
    t = line.strip()
    m = ROMAN_RE.match(t)
    if m:
        return f"## {m.group(2).strip()}"
    m = NUM_TITLE_RE.match(t)
    if m:
        return f"## {title_case_banner(m.group(2).strip())}"
    if is_all_caps_banner(t):
        return f"## {title_case_banner(t)}"
    return f"## {t}"


def reformat_body(body: str) -> str:
    text = body.replace("\r\n", "\n").replace("\r", "\n")
    text = (
        text.replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2018", "'")
        .replace("\u2019", "'")
    )
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        prev = out[-1] if out else ""
        nxt = lines[i + 1] if i + 1 < len(lines) else None

        if not stripped:
            if out and out[-1] != "":
                out.append("")
            i += 1
            continue

        if re.match(r"^#{1,6}\s", stripped):
            out.append(stripped)
            i += 1
            continue

        if looks_like_heading(stripped, prev, nxt):
            if out and out[-1] != "":
                out.append("")
            out.append(promote_heading(stripped))
            out.append("")
            i += 1
            continue

        # Indented Good For / Bad At
        m = re.match(r"^\s+(Good For|Bad At):\s*(.+)$", line, re.I)
        if m:
            out.append(f"- **{m.group(1).title()}:** {m.group(2).strip()}")
            i += 1
            continue

        # Indented short lines (pillar lists, purpose bullets) → markdown list
        if re.match(r"^[ \t]{2,}\S", line) and len(stripped) < 80 and not stripped.endswith("."):
            out.append(f"- {stripped}")
            i += 1
            continue

        # Short Label: body → bullet (training docs)
        m = re.match(r"^([A-Za-z][A-Za-z0-9 /&-]{1,32}):\s+(.{12,})$", stripped)
        if m and "http" not in stripped.lower():
            label, rest = m.group(1), m.group(2)
            if prev == "" or prev.startswith("#") or prev.startswith("-"):
                out.append(f"- **{label}:** {rest}")
                i += 1
                continue

        # Composition bullets that were plain lines under a heading
        if prev.startswith("##") or (
            out
            and len(out) >= 2
            and out[-2].startswith("##")
            and out[-1] == ""
        ):
            # "Counter most…" purpose bullets after "It is designed to:"
            pass

        out.append(stripped)
        i += 1

    # Collapse excess blanks
    cleaned: list[str] = []
    blanks = 0
    for ln in out:
        if ln == "":
            blanks += 1
            if blanks <= 2:
                cleaned.append("")
        else:
            blanks = 0
            cleaned.append(ln)
    while cleaned and cleaned[0] == "":
        cleaned.pop(0)
    while cleaned and cleaned[-1] == "":
        cleaned.pop()
    cleaned.append("")
    return "\n".join(cleaned)


def ensure_title(body: str, filename: str) -> str:
    stripped = body.lstrip()
    if stripped.startswith("# "):
        return body
    stem = re.sub(r"[_-]+", " ", Path(filename).stem).strip()
    if not stem:
        return body
    return f"# {stem}\n\n{body.lstrip()}"


def should_skip(path: Path) -> bool:
    posix = path.as_posix()
    return any(posix.endswith(s) for s in SKIP_SUFFIXES)


def reformat_file(path: Path, dry_run: bool) -> bool:
    if should_skip(path):
        return False
    raw = path.read_text(encoding="utf-8", errors="replace")
    fields, body = parse_frontmatter(raw)
    if not fields.get("classification"):
        fields["classification"] = "unclassified"
    new_body = ensure_title(reformat_body(body), path.name)
    new_text = format_frontmatter(fields) + new_body
    old_norm = raw.replace("\r\n", "\n").lstrip("\ufeff")
    if new_text == old_norm:
        return False
    if dry_run:
        print(f"Would update: {path}")
        return True
    path.write_text(new_text, encoding="utf-8")
    print(f"Updated: {path}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("doctrine_dir", type=Path)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    root: Path = args.doctrine_dir
    if not root.is_dir():
        print(f"Not a directory: {root}", file=sys.stderr)
        return 1
    n = 0
    for path in sorted(root.rglob("*.md")):
        if path.name.startswith("."):
            continue
        if reformat_file(path, args.dry_run):
            n += 1
    print(f"{'Would change' if args.dry_run else 'Changed'} {n} file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
