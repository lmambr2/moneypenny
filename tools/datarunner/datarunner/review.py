from __future__ import annotations

from typing import Any


def format_table(prices: list[dict[str, Any]]) -> str:
    if not prices:
        return "(no rows parsed)"
    lines = [f"{'name':<24} {'buy':>10} {'sell':>10} {'scu_b':>8} {'scu_s':>8}"]
    lines.append("-" * 64)
    for p in prices:
        lines.append(
            f"{str(p.get('name') or ''):<24} "
            f"{_fmt(p.get('price_buy')):>10} "
            f"{_fmt(p.get('price_sell')):>10} "
            f"{_fmt(p.get('scu_buy')):>8} "
            f"{_fmt(p.get('scu_sell')):>8}"
        )
    return "\n".join(lines)


def _fmt(v: object) -> str:
    if v is None:
        return "-"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def confirm(prompt: str, *, yes: bool) -> bool:
    if yes:
        return True
    try:
        ans = input(f"{prompt} [y/N] ").strip().lower()
    except EOFError:
        return False
    return ans in ("y", "yes")
