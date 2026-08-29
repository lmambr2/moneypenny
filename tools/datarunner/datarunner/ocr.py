"""CPU Tesseract plus optional NVIDIA/AMD/Intel GPU OCR (RapidOCR + ONNX)."""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class OcrResult:
    text: str
    backend: str
    device: str


def detect_gpu() -> str:
    """Return cuda | rocm | openvino | cpu from the host, not from pip extras."""
    if shutil.which("nvidia-smi") or Path("/dev/nvidia0").exists():
        return "cuda"
    if Path("/dev/kfd").exists() or shutil.which("rocminfo"):
        return "rocm"
    drm = Path("/sys/class/drm")
    if drm.is_dir():
        for child in drm.iterdir():
            uevent = child / "device" / "uevent"
            try:
                raw = uevent.read_text(encoding="utf-8", errors="ignore").lower()
            except OSError:
                continue
            if "i915" in raw or "xe\n" in raw or "driver=xe" in raw or "pci_id=8086" in raw:
                return "openvino"
    return "cpu"


def _tesseract(image: Path) -> str:
    exe = shutil.which("tesseract")
    if not exe:
        raise FileNotFoundError(
            "tesseract not found. Install the distro package, or pip install a GPU extra "
            "(ocr-cuda / ocr-rocm / ocr-intel) for RapidOCR."
        )
    proc = subprocess.run(
        [exe, str(image), "stdout", "--psm", "6", "-l", "eng"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"tesseract failed: {err or proc.returncode}")
    return proc.stdout or ""


def _rapidocr(image: Path, device: str) -> str:
    """RapidOCR ONNX. Extra packages select the Execution Provider."""
    try:
        from rapidocr import RapidOCR  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "RapidOCR is not installed. pip install -e '.[ocr-cuda]' (NVIDIA), "
            "'.[ocr-rocm]' (AMD), or '.[ocr-intel]' (Intel OpenVINO)."
        ) from exc

    params: dict[str, object] = {}
    if device == "cuda":
        params["EngineConfig.onnxruntime.use_cuda"] = True
    elif device == "rocm":
        # RapidOCR talks to whatever onnxruntime wheel is installed.
        os.environ.setdefault("ORT_ROCM_DEVICE_ID", "0")
    elif device in ("openvino", "intel"):
        params["EngineConfig.onnxruntime.use_openvino"] = True

    try:
        engine = RapidOCR(params=params) if params else RapidOCR()
        out = engine(str(image))
    except TypeError:
        engine = RapidOCR()
        out = engine(str(image))

    # RapidOCR 2 returns (result, elapse); 3 returns a result object.
    if isinstance(out, tuple):
        result = out[0]
    else:
        result = getattr(out, "txts", None) or getattr(out, "result", out)
    if result is None:
        return ""
    lines: list[str] = []
    if isinstance(result, list):
        for item in result:
            if isinstance(item, str):
                lines.append(item)
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                # [[box], text, score]
                text = item[1]
                if isinstance(text, str):
                    lines.append(text)
            elif isinstance(item, dict) and "text" in item:
                lines.append(str(item["text"]))
    elif isinstance(result, str):
        lines.append(result)
    return "\n".join(lines)


def image_to_text(image: Path, device: str = "auto") -> OcrResult:
    image = Path(image)
    if not image.is_file():
        raise FileNotFoundError(image)
    wanted = detect_gpu() if device == "auto" else device
    if wanted != "cpu":
        try:
            text = _rapidocr(image, wanted)
            return OcrResult(text=text, backend="rapidocr", device=wanted)
        except Exception as err:
            # GPU extra missing or EP failed — CPU Tesseract is the floor.
            fallback = _tesseract(image)
            return OcrResult(
                text=fallback + ("" if fallback.endswith("\n") else "\n")
                + f"[ocr: {wanted} failed ({err.__class__.__name__}); used tesseract]",
                backend="tesseract",
                device="cpu",
            )
    text = _tesseract(image)
    return OcrResult(text=text, backend="tesseract", device="cpu")
