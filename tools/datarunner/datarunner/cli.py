from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from datarunner.config import RunnerConfig
from datarunner.ocr import image_to_text
from datarunner.parse import parse_ocr_text
from datarunner.paths import resolve_watch_dir
from datarunner.review import confirm, format_table
from datarunner.snapshot import build_snapshot, dumps
from datarunner.submit import SubmitError, submit_snapshot
from datarunner.watch import watch_dir


def _cfg(args: argparse.Namespace) -> RunnerConfig:
    return RunnerConfig.from_env(
        destination=getattr(args, "dest", None),
        screenshot_dir=getattr(args, "dir", None),
        terminal_id=getattr(args, "terminal_id", None),
        terminal_name=getattr(args, "terminal_name", None) or "",
        snapshot_type=getattr(args, "type", None) or "commodity",
        ocr_device=getattr(args, "device", None),
        yes=bool(getattr(args, "yes", False)),
        environment=getattr(args, "environment", None),
    )


def _process_image(cfg: RunnerConfig, image: Path) -> int:
    print(f"OCR {image} (device={cfg.ocr_device})", file=sys.stderr)
    ocr = image_to_text(image, cfg.ocr_device)
    print(f"backend={ocr.backend} device={ocr.device}", file=sys.stderr)
    prices = parse_ocr_text(ocr.text)
    print(format_table(prices))
    if not prices:
        print("No rows parsed. Correct the image or type, then retry.", file=sys.stderr)
        return 2
    if cfg.terminal_id is None:
        print("Set --terminal-id (UEX id_terminal) before submit.", file=sys.stderr)
        return 2
    if not confirm(f"Submit {len(prices)} rows to {cfg.destination}?", yes=cfg.yes):
        print("skipped")
        return 0
    snap = build_snapshot(
        prices=prices,
        id_terminal=cfg.terminal_id,
        terminal_name=cfg.terminal_name,
        snapshot_type=cfg.snapshot_type,
        game_version=cfg.game_version,
        environment=cfg.environment,
        screenshot=image,
    )
    try:
        result = submit_snapshot(cfg, snap, image)
    except SubmitError as err:
        print(f"{err.dest} submit failed: {err}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, default=str))
    return 0


def cmd_ocr(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    image = Path(args.image).expanduser()
    ocr = image_to_text(image, cfg.ocr_device)
    print(f"# backend={ocr.backend} device={ocr.device}", file=sys.stderr)
    print(ocr.text)
    prices = parse_ocr_text(ocr.text)
    print("\n# parsed:\n" + format_table(prices), file=sys.stderr)
    return 0


def cmd_submit(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    path = Path(args.file).expanduser()
    snap = json.loads(path.read_text(encoding="utf-8"))
    shot = Path(args.screenshot).expanduser() if args.screenshot else None
    try:
        result = submit_snapshot(cfg, snap, shot)
    except SubmitError as err:
        print(f"{err.dest} submit failed: {err}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, default=str))
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    directory = resolve_watch_dir(args.dir)
    print(
        f"watching {directory} dest={cfg.destination} device={cfg.ocr_device}",
        file=sys.stderr,
    )
    watch_dir(directory, lambda p: _process_image(cfg, p))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="datarunner",
        description="Linux-native Star Citizen kiosk datarunner (Moneypenny / UEX).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--dest", choices=("uex", "moneypenny", "both"), default=None)
        sp.add_argument("--device", choices=("auto", "cpu", "cuda", "rocm", "openvino"), default=None)
        sp.add_argument("--yes", action="store_true", help="Skip review confirm")
        sp.add_argument("--terminal-id", type=int, default=None)
        sp.add_argument("--terminal-name", default="")
        sp.add_argument("--type", default="commodity")
        sp.add_argument("--environment", choices=("LIVE", "PTU"), default=None)

    w = sub.add_parser("watch", help="Inotify a screenshot directory")
    common(w)
    w.add_argument("--dir", default=None, help="Screenshot directory (not C:\\…)")
    w.set_defaults(func=cmd_watch)

    o = sub.add_parser("ocr", help="OCR one image and print text/rows")
    common(o)
    o.add_argument("--image", required=True)
    o.set_defaults(func=cmd_ocr)

    s = sub.add_parser("submit", help="POST a snapshot JSON")
    common(s)
    s.add_argument("--file", required=True)
    s.add_argument("--screenshot", default=None)
    s.set_defaults(func=cmd_submit)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))
