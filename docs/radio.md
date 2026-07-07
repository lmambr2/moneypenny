# Project Moneypenny — Radio Mode / Autonomous DJ (design v2)

> Feature design doc. Continues `DESIGN.md` §4 (control architecture), §8 (rights),
> §9 (LLM), §10 (voice/TTS) and the ROADMAP retrieval phases (5–7). Style mirrors
> [`docs/voice.md`](./voice.md) and [`docs/rank-gating.md`](./rank-gating.md).
>
> **v2 changes (post-review):** `@dj` op group added; the local-index extension is
> promoted from optional → core; bumper persistence/caching defined; prerecorded
> "bumper-eligible" assets added as a first-class source; a tag overlay + dashboard
> tag editor + analyzer sidecar + `select_tracks` tool specified (§9); the
> streaming-service metadata reality is documented (Spotify deprecations, Tidal
> key/BPM) and the recommended selection substrate is **your own analyzer-populated
> tags, not a third-party API**.

**Status:** backend **implemented** (R-R1 – R-R5 mechanism-complete on `dev`,
2026-07-03; commit refs in §13). Dashboard surfaces shipped (`e02b87f`): Settings
**Radio / DJ** panel, Library **Track tags** editor + star ratings, `!radio pin`
(pin-to-pool). Pi deployed at `e02b87f`. **Analyzer sidecar** (OQ2 keyfinder+aubio) ships in the
bot image + `POST /api/music/analyze` + Library “Analyze library” when enabled in Settings.
Still pending: TS live smoke (bumper test, `!radio ops`), re-run OQ3 when a full org
library is mounted, and optional R-R6.
**Gating:** off by default (`radio.enabled = false`); no profiles ship — author
them in config before `!radio ops` has anything to switch to.
**Note:** command registration now goes through the single `COMMAND_MANIFEST`
(`bot/src/bot/commands.ts`); the multi-list registration described against
older revisions no longer exists.

---

## 1. Summary

Add a **radio mode** where Moneypenny runs the channel like an autonomous DJ:
between songs (every *N* tracks) or on dead air, she plays a short (15–60 s)
**bumper** — a prerecorded jingle/ID, or a synthesized tip/lore drop/time check
pulled from the doctrine RAG / MemPalace and spoken through the existing TTS path
— then carries on with the music. An operator sets the **op context**
(`!radio ops mining`); that one switch retunes both music selection and bumper
content/tone.

This is **not** a new audio stack — it's a thin **program director** over the
existing single-stream player, the trackEnd boundary, the idle poller, the
RAG/MemPalace retrieval, and the TTS injection Phase 2 already built. Its only job
is to decide *what plays next and when to insert non-music elements*. The player
already executes.

Design rule (inherited): **never put the model between a user and the music.** The
director fails open to `playNext()`. A down LLM/RAG/TTS degrades to prerecorded or
canned liners, never to a gap or a stall.

---

## 2. Goals / Non-Goals

### Goals
- Inject bumpers **every N songs** and/or after **Y seconds of dead air**.
- Bumpers come from (a) **prerecorded, tagged audio** (jingles/IDs/sweepers), or
  (b) **generated** content — doctrine RAG / MemPalace rewritten to a short spoken
  script in persona, then TTS — or (c) **canned** station IDs / time checks.
- **Op-context profiles** that retune music selection **and** bumper topics/tone.
- A **format clock** (AzuraCast-style rotation wheel) so the song/bumper/ID mix is
  declarative, not hard-coded.
- **Tag-driven selection** on local tracks (genre, subgenre, mood, key, BPM,
  energy) populated by a local analyzer + embedded tags + manual edits, queryable
  by the AI via a `select_tracks` tool.
- 100% local for the core. Off by default; controls gated through the rights model,
  with a new **`@dj`** op group.

### Non-Goals
- **No talk-over-music ("ramping").** Single stream, no mixer (`DESIGN` §10A) —
  bumpers play **at song boundaries / on dead air**, sequential with music. True
  ducking under a live bumper needs a mixer; out of scope. (The rare forced
  mid-song bumper reuses the voice save→speak→resume trick, §6.4.)
- **Not LibreTime/AzuraCast/Liquidsoap as the engine** (§7a).
- No public internet broadcast in core (Icecast tee is an optional extension, §10).
- **The LLM does not "analyze audio."** It is a text model on the NPU; it cannot
  hear. Audio features come from a **DSP analyzer** (§9); the LLM only *selects on*
  the resulting tags and *rewrites retrieved text* into bumper scripts.

---

## 3. What we borrow from the named projects

| Project | Useful | Verdict |
|---|---|---|
| **AzuraCast / LibreTime** | Concepts: playlists, **smart blocks** (dynamic selection by criteria), **rotation "clocks"**, **every-N jingle injection**, a distinct **jingle/media-type** for non-song assets, dayparting. | **Borrow the model, not the stack** (§7a). The smart-block + jingle-type ideas map directly onto §8/§9 and the prerecorded-bumper source. |
| **Icecast** | Streaming sink; historically fed TS3/Mumble. | **Optional extension only (§10).** Core output is the bot's Opus injection into TS6; an Icecast mount fed the same PCM is a nice add. |
| **Stanton / The Base / HCN Radio** | Tone/persona reference; some publish live stream URLs. | Persona/liner reference; a live relay is **already** a `StreamProvider` URL (`DESIGN` §7.3) — a one-field profile (§8). |

---

## 4. Architecture

```mermaid
flowchart TD
    subgraph EXIST["Existing (reused)"]
        PLAYER[AudioPlayer\nsingle Opus stream]
        QUEUE[PlayQueue]
        ENGINE[PlaybackEngine\nresolve + playNext]
        IDLE[IdlePoller\n30s presence poll]
        TTS[KokoroTtsClient]
        RAG[RetrievalStore.query\nrank-gated chunks]
        MEM[MemPalaceClient]
        LLM[LlmModule.ask\nscript rewrite]
        RIGHTS[RightsEngine\nclassification floor + @dj]
        LOCAL[LocalProvider\nindex + resolve]
    end

    subgraph NEW["Radio (new)"]
        DIR[RadioDirector\nclock + counters + dead-air timer]
        CLOCK[FormatClock\nwheel + ops profile]
        BF[BumperFactory\nprerecorded | generated | canned]
        CACHE[Bumper cache\nunclassified-only]
        SINK[SpeechSink.playSpeech]
        TAGS[TagStore overlay\n+ Analyzer sidecar]
        SEL[select_tracks tool]
    end

    PLAYER -- trackEnd --> DIR
    IDLE -- onPoll --> DIR
    ENGINE -- queue dry --> DIR
    DIR --> CLOCK
    CLOCK -- "song slot" --> ENGINE
    CLOCK -- "bumper slot" --> BF
    BF -- prerecorded --> LOCAL
    BF -- generated --> RAG
    BF --> MEM
    BF --> LLM
    BF <--> CACHE
    BF --> SINK
    SINK --> TTS --> PLAYER
    RIGHTS -. floor .-> BF
    IDLE -. present members .-> RIGHTS
    SEL --> TAGS
    TAGS --> LOCAL
    ENGINE --> SEL
```

Three new units (director / clock / factory) plus a **TagStore + analyzer** and a
**`select_tracks`** tool (§9). A small `SpeechSink.playSpeech(text)` is extracted
from `VoiceSession.createOutput().speak()` so radio and voice share one "speak into
the channel" path.

---

## 5. Integration seams (exact, against current code)

### 5.1 "Every N songs" boundary — `bot/src/bot/lifecycle/event-bindings.ts`
Today: `player.on("trackEnd") → voice.handleTrackEnd(playNext) → (if not resumed) playNext()`.
Insert the director **after** voice (voice keeps precedence), **in place of** the bare `playNext`:

```ts
player.on("trackEnd", () => {
  void voice.handleTrackEnd(() => playNext()).then((resumed) => {
    if (resumed) return;
    radio.onTrackBoundary(() => playNext()); // bumper, or just next song
  });
});
```

> ⚠️ This seam is the same shared voice wiring the parallel voice session owns
> (`bot/src/bot/voice/session.ts` `captureDuck`/`savedMusic` state machine). R-R1
> must coordinate before editing `event-bindings.ts`.

### 5.2 "Bumper ends → advance, don't re-evaluate"
A bumper is an audio file → it also emits `trackEnd`. One-shot guard
(`pendingAfterBumper`) consumed by the director's own `handleTrackEnd` — the exact
`suppressNextTrackAdvance`/`savedMusic` pattern already in
`bot/src/bot/voice/session.ts`. Order: voice → **radio** → plain `playNext`.

### 5.3 Dead air — two signals
- **Primary:** arm `deadAirTimer` when a boundary yields no song
  (`PlaybackEngine.playNext()` → `false`, queue dry). After `radio.deadAirSeconds`,
  if idle + humans present + on → fill (bumper, optionally auto-program from profile §8).
- **Backstop:** `IdlePoller.onPoll(clients, humanCount)` (30 s) re-checks
  `player.getState() === "idle"`. The poller's `clients` also feed the floor (§6.3).

### 5.4 / 5.5 Speak + retrieve
Reuse `SpeechSink.playSpeech` (TTS → temp file → `player.play`) and
`RetrievalStore.query` / `MemPalaceClient` / `LlmModule.ask` as in v1.

---

## 6. Bumper pipeline (`BumperFactory`)

### 6.1 Sources (configurable, weighted per profile)
| Source | Pull | Needs | Reliability |
|---|---|---|---|
| `prerecorded` | a **bumper-tagged** local asset (§9.2), optionally filtered by `bumperKind`/op scope | upload only | **Highest** — already audio, zero gen latency, zero injection risk. Default + fallback. |
| `stationId` / `timeCheck` | canned text → TTS | TTS | High. Always available. |
| `nowPlaying` | queue/history → short script | TTS | High. "That was X, up next Y." |
| `doctrine` | `RetrievalStore.query(topic)` → LLM rewrite | RAG + LLM | Floored (§6.3). |
| `memory` | org-scoped MemPalace → LLM rewrite | MemPalace + `memoryBroadcastOptIn` | Off by default; org facts only, never private `!remember` (§6.3). |

### 6.2 Script generation + cap
Generated sources: retrieved text → model with *"rewrite as a spoken bumper, under
N words, one breath, no markdown, invent nothing"* persona prompt, **`tool_choice:
"none"`** (a bumper can never emit an action), length-capped to
`radio.maxBumperSeconds` (~150 wpm; default 30 s ≈ 75 words; 15 s floor). `stationId`/
`timeCheck` skip the model.

### 6.3 Security — a bumper is a *broadcast* (load-bearing)
Per `DESIGN` §8/§14.1 and **"the LLM proposes, the executor disposes"**, enforced in
the director, server-side:
- **Classification floor = lowest clearance among present members.** Director takes
  `clients` from the idle poller, resolves each member's `doctrine:<level>` via
  `allowedClassificationsFor(subject, rightsEngine)` (`bot/src/bot/rights/subject.ts`),
  passes the **intersection** to `RetrievalStore.query`. Default/floor: **`["unclassified"]`**.
  One uncleared listener → the whole window is unclassified. Stricter than `!ask`
  (which gates to one asker); a broadcast gates to the least-cleared listener.
- **No private-memory leakage.** `memory` source draws only from an explicit
  org-scoped MemPalace namespace; gated behind `radio.memoryBroadcastOptIn`
  (default off).
- **Floor applied to the retrieval filter** before text reaches the model.
- **Rate/spam/DoS:** cooldown, max/hour, min-present, quiet hours. Never delays or
  blocks music — limit hit → `playNext()`.

### 6.4 Forced mid-song bumper (rare)
`!radio bumper`/`!radio say` speak now via the voice save-position → speak → resume
path (`savedMusic`/`tryResumeMusic`). Single stream, so the song pauses for the
drop — fine for the occasional forced bumper, not the default rotation.

### 6.5 Persistence / caching (generated bumpers do NOT go in the music library)
- **Generated TTS bumpers are cached, not added to `MUSIC_DIR`.** A dedicated
  `data/bumper-cache/` dir + a small index table (`bumper_cache(hash, text, source,
  builtFloor, voice, createdAt, hits, ttl)`), keyed by `sha1(sourceChunkId + script
  + voice)`. Saves NPU+TTS cycles on repeated IDs/liners, enables pre-fetch ahead of
  the boundary, and gives an audit trail of what was broadcast. Evictable by TTL/LRU.
- **Cache only at the unclassified floor.** A cached bumper can be replayed to
  *anyone*, so only `builtFloor === "unclassified"` entries are cacheable; any
  higher-clearance window regenerates and is never written to cache. This keeps the
  cache from becoming a classified-leak vector. (Cache also invalidates when the
  underlying doctrine chunk changes — key includes the chunk id/content hash.)
- **Prerecorded bumpers are the opposite** — they *are* persistent library assets
  (§9.2), just flagged so they're never served as music.
- **Pin-to-pool:** an admin can promote a one-off generated bumper into the
  prerecorded pool (writes the cached audio into the bumper asset dir + tags it),
  bridging generated → prerecorded.

---

## 7. Format clock + why not the heavy stacks

### 7. Clock (rotation model)
Declarative wheel evaluated by a **pure** `FormatClock`:
```jsonc
{
  "wheel": [
    { "slot": "song" }, { "slot": "song" }, { "slot": "song" },
    { "slot": "bumper", "sources": ["prerecorded", "doctrine", "nowPlaying"] },
    { "slot": "song" }, { "slot": "song" }, { "slot": "song" },
    { "slot": "stationId" }
  ],
  "deadAir": { "afterSeconds": 25, "fill": ["prerecorded", "stationId"], "thenAutoProgram": true },
  "quietHours": [{ "from": "02:00", "to": "08:00", "bumpers": false }],
  "minPresentToBroadcast": 1, "cooldownSeconds": 180, "maxBumpersPerHour": 12
}
```
"Every N songs" = *N* `song` slots between non-song slots (the `radio.everyNSongs`
shortcut writes this). `thenAutoProgram` seeds the queue from the active profile so
the station self-heals when dry (§8).

### 7a. Why not LibreTime / AzuraCast / Liquidsoap as the engine
1. **They are the player.** Moneypenny already injects a hardened single Opus
   stream into TS6; those platforms would replace it and then need a *second* bridge
   back into TS6 — more moving parts, not fewer.
2. **Wrong runtime for the box.** Liquidsoap (OCaml) + Icecast + a PHP/Python app +
   its own DB is heavy on an RK3588 already running the bot, TS6, the NPU LLM,
   embeddings, and optional STT/TTS. The director is a few hundred lines of TS
   in-process.
3. **They lack the differentiators** — TTS bumpers from a rank-gated org knowledge
   base + memory, in persona, retuned by op context. We'd build that regardless, so
   we build *only* that and reuse their rotation-clock/smart-block vocabulary.

---

## 8. Op-context / format profiles

`!radio ops <profile>` sets the active profile, binding music selection + bumper
theming.
```jsonc
{
  "name": "mining",
  "music": {
    "select": { "mood": ["calm","focus"], "genreAny": ["ambient","synthwave"], "bpmMax": 110, "energyMax": 0.5 },
    "playlistRefs": [                             // expanded via getPlaylistSongs (§8.1)
      { "platform": "local",   "ref": "ops-mining" },                          // ✅ now
      { "platform": "youtube", "ref": "https://youtube.com/playlist?list=…" }  // ✅ now
      // { "platform": "spotify", "ref": "https://open.spotify.com/playlist/…" } // ⏳ §8.1
    ],
    "shuffle": true,
    "seedQueries": ["ambient","focus"],           // sparse-data fallback
    "relayUrl": null                              // or a live SC-radio stream URL (last resort)
  },
  "bumper": {
    "topics": ["refinery yields","ore types","quantanium handling","Aaron Halo"],
    "sourceWeights": { "prerecorded": 3, "doctrine": 5, "nowPlaying": 2, "stationId": 1 },
    "tone": "calm logistics dispatcher"
  }
}
```
Starter profiles: `combat`, `mining`, `salvage`, `hauling`, `lobby`/`idle`.

**Selection precedence:** `music.select` (tag query, §9.4) + `playlistRefs`
(expanded, §8.1) form the primary pool; `seedQueries` (free-text `play_music`) is the
sparse-data fallback; `relayUrl` is last (hand off to a live stream). Dead-air
auto-program uses the same selection.

### 8.1 Playlist sources (per profile)
`playlistRefs` are expanded once via the provider's `getPlaylistSongs(ref)` and merged
into rotation — distinct from `select_tracks` (a live tag query); the two compose.
Per-platform support **today** (verified in-code):

- **`local`** (M3U/M3U8 by name/path) — ✅ now (`LocalProvider`).
- **`youtube`** (playlist URL or bare `list=` id) — ✅ now; expands via yt-dlp
  `--flat-playlist`. This is the existing `!playlist -y` path reused — **no new code**.
  (Note: `!play <playlist url>` is single-video/unreliable; the playlist path is
  `getPlaylistSongs`.)
- **`spotify`** / **`tidal`** — ⏳ not yet (deferred to R-R6 per OQ8).
  `StreamProvider.getPlaylistSongs` is a stub returning `[]`; Spotify/Tidal refs
  currently resolve to a *single track* only (bridge `/resolve?uri=` or
  link→"Artist Title" search). Needs a service-aware `getPlaylistSongs` that
  enumerates the playlist then resolves each track via that existing single-track
  path. Until built, a spotify/tidal ref is skipped with a log — never blocks the
  profile.

**Mechanics.** `shuffle:true` drops expanded tracks into the Random/RandomLoop bag
(rating-weighting §9.7 still applies); `false` keeps playlist order (Sequential).
External lists drift, so re-expand on profile switch + dead-air auto-program and cache
the expansion briefly (≈10 min, keyed by ref) to avoid re-hitting yt-dlp/the API every
boundary; local M3U re-reads on `LocalProvider.refresh()`. Playlist *music* isn't
classified — the bumper floor (§6.3) gates only spoken bumpers, not track selection.

---

## 9. Tags, analysis & selection (covers prerecorded-bumper, key/mood/subgenre, dashboard editing, streaming APIs)

### 9.0 Today's reality (verified in-code 2026-06-30)
`LocalProvider.indexFile` (`bot/src/music/local.ts:157-161`) parses **only** title /
artist / album / duration / cover via `music-metadata`. No genre, BPM, key, mood, or
subgenre is read (even though `music-metadata` exposes `common.genre`/`common.bpm`).
`opaqueId = sha1(realPath)` (`local.ts:50`). `IndexedSong` adds only `absolutePath`.
There is **no music tag editor and no songs/tags DB table** — only *doctrine* has tags
(`Library.vue`, read-only). Uniform random pick is `unplayed[floor(random*len)]`
(`bot/src/audio/queue.ts:189`). So all tag work below is net-new. **(Per review: the
index extension is core, not optional.)**

### 9.1 Tag schema + overlay store (non-destructive)
New SQLite table keyed by the LocalProvider's existing stable opaque id
(`sha1(realpath)` — already computed as `opaqueId`):
```
track_tags(
  trackKey TEXT PRIMARY KEY,
  genre TEXT, subgenre TEXT, mood TEXT,        -- selection tags
  musicalKey TEXT, keyScale TEXT, bpm INTEGER, energy REAL, danceability REAL,
  bumper INTEGER DEFAULT 0,                     -- bumper-eligible flag (§9.2)
  bumperKind TEXT,                              -- id | sweeper | liner | ad | sting
  opsScope TEXT,                                -- optional CSV of ops profiles
  ratingAvg REAL, ratingCount INTEGER,         -- denormalized aggregate (§9.7)
  source TEXT,                                  -- embedded | analyzer | api | manual
  updatedAt INTEGER
)

-- canonical per-rater ratings (§9.7); ratingAvg/Count above are derived from this
track_ratings(
  trackKey TEXT, rater TEXT,                    -- rater = "ts:<uid>" | "web:<userId>"
  stars INTEGER,                                -- 1..5
  updatedAt INTEGER,
  PRIMARY KEY (trackKey, rater)                 -- one rating per rater per track (upsert)
)
```
- **Overlay, not file rewrite** — survives re-index, no corruption risk, manual
  edits win. Optional opt-in **write-back** to file metadata (off by default) for
  portability.
- **Precedence:** `manual` > `analyzer`/`api` > `embedded`.
- Index extension: `IndexedSong` gains the fields; `indexFile` reads embedded tags
  where present (`music-metadata` exposes `common.genre`, `common.bpm`,
  `common.year`, and ID3v2.4 `TMOO`/TXXX for mood/subgenre via native frames), then
  merges the overlay over the top.

### 9.2 Prerecorded "bumper-eligible" assets
This is AzuraCast's **jingle media type**. Upload via the existing
`LocalProvider.uploadSong` path, then set `bumper = 1` (+ optional `bumperKind`,
`opsScope`) in the overlay — at upload time (a flag on the upload endpoint) or via
the tag editor (§9.3). The `prerecorded` bumper source (§6.1) picks a weighted/random
bumper-eligible asset, optionally filtered by kind/op profile, and plays it directly
(no LLM/TTS). Bumper-flagged assets are **excluded from music search/queue** so
they never surface as songs.

### 9.3 Editing tags from the dashboard (build it)
- New **`PATCH /api/music/tracks/:id/tags`** (admin/`@dj`-gated, CSRF, like the rest
  of the music API), plus a bulk endpoint and a "mark bumper-eligible" action.
- UI: an edit affordance on `SongCard.vue` + a Library **Tracks** tab (mirrors the
  existing doctrine Tracks/Doctrine layout) with inline fields for genre/subgenre/
  mood/key/BPM/energy and the bumper flag.
- A **"re-analyze"** button to (re)run the analyzer (§9.5) for selected tracks.

### 9.4 The `select_tracks` tool (how the AI actually picks music)
A new tool alongside `play_music` (`bot/src/llm/tools.ts`), keeping the surface tiny
for the small model:
```jsonc
select_tracks({
  mood?: string[], genreAny?: string[], subgenreAny?: string[],
  bpmMin?: number, bpmMax?: number, musicalKey?: string, energyMin?: number, energyMax?: number,
  ratingMin?: number,   // 1..5, on the smoothed aggregate (§9.7)
  limit?: number
}) // → queues matching LOCAL tracks via the same resolve+execute path play_music uses
```
The AI selects by **querying your tag index**, not by ingesting third-party audio
features. This is the robust seam: it works offline, it's auditable, and it's
exactly the rights-gated executor path the rest of the bot uses. Harmonic ("Camelot")
sequencing (OQ5) is a deterministic post-filter on `musicalKey`/`keyScale` in the
executor — not the model's job.

### 9.5 Acquiring genre / subgenre / mood / key / BPM / energy
**Measure first (OQ3).** `bot/src/tools/library-tag-scan.ts` counts embedded
genre/BPM/key/mood/subgenre coverage so the analyzer choice (OQ2) is data-driven:

```bash
cd bot && npm run scan:tags /path/to/music   # dev
./scripts/oq3-tag-scan.sh                    # Pi (bot container)
```

**Primary — local analyzer sidecar (per OQ2: keyfinder-cli + aubio first).**
A CPU batch + on-ingest pass over `MUSIC_DIR`, results written to the overlay, cached
by file hash, never blocking playback:
- **keyfinder-cli / libKeyFinder** (Mixxx's detector) for **key**; **aubio** for
  **BPM** — light C, objective, reliable. This is the default first pass.
- **Essentia** (Apache-2.0) is the richest single tool — one pass yields key + BPM +
  danceability + mood + genre via its classifier models — but the TF models are
  heavy on the RK3588 and its mood/genre tags are approximate. Add it as an **opt-in
  second pass** only once the OQ3 scan shows embedded mood/genre coverage is thin.
- **bliss-rs / blissify** (Rust) for tempo + timbre + mood-similarity if a lighter
  footprint is wanted.

**Secondary — internet enrichment (fill gaps + tag streamed tracks; ToS-gray, fragile):**
- **Spotify audio-features / audio-analysis / recommendations: not available.** Per
  Spotify's 2024-11-27 Web API change these are 403/404 for any app created after
  that date (extended quota now requires 250k MAU), and Spotify explicitly cited not
  wanting the data used to train AI. **Do not design selection around Spotify.**
  (Search + basic track/artist metadata still work; energy/valence/key/recs do not.)
- **Tidal: enrichment only (OQ4).** Tidal's catalog carries `key`, `keyScale`, and
  `bpm` per track, so when you resolve a track through the Tidal bridge you *may*
  grab those into the overlay — but the **local analyzer is the canonical key/BPM
  source**, so Tidal is never a dependency. Use the **official** Open API only; do
  not build on reverse-engineered internal endpoints.
- **Bandcamp:** no catalog API; the yt-dlp Bandcamp extractor can scrape a release
  page's user **tags** (genre/location/mood-ish), per-URL only.
- **Static datasets:** **AcousticBrainz** (key/BPM/mood/genre by MusicBrainz ID) is a
  free dump, frozen since ~2022 — usable as a one-shot enrichment for tracks with
  MBIDs, with stale-coverage caveats.

**AI-assisted (cheap heuristic, human-overridable):** for mood/subgenre, the LLM can
infer from *text* (title + artist + existing genre) — a guess, flagged
`source: manual`-reviewable, never ground truth. Text→text classification, distinct
from audio analysis.

### 9.6 Can the AI use Tidal/Spotify/Bandcamp API data to pull desired music?
- **In the codebase today: no.** `StreamProvider` resolves a *specific link* to a
  track and plays it; `play_music` is free-text → resolve. No search/recommendation/
  feature-query integration.
- **Spotify: no path** (deprecations above).
- **Tidal: partial** — its search/playlist surfaces + per-track key/BPM make it the
  one streaming service where AI-assisted selection is plausible, behind auth/approval
  and ToS caveats; best as "select/enrich tracks you then stream."
- **Decision (OQ4/OQ8):** build selection on the **local TagStore + analyzer** via
  `select_tracks`; treat streaming services as **playback sources** and
  **opportunistic enrichment**, not as the selection brain.

### 9.7 Star ratings (1–5)
A library feature radio *consumes* — same overlay, same selection seam. Distinct
from the existing `!vote` (vote-skip).

- **Model (OQ6): per-rater, with a derived aggregate** (matches the rest of the
  system — memory, roast). `track_ratings(trackKey, rater, stars)` holds one upserted
  row per rater per track; `ratingAvg`/`ratingCount` on `track_tags` are denormalized
  from it. `rater` is namespaced — `ts:<uid>` for chat/voice, `web:<userId>` for the
  dashboard. **ts↔web is not linked in v1** — counted as distinct raters; Bayesian
  smoothing damps the negligible double-count. Default selection uses the aggregate
  (**station favorites**); an asker can also filter to their own ratings.
- **Aggregate is smoothed, not raw.** IMDB-style Bayesian mean `(C*m + Σstars)/(C + n)`
  (m = global mean, C ≈ 5 prior) so a lone 5-star doesn't outrank a well-rated track.
  Thresholds use the smoothed score; the UI shows raw avg + count.
- **Low-stakes** — not doctrine, no classification gating; one rating per rater
  (upsert) prevents inflation. Gated by a broadly-granted `rate` token.
- **Surfaces:**
  - Chat/voice: `!rate <1-5>` (now-playing), `!rate <1-5> <query>` (specific track),
    `!unrate`. Voice-compatible ("moneypenny rate this five").
  - Dashboard: a star widget on `Player.vue` / `SongCard.vue` / the Library Tracks
    tab → `POST /api/music/tracks/:id/rating` (the auth'd web user is the rater).
- **Selection:** `select_tracks` gains `ratingMin` (§9.4); profiles can set it
  (e.g. `lobby` = `ratingMin: 4`); a "favorites" dead-air auto-program.
- **Rotation weighting (OQ7): gentle auto-on in radio mode, off in manual.** In
  Random/RandomLoop under radio mode, the uniform pick in `PlayQueue.next()`
  (`queue.ts:189`, `unplayed[floor(random*len)]`) is swapped for a rating-weighted
  draw (weight ∝ smoothedScore^k). The exponent `k` and a weight cap (a 5-star ≲3× an
  unrated track, default) are **config-exposed** (`radio.ratingWeight`). Manual
  `!mode random` stays uniform — `queue.ts:189` is the untouched fallback path.
- **Bumper hook (minor):** the `nowPlaying` source can name a standout rating
  ("a station favorite — four stars").
- **Future (not MVP):** implicit signals — `play_history` + skip-rate blended with
  explicit stars.

---

## 10. Optional extension — broadcast out (Icecast) + relay in
- **Out:** a second PCM sink alongside TS voice → a local Icecast mount (ffmpeg →
  Icecast source). Non-TS clients tune in to the same set. Opt-in, documented like
  the web UI.
- **In:** a live SC-radio stream is already a `StreamProvider` URL; a profile sets
  `music.relayUrl` to "relay an existing station, drop our own bumpers at the
  boundaries." Bumpers over a relay are timer-driven (no track boundaries we control).
Both out of MVP, gated off.

---

## 11. Configuration (`radio` block in `BotConfig`)
Mirrors the `voice`/`llm` blocks (default off, hot-reloadable). Defaults reflect the
resolved OQs:
```ts
interface RadioConfig {
  enabled: boolean;            // default false
  everyNSongs: number;         // default 4; 0 = clock-only
  deadAirSeconds: number;      // default 25
  maxBumperSeconds: number;    // default 30
  minPresentToBroadcast: number; cooldownSeconds: number; maxBumpersPerHour: number;
  quietHours: { from: string; to: string }[];
  sources: ("prerecorded"|"stationId"|"timeCheck"|"doctrine"|"memory"|"nowPlaying")[];
  memoryBroadcastOptIn: boolean; // default false — org-namespace only (OQ1)
  classificationFloor?: string[]; // override; default = lowest-present
  activeProfile: string; profiles: Record<string, RadioProfile>;
  clock?: FormatClock; ttsVoice?: string;
  // OQ2: keyfinder+aubio first; essentia is the opt-in second pass.
  analyzer?: { enabled: boolean; tool: "keyfinder"|"essentia"|"bliss"; onIngest: boolean };
  // OQ7: gentle rating-weighted rotation, radio-mode only.
  ratingWeight?: { enabled: boolean; exponent: number; maxRatio: number }; // default {true, ~1, 3}
  // OQ5: harmonic ordering of the upcoming queue window, per profile, default off.
  harmonicSequencing?: boolean;
  icecast?: { enabled: boolean; mountUrl: string };
}
```
Settings UI: a "Radio / DJ" panel (master toggle, active profile, every-N + dead-air
sliders, source checkboxes, memory-broadcast opt-in with a warning, analyzer toggle,
"test bumper now"). Plus the Library **Tracks** tag editor (§9.3).

---

## 12. Commands (`!radio …`) + `@dj` gating
Routed through the same `ControlRouter` (rank-gated, voice-compatible). Each
subcommand is its **own rights token** so it can be granted granularly.

| Command | Token | Granted to | Effect |
|---|---|---|---|
| `!radio` / `!radio status` | `radio` | member | Mode, profile, songs-until-next-bumper. |
| `!radio on` / `!radio off` | `radio.power` | **admin** | Master toggle. |
| `!radio ops <profile>` | `radio.ops` | **`@dj`** + admin | Set op context. |
| `!radio ops list` | `radio` | member | List profiles. |
| `!radio bumper [topic]` | `radio.bumper` | **`@dj`** + admin | Force a bumper now (§6.4). |
| `!radio say <text>` | `radio.say` | **`@dj`** + admin | One-off liner (floor + length checked). |
| `!radio skip` | `radio.skip` | **`@dj`** + admin | Skip the queued/forced bumper. |
| `!radio pin` | `radio.pin` | admin | Promote last generated bumper → prerecorded pool (§6.5). |
| `!rate <1-5> [query]` · `!unrate` | `rate` | member | Rate now-playing (or a track); per-rater, aggregated (§9.7). |

**`@dj` group:** a new entry in `scripts/rights-rank-gating.json` mapping a TS
server-group id → allow `[radio.ops, radio.bumper, radio.say, radio.skip]` (and the
tag-edit API). It does **not** grant `radio.power` or any music-transport admin
token — section leads can run the station's *programming* without full admin.
Document in `docs/rank-gating.md`. Tag-edit endpoints (§9.3) accept admin **or** `@dj`.

---

## 13. Phasing + acceptance

- [x] **R-R1 — Director MVP** (`8bfac36`, `cc62a7e`, `ae6327e`, `75586aa`). `RadioDirector` + pure `FormatClock`
  + `prerecorded`/`stationId`/`timeCheck`/`nowPlaying` + `SpeechSink` + dead-air
  timer + idle-poller backstop + bumper cache (§6.5). Off by default. **Touches the
  shared `event-bindings.ts` voice seam (§5.1) — coordinate with the voice session.**
  *Accept:* a prerecorded/canned bumper plays every N tracks; a fill fires after
  `deadAirSeconds`; radio-off is byte-identical to today; a TTS outage never opens a
  music gap.
- [x] **R-R2 — TagStore + analyzer** (`e9d0e4a`, `846d32d`, `ba02614`, `85eaf6e`, `0184783`). Overlay table,
  `indexFile` reads embedded tags, analyzer sidecar (**keyfinder+aubio default**, OQ2)
  batch + on-ingest, `bumper`-eligible flag + the prerecorded source consuming it.
  *Accept:* a re-analyze pass populates key/BPM (+ mood/genre if Essentia opt-in);
  an uploaded jingle marked `bumper` plays as a bumper and never appears in music
  search.
- [x] **R-R3 — backend + Vue** (`a13cba6`, `52c309b`, `a7811f9` + Library track-tags + star widget). `PATCH …/tags` +
  Library Tracks tab + bulk + bumper-flag actions; `@dj` rights entry + granular
  `radio.*` tokens; the `track_ratings` table + `!rate`/`!unrate` + star widget +
  `POST …/rating` + denormalized aggregate (§9.7). *Accept:* a `@dj` user sets tags
  and runs `!radio ops`/`!radio bumper` but cannot toggle power or run
  transport-admin commands; tag edits + ratings persist across re-index;
  `select_tracks ratingMin: 4` returns only station favorites.
- [x] **R-R4 — content engine + select_tracks + profiles** (`d528dbe`, `c0014ca`, `fd03d8b`). Doctrine/memory
  → LLM script (`tool_choice:"none"`, capped) with the **classification floor**;
  `select_tracks` tool; profiles bind `music.select` + `playlistRefs` (local + YouTube,
  §8.1) + bumper themes; `!radio ops`. *Accept:* a doctrine note becomes a ≤cap spoken
  bumper; an uncleared member present forces unclassified-only (adversarial floor
  test); `!radio ops mining` shifts both music and bumper topics; LLM/RAG down →
  prerecorded/canned fallback.
- [x] **R-R5 — backend + Settings panel** (`e851666` + Radio/DJ panel, test-bumper, status API). Custom wheels, quiet hours,
  limits, the Radio/DJ panel + harmonic-sequencing toggle (OQ5). *Accept:* a custom
  wheel honored; quiet hours suppress; limits hold under flood.
- [ ] **R-R6 (optional, not started) — Broadcast out / relay in + streaming providers (OQ8).**
  Icecast tee; `relayUrl`; **Spotify/Tidal `getPlaylistSongs`** (enumerate → resolve
  each track, §8.1); opportunistic Tidal key/BPM + AcousticBrainz fill. *Accept:* same
  program on an Icecast mount; relay profile drops bumpers over a third-party stream;
  a Spotify playlist ref expands and plays via local/YT resolution; resolving a Tidal
  track enriches its overlay row.

---

## 14. Failure modes (all → music keeps playing)
| Failure | Behavior |
|---|---|
| TTS down | Use prerecorded assets; optionally post liner text in chat; `playNext()`. |
| LLM down | Skip generated sources; prerecorded + `stationId`/`timeCheck`. |
| RAG/Qdrant down | `doctrine` weight → 0; other sources/prerecorded. |
| Analyzer down/missing tags | `select_tracks` returns sparse → fall back to playlists/seeds. |
| Bumper not ready by the boundary | Skip this boundary (music first); pre-fetch earlier. |
| Classification floor uncertain | Default `["unclassified"]`; if unresolved → prerecorded/canned only. |

---

## 15. Resolved decisions (2026-06-30)

The eight design questions are resolved. Defaults are baked into §11.

**Critical-path note:** OQ2, OQ4, and OQ5 all hang off OQ3 → the analyzer. The OQ3
scan (`bot/src/tools/library-tag-scan.ts`) is the dependency root; harmonic sequencing
(OQ5) and Tidal-as-moot (OQ4) ship *decided but dormant* until the analyzer populates
keys. **R-R1 (Director MVP) is fully independent of all tag/analyzer work** and can
proceed in parallel.

```
OQ3 scan ──decides──▶ OQ2 analyzer ──runs──▶ key/BPM coverage
                                              ├─▶ OQ4 (Tidal moot)
                                              └─▶ OQ5 (harmonic can activate)
```

1. **Org-memory namespace** → **reserved `org` user id**, admin/`@dj`-write only. The
   broadcast `memory` source physically cannot see per-user drawers — closes the
   private-leak vector without a bridge contract change. Dormant in v1
   (`memoryBroadcastOptIn=false`, org drawer starts empty). Add a per-fact `shareable`
   flag later only if needed.
2. **Analyzer footprint** → **keyfinder-cli + aubio first** (objective key/BPM, light
   C). Essentia mood/genre is an **opt-in second pass**, added only once OQ3 shows
   embedded coverage is thin. All analysis is off-peak batch, cached by file hash,
   never blocks playback. *(Gated on OQ3.)*
3. **Embedded tag coverage** → **measured (2026-07-06, opi5 `./music`, 85 tracks).**
   `bot/src/tools/library-tag-scan.ts` + `./scripts/oq3-tag-scan.sh`. Pi corpus today
   is mostly YouTube auto-saves (`~/moneypenny/music`, 2.2 GiB) — not a separate org
   library mount. **OQ3 result:** genre **97.6%** (83/85), BPM/key/mood/subgenre
   **0%** → **OQ2 = keyfinder-cli + aubio** for key/BPM; mood/subgenre from YouTube
   genre strings + manual/LLM. Re-run when a full library is mounted (`MUSIC_HOST_DIR`).
4. **Tidal access tier** → **moot.** The local analyzer (OQ2) is the canonical key/BPM
   source. Treat Tidal as a *playback* source + optional basic-metadata enrichment via
   the **official** API only; do not build on reverse-engineered endpoints.
5. **Harmonic sequencing** → **opt-in per profile** (`harmonicSequencing`, default
   off). Harmonic *ordering*, not beatmatched mixing: a post-selection reorder of the
   upcoming queue window, not a hard selection constraint (tracks lacking a key fall
   back to normal order). Composes with OQ7 (weighting picks the bag draw; ordering
   reorders the window). Active only once key coverage is adequate.
6. **Ratings model** → **per-user + smoothed aggregate.** `ts:*` and `web:*` counted
   as distinct raters; **not linked in v1** (Bayesian smoothing damps the double-count).
   Add a verify-in-channel account-link flow later only if precision matters.
7. **Rating-weighted rotation** → **gentle auto-on in radio mode, uniform in manual.**
   Low exponent + capped weight ratio (a 5-star ≲3× an unrated track); the Bayesian
   floor keeps unrated tracks in rotation. `k` and the cap are config-exposed
   (`radio.ratingWeight`). `!mode random` stays byte-identical (`queue.ts:189`
   untouched).
8. **Spotify/Tidal playlist provider** → **skip for v1; YouTube + local only** (both
   verified working, zero creds, offline-friendly). Build a Spotify provider (isolated,
   off by default) only if the org actually lives on Spotify playlists — deferred to
   R-R6.

---

## 16. References
AzuraCast / LibreTime (rotation-clock + smart-block + jingle model, concept only) ·
Icecast (optional sink) · Stanton/The Base/HCN Radio (tone + relay) · Spotify Web
API change 2024-11-27 (audio-features/recommendations deprecated for new apps) ·
TIDAL Open API + track key/BPM/djReady metadata · Essentia / libKeyFinder / aubio /
librosa / bliss-rs (local analysis) · AcousticBrainz (frozen feature dataset) ·
`DESIGN.md` §4/§8/§9/§10/§14 · `docs/voice.md` · `docs/rank-gating.md` ·
`docs/rag-ingestion.md` · `bot/src/tools/library-tag-scan.ts` · `scripts/oq3-tag-scan.sh` ·
`bot/src/audio/*` · `bot/src/bot/voice/session.ts` ·
`bot/src/bot/lifecycle/{event-bindings,idle-poller}.ts` · `bot/src/rag/index.ts` ·
`bot/src/memory/mempalace-client.ts` · `bot/src/music/local.ts` ·
`bot/src/llm/tools.ts`.
