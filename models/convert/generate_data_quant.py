#!/usr/bin/env python3
"""Generate calibration JSON for RKLLM W8A8 export (Gemma4 QAT)."""

from __future__ import annotations

import argparse
import json
import os

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

INPUT_TEXT = [
    "Play something chill from the library.",
    "What is the theory of general relativity?",
    "Skip the current track and queue jazz next.",
    "Human: Summarize the mission doctrine in two sentences.",
    "Set volume to 40 percent.",
    "Which artist is playing right now?",
    "Write a one-line joke about saving RAM on an Orange Pi.",
    "Pause playback.",
    "Recommend upbeat music for a workout.",
    "What does W8A8 quantization mean for NPU inference?",
    "List three ways to improve voice round-trip latency.",
    "Translate to English: RK3588 is a high-performance edge SoC.",
    "Who won the Battle of Hastings?",
    "Resume music.",
    "Explain tool calling in OpenAI-compatible chat APIs.",
    "Add Bohemian Rhapsody to the queue.",
    "What is the capital of Estonia?",
    "Describe the difference between Moonshine and Whisper for STT.",
    "Stop the bot from talking.",
    "Give me a 30-second briefing on split-brain LLM deployment.",
]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-m", "--model-dir", required=True, help="Local HF model directory")
    ap.add_argument(
        "-o",
        "--output-file",
        default=os.path.join(os.path.dirname(__file__), "data_quant.json"),
    )
    ap.add_argument("--apply-chat-template", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--max-new-tokens", type=int, default=128)
    ap.add_argument("--temperature", type=float, default=0.6)
    ap.add_argument("--repetition-penalty", type=float, default=1.1)
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    args = ap.parse_args()

    dev = args.device
    if dev == "auto":
        dev = "cuda" if torch.cuda.is_available() else "cpu"

    print(f"Loading tokenizer/model from {args.model_dir} on {dev}…")
    tokenizer = AutoTokenizer.from_pretrained(args.model_dir, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model_dir, trust_remote_code=True, torch_dtype=torch.float32
    )
    model = model.to(dev).eval()

    gen_kwargs = {
        "max_new_tokens": args.max_new_tokens,
        "top_k": 1,
        "temperature": args.temperature,
        "do_sample": True,
        "repetition_penalty": args.repetition_penalty,
    }
    calidata: list[dict[str, str]] = []

    for idx, inp in enumerate(INPUT_TEXT):
        question = inp.strip()
        if args.apply_chat_template:
            datas = [{"role": "user", "content": question}]
            messages = tokenizer.apply_chat_template(
                datas, tokenize=False, add_generation_prompt=True, return_tensors="pt"
            )
        else:
            messages = question

        try:
            inputs = tokenizer(messages, return_tensors="pt").to(dev)
            outputs = model.generate(**inputs, **gen_kwargs)
            result = tokenizer.decode(outputs[0], skip_special_tokens=True)
            target = result[len(messages) :]
            print(f"[{idx + 1}/{len(INPUT_TEXT)}] ok ({len(target)} chars)")
            calidata.append({"input": messages, "target": target})
        except Exception as exc:  # noqa: BLE001 — keep going for partial calib set
            print(f"[{idx + 1}/{len(INPUT_TEXT)}] failed: {exc}")
            calidata.append({"input": messages, "target": ""})

    with open(args.output_file, "w", encoding="utf-8") as f:
        json.dump(calidata, f, ensure_ascii=False, indent=2)
    print(f"Wrote {len(calidata)} samples -> {args.output_file}")


if __name__ == "__main__":
    main()