#!/usr/bin/env python3
"""Convert unsloth Gemma4 E2B QAT (safetensors) -> RKLLM W8A8 for RK3588."""

from __future__ import annotations

import argparse
import os
import sys

from rkllm.api import RKLLM

DEFAULT_MODEL = "unsloth/gemma-4-E2B-it-qat-q4_0-unquantized"
DEFAULT_HF_REPO = DEFAULT_MODEL


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "-m",
        "--model-dir",
        default=os.environ.get("GEMMA4_QAT_DIR", ""),
        help="Local HF model directory (default: $GEMMA4_QAT_DIR)",
    )
    ap.add_argument(
        "-d",
        "--dataset",
        default=os.path.join(os.path.dirname(__file__), "data_quant.json"),
        help="Calibration JSON from generate_data_quant.py",
    )
    ap.add_argument(
        "-o",
        "--output",
        default="",
        help="Output .rkllm path (default: <model-dir-basename>_W8A8_RK3588.rkllm in cwd)",
    )
    ap.add_argument(
        "--target-platform",
        default="RK3588",
        choices=["RK3588", "RK3576", "RK3562", "RV1126B"],
    )
    ap.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "cuda"],
        help="Load device; auto picks cuda when available",
    )
    ap.add_argument(
        "--dtype",
        default="float32",
        choices=["float32", "float16", "bfloat16"],
    )
    ap.add_argument(
        "--optimization-level",
        type=int,
        default=0,
        help="0 per rknn-llm benchmark.md for best on-device tok/s",
    )
    args = ap.parse_args()

    model_dir = args.model_dir
    if not model_dir:
        print("Set --model-dir or GEMMA4_QAT_DIR", file=sys.stderr)
        return 2
    if not os.path.isdir(model_dir):
        print(f"Model directory not found: {model_dir}", file=sys.stderr)
        return 2
    if not os.path.isfile(args.dataset):
        print(f"Calibration file not found: {args.dataset}", file=sys.stderr)
        print("Run: python generate_data_quant.py -m <model-dir>", file=sys.stderr)
        return 2

    device = args.device
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"
    if device == "cuda":
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "0")

    print(f"Loading {model_dir} on {device} ({args.dtype})…")
    llm = RKLLM()
    ret = llm.load_huggingface(
        model=model_dir,
        model_lora=None,
        device=device,
        dtype=args.dtype,
        custom_config=None,
        load_weight=True,
    )
    if ret != 0:
        print(f"load_huggingface failed: {ret}", file=sys.stderr)
        return ret

    print(
        f"Building W8A8 for {args.target_platform} "
        f"(optimization_level={args.optimization_level})…"
    )
    ret = llm.build(
        do_quantization=True,
        optimization_level=args.optimization_level,
        quantized_dtype="W8A8",
        quantized_algorithm="normal",
        target_platform=args.target_platform,
        num_npu_core=3,
        extra_qparams=None,
        dataset=args.dataset,
        hybrid_rate=0,
        max_context=4096,
    )
    if ret != 0:
        print(f"build failed: {ret}", file=sys.stderr)
        return ret

    base = os.path.basename(model_dir.rstrip("/"))
    out = args.output or f"./{base}_W8A8_{args.target_platform}.rkllm"
    print(f"Exporting {out}…")
    ret = llm.export_rkllm(out)
    if ret != 0:
        print(f"export_rkllm failed: {ret}", file=sys.stderr)
        return ret

    print(f"Done: {os.path.abspath(out)}")
    print(f"HUGGINGFACE_PATH for Modelfile: {DEFAULT_HF_REPO}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())