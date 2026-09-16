# Host GGUFs (Server edition, AMD)

Weights for **host llama.cpp HIP**, not Ollama.

| File | Role |
|------|------|
| `gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` | Chat target (~6.7 GB). Unsloth QAT. |
| `mtp-gemma-4-12B-it-Q8_0.gguf` | MTP draft (~465 MB). |

```bash
./scripts/download-gemma4-qat-gguf.sh
```

Do **not** download `mmproj-*.gguf`. MoneyPenny already owns Whisper + Piper.

See [docs/gpu-amd.md](../../docs/gpu-amd.md).
