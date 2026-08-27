import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { bot, registerBotCommands } from './bot.js';
import { createGoogleAuthUrl, finishGoogleAuth } from './oauth.js';
import { disconnect, isConnected } from './db.js';
import { verifyInitData } from './telegramAuth.js';
import {
  cancelUpload,
  createUpload,
  filenameFromDisposition,
  filenameFromUrl,
  getUserJobs,
  safeFetch,
  streamSourceFactory,
  urlSourceFactory
} from './upload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const jsonParser = express.json({ limit: '64kb' });
app.use((req, res, next) => req.path === '/api/upload/file' ? next() : jsonParser(req, res, next));
app.use(express.static(path.resolve(__dirname, '../webapp')));

function telegramUser(req) {
  return verifyInitData(req.get('X-Telegram-Init-Data'));
}

function requireConnected(user) {
  if (!isConnected(user.id)) throw new Error('Connect Google Drive first');
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/status', (req, res) => {
  try {
    const user = telegramUser(req);
    res.json({ connected: isConnected(user.id), uploads: getUserJobs(user.id) });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/api/connect', (req, res) => {
  try {
    const user = telegramUser(req);
    res.json({ url: createGoogleAuthUrl(user.id) });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  try {
    const user = telegramUser(req);
    disconnect(user.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post('/api/upload/url', async (req, res) => {
  try {
    const user = telegramUser(req);
    requireConnected(user);
    const rawUrl = String(req.body?.url || '').trim();
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP/HTTPS URLs are allowed');

    let totalBytes = null;
    let mimeType = 'application/octet-stream';
    let filename = filenameFromUrl(rawUrl);

    try {
      const head = await safeFetch(rawUrl, { method: 'HEAD' });
      if (head.ok) {
        const length = head.headers.get('content-length');
        if (length !== null && /^\d+$/.test(length)) totalBytes = Number(length);
        mimeType = head.headers.get('content-type') || mimeType;
        filename = filenameFromDisposition(head.headers.get('content-disposition')) || filename;
      }
    } catch {}

    const job = createUpload({
      telegramId: user.id,
      chatId: user.id,
      filename,
      mimeType,
      totalBytes,
      sourceFactory: urlSourceFactory(rawUrl, { filename, mimeType }),
      bot
    });
    res.status(202).json({ ok: true, jobId: job.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/upload/file', async (req, res) => {
  let job;
  try {
    const user = telegramUser(req);
    requireConnected(user);

    const encodedName = req.get('X-File-Name') || '';
    let filename;
    try { filename = decodeURIComponent(encodedName); } catch { filename = encodedName; }
    filename = filename.trim() || `upload-${Date.now()}`;

    const contentLength = req.get('content-length');
    const totalBytes = contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
    const mimeType = req.get('content-type') || 'application/octet-stream';

    job = createUpload({
      telegramId: user.id,
      chatId: user.id,
      filename,
      mimeType,
      totalBytes,
      sourceFactory: streamSourceFactory(req),
      bot
    });

    await new Promise((resolve, reject) => {
      req.once('end', resolve);
      req.once('error', reject);
      req.once('aborted', () => reject(new Error('Browser upload was interrupted')));
    });

    if (!res.headersSent) res.status(202).json({ ok: true, jobId: job.id });
  } catch (error) {
    if (job) cancelUpload(job.telegramId, job.id);
    if (!res.headersSent) res.status(400).json({ error: error.message });
  }
});

app.post('/api/upload/:id/cancel', (req, res) => {
  try {
    const user = telegramUser(req);
    const job = cancelUpload(user.id, req.params.id);
    if (!job) return res.status(404).json({ error: 'Upload not found' });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const telegramId = await finishGoogleAuth(req.query.code, req.query.state);
    await bot.telegram.sendMessage(telegramId, '✅ Google Drive Connected');
    res.send('<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:40px"><h2>✅ Google Drive Connected</h2><p>You can close this page and return to Telegram.</p></body></html>');
  } catch (error) {
    res.status(400).send(`Google connection failed: ${error.message}`);
  }
});

const server = app.listen(config.port, () => console.log(`Web server listening on :${config.port}`));
server.requestTimeout = 0;

registerBotCommands().catch(error => console.error('Could not register bot commands:', error.message));
bot.launch().then(() => console.log('Telegram bot started'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
