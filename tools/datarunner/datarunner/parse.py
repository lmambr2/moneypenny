"""Turn OCR text into snapshot price rows. Conservative; review is required."""

from __future__ import annotations

import re
from typing import Any

# Name then 2–6 numbers (buy/sell/scu/status-ish).
_ROW = re.compile(
    r"^(?P<name>[A-Za-z][A-Za-z0-9][A-Za-z0-9 \-/]{1,40}?)"
    r"(?:\s+(?P<nums>-?\d+(?:[.,]\d+)?(?:\s+-?\d+(?:[.,]\d+)?){1,5}))\s*$"
)
_SKIP = re.compile(
    r"^(buy|sell|price|commodity|inventory|quantity|scu|kiosk|terminal|local market)\b",
    re.I,
)


def _num(tok: str) -> float:
    return float(tok.replace(",", ""))


def parse_ocr_text(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if len(line) < 4 or _SKIP.match(line):
            continue
        m = _ROW.match(line)
        if not m:
            continue
        name = re.sub(r"\s+", " ", m.group("name")).strip()
        nums = [_num(t) for t in m.group("nums").split()]
        if not name or not nums:
            continue
        row: dict[str, Any] = {"name": name}
        # Heuristic: two money-like values then optional SCU then status 1–7.
        if len(nums) >= 2:
            a, b = nums[0], nums[1]
            # Lower first → buy, higher → sell (kiosk: shop buy from you is sell col).
            if a <= b:
                row["price_buy"] = a
                row["price_sell"] = b
            else:
                row["price_sell"] = a
                row["price_buy"] = b
        elif len(nums) == 1:
            row["price_sell"] = nums[0]
        rest = nums[2:]
        scu = [n for n in rest if n > 7]
        status = [int(n) for n in rest if 1 <= n <= 7 and float(n).is_integer()]
        if len(scu) >= 2:
            row["scu_buy"] = int(scu[0])
            row["scu_sell"] = int(scu[1])
        elif len(scu) == 1:
            row["scu_sell"] = int(scu[0])
        if len(status) >= 2:
            row["status_buy"] = status[0]
            row["status_sell"] = status[1]
        elif len(status) == 1:
            row["status_sell"] = status[0]
        rows.append(row)
    return rows
