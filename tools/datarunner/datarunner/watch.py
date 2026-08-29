from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


class _Handler(FileSystemEventHandler):
    def __init__(self, on_image: Callable[[Path], None], debounce_s: float = 1.25):
        self._on_image = on_image
        self._debounce_s = debounce_s
        self._last: dict[str, float] = {}

    def on_created(self, event: FileSystemEvent) -> None:
        self._maybe(event)

    def on_modified(self, event: FileSystemEvent) -> None:
        self._maybe(event)

    def _maybe(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        path = Path(str(event.src_path))
        if path.suffix.lower() not in IMAGE_SUFFIXES:
            return
        now = time.monotonic()
        key = str(path.resolve()) if path.exists() else str(path)
        prev = self._last.get(key, 0)
        if now - prev < self._debounce_s:
            return
        self._last[key] = now
        # Print Screen may still be writing the file.
        time.sleep(0.4)
        if path.is_file():
            self._on_image(path)


def watch_dir(directory: Path, on_image: Callable[[Path], None]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    handler = _Handler(on_image)
    obs = Observer()
    obs.schedule(handler, str(directory), recursive=False)
    obs.start()
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        obs.stop()
    obs.join()
