# Loading documents into the knowledge base (RAG)

Moneypenny's `!ask` and `!analyst` answers from a **doctrine corpus** — Markdown
documents you load, embedded into a vector store (Qdrant) and retrieved at query
time, rank-gated by each document's classification. The fast chat model and the
delegate analyst both receive the same retrieved chunks (and per-user memory on
`!ask`). This doc covers **every way to get documents in**, plus what you need
enabled for any of it to work.

> Music uses the same ideas in two of these paths (web upload, TeamSpeak file
> drop), but the corpus itself is **Markdown only**.

## Public repo policy (hard rule)

**No real doctrine / RAG corpus files live in the public Moneypenny git tree.**

| Location | Role |
|----------|------|
| **`bot/data/doctrine/`** on the bot host | Runtime corpus (gitignored; never commit) |
| **Private `doctrine.git` wiki** on the host | Versioned org knowledge (not this GitHub repo) |
| **`docs/examples/doctrine/*.example.md`** | Public *templates* only — copy into private store |
| **`docs/rag-ingestion*.md`** | Product how-to (not ingested as org doctrine) |
| **`/doctrine/` in a clone** | Gitignored — do not use for public commits |

Operator quick sheet: [rag-ingestion-cheatsheet.md](./rag-ingestion-cheatsheet.md).

---

## Prerequisites (enable RAG first)

None of the ingestion paths embed anything unless retrieval is on:

1. **Vector store running** — bring up TurboVec via the `rag` compose profile:
   `docker compose --profile core --profile ollama --profile rag up -d`
   (`turbovec` service; `VECTOR_DB_URL=http://turbovec:6333`).
2. **`ragEnabled` on** — Settings → *AI & Permissions* → **Knowledge base**, or
   `ragEnabled: true` in `config.json`. (If it was off at boot, restart the bot
   so the retrieval store is constructed.)
3. **An embedding model** reachable — default is `embeddinggemma` (Gemma-family)
   on ollama for Pi and x86.
   Empty `EMBEDDING_URL` reuses the LLM endpoint.

Verify: `GET /api/rag/doctrine` lists the corpus; `!ask <question>` or
`!analyst <task>` retrieves (delegate path needs `llmDelegateUrl` in Settings —
see [remote-llm.md](./remote-llm.md)).

## Export to Word (R3)

When a doc is in the corpus, admins can download a **`.docx`** from **Library → Doctrine →
Export** (or `GET /api/rag/doctrine/:source/export?format=docx`). Requires `pandoc` on the
bot host (included in the production Docker image). See [r3-workflows.md](./r3-workflows.md).

---

## Formatting for retrieval (recommended)

Chunking is **heading-first** (`bot/src/rag/chunk.ts`): each `## Section` becomes its
own embed when small enough. Docs without headings become one blob (then
size-split), which is worse for `!ask` and doctrine bumpers.

**Prefer:**

```markdown
---
classification: restricted
tags: [training, fighter-ops]
---

# Doc title

## Section name

Short paragraphs. One idea per section when possible.

- **Label:** detail line for procedures
```

**Reformat an existing host corpus** (does not live in the public git tree):

- **Dashboard (admin):** Library → Doctrine → **Normalize formatting**  
  (`POST /api/rag/doctrine/reformat` — re-embeds only files that change)
- **CLI on the bot host:**

```bash
# After backing up bot/data/doctrine:
python3 scripts/reformat-doctrine-corpus.py /path/to/bot/data/doctrine
# Watcher / !reindex / POST /api/rag/doctrine/reindex picks up changes
```

Both paths normalize frontmatter, promote real section titles to `##`, keep
list items as bullets, and leave operator cheatsheets alone.

---

## Document format (frontmatter → classification + tags)

A doctrine doc is plain Markdown with an optional YAML-ish frontmatter block.
Only three fields are read (`bot/src/rag/frontmatter.ts`):

```markdown
---
classification: secret        # rank-gating bucket; omitted → "unclassified"
tags: [intel, fleet-ops]      # free-form labels (also: a, b on one line)
valid_until: 2026-12-31       # optional; informational
---

# INTSUM 2026-06-14
Body text… everything below the frontmatter is chunked and embedded.
```

- **`classification`** drives **rank-gating**: a member only retrieves chunks
  whose classification their TeamSpeak rank clears (`unclassified` is always
  retrievable). See [rank-gating.md](./rank-gating.md) for the production tier
  ladder and `scripts/rights-rank-gating.json`.
- No frontmatter → the whole file is treated as `unclassified`.

---

## Path 1 — Git wiki-as-code (canonical, multi-author)

Best for an org: members publish doctrine with `git push`; full history; zero
inbound network exposure.

```bash
# On the bot host, once:
./scripts/setup-doctrine-repo.sh           # creates ~/doctrine.git + a hook
# On a workstation, once:
git clone ssh://<user>@<host>/~/doctrine.git doctrine && cd doctrine
# Publish:
git add intsum.md && git commit -m "doctrine update" && git push
```

A `post-receive` hook mirrors pushed `.md` files (including **nested paths** like
`intel/intsum.md`) into `bot/data/doctrine/`, and the bot's recursive watcher
re-embeds automatically. `git rm` + push removes a doc from the knowledge base
too (rsync `--delete` + reindex purge).

**Local smoke test (no SSH):**

```bash
./scripts/doctrine-sync-test.sh
./scripts/ci-validate.sh --doctrine-only
```

Sync log: `bot/data/doctrine/.git-sync.log`

## Path 2 — TeamSpeak file browser (drop zone) ⭐ new

The most natural path for non-technical members: drag a file into a channel.

1. Create a TeamSpeak channel named **exactly** `moneypenny-drop`.
2. Restrict **who can upload** to it (TS permission `i_ft_needed_file_upload_power`)
   — this is the security boundary (see the note below).
3. Settings → *AI & Permissions* → enable **File drop (TeamSpeak)**.
4. In your TS client, open the channel's file browser and drop files:
   - `.md` / `.markdown` → the **knowledge base** (RAG)
   - audio (`.mp3 .flac .wav .ogg .m4a .aac .wma .opus`) → the **music library**

The bot polls the channel (default every 30 s), **recurses into subfolders**,
ingests new files, and posts a confirmation in the channel. Each file is
ingested once — re-uploading an edited file (new size/timestamp) re-ingests it.
A transient read failure retries (up to 3 polls) before giving up; protocol-mode
downloads also have a 60 s timeout. Admins can check the last 10 ingests + any
errors with **`!ingeststatus`**. Implementation: `bot/src/ingest/file-drop.ts`.

**Co-located TS6 + bot (e.g. DietPi):** TS6 6.0.0-beta11 does not expose
`ftgetfilelist` over WebQuery and the honeybbq client drops the full-client
notification. Bind-mount the server's `files/` tree instead:

```bash
# In .env on the Pi (paths are examples — adjust to your TS data dir):
TS6_FILES_HOST_DIR=/path/to/teamspeak6/data/files
TS6_FILES_DIR=/ts6-files
TS6_VIRTUAL_SERVER_ID=1
```

Then recreate the bot container. The watcher scans
`virtualserver_<id>/channel_<cid>/` on disk for the resolved `moneypenny-drop`
channel. TS6 often creates per-channel file dirs as **`0700`** (owner-only); the
bot runs as uid **1000** inside the container, so the drop channel dir needs at
least `0755` (or group-read via `group_add` in compose) or polls will log
`EACCES`. One-time fix on the host:

```bash
chmod 755 /path/to/files/virtualserver_1/channel_<cid>
```

Remote servers: leave `TS6_FILES_DIR` unset until
`docs/honeybbq-ts6-file-list-patch-plan.md` is implemented.

## Path 3 — Web admin upload & inline editor

Settings/admin API, good for one-offs from a browser. The **Library → Doctrine**
section also supports inline edit (Edit / Preview tabs), **New doc** (blank
template), and a filter box for large corpora.

```bash
# Batch upload
curl -u admin -F files=@intsum.md  http://localhost:3000/api/rag/doctrine

# Read one doc (for the inline editor)
curl -u admin http://localhost:3000/api/rag/doctrine/intel%2Fintsum.md

# Save edits (writes disk + re-embeds)
curl -u admin -X PUT -H 'Content-Type: application/json' \
  -d '{"content":"---\nclassification: secret\n---\n\n# Updated"}' \
  http://localhost:3000/api/rag/doctrine/intel/intsum.md

# Create a new doc from a path (409 if it already exists)
curl -u admin -X POST -H 'Content-Type: application/json' \
  -d '{"source":"intel/new-brief"}' \
  http://localhost:3000/api/rag/doctrine/new
```

`POST /api/rag/doctrine` accepts up to 20 `.md` files, ≤15 MiB each (same cap for
TS file-browser drops and the inline editor). Companion
endpoints (`bot/src/web/api/rag.ts`):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/rag/doctrine` | List registry |
| `GET` | `/api/rag/doctrine/:source` | Read file + metadata |
| `PUT` | `/api/rag/doctrine/:source` | Save + re-ingest |
| `POST` | `/api/rag/doctrine/new` | Create blank template |
| `DELETE` | `/api/rag/doctrine/:source` | Delete + purge vectors |
| `POST` | `/api/rag/doctrine/reindex` | Full or `{ sources: [...] }` selective |

## Path 4 — Manual file drop

Drop `.md` straight into `bot/data/doctrine/` (scp, rsync, NFS, an editor). The
same watcher re-embeds on change (debounced ~2.5 s), and a startup sync catches
files added while the bot was down. The `!reindex` command forces a full resync.

---

## Security note (classification trust)

Paths 1–4 all **trust the document's `classification` frontmatter** — there is
no separate approval step. Whoever can write a file (push to the repo, upload to
the drop channel, hit the admin API, or write to the data dir) can declare any
classification, including a low one to widen its audience or a high one to hide
it. The real boundary is **who can put files there**:

- Git: who can push to `doctrine.git`.
- TS drop: who has upload permission on `moneypenny-drop`.
- Web API: admin auth.
- Manual: host filesystem access.

Scope those accordingly.

## Quick reference

| Path | Who it's for | Entry point |
|------|--------------|-------------|
| Git wiki-as-code | Multi-author org, versioned | `scripts/setup-doctrine-repo.sh` |
| TS file browser  | Anyone, drag-and-drop | channel `moneypenny-drop` |
| Web admin upload | One-off from a browser | `POST /api/rag/doctrine` |
| Manual drop      | Host/automation | `bot/data/doctrine/*.md` |
