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
  * native — ctypes over librkllmrt (RKLLM 1.2.x). See NativeRkllmBackend; the
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

    content = _TOOLCALL_RE.sub("", text).strip()
    return content, tool_calls


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

    def generate(self, prompt: str, max_tokens: int, temperature: float) -> str:
        raise NotImplementedError


class MockBackend(Backend):
    """No-NPU backend for dev/CI and end-to-end bot validation.

    If the last user turn looks like a music request, emits a Qwen3 tool_call so
    the bot's tool-execution path can be exercised; otherwise echoes a short
    canned answer. Deterministic — no randomness.
    """
    name = "mock"

    _PLAY_RE = re.compile(r"\b(play|put on|queue)\b\s+(.*)", re.IGNORECASE)

    def generate(self, prompt: str, max_tokens: int, temperature: float) -> str:
        last_user = ""
        for chunk in prompt.split(f"{IM_START}user\n"):
            seg = chunk.split(IM_END)[0]
            if seg:
                last_user = seg.strip()
        m = self._PLAY_RE.search(last_user)
        if m and "<tools>" in prompt:
            query = m.group(2).strip().strip(".?!") or "something"
            args = json.dumps({"query": query})
            return f'<tool_call>\n{{"name": "play_music", "arguments": {args}}}\n</tool_call>'
        if not last_user:
            return "Hello! I'm Moneypenny's mock LLM — set RKLLM_BACKEND=native on the Orange Pi for the real model."
        return f"(mock) You said: {last_user[:200]}"


class NativeRkllmBackend(Backend):
    """ctypes wrapper over librkllmrt (RKLLM 1.2.x), loading a .rkllm model.

    ⚠️  HARDWARE BRING-UP NOTE: the RKLLMParam / RKLLMResult / RKLLMInput struct
    layouts below follow the documented RKLLM 1.2.x C API, but ABI details can
    shift between point releases. VERIFY every field against the rkllm.h that
    ships with YOUR installed librkllmrt before relying on this — a mismatch
    will segfault the process, not raise. As an alternative, point the bot's
    RKLLAMA_URL at airockchip's rkllm_server_demo or NotPunchnox/rkllama, which
    speak the same OpenAI contract this gateway does.
    """
    name = "native"

    def __init__(self, model_path: str, max_context: int):
        import ctypes  # local import; only needed for the native path

        self.ctypes = ctypes
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"RKLLM model not found: {model_path}")
        self.lib = ctypes.CDLL("librkllmrt.so")
        self.model_path = model_path
        self.max_context = max_context
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
                ("is_async", ct.c_bool),
                ("img_start", ct.c_char_p),
                ("img_end", ct.c_char_p),
                ("img_content", ct.c_char_p),
                ("extend_param", RKLLMExtendParam),
            ]

        # RKLLMResult: we only read `text` (UTF-8 token piece) in the callback.
        class RKLLMResult(ct.Structure):
            _fields_ = [
                ("text", ct.c_char_p),
                ("token_id", ct.c_int32),
            ]

        # RKLLMInput (RKLLM_INPUT_PROMPT path): a type discriminator + a union
        # whose first member is the prompt string. We only use the prompt path —
        # the other union variants (embed/token/multimodal) are unused, so the
        # union just needs prompt_input first. ⚠️ If your rkllm.h adds fields
        # before `input_type` (some builds carry role/enable_thinking), prepend
        # them here or offsets will be wrong (→ segfault).
        class _RKLLMInputUnion(ct.Union):
            _fields_ = [("prompt_input", ct.c_char_p)]

        class RKLLMInput(ct.Structure):
            # RKLLM 1.2.x prepends `role` + `enable_thinking` before input_type.
            # Omitting them puts input_type at the wrong offset → the runtime
            # reports "input_type of rkllm_input is not set". role/enable_thinking
            # zero-init to NULL/false, which is correct since we pre-render ChatML.
            _anonymous_ = ("u",)
            _fields_ = [
                ("role", ct.c_char_p),
                ("enable_thinking", ct.c_bool),
                ("input_type", ct.c_int),
                ("u", _RKLLMInputUnion),
            ]

        # RKLLMInferParam: generate mode, no LoRA / no prompt cache, history off
        # (the bot owns conversation history). `keep_history` was added in 1.2.x.
        class RKLLMInferParam(ct.Structure):
            _fields_ = [
                ("mode", ct.c_int),
                ("lora_params", ct.c_void_p),
                ("prompt_cache_params", ct.c_void_p),
                ("keep_history", ct.c_int),
            ]

        self.RKLLMParam = RKLLMParam
        self.RKLLMResult = RKLLMResult
        self.RKLLMInput = RKLLMInput
        self.RKLLMInferParam = RKLLMInferParam
        # Enum values (rkllm.h): RKLLM_INPUT_PROMPT=0, RKLLM_INFER_GENERATE=0.
        self.RKLLM_INPUT_PROMPT = 0
        self.RKLLM_INFER_GENERATE = 0
        # Callback: void(*)(RKLLMResult*, void* userdata, int state)
        self.CALLBACK = ct.CFUNCTYPE(None, ct.POINTER(RKLLMResult), ct.c_void_p, ct.c_int)

        self.lib.rkllm_createDefaultParam.restype = RKLLMParam
        self.lib.rkllm_init.argtypes = [ct.POINTER(ct.c_void_p), ct.POINTER(RKLLMParam), self.CALLBACK]
        self.lib.rkllm_init.restype = ct.c_int
        self.lib.rkllm_run.argtypes = [
            ct.c_void_p, ct.POINTER(RKLLMInput), ct.POINTER(RKLLMInferParam), ct.c_void_p
        ]
        self.lib.rkllm_run.restype = ct.c_int
        self.lib.rkllm_destroy.argtypes = [ct.c_void_p]

    def _init_model(self) -> None:
        ct = self.ctypes
        param = self.lib.rkllm_createDefaultParam()
        param.model_path = self.model_path.encode()
        param.max_context_len = self.max_context
        # Upper bound on generated tokens (our requests are short; the OpenAI
        # max_tokens is advisory here since RKLLM sets this at init, not per-run).
        param.max_new_tokens = int(os.environ.get("RKLLM_MAX_NEW_TOKENS", "512"))
        param.skip_special_token = True
        param.is_async = False  # synchronous: rkllm_run blocks until the finish callback

        self._buf: list[str] = []
        self._lock = threading.Lock()  # serialize inference (one NPU model, shared buffer)
        self._error = False

        def _on_token(result_ptr, _userdata, state):
            # state (LLMCallState): 0 = RKLLM_RUN_NORMAL (token), 1 = RKLLM_RUN_FINISH,
            # 2 = RKLLM_RUN_WAITING, 3 = RKLLM_RUN_ERROR. Exact values per rkllm.h.
            if state == 0 and result_ptr:
                piece = result_ptr.contents.text
                if piece:
                    self._buf.append(piece.decode("utf-8", "replace"))
            elif state >= 3:
                self._error = True

        self._cb = self.CALLBACK(_on_token)  # keep a ref so it isn't GC'd
        self.handle = ct.c_void_p()
        rc = self.lib.rkllm_init(ct.byref(self.handle), ct.byref(param), self._cb)
        if rc != 0:
            raise RuntimeError(f"rkllm_init failed (rc={rc}). Check model/runtime version match.")

        # We pre-render Qwen3 ChatML ourselves, so neutralize the runtime's own
        # chat template (empty system/prefix/postfix) to avoid double-wrapping.
        # Best-effort: not all 1.2.x builds export this symbol.
        try:
            self.lib.rkllm_set_chat_template.argtypes = [ct.c_void_p, ct.c_char_p, ct.c_char_p, ct.c_char_p]
            self.lib.rkllm_set_chat_template.restype = ct.c_int
            self.lib.rkllm_set_chat_template(self.handle, b"", b"", b"")
        except AttributeError:
            pass

    def generate(self, prompt: str, max_tokens: int, temperature: float) -> str:
        """Run one synchronous inference and return the full decoded text.

        Serialized: a single NPU model can't infer concurrently and the token
        buffer/callback are shared. rkllm_run blocks (is_async=False) until the
        finish callback fires, so on return self._buf holds the complete output.
        """
        ct = self.ctypes
        with self._lock:
            self._buf = []
            self._error = False

            inp = self.RKLLMInput()
            inp.input_type = self.RKLLM_INPUT_PROMPT
            inp.prompt_input = prompt.encode("utf-8")  # via anonymous union

            infer = self.RKLLMInferParam()
            infer.mode = self.RKLLM_INFER_GENERATE
            infer.lora_params = None
            infer.prompt_cache_params = None
            infer.keep_history = 0  # stateless — the bot manages conversation history

            rc = self.lib.rkllm_run(self.handle, ct.byref(inp), ct.byref(infer), None)
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
    model_name: str = "qwen3-4b-instruct-2507"

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

        prompt = build_prompt(messages, tools)
        try:
            raw = self.backend.generate(prompt, max_tokens, temperature)
        except NotImplementedError as e:
            self._send(501, {"error": {"message": str(e)}})
            return
        except Exception as e:
            self._send(500, {"error": {"message": f"generation failed: {e}"}})
            return

        content, tool_calls = parse_generation(raw)
        body = chat_response(
            model, content, tool_calls,
            prompt_tokens=approx_tokens(prompt),
            completion_tokens=approx_tokens(raw),
            created=int(time.time()),
        )
        self._send(200, body)


def serve() -> None:
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("BIND_ADDRESS", "0.0.0.0")
    Handler.backend = make_backend()
    Handler.model_name = os.environ.get("RKLLM_MODEL_NAME", "qwen3-4b-instruct-2507")
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

    # MockBackend: music intent → tool call; question → text.
    mb = MockBackend()
    play = mb.generate(build_prompt([{"role": "user", "content": "play some jazz"}],
                                    [{"type": "function", "function": {"name": "play_music"}}]), 256, 0.2)
    _, pcalls = parse_generation(play)
    check(len(pcalls) == 1 and pcalls[0]["name"] == "play_music", "mock emits play_music tool call")
    ans = mb.generate(build_prompt([{"role": "user", "content": "what is 2+2"}], None), 256, 0.2)
    _, acalls = parse_generation(ans)
    check(acalls == [], "mock answers questions without tools")

    print(f"\nselftest: {'PASS' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    serve()
