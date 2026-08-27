import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import { categoryForFile, uploadStream } from './drive.js';
import { config } from './config.js';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') ||
    v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

export async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP/HTTPS URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('Local URLs are not allowed');

  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('Private/local network URLs are not allowed');
  }
  return url;
}

export async function safeFetch(rawUrl, options = {}, redirectsLeft = 5) {
  await assertPublicUrl(rawUrl);
  const response = await fetch(rawUrl, { ...options, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirectsLeft <= 0) throw new Error('Too many redirects');
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect has no Location header');
    const next = new URL(location, rawUrl).toString();
    const method = response.status === 303 ? 'GET' : options.method;
    return safeFetch(next, { ...options, method }, redirectsLeft - 1);
  }
  return response;
}

function contentDispositionFilename(disposition) {
  if (!disposition) return null;

  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded?.[1]) {
    try { return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, '')); } catch {}
  }

  const normal = disposition.match(/filename=(?:"([^"]+)"|([^;]+))/i);
  return (normal?.[1] || normal?.[2] || '').trim() || null;
}

const jobs = new Map();
const queue = [];
let active = 0;
let nextId = 1;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i < 2 ? 1 : 2)} ${units[i]}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${Math.max(1, seconds)}s`;
}

function formatSpeed(bytes, ms) {
  if (!bytes || !ms) return null;
  return `${formatBytes(bytes / (ms / 1000))}/s`;
}

export function createUpload({ telegramId, chatId, filename, mimeType, totalBytes, sourceFactory, bot }) {
  const id = String(nextId++);
  const now = Date.now();
  const job = {
    id,
    telegramId: String(telegramId),
    chatId,
    filename,
    mimeType,
    category: categoryForFile(filename, mimeType),
    totalBytes: Number.isFinite(Number(totalBytes)) && Number(totalBytes) >= 0 ? Number(totalBytes) : null,
    uploadedBytes: 0,
    state: 'waiting',
    error: null,
    messageId: null,
    sourceFactory,
    bot,
    controller: new AbortController(),
    createdAt: now,
    startedAt: null,
    completedAt: null
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  return job;
}

async function pump() {
  while (active < config.maxConcurrentUploads && queue.length) {
    const job = queue.shift();
    if (!job || job.state === 'cancelled') continue;
    active++;
    run(job).finally(() => {
      active--;
      pump();
    });
  }
}

async function run(job) {
  if (job.state === 'cancelled') return;
  job.state = 'uploading';
  job.startedAt = Date.now();

  try {
    const sourceResult = await job.sourceFactory(job.controller.signal);
    const stream = sourceResult?.stream || sourceResult;

    if (sourceResult?.filename) job.filename = sourceResult.filename;
    if (sourceResult?.mimeType) job.mimeType = sourceResult.mimeType;
    if (Number.isFinite(sourceResult?.totalBytes) && sourceResult.totalBytes >= 0) {
      job.totalBytes = sourceResult.totalBytes;
    }
    job.category = categoryForFile(job.filename, job.mimeType);

    const file = await uploadStream({
      telegramId: job.telegramId,
      filename: job.filename,
      mimeType: job.mimeType,
      totalBytes: job.totalBytes,
      stream,
      signal: job.controller.signal,
      onProgress: bytes => { job.uploadedBytes = bytes; }
    });

    if (job.state === 'cancelled') return;
    job.state = 'done';
    job.completedAt = Date.now();
    if (!job.totalBytes) job.totalBytes = job.uploadedBytes;

    if (job.bot && job.chatId) {
      await job.bot.telegram.sendMessage(
        job.chatId,
        `✅ Successfully Uploaded\n\n${job.filename}\n\n📁 EZ Uploads / ${job.category}`
      ).catch(() => {});
    }
    return file;
  } catch (error) {
    job.completedAt = Date.now();
    if (job.controller.signal.aborted || error?.name === 'AbortError') {
      job.state = 'cancelled';
      job.error = null;
      if (job.bot && job.chatId) {
        await job.bot.telegram.sendMessage(job.chatId, `🛑 Upload Cancelled\n\n${job.filename}`).catch(() => {});
      }
      return;
    }

    job.state = 'failed';
    job.error = error.message;
    if (job.bot && job.chatId) {
      await job.bot.telegram.sendMessage(
        job.chatId,
        `❌ Upload Failed\n\n${job.filename}\n\n${error.message}`
      ).catch(() => {});
    }
  }
}

export function getJob(id, telegramId) {
  const job = jobs.get(String(id));
  if (!job || job.telegramId !== String(telegramId)) return null;
  return job;
}

export function getUserJobs(telegramId) {
  const userId = String(telegramId);
  const cutoff = Date.now() - (30 * 60 * 1000);
  return [...jobs.values()]
    .filter(job => job.telegramId === userId)
    .filter(job => ['waiting', 'uploading'].includes(job.state) || (job.completedAt || job.createdAt) >= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map(publicJob);
}

export function cancelUpload(telegramId, id = null) {
  const userId = String(telegramId);
  const job = id
    ? getJob(id, userId)
    : [...jobs.values()].reverse().find(item =>
        item.telegramId === userId && ['waiting', 'uploading'].includes(item.state)
      );

  if (!job || !['waiting', 'uploading'].includes(job.state)) return null;
  job.state = 'cancelled';
  job.completedAt = Date.now();
  job.controller.abort();
  return job;
}

export function publicJob(job) {
  const now = job.completedAt || Date.now();
  const durationMs = job.startedAt ? Math.max(1, now - job.startedAt) : 0;
  const percent = job.totalBytes
    ? Math.min(100, Math.floor((job.uploadedBytes / job.totalBytes) * 100))
    : null;
  const queuePosition = job.state === 'waiting'
    ? queue.filter(item => item.state === 'waiting').findIndex(item => item.id === job.id) + 1
    : null;

  return {
    id: job.id,
    filename: job.filename,
    category: job.category,
    destination: `EZ Uploads / ${job.category}`,
    state: job.state,
    uploadedBytes: job.uploadedBytes,
    totalBytes: job.totalBytes,
    uploaded: formatBytes(job.uploadedBytes),
    total: job.totalBytes ? formatBytes(job.totalBytes) : null,
    percent,
    queuePosition: queuePosition > 0 ? queuePosition : null,
    elapsed: durationMs ? formatDuration(durationMs) : null,
    averageSpeed: durationMs ? formatSpeed(job.uploadedBytes, durationMs) : null,
    error: job.error
  };
}

export function urlSourceFactory(url, fallback = {}, requestHeaders = {}) {
  return async signal => {
    const response = await safeFetch(url, { signal, headers: requestHeaders });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    if (!response.body) throw new Error('Source returned no body');

    const headerFilename = contentDispositionFilename(response.headers.get('content-disposition'));
    const totalHeader = response.headers.get('content-length');
    const totalBytes = totalHeader !== null && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null;

    return {
      stream: Readable.fromWeb(response.body),
      filename: headerFilename || fallback.filename || filenameFromUrl(url),
      mimeType: response.headers.get('content-type') || fallback.mimeType || 'application/octet-stream',
      totalBytes
    };
  };
}

export function trustedUrlSourceFactory(url) {
  return async signal => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Telegram file returned HTTP ${response.status}`);
    if (!response.body) throw new Error('Telegram file returned no body');
    return Readable.fromWeb(response.body);
  };
}

export function fileSourceFactory(filePath) {
  return async signal => fs.createReadStream(filePath, { signal });
}

export function streamSourceFactory(stream) {
  return async signal => {
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    const abort = () => stream.destroy(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    stream.once('close', () => signal?.removeEventListener('abort', abort));
    return stream;
  };
}

export function filenameFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const base = decodeURIComponent(path.basename(parsed.pathname));
    return base && base !== '/' ? base : `upload-${Date.now()}`;
  } catch {
    return `upload-${Date.now()}`;
  }
}

export function filenameFromDisposition(disposition) {
  return contentDispositionFilename(disposition);
}
