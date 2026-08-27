# EZ GDrive Upload Bot

Minimal Telegram bot + Mini App that sends Telegram files or direct HTTP/HTTPS file URLs to each user's own Google Drive.

## What it does

1. User opens the Telegram Mini App.
2. User connects Google Drive with Google OAuth.
3. User sends any Telegram file/media or a direct HTTP/HTTPS file URL.
4. The VPS streams it to that user's Drive.
5. At most 2 uploads run simultaneously. Extra uploads wait in memory.
6. Telegram shows a **Refresh** button for manual progress checks.
7. When complete, the bot sends `✅ Successfully Uploaded` plus the filename.

## Google Drive layout

The bot automatically creates and uses:

```text
My Drive/
└── EZ Uploads/
    ├── Videos/
    ├── Images/
    ├── Audios/
    ├── Documents/
    ├── Archives/
    └── Others/
```

Classification uses MIME type first and the filename extension as a fallback.

Examples:

- MP4/MKV/WebM → `Videos`
- JPG/PNG/WebP → `Images`
- MP3/FLAC/WAV → `Audios`
- PDF/DOCX/XLSX/TXT → `Documents`
- ZIP/RAR/7Z/TAR/GZ → `Archives`
- Unknown files → `Others`

## Direct URLs

A direct URL no longer needs to provide `Content-Length`.

If the source reports its size, Refresh shows:

```text
57%
2.8 GB / 4.9 GB
```

If the source does not report its size, the upload still runs and Refresh shows:

```text
2.8 GB uploaded
Size: unknown
```

The URL must still be an actual HTTP/HTTPS resource that returns a downloadable response body. Redirects are followed. Private/local-network targets are blocked.

## Project structure

```text
EZ_GDrive_Upload_Bot/
├── backend/
│   ├── index.js
│   ├── bot.js
│   ├── config.js
│   ├── db.js
│   ├── drive.js
│   ├── oauth.js
│   ├── telegramAuth.js
│   └── upload.js
├── webapp/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/
├── .env.example
├── .gitignore
└── package.json
```

## VPS requirements

- Node.js 22.13+; Node.js 24 LTS recommended
- HTTPS domain pointing to the VPS
- Telegram bot token from BotFather
- Telegram Local Bot API server for large Telegram files
- Google Cloud OAuth Web Application credentials
- Google Drive API enabled

## Install

```bash
npm install
cp .env.example .env
openssl rand -hex 32
```

Put the generated value into `TOKEN_ENCRYPTION_KEY` and fill the other `.env` values.

Start:

```bash
npm start
```

## Google OAuth

The app requests:

```text
https://www.googleapis.com/auth/drive.file
```

Each user's Google refresh token is encrypted before being stored in SQLite.

## Telegram Local Bot API

For large Telegram files use:

```env
TELEGRAM_API_ROOT=http://127.0.0.1:8081
```

## Queue

```text
Upload 1 → Uploading
Upload 2 → Uploading
Upload 3 → Waiting
Upload 4 → Waiting
```

Default:

```env
MAX_CONCURRENT_UPLOADS=2
```

## Current limitations

- Queue and progress are in memory and disappear if Node restarts.
- No crash-resume system yet.
- Direct URLs must resolve to a reachable HTTP/HTTPS response body. This bot does not extract media from normal webpages, DRM services, HLS/DASH pages, or torrents.
