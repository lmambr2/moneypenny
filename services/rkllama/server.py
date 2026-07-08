#!/usr/bin/env python3
"""
Moneypenny RKLLama gateway — an OpenAI-compatible HTTP server over the RK3588 NPU.

The bot's LlmClient (bot/src/llm/client.ts) speaks plain OpenAI
`POST /v1/chat/completions` (+ `GET /v1/models` for the health probe). This
server implements that contract on top of the RKLLM runtime, including Qwen3
function/tool-calling, so the bot's deterministic-first router can drive music
by natural language (DESIGN §9).

Two backends, selected by RKLLM_BACKEND:
  * mock   — no NPU; deterministic canned/echo responses. Lets you validate the
             full bot↔LLM integration (router handoff, tool execution, history)
             on any machine before hardware. DEFAULT.
  * native — ctypes over librkllmrt (RKLLM 1.3.x). See NativeRkllmBackend; the
             struct layout MUST match the rkllm.h for your installed runtime.

Only the OpenAI/Qwen3 translation layer (prompt build + tool-call parse +
response shaping) carries logic; it is pure and covered by `--selftest`.
Standard-library only (http.server) — no FastAPI/uvicorn dependency.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
# OpenAI ↔ Qwen3 translation (pure, testable)
# ─────────────────────────────────────────────────────────────────────────────

IM_START = "<|im_start|>"
IM_END = "<|im_end|>"


def build_prompt(messages: list[dict], tools: list[dict] | None) -> str:
    """Render OpenAI chat messages (+ optional tools) into Qwen3 ChatML.

    Tools are advertised inside the system turn using Qwen3's <tools> / <tool_call>
    convention so the model emits callable JSON we can parse back out.
    """
    msgs = [dict(m) for m in messages]

    # Ensure a system turn exists; append the tool preamble to it.
    if tools:
        sys_idx = next((i for i, m in enumerate(msgs) if m.get("role") == "system"), None)
        preamble = _tool_preamble(tools)
        if sys_idx is None:
            msgs.insert(0, {"role": "system", "content": preamble})
        else:
            base = (msgs[sys_idx].get("content") or "").rstrip()
            msgs[sys_idx] = {"role": "system", "content": f"{base}\n\n{preamble}" if base else preamble}

    parts: list[str] = []
    for m in msgs:
        role = m.get("role", "user")
        content = m.get("content") or ""
        # An assistant turn that itself made tool calls (history) → render them back.
        if role == "assistant" and m.get("tool_calls"):
            calls = "\n".join(
                "<tool_call>\n"
                + json.dumps({"name": tc["function"]["name"],
                              "arguments": _maybe_json(tc["function"].get("arguments"))},
                             ensure_ascii=False)
                + "\n</tool_call>"
                for tc in m["tool_calls"]
            )
            content = (content + "\n" + calls).strip()
        if role == "tool":
            # Tool result fed back to the model.
            content = f"<tool_response>\n{content}\n</tool_response>"
            role = "user"
        parts.append(f"{IM_START}{role}\n{content}{IM_END}\n")

    parts.append(f"{IM_START}assistant\n")
    return "".join(parts)


def _tool_preamble(tools: list[dict]) -> str:
    sigs = "\n".join(json.dumps(t.get("function", t), ensure_ascii=False) for t in tools)
    return (
        "# Tools\n\n"
        "You may call one or more functions to assist with the user query.\n\n"
        "You are provided with function signatures within <tools></tools> XML tags:\n"
        f"<tools>\n{sigs}\n</tools>\n\n"
        "For each function call, return a json object with the function name and "
        "arguments within <tool_call></tool_call> XML tags:\n"
        '<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>'
    )


def _maybe_json(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return v
    return v


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_TOOLCALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)
_GEMMA_TOOLCALL_RE = re.compile(r"<\|tool_call>call:(\w+)\{(.*?)\}<tool_call\|>", re.DOTALL)
_GEMMA_BARE_TOOLCALL_RE = re.compile(r"^call:(\w+)\{(.*?)\}\s*$", re.DOTALL)
_GEMMA_FUNC_TOOLCALL_RE = re.compile(r"^(\w+)\{(.*?)\}\s*$", re.DOTALL)
_GEMMA_ARG_RE = re.compile(
    r'(\w+):(?:<\|"\|>(.*?)<\|"\|>|"([^"]*)"|([^,}]+))'
)


def _extract_text_content(msg: dict) -> str:
    c = msg.get("content", "")
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if p.get("type") == "text")
    return c or ""


def get_last_input(messages: list[dict], last_messages: list[dict]) -> tuple[str, str, list[dict]]:
    """Return (role, content, updated_history) for the newest user/tool turn.

    Mirrors Rockchip's rkllm_server_demo: only the delta since the prior request
    is fed to RKLLM (keep_history=0); the bot resends full history each turn.
    """
    prev_len = len(last_messages)
    new_messages = messages[prev_len:] if prev_len < len(messages) else []
    updated = list(messages)

    if not new_messages:
        for msg in reversed(messages):
            role = msg.get("role", "")
            if role in ("user", "tool"):
                return role, _extract_text_content(msg), updated
        return "user", "", updated

    new_inputs = [m for m in new_messages if m.get("role", "") in ("user", "tool")]
    if not new_inputs:
        for msg in reversed(messages):
            role = msg.get("role", "")
            if role in ("user", "tool"):
                return role, _extract_text_content(msg), updated
        return "user", "", updated

    if all(m.get("role") == "tool" for m in new_inputs):
        tool_contents = []
        for m in new_inputs:
            c = m.get("content", "")
            try:
                tool_contents.append(json.loads(c))
            except (json.JSONDecodeError, TypeError):
                tool_contents.append(c)
        return "tool", json.dumps(tool_contents, ensure_ascii=False), updated

    last = new_inputs[-1]
    return last.get("role", "user"), _extract_text_content(last), updated


def _parse_gemma_args(raw: str) -> dict:
    raw = raw.strip()
    if not raw:
        return {}
    try:
        return json.loads(raw if raw.startswith("{") else "{" + raw + "}")
    except Exception:
        pass
    args: dict[str, Any] = {}
    for m in _GEMMA_ARG_RE.finditer(raw):
        args[m.group(1)] = (m.group(2) or m.group(3) or m.group(4) or "").strip()
    return args


def parse_generation(text: str) -> tuple[str, list[dict]]:
    """Split raw Qwen3 output into (assistant_text, tool_calls).

    Strips <think> reasoning and any trailing <|im_end|>; extracts every
    <tool_call>{...}</tool_call> block. tool_calls are returned as
    {name, arguments(dict)}.
    """
    text = text.split(IM_END)[0]
    text = _THINK_RE.sub("", text)

    tool_calls: list[dict] = []
    for m in _TOOLCALL_RE.finditer(text):
        try:
            obj = json.loads(m.group(1))
            if isinstance(obj, dict) and "name" in obj:
                tool_calls.append({"name": obj["name"], "arguments": obj.get("arguments", {})})
        except Exception:
            continue

    for m in _GEMMA_TOOLCALL_RE.finditer(text):
        tool_calls.append({"name": m.group(1), "arguments": _parse_gemma_args(m.group(2))})

    if not tool_calls:
        stripped = text.strip()
        bare = _GEMMA_BARE_TOOLCALL_RE.match(stripped) or _GEMMA_FUNC_TOOLCALL_RE.match(stripped)
        if bare:
            tool_calls.append({"name": bare.group(1), "arguments": _parse_gemma_args(bare.group(2))})

    content = _TOOLCALL_RE.sub("", text)
    content = _GEMMA_TOOLCALL_RE.sub("", content)
    if tool_calls and (_GEMMA_BARE_TOOLCALL_RE.match(content.strip())
                       or _GEMMA_FUNC_TOOLCALL_RE.match(content.strip())):
        content = ""
    return content.strip(), tool_calls


def chat_response(model: str, content: str, tool_calls: list[dict],
                  prompt_tokens: int, completion_tokens: int, created: int) -> dict:
    """Shape an OpenAI /v1/chat/completions response body."""
    message: dict[str, Any] = {"role": "assistant", "content": content or None}
    if tool_calls:
        message["tool_calls"] = [
            {
                "id": f"call_{i}",
                "type": "function",
                "function": {
                    "name": tc["name"],
                    "arguments": tc["arguments"] if isinstance(tc["arguments"], str)
                    else json.dumps(tc["arguments"], ensure_ascii=False),
                },
            }
            for i, tc in enumerate(tool_calls)
        ]
    return {
        "id": f"chatcmpl-{created}",
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": "tool_calls" if tool_calls else "stop",
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Backends
# ─────────────────────────────────────────────────────────────────────────────

class Backend:
    name = "base"

    def generate(self, messages: list[dict], tools: list[dict] | None,
                 max_tokens: int, temperature: float) -> str:
        raise NotImplementedError


class MockBackend(Backend):
    """No-NPU backend for dev/CI and end-to-end bot validation.

    If the last user turn looks like a music request, emits a Qwen3 tool_call so
    the bot's tool-execution path can be exercised; otherwise echoes a short
    canned answer. Deterministic — no randomness.
    """
    name = "mock"

    _PLAY_RE = re.compile(r"\b(play|put on|queue)\b\s+(.*)", re.IGNORECASE)

    def generate(self, messages: list[dict], tools: list[dict] | None,
                 max_tokens: int, temperature: float) -> str:
        prompt = build_prompt(messages, tools)
        last_user = ""
        for chunk in prompt.split(f"{IM_START}user\n"):
            seg = chunk.split(IM_END)[0]
            if seg:
                last_user = seg.strip()
        m = self._PLAY_RE.search(last_user)
        if m and tools:
            query = m.group(2).strip().strip(".?!") or "something"
            args = json.dumps({"query": query})
            return f'<tool_call>\n{{"name": "play_music", "arguments": {args}}}\n</tool_call>'
        if not last_user:
            return "Hello! I'm Moneypenny's mock LLM — set RKLLM_BACKEND=native on the Orange Pi for the real model."
        return f"(mock) You said: {last_user[:200]}"


class NativeRkllmBackend(Backend):
    """ctypes wrapper over librkllmrt (RKLLM 1.3.x), loading a .rkllm model.

    Follows Rockchip's rkllm_server_demo: built-in chat template, role-based
    turns, rkllm_set_function_tools for tool calling. Gemma4 QAT models validated
    via native llm_demo on RK3588.
    """
    name = "native"

    RKLLM_RUN_NORMAL = 0
    RKLLM_RUN_WAITING = 1
    RKLLM_RUN_FINISH = 2
    RKLLM_RUN_ERROR = 3

    def __init__(self, model_path: str, max_context: int):
        import ctypes

        self.ctypes = ctypes
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"RKLLM model not found: {model_path}")
        self.lib = ctypes.CDLL("librkllmrt.so")
        self.model_path = model_path
        self.max_context = max_context
        self._last_messages: list[dict] = []
        self._tools_json: str | None = None
        self._enc_refs: list[Any] = []
        self._define_abi()
        self._init_model()

    def _define_abi(self) -> None:
        ct = self.ctypes

        class RKLLMExtendParam(ct.Structure):
            _fields_ = [
                ("base_domain_id", ct.c_int32),
                ("embed_flash", ct.c_int8),
                ("enabled_cpus_num", ct.c_int8),
                ("enabled_cpus_mask", ct.c_uint32),
                ("n_batch", ct.c_uint8),
                ("use_cross_attn", ct.c_int8),
                ("reserved", ct.c_uint8 * 104),
            ]

        class RKLLMParam(ct.Structure):
            _fields_ = [
                ("model_path", ct.c_char_p),
                ("max_context_len", ct.c_int32),
                ("max_new_tokens", ct.c_int32),
                ("top_k", ct.c_int32),
                ("n_keep", ct.c_int32),
                ("top_p", ct.c_float),
                ("temperature", ct.c_float),
                ("repeat_penalty", ct.c_float),
                ("frequency_penalty", ct.c_float),
                ("presence_penalty", ct.c_float),
                ("mirostat", ct.c_int32),
                ("mirostat_tau", ct.c_float),
                ("mirostat_eta", ct.c_float),
                ("skip_special_token", ct.c_bool),
                ("ignore_eos_token", ct.c_bool),
                ("is_async", ct.c_bool),
                ("extend_param", RKLLMExtendParam),
            ]

        class RKLLMEmbedInput(ct.Structure):
            _fields_ = [("embed", ct.POINTER(ct.c_float)), ("n_tokens", ct.c_size_t)]

        class RKLLMTokenInput(ct.Structure):
            _fields_ = [("input_ids", ct.POINTER(ct.c_int32)), ("n_tokens", ct.c_size_t)]

        class RKLLMImageInput(ct.Structure):
            _fields_ = [
                ("image_embed", ct.POINTER(ct.c_float)),
                ("n_image_tokens", ct.c_size_t),
                ("n_image", ct.c_size_t),
                ("image_start", ct.c_char_p),
                ("image_end", ct.c_char_p),
                ("image_content", ct.c_char_p),
                ("image_width", ct.c_size_t),
                ("image_height", ct.c_size_t),
            ]

        class RKLLMVideoInput(ct.Structure):
            _fields_ = [
                ("video_embed", ct.POINTER(ct.c_float)),
                ("n_frame_tokens", ct.c_size_t),
                ("n_frame_per_video", ct.c_size_t),
                ("n_video", ct.c_size_t),
                ("video_start", ct.c_char_p),
                ("video_end", ct.c_char_p),
                ("video_content", ct.c_char_p),
                ("frame_width", ct.c_size_t),
                ("frame_height", ct.c_size_t),
            ]

        class RKLLMMultiModalInput(ct.Structure):
            _fields_ = [
                ("prompt", ct.c_char_p),
                ("image", RKLLMImageInput),
                ("video", RKLLMVideoInput),
            ]

        class RKLLMInputUnion(ct.Union):
            _fields_ = [
                ("prompt_input", ct.c_char_p),
                ("embed_input", RKLLMEmbedInput),
                ("token_input", RKLLMTokenInput),
                ("multimodal_input", RKLLMMultiModalInput),
            ]

        class RKLLMInput(ct.Structure):
            _anonymous_ = ("input_data",)
            _fields_ = [
                ("role", ct.c_char_p),
                ("enable_thinking", ct.c_bool),
                ("input_type", ct.c_int),
                ("input_data", RKLLMInputUnion),
            ]

        class RKLLMLoraParam(ct.Structure):
            _fields_ = [("lora_adapter_name", ct.c_char_p)]

        class RKLLMPromptCacheParam(ct.Structure):
            _fields_ = [("save_prompt_cache", ct.c_int), ("prompt_cache_path", ct.c_char_p)]

        class RKLLMSamplingParam(ct.Structure):
            _fields_ = [
                ("top_k", ct.c_int32),
                ("top_p", ct.c_float),
                ("temperature", ct.c_float),
                ("repeat_penalty", ct.c_float),
                ("frequency_penalty", ct.c_float),
                ("presence_penalty", ct.c_float),
                ("mirostat", ct.c_int32),
                ("mirostat_tau", ct.c_float),
                ("mirostat_eta", ct.c_float),
            ]

        class RKLLMInferParam(ct.Structure):
            _fields_ = [
                ("mode", ct.c_int),
                ("lora_params", ct.POINTER(RKLLMLoraParam)),
                ("prompt_cache_params", ct.POINTER(RKLLMPromptCacheParam)),
                ("sampling_params", ct.POINTER(RKLLMSamplingParam)),
                ("keep_history", ct.c_int),
                ("max_new_tokens", ct.c_int32),
            ]

        class RKLLMResultLastHiddenLayer(ct.Structure):
            _fields_ = [
                ("hidden_states", ct.POINTER(ct.c_float)),
                ("embd_size", ct.c_int),
                ("num_tokens", ct.c_int),
            ]

        class RKLLMResultLogits(ct.Structure):
            _fields_ = [
                ("logits", ct.POINTER(ct.c_float)),
                ("vocab_size", ct.c_int),
                ("num_tokens", ct.c_int),
            ]

        class RKLLMPerfStat(ct.Structure):
            _fields_ = [
                ("prefill_time_ms", ct.c_float),
                ("prefill_tokens", ct.c_int),
                ("generate_time_ms", ct.c_float),
                ("generate_tokens", ct.c_int),
                ("memory_usage_mb", ct.c_float),
            ]

        class RKLLMResult(ct.Structure):
            _fields_ = [
                ("text", ct.c_char_p),
                ("token_id", ct.c_int32),
                ("last_hidden_layer", RKLLMResultLastHiddenLayer),
                ("logits", RKLLMResultLogits),
                ("perf", RKLLMPerfStat),
            ]

        CALLBACK = ct.CFUNCTYPE(ct.c_int, ct.POINTER(RKLLMResult), ct.c_void_p, ct.c_int)

        class RKLLMCallback(ct.Structure):
            _fields_ = [
                ("result_callback", CALLBACK),
                ("result_userdata", ct.c_void_p),
                ("tokenizer_callback", ct.CFUNCTYPE(ct.c_int, ct.c_void_p, ct.c_char_p,
                                                    ct.c_int32, ct.POINTER(ct.c_int32), ct.c_int32)),
                ("tokenizer_userdata", ct.c_void_p),
                ("embed_callback", ct.CFUNCTYPE(ct.c_int, ct.c_void_p, ct.POINTER(ct.c_int32),
                                                 ct.c_uint64, ct.c_void_p, ct.c_uint64)),
                ("embed_userdata", ct.c_void_p),
            ]

        self.RKLLMParam = RKLLMParam
        self.RKLLMResult = RKLLMResult
        self.RKLLMInput = RKLLMInput
        self.RKLLMInferParam = RKLLMInferParam
        self.RKLLMSamplingParam = RKLLMSamplingParam
        self.RKLLMCallback = RKLLMCallback
        self.CALLBACK = CALLBACK
        self.RKLLM_INPUT_PROMPT = 0
        self.RKLLM_INFER_GENERATE = 0

        self.lib.rkllm_init.argtypes = [ct.POINTER(ct.c_void_p), ct.POINTER(RKLLMParam),
                                        ct.POINTER(RKLLMCallback)]
        self.lib.rkllm_init.restype = ct.c_int
        self.lib.rkllm_run.argtypes = [
            ct.c_void_p, ct.POINTER(RKLLMInput), ct.POINTER(RKLLMInferParam), ct.c_void_p
        ]
        self.lib.rkllm_run.restype = ct.c_int
        self.lib.rkllm_destroy.argtypes = [ct.c_void_p]
        self.lib.rkllm_destroy.restype = ct.c_int
        self.lib.rkllm_set_function_tools.argtypes = [
            ct.c_void_p, ct.c_char_p, ct.c_char_p, ct.c_char_p
        ]
        self.lib.rkllm_set_function_tools.restype = ct.c_int

    def _init_model(self) -> None:
        ct = self.ctypes
        param = self.RKLLMParam()
        ct.memset(ct.byref(param), 0, ct.sizeof(self.RKLLMParam))
        param.model_path = self._cstr(self.model_path)
        param.max_context_len = self.max_context
        param.max_new_tokens = int(os.environ.get("RKLLM_MAX_NEW_TOKENS", "512"))
        param.skip_special_token = True
        param.ignore_eos_token = False
        param.is_async = False
        param.top_k = 1
        param.top_p = 0.95
        param.temperature = 0.8
        param.repeat_penalty = 1.1
        param.n_keep = -1
        param.extend_param.base_domain_id = 0
        param.extend_param.embed_flash = 1
        param.extend_param.n_batch = 1
        param.extend_param.use_cross_attn = 0
        param.extend_param.enabled_cpus_num = 4
        param.extend_param.enabled_cpus_mask = (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7)

        self._buf: list[str] = []
        self._lock = threading.Lock()
        self._error = False

        def _on_token(result_ptr, _userdata, state):
            if state == self.RKLLM_RUN_NORMAL and result_ptr:
                piece = result_ptr.contents.text
                if piece:
                    self._buf.append(piece.decode("utf-8", "replace"))
            elif state == self.RKLLM_RUN_ERROR:
                self._error = True
            return 0

        self._cb = self.CALLBACK(_on_token)
        self._callback = self.RKLLMCallback()
        self._callback.result_callback = self._cb

        self.handle = ct.c_void_p()
        rc = self.lib.rkllm_init(ct.byref(self.handle), ct.byref(param), ct.byref(self._callback))
        if rc != 0:
            raise RuntimeError(f"rkllm_init failed (rc={rc}). Check model/runtime version match.")

        self._infer = self.RKLLMInferParam()
        ct.memset(ct.byref(self._infer), 0, ct.sizeof(self.RKLLMInferParam))
        self._infer.mode = self.RKLLM_INFER_GENERATE
        self._infer.keep_history = 0

    def _cstr(self, s: str) -> Any:
        b = s.encode("utf-8")
        self._enc_refs.append(b)
        return self.ctypes.c_char_p(b)

    def _configure_tools(self, messages: list[dict], tools: list[dict] | None) -> None:
        if not tools:
            return
        sys_prompt = ""
        for msg in messages:
            if msg.get("role") == "system":
                sys_prompt = _extract_text_content(msg)
        tools_json = json.dumps(tools, ensure_ascii=False)
        if tools_json == self._tools_json:
            return
        self._tools_json = tools_json
        rc = self.lib.rkllm_set_function_tools(
            self.handle,
            self._cstr(sys_prompt),
            self._cstr(tools_json),
            self._cstr("tool_response"),
        )
        if rc != 0:
            raise RuntimeError(f"rkllm_set_function_tools failed (rc={rc})")

    def generate(self, messages: list[dict], tools: list[dict] | None,
                 max_tokens: int, temperature: float) -> str:
        ct = self.ctypes
        with self._lock:
            role, prompt, self._last_messages = get_last_input(messages, self._last_messages)
            if not prompt:
                raise ValueError("no user/tool content in messages")

            self._configure_tools(messages, tools)
            self._buf = []
            self._error = False
            self._enc_refs = []

            inp = self.RKLLMInput()
            ct.memset(ct.byref(inp), 0, ct.sizeof(self.RKLLMInput))
            inp.role = self._cstr(role)
            inp.enable_thinking = False
            inp.input_type = self.RKLLM_INPUT_PROMPT
            inp.prompt_input = self._cstr(prompt)

            sampling = self.RKLLMSamplingParam()
            sampling.top_k = 1
            sampling.top_p = 0.95
            sampling.temperature = float(temperature)
            sampling.repeat_penalty = 1.1
            sampling.frequency_penalty = 0.0
            sampling.presence_penalty = 0.0
            sampling.mirostat = 0
            sampling.mirostat_tau = 5.0
            sampling.mirostat_eta = 0.1

            self._infer.sampling_params = ct.pointer(sampling)
            self._infer.max_new_tokens = int(max_tokens)

            rc = self.lib.rkllm_run(self.handle, ct.byref(inp), ct.byref(self._infer), None)
            self._infer.sampling_params = None
            self._infer.max_new_tokens = 0

            if rc != 0:
                raise RuntimeError(f"rkllm_run failed (rc={rc})")
            if self._error:
                raise RuntimeError("rkllm_run reported an error state in the callback")
            return "".join(self._buf)

    def close(self) -> None:
        try:
            self.lib.rkllm_destroy(self.handle)
        except Exception:
            pass


def make_backend() -> Backend:
    kind = os.environ.get("RKLLM_BACKEND", "mock").lower()
    if kind == "native":
        model = os.environ.get("MODEL_PATH", "/models/default.rkllm")
        ctx = int(os.environ.get("MAX_CONTEXT", "2048"))
        return NativeRkllmBackend(model, ctx)
    return MockBackend()


# ─────────────────────────────────────────────────────────────────────────────
# HTTP server (stdlib)
# ─────────────────────────────────────────────────────────────────────────────

def approx_tokens(text: str) -> int:
    return max(1, len(text) // 4)


class Handler(BaseHTTPRequestHandler):
    backend: Backend = MockBackend()
    model_name: str = "npu-llm"

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter logs
        sys.stderr.write("rkllama: " + (fmt % args) + "\n")

    def _send(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path.rstrip("/") in ("/health", "/api/health"):
            self._send(200, {"status": "ok", "backend": self.backend.name})
        elif self.path.rstrip("/") == "/v1/models":
            self._send(200, {"object": "list", "data": [
                {"id": self.model_name, "object": "model", "owned_by": "moneypenny"}
            ]})
        else:
            self._send(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            self._send(400, {"error": {"message": f"bad request: {e}"}})
            return

        messages = req.get("messages", [])
        tools = req.get("tools")
        max_tokens = int(req.get("max_tokens", 512))
        temperature = float(req.get("temperature", 0.2))
        model = req.get("model") or self.model_name

        try:
            raw = self.backend.generate(messages, tools, max_tokens, temperature)
        except NotImplementedError as e:
            self._send(501, {"error": {"message": str(e)}})
            return
        except Exception as e:
            self._send(500, {"error": {"message": f"generation failed: {e}"}})
            return

        content, tool_calls = parse_generation(raw)
        prompt_len = sum(approx_tokens(_extract_text_content(m)) for m in messages)
        body = chat_response(
            model, content, tool_calls,
            prompt_tokens=prompt_len,
            completion_tokens=approx_tokens(raw),
            created=int(time.time()),
        )
        self._send(200, body)


def serve() -> None:
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("BIND_ADDRESS", "0.0.0.0")
    Handler.backend = make_backend()
    Handler.model_name = os.environ.get("RKLLM_MODEL_NAME", "npu-llm")
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"rkllama gateway on {host}:{port} (backend={Handler.backend.name}, model={Handler.model_name})",
          flush=True)
    httpd.serve_forever()


# ─────────────────────────────────────────────────────────────────────────────
# Self-test (no NPU, stdlib only): validates the OpenAI/Qwen3 layer.
# ─────────────────────────────────────────────────────────────────────────────

def selftest() -> int:
    failures = 0

    def check(cond: bool, msg: str) -> None:
        nonlocal failures
        if not cond:
            failures += 1
            print(f"  FAIL: {msg}")
        else:
            print(f"  ok: {msg}")

    # build_prompt: tools fold into a system turn; ends ready for assistant.
    p = build_prompt([{"role": "user", "content": "hi"}],
                     [{"type": "function", "function": {"name": "skip", "parameters": {}}}])
    check("<tools>" in p and '"name": "skip"' in p, "tools advertised in prompt")
    check(p.endswith(f"{IM_START}assistant\n"), "prompt ends at assistant turn")
    check(f"{IM_START}system\n" in p, "synthesized system turn when none given")

    # build_prompt: existing system message is preserved + extended.
    p2 = build_prompt([{"role": "system", "content": "You are Moneypenny."},
                       {"role": "user", "content": "yo"}],
                      [{"type": "function", "function": {"name": "skip"}}])
    check("You are Moneypenny." in p2 and "<tools>" in p2, "existing system turn extended")

    # parse_generation: strips think, extracts tool call.
    raw = '<think>reasoning</think>Sure.<tool_call>\n{"name":"play_music","arguments":{"query":"jazz"}}\n</tool_call>'
    content, calls = parse_generation(raw)
    check("reasoning" not in content, "<think> stripped")
    check(content == "Sure.", f"content is clean text (got {content!r})")
    check(len(calls) == 1 and calls[0]["name"] == "play_music", "tool call extracted")
    check(calls[0]["arguments"] == {"query": "jazz"}, "tool args parsed")

    # parse_generation: plain answer, no tools.
    c2, k2 = parse_generation("The capital of France is Paris.<|im_end|>")
    check(c2 == "The capital of France is Paris." and k2 == [], "plain answer, no tool calls")

    # chat_response: OpenAI shape + tool_calls with stringified arguments.
    resp = chat_response("m", "", [{"name": "skip", "arguments": {}}], 10, 2, 123)
    tc = resp["choices"][0]["message"]["tool_calls"][0]
    check(tc["type"] == "function" and tc["function"]["name"] == "skip", "response tool_call shape")
    check(isinstance(tc["function"]["arguments"], str), "tool_call arguments stringified")
    check(resp["choices"][0]["finish_reason"] == "tool_calls", "finish_reason=tool_calls")
    check(resp["usage"]["total_tokens"] == 12, "usage totals")

    # parse_generation: Gemma4 tool call formats.
    g_raw = '<|tool_call>call:play_music{query:<|"|>jazz<|"|>}<tool_call|>'
    _, gcalls = parse_generation(g_raw)
    check(len(gcalls) == 1 and gcalls[0]["name"] == "play_music", "gemma tool call extracted")
    check(gcalls[0]["arguments"].get("query") == "jazz", "gemma tool args parsed")
    _, bare_calls = parse_generation("call:play_music{query:jazz music}")
    check(len(bare_calls) == 1 and bare_calls[0]["name"] == "play_music", "bare gemma tool call")
    _, fn_calls = parse_generation("play_music{query:bohemian rhapsody}")
    check(len(fn_calls) == 1 and fn_calls[0]["arguments"].get("query") == "bohemian rhapsody",
          "func-only gemma tool call")

    # MockBackend: music intent → tool call; question → text.
    mb = MockBackend()
    tools = [{"type": "function", "function": {"name": "play_music"}}]
    play = mb.generate([{"role": "user", "content": "play some jazz"}], tools, 256, 0.2)
    _, pcalls = parse_generation(play)
    check(len(pcalls) == 1 and pcalls[0]["name"] == "play_music", "mock emits play_music tool call")
    ans = mb.generate([{"role": "user", "content": "what is 2+2"}], None, 256, 0.2)
    _, acalls = parse_generation(ans)
    check(acalls == [], "mock answers questions without tools")

    print(f"\nselftest: {'PASS' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    serve()
