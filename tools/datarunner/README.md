# Moneypenny datarunner (Linux, Rust)

Linux-native Star Citizen **kiosk screenshot → OCR → review → submit**.
Lives outside the bot image. One static-ish binary; no Python venv on the
gaming PC.

CPU OCR is **Tesseract**. If `--device cuda|rocm|openvino` (or `auto` and a
GPU is present), the runner tries a `rapidocr` CLI on `PATH` and **falls back
to Tesseract** when it is missing.

Docs: [linux-datarunner-plan.md](../../docs/linux-datarunner-plan.md).

## Build

```bash
# Tesseract (CPU OCR)
sudo pacman -S tesseract tesseract-data-eng   # or apt install tesseract-ocr

cd tools/datarunner
cargo build --release
./target/release/datarunner --help
```

Optional GPU OCR: install a RapidOCR CLI onto `PATH` (the old Python extra).
If it is absent, Tesseract still runs.

## Screenshot directory

Never `C:\…`. Pass `--dir` or `DATARUNNER_SCREENSHOT_DIR`.

LUG Helper default (`~/.config/starcitizen-lug/winedir.conf`):

```
$WINEPREFIX/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE/ScreenShots
```

## Destination toggle

```
DATARUNNER_DESTINATION=moneypenny   # never talks to UEX
DATARUNNER_DESTINATION=uex
DATARUNNER_DESTINATION=both         # UEX failure does not fail Moneypenny
```

```bash
export MONEYPENNY_INGEST_URL=http://127.0.0.1:3000
export MONEYPENNY_INGEST_TOKEN=   # same as bot ECONOMY_INGEST_TOKEN or MCP_TOKEN

cargo run --release -- watch \
  --dir "$HOME/Games/star-citizen/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE/ScreenShots" \
  --dest moneypenny --terminal-id 89

cargo run --release -- ocr --image ./shot.png --device auto
cargo run --release -- submit --file snapshot.json --dest both
```

Print Screen in-game, review the table, confirm. No process-memory reading.
