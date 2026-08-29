# Linux-native Star Citizen datarunner — plan

**Status:** Rust CLI at `tools/datarunner/` plus Moneypenny ingest on
`POST /api/economy/ingest/terminal-snapshot`. **Does not** live in the bot
image. Economy audit:
[economy-audit.md](./economy-audit.md). Ecosystem:
[sc-economy-tooling.md](./sc-economy-tooling.md).

---

## Goal

A Linux-native terminal data runner that:

1. Watches a screenshot directory (Wine/Proton/LUG Helper; path **configurable**,
   never hardcoded `C:\…`)
2. OCRs commodity / item / vehicle / fuel kiosk screenshots **locally**
3. Lets the user review/correct rows (CLI table + confirm)
4. Submits through a destination toggle:

```
DESTINATION=uex | moneypenny | both
```

| Dest | Behavior |
|------|----------|
| `uex` | `POST https://api.uexcorp.uk/2.0/data_submit` with Bearer + `secret-key` + optional screenshot |
| `moneypenny` | `POST {MONEYPENNY_INGEST_URL}/api/economy/ingest/terminal-snapshot` — **never talks to UEX** |
| `both` | send to both; **Moneypenny success must not depend on UEX success** |

Never read SC process memory. Screenshots + manual review only. No Windows
WPF, no `.exe` requirement. No scrapers.

---

## Language: Rust (CLI on the gaming PC, not in the bot image)

The station stays TypeScript. This runner is a **small Linux binary** (watch +
OCR + HTTP), which is a good Rust fit: one artifact, no venv, `notify` for
inotify. OCR still shells out to Tesseract (and optional `rapidocr` on PATH).

| Option | Why not / why |
|--------|----------------|
| **TypeScript in the bot** | Pulls Tesseract/ONNX into the TeamSpeak image. Forbidden by “OCR opt-in”. |
| **Python 3.11+** | Fine for sidecars; extra venv on the gaming PC. Replaced by this crate. |
| **Rust CLI** | `tools/datarunner` — `cargo build --release` → `datarunner`. |

Package: `tools/datarunner/` — `datarunner watch --dir … --dest moneypenny`.

---

## OCR backends (CPU default, GPU optional)

CPU Tesseract is the **always-on** path. GPU engines sit **on top** of it:
if the GPU stack is missing or fails, we fall back to Tesseract. The bot
container never installs these.

| Backend | Device | How | Extra install |
|---------|--------|-----|----------------|
| **tesseract** (default) | CPU | `tesseract` CLI | distro package `tesseract` |
| **rapidocr CLI** (optional) | NVIDIA / AMD / Intel | If `rapidocr` is on `PATH` | optional; else Tesseract |

Selection (`OCR_DEVICE=auto|cpu|cuda|rocm|openvino|intel`):

1. If `cpu` → Tesseract.
2. If `auto` → detect NVIDIA (`nvidia-smi` / `/dev/nvidia0`), AMD (`/dev/kfd` or `rocminfo`), Intel (`i915`/`xe` DRM) and try `rapidocr` on `PATH`.
3. On any GPU / RapidOCR failure → log and use Tesseract.

We do **not** vendor PaddleOCR-GPU wheels or PyTorch EasyOCR (huge). RapidOCR
ONNX models stay on the gaming PC.

---

## Moneypenny ingest

Authenticated like other protected APIs — **no new token type**:

| Client | Auth |
|--------|------|
| Dashboard | Session cookie + CSRF Origin (admin for accept/reject) |
| Datarunner CLI | `Authorization: Bearer {ECONOMY_INGEST_TOKEN}` (falls back to `MCP_TOKEN` if ingest token unset) |

CSRF is a **cookie** attack. Bearer-only requests (no session cookie) skip the
Origin check. Cookie sessions still need Origin.

```
POST /api/economy/ingest/terminal-snapshot
{
  "source": "datarunner",
  "game_version": "4.10.0",
  "environment": "LIVE" | "PTU",
  "id_terminal": 89,
  "terminal_name": "...",
  "type": "commodity" | "item" | "vehicle_buy" | "vehicle_rent" | "fuel",
  "prices": [{ "id_commodity", "name", "price_buy", "price_sell", "scu_buy", "scu_sell", "status_buy", "status_sell" }],
  "screenshot_sha256": "...",
  "captured_at": 1756...
}
```

Stored in SQLite (`economy_terminal_snapshots`). Accepted snapshots feed L2
cache source `local`. `!econ prices` / `GET /api/economy/prices` **prefer local
rows when `captured_at` is newer than the UEX cache `fetchedAt`**. UEX remains
the fallback (and the commodity catalog).

UEX `data_submit` does not take `fuel`; fuel snapshots are Moneypenny-local
unless we later map them to `GET/POST` fuel endpoints.

---

## Linux screenshot discovery

`--dir` always wins. Otherwise, in order:

1. `DATARUNNER_SCREENSHOT_DIR`
2. `$XDG_CONFIG_HOME/starcitizen-lug/winedir.conf` +
   `drive_c/Program Files/Roberts Space Industries/StarCitizen/{LIVE,PTU}/*creenShots*`
3. `~/Games/star-citizen/…` (LUG wiki default)

Watch **ScreenShots** and **Screenshots**. Inotify via `notify` (Rust).

---

## CLI MVP

```
datarunner watch --dir DIR --dest moneypenny|uex|both
datarunner ocr --image FILE [--device auto]
datarunner submit --file snapshot.json --dest …
```

Review is a terminal table + `y/N` unless `--yes`.

---

## Acceptance

- [x] vitest economy + ingest tests
- [x] three docs in `docs/`
- [x] runner can target Moneypenny and **never talk to UEX**
- [x] destination toggle `uex | both`
- [x] `!econ prices` uses a locally ingested snapshot when newer than UEX
- [x] CPU Tesseract + optional NVIDIA/AMD/Intel GPU OCR extras
- [ ] Live UEX submit with a real secret-key (operator; not CI)
