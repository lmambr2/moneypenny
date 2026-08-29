# Moneypenny datarunner (Linux)

Linux-native Star Citizen **kiosk screenshot → OCR → review → submit** tool.
Lives outside the bot image. CPU OCR is Tesseract; NVIDIA / AMD / Intel GPU
OCR is optional.

Docs: [linux-datarunner-plan.md](../../docs/linux-datarunner-plan.md).

## Install

```bash
# CPU (Tesseract distro package + this package)
sudo pacman -S tesseract tesseract-data-eng   # or apt install tesseract-ocr
cd tools/datarunner
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

GPU extras — **on the gaming PC only**, pick one:

```bash
pip install -e ".[ocr-cuda]"    # NVIDIA CUDA (onnxruntime-gpu)
pip install -e ".[ocr-rocm]"    # AMD ROCm
pip install -e ".[ocr-intel]"   # Intel iGPU / Arc (OpenVINO)
```

`OCR_DEVICE=auto` (default) detects NVIDIA (`nvidia-smi` / `/dev/nvidia0`),
AMD (`/dev/kfd` / `rocminfo`), or Intel (`i915`/`xe`) and uses RapidOCR when
the extra imported. Any GPU init failure **falls back to Tesseract**.

## Screenshot directory

Never `C:\…`. Pass `--dir` or `DATARUNNER_SCREENSHOT_DIR`.

LUG Helper default (Wine prefix from `~/.config/starcitizen-lug/winedir.conf`):

```
$WINEPREFIX/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE/ScreenShots
```

Casing is `ScreenShots` or `Screenshots` — we look for both. Proton/umu is
documented in the plan.

## Destination toggle

```
DATARUNNER_DESTINATION=moneypenny   # never talks to UEX
DATARUNNER_DESTINATION=uex
DATARUNNER_DESTINATION=both         # UEX failure does not fail Moneypenny
```

```bash
export MONEYPENNY_INGEST_URL=http://127.0.0.1:3000
export MONEYPENNY_INGEST_TOKEN=   # same as bot ECONOMY_INGEST_TOKEN or MCP_TOKEN
export UEX_API_TOKEN=             # My Apps Bearer
export UEX_SECRET_KEY=            # profile secret-key (submit)
export DATARUNNER_TERMINAL_ID=89

datarunner watch --dir "$HOME/Games/star-citizen/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE/ScreenShots" --dest moneypenny
datarunner ocr --image ./shot.png --device auto
datarunner submit --file snapshot.json --dest both
```

Print Screen in-game, review the table, confirm. No process-memory reading.

UEX `data_submit` types are `commodity|item|vehicle_buy|vehicle_rent`. `fuel`
is stored on Moneypenny only (UEX has a separate fuel API).

New UEX runners must attach a screenshot (90-day evaluation). The CLI sends
the PNG/JPEG as base64 when `--dest uex|both` and a file is present.
