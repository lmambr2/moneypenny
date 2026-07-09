# ACE-Step music generation — design sketch

> **Status:** **A1–A3 shipped** (client + `!generate` + Settings UI). Radio
> auto-fill still queued (A4–A6). Optional DJ / library fill via
> [ACE-Step](https://ace-step.com/) / [ACE-Step-1.5](https://github.com/ace-step/ACE-Step-1.5)
> on a GPU host (e.g. AMD Server / LAN workstation).  
> Related: [radio.md](./radio.md), [editions.md](./editions.md), [remote-llm.md](./remote-llm.md).

---

## 1. Summary

Add an **optional music-generation provider** that turns text (or radio-profile
prompts) into audio files, drops them into the local library, and queues them
like any other local track.

Moneypenny **never embeds** ACE-Step. Same pattern as STT/TTS/LLM:

```text
bot ──HTTP──► ace-step sidecar (or acestep-api on LAN host)
              │
              └─► write WAV/MP3 under MUSIC_DIR/generated/ace-step/
                  LocalProvider.refresh() → queue / radio director
```

**Design rule (inherited):** never put the model between the user and skip.
Generation is async; dead air uses existing bumpers / library until the file is ready.

---

## 2. Goals / Non-Goals

### Goals
- Explicit: `!generate [prompt]` / `!radio gen [prompt]` (rank-gated `@dj` or admin).
- Optional auto-fill: when radio queue is empty / director needs a track **and**
  `aceStep.autoFill` is on **and** the sidecar is reachable.
- Save under library with tags (`source:ace-step`, genre/mood from prompt).
- Probe health; fail open to normal library selection.
- Prefer running on **Server / LAN GPU** (e.g. 192.168.1.89), not the Pi.

### Non-Goals
- Generating on the SBC as a product default.
- Cloud ACE-Step APIs as default (local-only first).
- Replacing LocalProvider as primary source.
- Talk-over-music or multi-stem live mixing.
- Training LoRAs inside Moneypenny (operator uses ACE-Step tools separately).

---

## 3. Topology

| Host | Role |
|------|------|
| **Bot host** (SBC or Server edition) | HTTP client, queue, library index |
| **ACE-Step host** (usually AMD Server / .89) | `acestep-api` or thin Docker wrapper |
| **Pi** | Optional client only; do not co-locate heavy gen with STT/NPU chat |

Split-brain style config (mirrors LLM):

```json
{
  "aceStepEnabled": false,
  "aceStepUrl": "http://192.168.1.89:7865",
  "aceStepAutoFill": false,
  "aceStepTimeoutMs": 300000,
  "aceStepOutputDir": "generated/ace-step"
}
```

**Command:** `!generate <prompt>` (rank-gated `@dj` / admin). Rate limit 3/hour per
user; max 1 concurrent job. Files land in `MUSIC_DIR/generated/ace-step/`.

Compose (optional profile, not edition-default):

```yaml
# future: services/ace-step or external host only
# profiles: ["music-gen"]
```

---

## 4. HTTP contract (adapter)

ACE-Step’s native API may differ; **pin an adapter** so the bot only speaks one shape:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | `{ ok, engine: "ace-step", busy? }` |
| `POST` | `/v1/generate` | Start job |
| `GET` | `/v1/jobs/{id}` | Poll status |
| `GET` | `/v1/jobs/{id}/audio` | Optional download if not written to shared FS |

### `POST /v1/generate` (request)

```json
{
  "prompt": "late-night focus, minor key, no vocals, 110 bpm",
  "durationSec": 120,
  "seed": null,
  "lyrics": null,
  "tags": ["focus", "instrumental"]
}
```

### Job status

```json
{
  "id": "…",
  "status": "queued|running|done|error",
  "path": "/music/generated/ace-step/2026-07-08-….mp3",
  "error": null
}
```

**Shared filesystem (preferred on LAN):** ACE-Step writes into a path bind-mounted
as the bot’s `MUSIC_DIR/generated/ace-step/`. Bot only needs job completion +
relative path — no large HTTP audio transfer.

**HTTP audio fallback:** bot downloads into the same dir if hosts don’t share disk.

---

## 5. Bot architecture

### 5.1 New modules (sketch)

| Path | Owns |
|------|------|
| `bot/src/music/ace-step-client.ts` | Health, submit, poll |
| `bot/src/music/generate-provider.ts` | Orchestrate gen → file → `Song` |
| `bot/src/bot/commands/…` | `!generate`, `!radio gen` |
| Radio director hook | Optional auto-fill when queue starved |

### 5.2 Provider surface

Do **not** require expanding the `platform` union unless UI needs a fourth tab.
Simpler: generation always lands as **`local`** after write (primary path already
indexes `uploads/` / library).

```text
generate() → write file → LocalProvider.refresh() → resolve local path → queue
```

### 5.3 Radio director integration

```text
ProgramDirector.pickNextMusic()
  if library has candidates → existing select_tracks / format clock
  else if aceStep.enabled && aceStep.autoFill && client.healthy()
       → start job, play bumper or wait with timeout
       → on done, queue generated local track
  else → fail open (silence / idle poller as today)
```

**Timeout:** if gen exceeds N seconds, cancel wait and pick library / stay idle.
Never block `skip`.

### 5.4 Prompt construction

| Source | Example |
|--------|---------|
| Explicit command | User text after `!generate` |
| Radio profile | `lobby` / `focus` / `ops` mood strings from config |
| Format clock slot | “instrumental bed”, “high energy” |
| Last tags | From tag store of previous track |

Template (config):

```text
{{profileTone}}. {{slotHint}}. Style tags: {{tags}}. Keep clean for TS voice channel.
```

### 5.5 Rights

| Command / action | Default right |
|------------------|---------------|
| `!generate` / `!radio gen` | `@dj` + admin |
| Auto-fill | config only (operator-enabled); no per-user invoke |
| LLM tool `generate_music` (optional later) | Same as `@dj`; executor enforces |

---

## 6. Library & disk

```text
$MUSIC_DIR/generated/ace-step/
  20260708T120000Z_focus-minor.mp3
  …
```

- Filename: timestamp + slug from prompt (sanitized).
- Tags (TagStore): `source=ace-step`, optional mood/genre from profile.
- **Prune policy:** keep last N files or last D days (config); never delete pinned.
- **Dedup:** optional hash of prompt+seed to avoid regenerating identical requests.

---

## 7. Resource policy (GPU)

On a box that also runs Gemma 12B/31B:

| Setting | Default |
|---------|---------|
| `maxConcurrent` | **1** |
| Gen while analyst running | **No** (or queue gen until analyst free) |
| VRAM | ACE-Step claims &lt;4 GB; still avoid thrashing with 31B resident |

Document next to [gpu-amd.md](./gpu-amd.md): “music-gen vs analyst concurrency.”

---

## 8. Security

- **Local URL only** by default (SSRF: reuse `url-guard` / private-LAN allowlist).
- Rank gate all explicit generate commands.
- Rate limit per invoker (e.g. 3/hour unless admin).
- No automatic cloud upload of audio.
- Treat generated audio as untrusted media (same as uploads): size caps, path under MUSIC_DIR only.

---

## 9. Implementation phases (PR plan)

| PR | Deliverable | Accept |
|----|-------------|--------|
| **A1** | `AceStepClient` + health probe + config keys | Unit tests with mock HTTP — **done** |
| **A2** | `!generate` → job → save under `generated/ace-step/` → play | Unit tests + manual on host with API — **done** |
| **A3** | Settings panel (URL, enable, autoFill) | UI + `/api/bot/ace-step/status` — **done** |
| **A4** | Radio director auto-fill + bumper-while-wait | Dead air → gen → play |
| **A5** | Prune + tags + `!radio gen` alias | Ops-ready |
| **A6** | Optional compose profile / docs for LAN ACE-Step host | Install notes |

---

## 10. Open questions

1. Exact **acestep-api** OpenAPI (adapt in A1 once pinned version).
2. Shared FS vs HTTP download for multi-host.
3. Default **duration** for radio beds vs “full songs.”
4. Whether generated tracks enter **roast/radio history** the same as local.
5. Content policy string in system prompt for gen (org-specific).

---

## 11. Out of scope for v1

- ACE-Step UI embedded in Moneypenny web
- Cover / repaint / vocal-to-BGM modes (can add as later job types)
- Training LoRA from channel library
- Streaming partial audio before job completes
