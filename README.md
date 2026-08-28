# CRZ GDrive Upload Bot v2.0.0

CRZ is a Telegram-based media processing and Google Drive delivery bot with persistent torrent catalogs, reusable MKV processing, multi-stage job queues, restart recovery, and owner monitoring tools.

It can accept magnets, `.torrent` files, direct HTTP/HTTPS URLs, and Telegram MKV/media uploads, then route work through independent download, processing, and upload queues.

## Architecture

```text
                  CRZ v2.0.0

 Magnet ───────┐
 .torrent ─────┤
 Direct URL ───┼──► Job Manager
 Telegram MKV ─┘          │
                          │
              ┌───────────┴───────────┐
              │                       │
         Torrent Pipeline        Direct/MKV
              │                       │
         Preflight x3                 │
              │                       │
         Download x2                  │
              └──────────┬────────────┘
                         │
                    ffprobe
                         │
                Persistent Source
                         │
                   Audio select
                         │
                 Subtitle select
                         │
                 Processing x2
                         │
                Persistent Variant
                         │
                ┌────────┴────────┐
                │                 │
            Telegram          Drive x2
                                  │
                             Finalizing
                                  │
                         Google confirmation
```

## Main Features

### Multi-job architecture

CRZ uses a central `JobManager` and separate queues for expensive stages.

```text
Torrent preflight     max 3
Movie downloads       max 2
MKV processing        max 2
Google Drive uploads  max 2
ffprobe analysis      immediate
```

The queues are independent. A long torrent download does not block FFmpeg processing or Google Drive uploads.

Queued jobs receive queue positions, and cancelling one queued job removes only that item.

### Torrent support

CRZ supports:

- Magnet links
- Uploaded `.torrent` files
- Torrent metadata/preflight
- Seeds, peers, trackers and file listing
- Movie/file selection from a torrent
- Independent movie download jobs
- Persistent torrent catalog for the owner
- Reuse of already-downloaded source files

Owner torrent data can survive service restarts.

Use:

```text
/torrents
```

to open the persistent torrent catalog.

### Persistent movie sources

After an owner downloads a movie from a torrent, CRZ can move the completed source into persistent storage.

```text
data/storage/sources/
```

The source is then reusable without another torrent download.

CRZ also caches ffprobe analysis, so reopening the same saved source can skip probing when metadata is already available.

### MKV inspection

For MKV files CRZ uses `ffprobe` to inspect:

- Video streams
- Audio streams
- Subtitle streams
- Codec
- Language
- Channels
- Duration

For multi-audio MKVs, CRZ asks the user to choose the desired audio track.

For a single-audio MKV, CRZ automatically selects it and explicitly tells the user.

### Audio processing

Audio codecs normally copied directly:

```text
AAC
MP3
FLAC
Vorbis
Opus
```

Unsupported audio formats such as AC3, EAC3, DTS or TrueHD are transcoded while the video stream remains copied.

Default conversion target:

```env
MIRROR_AUDIO_TARGET=aac
```

Typical processing:

```text
Video      COPY
Audio      COPY when supported
           otherwise AAC conversion
Subtitle   optional English subtitle
```

### Reusable processed variants

Prepared outputs are stored persistently for the owner.

```text
data/storage/variants/
```

One source movie can therefore have several reusable variants, for example:

```text
Movie.mkv
├── Tamil + no subtitle
├── Tamil + English subtitle
├── English + no subtitle
└── Japanese + English subtitle
```

CRZ identifies variants using the source, selected audio stream, subtitle choice, and output codec.

If the same variant already exists:

```text
No torrent download
No ffprobe
No FFmpeg
```

CRZ simply reopens the prepared result.

Use:

```text
/movies
```

to open persistent processed movies.

### Prepared result actions

After processing:

```text
✅ MKV Prepared

[Download] [Upload to Drive]
[Delete]
```

CRZ does not automatically upload a prepared MKV.

`Delete` removes the prepared persistent variant when applicable, not the persistent original source.

## Google Drive delivery

Drive uploads are handled through the CRZ → EZ → Google Drive route.

The important lifecycle is:

```text
QUEUED
   ↓
UPLOADING
   ↓
100% bytes sent
   ↓
FINALIZING
   ↓
EZ / Google confirmation
   ↓
COMPLETED
```

CRZ does **not** treat `100% bytes sent` as upload success.

A job is successful only after the EZ/Google Drive layer returns final confirmation.

If finalization fails, the prepared local file is preserved so the upload can be retried without reprocessing the movie.

## Cancellation

Cancellation is job-scoped.

CRZ can cancel:

- Queued torrent preflight
- Queued movie download
- Active torrent download
- MKV processing
- Google Drive upload

Cancelling one job does not cancel unrelated jobs.

Queued cancellation removes only that item.

Active cancellation signals the worker and waits for the operation to terminate before cleanup.

## Restart recovery

CRZ persists runtime job/session snapshots approximately every 5 seconds.

Runtime state is stored under:

```text
data/storage/state/runtime-jobs.json
```

If CRZ restarts while work was active, the old jobs are recorded as:

```text
interrupted_retryable
```

instead of silently disappearing.

Persistent torrent, source, metadata and variant catalogs remain available after restart.

## Temporary file cleanup

Temporary job directories are automatically eligible for cleanup after roughly 30 minutes.

Active work directories are protected from the cleanup sweep.

Persistent owner data under `data/storage/` is not part of the temporary cleanup process.

## Storage safety

Before large operations CRZ preserves a disk reserve equal to the stricter of:

```text
5 GiB
or
10% of filesystem capacity
```

If the requested operation would violate that reserve, CRZ rejects the operation with a storage warning instead of filling the VPS disk.

## Owner commands

```text
/torrents   Open persistent torrent catalog
/movies     Open persistent processed movie catalog
/jobs       Show active and interrupted jobs
/queues     Show queue concurrency and waiting jobs
/storage    Show CRZ storage and filesystem safety status
/cancel     Cancel the current job
```

### `/jobs`

Shows:

- Active jobs
- Current state
- Current stage
- Queue name
- Queue position
- Interrupted/retryable jobs

### `/queues`

Example:

```text
preflight:   1/3 active · 2 waiting
download:    2/2 active · 3 waiting
processing:  1/2 active · 0 waiting
upload:      2/2 active · 1 waiting
```

### `/storage`

Shows:

- Filesystem free space
- CRZ safety reserve
- Persistent CRZ storage usage
- Temporary job usage
- Whether available storage is above or below the reserve

## Persistent storage layout

```text
data/storage/
├── torrents/
├── sources/
├── variants/
├── metadata/
└── state/
    ├── catalog.json
    └── runtime-jobs.json
```

Runtime data is intentionally excluded from Git.

## Project structure

```text
CRZ_GDrive_Upload_Bot/
├── backend/
│   ├── crz-index.js
│   ├── mirrorBot.js
│   ├── mediaPrep.js
│   ├── jobs/
│   │   ├── jobManager.js
│   │   ├── queueManager.js
│   │   └── actionRegistry.js
│   ├── status/
│   │   └── ownerStatus.js
│   └── storage/
│       ├── catalogStore.js
│       └── runtimeState.js
├── resolver/
├── test/
│   ├── jobs.test.mjs
│   ├── catalogStore.test.mjs
│   ├── catalogStore.phase6.test.mjs
│   ├── runtimeState.test.mjs
│   └── ownerStatus.test.mjs
├── data/
├── webapp/
├── .env
├── .gitignore
└── package.json
```

## Environment

Important CRZ settings:

```env
TELEGRAM_API_ROOT=http://127.0.0.1:8081

WEBAPP_URL=https://drive.bot.projectdarkhope.xyz/crz/

EZ_API_BASE=https://drive.bot.projectdarkhope.xyz
EZ_API_SECRET=your_shared_secret

MIRROR_AUDIO_TARGET=aac

TORRENT_PREFLIGHT_SECONDS=12

PYTHON_BIN=/path/to/resolver/.venv/bin/python

CRZ_MAX_PREFLIGHTS=3
CRZ_MAX_DOWNLOADS=2
CRZ_MAX_PROCESSING=2
CRZ_MAX_UPLOADS=2

CRZ_OWNER_TELEGRAM_ID=your_owner_telegram_id

# Optional
CRZ_TEMP_RETENTION_MS=1800000
CRZ_DISK_RESERVE_BYTES=5368709120
```

Do not commit `.env`.

## Requirements

- Ubuntu/Linux VPS
- Node.js 22+
- FFmpeg + ffprobe
- Python 3
- `python-libtorrent`
- Telegram bot token
- Telegram Local Bot API server for large files
- EZ GDrive Upload Bot/API reachable by CRZ
- Google Drive connection through EZ
- Sufficient persistent disk storage

## Install

Install Node dependencies:

```bash
npm install
```

Install/verify FFmpeg:

```bash
ffmpeg -version
ffprobe -version
```

Verify Python/libtorrent:

```bash
python3 -c "import libtorrent; print(libtorrent.version)"
```

Configure `.env`, then start:

```bash
npm start
```

For production, CRZ can run under systemd.

Example checks:

```bash
sudo systemctl status crz-bot --no-pager
curl -s http://127.0.0.1:3000/health
```

Expected health response:

```json
{
  "ok": true,
  "service": "crz-bot"
}
```

## Testing

Current v2.0.0 regression suite:

```bash
node --test \
  test/jobs.test.mjs \
  test/catalogStore.test.mjs \
  test/catalogStore.phase6.test.mjs \
  test/runtimeState.test.mjs \
  test/ownerStatus.test.mjs
```

Expected:

```text
tests 26
pass 26
fail 0
```

The suite covers:

- Queue concurrency
- Queue independence
- Queued cancellation
- Active cancellation
- Upload finalizing semantics
- Persistent torrent catalog
- Persistent source reuse
- Persistent ffprobe metadata
- Variant reuse
- Subtitle-specific variants
- Processed movie catalog
- Runtime recovery
- Temporary cleanup
- Protected active workdirs
- Owner jobs UI
- Owner queue UI
- Owner storage UI
- Stale callback handling

## Stale Telegram buttons

CRZ includes a final callback fallback for old `mt-*` buttons.

When a callback no longer corresponds to a valid current action, the bot acknowledges it with a safe stale-button message instead of leaving Telegram spinning indefinitely.

## Release history

### v2.0.0

Major architecture upgrade:

- JobManager + QueueManager
- Graceful shutdown
- Job-scoped cancellation
- Independent torrent preflight/download queues
- Independent processing/upload queues
- Upload `FINALIZING` state
- Persistent torrent catalog
- Persistent source catalog
- Cached ffprobe metadata
- Persistent reusable MKV variants
- Restart recovery ledger
- Temporary cleanup
- Disk safety reserve
- Owner `/jobs`, `/queues`, `/storage`
- Stale callback protection

### pre-job-manager-v1

Stable rollback tag from before the persistent multi-job architecture.

## Current limitations

- Active workers are not resumed byte-for-byte after a process restart. They are recorded as interrupted/retryable instead.
- Persistent catalogs are owner-scoped.
- Torrent support depends on libtorrent and the configured resolver worker.
- Google Drive delivery depends on the EZ internal upload API and the user's valid Google Drive authorization.
- DRM-protected streaming services are not supported.
- CRZ does not treat an upload as complete until Google/EZ final confirmation is received.

## Version

```text
CRZ v2.0.0
```

Git tag:

```text
v2.0.0
```
