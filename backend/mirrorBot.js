import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Transform } from 'node:stream';
import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import { resolveUrl } from './resolver.js';
import { checkEzDriveConnection, uploadFileViaEz } from './ezApiClient.js';
import { safeFetch, filenameFromUrl } from './upload.js';
import { downloadHttpSource, copyLocalTelegramFile } from './mirrorDownload.js';
import { probeMedia, prepareMkv } from './mediaPrep.js';
import { preflightTorrent, downloadTorrent } from './torrentWorker.js';
import { jobManager } from './jobs/jobManager.js';
import { runtimeState } from './storage/runtimeState.js';
import {
  buildOwnerJobsText,
  buildQueuesText,
  buildStorageText,
  getOwnerStorageSummary,
  staleCallbackText
} from './status/ownerStatus.js';
import {
  catalogStore,
  isCatalogOwner
} from './storage/catalogStore.js';

const token = process.env.MIRROR_TELEGRAM_BOT_TOKEN || config.telegramToken;
if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');

export const mirrorBot = new Telegraf(token, {
  telegram: { apiRoot: config.telegramApiRoot },
  handlerTimeout: 6 * 60 * 60 * 1000
});

const sessions = new Map();
let nextId = 1;

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.webm', '.avi', '.mov', '.m4v', '.ts']);

function newSession(ctx, extra = {}) {
  const id = String(nextId++);

  const job = jobManager.create({
    id,
    type: extra.kind || 'legacy-session',
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    metadata: {
      kind: extra.kind || null
    }
  });

  const session = {
    id,
    userId: String(ctx.from.id),
    chatId: ctx.chat.id,
    createdAt: Date.now(),

    // Session and JobManager share the exact same AbortController.
    abort: job.abortController,
    job,

    ...extra
  };

  sessions.set(id, session);
  return session;
}

function getSession(id, userId) {
  const s = sessions.get(String(id));
  if (!s || s.userId !== String(userId)) return null;
  return s;
}

function resetSessionAbort(session) {
  const controller = new AbortController();
  session.abort = controller;

  const job = jobManager.get(session.id);
  if (job) {
    job.abortController = controller;

    if (
      job.state === 'cancelled' ||
      job.state === 'failed' ||
      job.state === 'completed' ||
      job.state === 'cancelling'
    ) {
      job.state = 'created';
      job.finishedAt = null;
      job.error = null;
      job.result = null;
      job.updatedAt = Date.now();
    }
  }

  return controller;
}

function queueDisplayName(queueName) {
  if (queueName === 'preflight') return 'Torrent preflight';
  if (queueName === 'download') return 'Movie download';
  if (queueName === 'processing') return 'MKV processing';
  if (queueName === 'upload') return 'Google Drive upload';
  return queueName;
}

async function enqueueSessionStage(
  session,
  queueName,
  runner,
  {
    queuedDetail = '',
    startingDetail = ''
  } = {}
) {
  if (session.activePromise) {
    const error = new Error('This job already has an active stage');
    error.code = 'JOB_ALREADY_ACTIVE';
    throw error;
  }

  const label = queueDisplayName(queueName);

  const promise = jobManager.enqueue(
    session.id,
    queueName,
    runner,
    {
      onQueued: info => {
        const detail = queuedDetail ? `\n\n${queuedDetail}` : '';
        void setStatus(
          session,
          `⏳ ${label} queued\n\nQueue position: ${info.position}\nActive: ${info.active} / ${info.concurrency}${detail}`,
          cancelKeyboard(session.id)
        ).catch(() => {});
      },

      onStart: () => {
        const detail = startingDetail ? `\n\n${startingDetail}` : '';
        void setStatus(
          session,
          `▶️ ${label} starting...${detail}`,
          cancelKeyboard(session.id)
        ).catch(() => {});
      }
    }
  );

  session.activePromise = promise;

  try {
    return await promise;
  } finally {
    if (session.activePromise === promise) {
      session.activePromise = null;
    }
  }
}

async function cancelSession(session, {
  finalText = '🛑 Cancelled'
} = {}) {
  if (!session) return false;

  const result = jobManager.cancel(session.id, {
    userId: session.userId,
    reason: 'Cancelled by user'
  });

  // Legacy sessions created before JobManager wiring are still safe.
  if (!result.ok && result.reason === 'not_found') {
    if (!session.abort.signal.aborted) {
      session.abort.abort('Cancelled by user');
    }
  }

  // Remove actionable buttons immediately so Cancel cannot be pressed twice.
  await setStatus(
    session,
    '🛑 Cancelling...\n\nStopping the active operation safely.',
    Markup.inlineKeyboard([])
  ).catch(() => {});

  // Wait until a queued item is removed or an active worker has really stopped.
  const activePromise = session.activePromise;
  if (activePromise) {
    await activePromise.catch(() => {});
  }

  await cleanup(session, { finalText });

  jobManager.markCancelled(session.id);
  return true;
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? value.toFixed(1) : value.toFixed(2)} ${units[i]}`;
}

function humanDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return 'calculating...';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function cancelKeyboard(id) {
  return Markup.inlineKeyboard([[Markup.button.callback('🛑 Cancel', `mt-cancel:${id}`)]]);
}

async function setStatus(session, text, keyboard = cancelKeyboard(session.id)) {
  if (!session.statusMessageId) {
    const sent = await mirrorBot.telegram.sendMessage(session.chatId, text, keyboard);
    session.statusMessageId = sent.message_id;
    session.lastStatusText = text;
    return;
  }
  session.lastStatusText = text;
  await mirrorBot.telegram.editMessageText(
    session.chatId,
    session.statusMessageId,
    undefined,
    text,
    keyboard
  ).catch(() => {});
}

async function ensureDrive(userId) {
  const connected = await checkEzDriveConnection(userId);
  if (!connected) {
    throw new Error('Google Drive is not connected. Tap Open Drive Uploader and connect it first.');
  }
}

function workDir(session) {
  return path.join(os.tmpdir(), 'ez-mirror-torrent', `job-${session.id}-${Date.now()}`);
}

async function collectCleanupFiles(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          const stat = await fsp.stat(full);
          files.push({ path: full, size: stat.size });
        } catch {}
      }
    }
  }
  await walk(dir);
  return files;
}

async function cleanup(session, { finalText = null, quiet = false } = {}) {
  const started = Date.now();
  let freedBytes = 0;
  let totalBytes = 0;
  let files = [];

  if (session.workDir) {
    files = await collectCleanupFiles(session.workDir);
    totalBytes = files.reduce((sum, file) => sum + file.size, 0);

    if (!quiet) {
      await setStatus(
        session,
        `🧹 Cleaning temporary files\n\nFiles: ${files.length}\nTotal: ${humanBytes(totalBytes)}\n\nProgress: 0%\nFreed: 0 B\nElapsed: 0s`,
        Markup.inlineKeyboard([])
      );
    }

    let lastUpdate = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      await fsp.unlink(file.path).catch(() => {});
      freedBytes += file.size;
      const now = Date.now();

      if (!quiet && (now - lastUpdate >= 500 || i === files.length - 1)) {
        lastUpdate = now;
        const percent = totalBytes > 0 ? Math.min(100, Math.floor(freedBytes * 100 / totalBytes)) : 100;
        await setStatus(
          session,
          `🧹 Cleaning temporary files\n\nFiles: ${i + 1} / ${files.length}\nProgress: ${percent}%\nFreed: ${humanBytes(freedBytes)} / ${humanBytes(totalBytes)}\nElapsed: ${humanDuration((now - started) / 1000)}`,
          Markup.inlineKeyboard([])
        );
      }
    }

    await fsp.rm(session.workDir, { recursive: true, force: true }).catch(() => {});
  }

  sessions.delete(session.id);

  const managedJob = jobManager.get(session.id);
  if (
    managedJob &&
    managedJob.state !== 'cancelled' &&
    managedJob.state !== 'cancelling'
  ) {
    jobManager.markCompleted(session.id, {
      cleanup: true,
      finalText: finalText || null
    });
  }

  if (!quiet && finalText) {
    await setStatus(
      session,
      `${finalText}\n\n🧹 Temporary files removed\nFreed: ${humanBytes(freedBytes)}\nElapsed: ${humanDuration((Date.now() - started) / 1000)}`,
      Markup.inlineKeyboard([])
    );
  }

  return { freedBytes, totalBytes, files: files.length };
}


const MIN_DISK_RESERVE_BYTES = Number(
  process.env.CRZ_DISK_RESERVE_BYTES ||
  5 * 1024 * 1024 * 1024
);

async function getDiskStats(target = os.tmpdir()) {
  const stat = await fsp.statfs(target);
  const blockSize = Number(stat.bsize);
  const availableBytes =
    Number(stat.bavail) * blockSize;
  const totalBytes =
    Number(stat.blocks) * blockSize;

  return {
    availableBytes,
    totalBytes
  };
}

async function getFreeDiskBytes(target = os.tmpdir()) {
  return (await getDiskStats(target)).availableBytes;
}

async function ensureServerSpace(expectedBytes, multiplier = 1, target = os.tmpdir()) {
  if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) return;

  const {
    availableBytes: available,
    totalBytes
  } = await getDiskStats(target);

  const reserve = Math.max(
    MIN_DISK_RESERVE_BYTES,
    Math.ceil(totalBytes * 0.10)
  );

  const required = Math.ceil(
    expectedBytes * multiplier + reserve
  );

  if (available < required) {
    const error = new Error('Server temporary storage is too low');
    error.code = 'SERVER_STORAGE_LOW';
    error.requiredBytes = required;
    error.availableBytes = available;
    throw error;
  }
}

function friendlyError(error) {
  const code = String(error?.code || '');
  const raw = `${code} ${String(error?.message || '')}`.toLowerCase();

  if (error?.name === 'AbortError') {
    return { code: 'CANCELLED', title: 'Cancelled', text: 'The current operation was cancelled.' };
  }
  if (code === 'SERVER_STORAGE_LOW' || raw.includes('enospc') || raw.includes('no space left')) {
    return {
      code: 'SERVER_STORAGE_LOW',
      title: 'Server storage is too low',
      text: error?.requiredBytes
        ? `CRZ does not have enough temporary disk space.\n\nRequired: ~${humanBytes(error.requiredBytes)}\nAvailable: ${humanBytes(error.availableBytes)}\n\nFree some server storage and retry.`
        : 'CRZ ran out of temporary server storage. Free some space and retry.'
    };
  }
  if (code === 'DRIVE_AUTH_EXPIRED' || raw.includes('invalid_grant') || raw.includes('authorization expired') || raw.includes('token expired') || raw.includes('revoked')) {
    return {
      code: 'DRIVE_AUTH_EXPIRED',
      title: 'Google Drive login expired',
      text: 'Your Google Drive authorization is no longer valid.\n\nReconnect Google Drive, then tap Retry Upload.\n\nYour processed file is still safe on CRZ.',
      reconnect: true
    };
  }
  if (code === 'DRIVE_NOT_CONNECTED' || raw.includes('drive is not connected') || raw.includes('connect google drive')) {
    return {
      code: 'DRIVE_NOT_CONNECTED',
      title: 'Google Drive is not connected',
      text: 'Connect Google Drive, then tap Retry Upload.\n\nYour processed file is still safe on CRZ.',
      reconnect: true
    };
  }
  if (code === 'DRIVE_STORAGE_FULL' || raw.includes('storagequotaexceeded') || raw.includes('storage quota') || raw.includes('insufficient storage')) {
    return {
      code: 'DRIVE_STORAGE_FULL',
      title: 'Google Drive storage is full',
      text: 'Google Drive reported a storage/quota problem.\n\nFree Drive storage, then tap Retry Upload.\n\nYour processed file is still safe on CRZ.'
    };
  }
  if (code === 'DRIVE_RATE_LIMIT' || raw.includes('rate limit') || raw.includes('ratelimit') || raw.includes('too many requests')) {
    return {
      code: 'DRIVE_RATE_LIMIT',
      title: 'Google Drive is temporarily rate-limited',
      text: 'Google is temporarily limiting uploads. Wait a little and tap Retry Upload.\n\nYour processed file is still safe on CRZ.'
    };
  }
  if (code === 'DRIVE_PERMISSION' || raw.includes('insufficient permission') || raw.includes('permission denied')) {
    return {
      code: 'DRIVE_PERMISSION',
      title: 'Google Drive permission problem',
      text: 'Google rejected the upload because the Drive authorization no longer has the required permission.\n\nReconnect Google Drive and retry.',
      reconnect: true
    };
  }
  if (code === 'NETWORK_ERROR' || raw.includes('econnreset') || raw.includes('etimedout') || raw.includes('enotfound') || raw.includes('eai_again') || raw.includes('fetch failed') || raw.includes('socket')) {
    return {
      code: 'NETWORK_ERROR',
      title: 'Temporary network problem',
      text: 'The current transfer was interrupted by a temporary network/server problem.\n\nThe local file is preserved. Retry the current stage.'
    };
  }
  if (raw.includes('file is too big')) {
    return {
      code: 'TELEGRAM_FILE_TOO_BIG',
      title: 'Telegram file transfer failed',
      text: 'Telegram refused this file size through the current Bot API connection.\n\nLarge files require CRZ to use its local Telegram Bot API server.'
    };
  }
  if (raw.includes('ffmpeg') || raw.includes('invalid data found') || raw.includes('could not find codec') || raw.includes('corrupt')) {
    return {
      code: 'MEDIA_PROCESSING_ERROR',
      title: 'MKV processing failed',
      text: 'FFmpeg could not process this media cleanly. The downloaded source is preserved so you can retry processing.'
    };
  }
  return {
    code: code || 'UNKNOWN_ERROR',
    title: 'Operation failed',
    text: 'CRZ could not complete the current stage. The local job is preserved where possible so you can retry.'
  };
}

function readyKeyboard(session) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⬇️ Download', `mt-ready-download:${session.id}`),
      Markup.button.callback('☁️ Upload to Drive', `mt-ready-upload:${session.id}`)
    ],
    [Markup.button.callback('🗑 Delete', `mt-ready-delete:${session.id}`)]
  ]);
}

function retryKeyboard(session, info, stage) {
  const rows = [];
  if (info.reconnect) rows.push([Markup.button.webApp('☁️ Reconnect Google Drive', config.webappUrl)]);
  if (stage === 'upload') {
    rows.push([Markup.button.callback('🔁 Retry Upload', `mt-retry-upload:${session.id}`)]);
    if (session.readyFilePath) rows.push([Markup.button.callback('⬇️ Download Instead', `mt-ready-download:${session.id}`)]);
  } else if (stage === 'process') {
    rows.push([Markup.button.callback('🔁 Retry Processing', `mt-retry-process:${session.id}`)]);
  } else if (stage === 'copy') {
    rows.push([Markup.button.callback('🔁 Retry Local Copy', `mt-retry-copy:${session.id}`)]);
  } else if (stage === 'torrent') {
    rows.push([Markup.button.callback('🔁 Retry Torrent', `mt-retry-torrent:${session.id}`)]);
  }
  rows.push([Markup.button.callback('🗑 Cancel & Clean', `mt-cancel:${session.id}`)]);
  return Markup.inlineKeyboard(rows);
}

async function showRecoverableError(session, error, stage) {
  const info = friendlyError(error);
  if (info.code === 'CANCELLED') return cleanup(session, { finalText: '🛑 Cancelled' });
  await setStatus(session, `❌ ${info.title}\n\n${info.text}`, retryKeyboard(session, info, stage));
}

function telegramSendProgress({ totalBytes, onProgress }) {
  let done = 0;
  let last = 0;
  const started = Date.now();
  return new Transform({
    transform(chunk, _encoding, callback) {
      done += chunk.length;
      const now = Date.now();
      if (now - last >= 2000 || done >= totalBytes) {
        last = now;
        const elapsed = Math.max(0.001, (now - started) / 1000);
        const speed = done / elapsed;
        onProgress?.({
          doneBytes: done,
          totalBytes,
          percent: totalBytes > 0 ? Math.min(100, Math.floor(done * 100 / totalBytes)) : 100,
          speed,
          elapsedSeconds: elapsed,
          etaSeconds: speed > 0 ? Math.max(0, Math.round((totalBytes - done) / speed)) : null
        });
      }
      callback(null, chunk);
    }
  });
}

async function showPreparedChoices(session) {
  await setStatus(
    session,
    `✅ MKV Prepared\n\n${session.readyFilename}\nSize: ${humanBytes(session.readySize)}\nAudio: ${session.selectedAudio.language} ${session.readyOutputCodec.toUpperCase()}\nVideo: copied\nSubtitle: ${session.keepEnglishSubtitle && session.media.englishSubtitle ? 'English' : 'None'}\n\nWhat do you want to do?`,
    readyKeyboard(session)
  );
}

async function uploadReadyFile(session) {
  try {
    if (!session.readyFilePath) {
      throw new Error('Prepared file is no longer available');
    }

    await ensureDrive(session.userId);

    const result = await uploadPrepared(
      session,
      session.readyFilePath,
      session.readyFilename,
      session.readyMimeType || 'video/x-matroska'
    );

    // Only reach here after EZ returned final success.
    jobManager.markCompleted(session.id, {
      stage: 'upload',
      confirmed: true,
      result: result || null
    });

    await cleanup(session, {
      finalText:
        `✅ Uploaded to Google Drive\n\n${session.readyFilename}\nSize: ${humanBytes(session.readySize)}\nDrive: confirmed`
    });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    await showRecoverableError(session, error, 'upload');
  }
}

async function downloadReadyFile(session) {
  try {
    if (!session.readyFilePath) throw new Error('Prepared file is no longer available');
    const stat = await fsp.stat(session.readyFilePath);
    const source = fs.createReadStream(session.readyFilePath);
    const progress = telegramSendProgress({
      totalBytes: stat.size,
      onProgress: p => {
        void setStatus(
          session,
          `⬇️ Sending processed MKV to Telegram\n\n${session.readyFilename}\n\nProgress: ${p.percent}%\nSent: ${humanBytes(p.doneBytes)} / ${humanBytes(p.totalBytes)}\nSpeed: ${humanBytes(p.speed)}/s\nElapsed: ${humanDuration(p.elapsedSeconds)}\nETA: ${humanDuration(p.etaSeconds)}`,
          cancelKeyboard(session.id)
        );
      }
    });
    source.pipe(progress);
    await mirrorBot.telegram.sendDocument(session.chatId, { source: progress, filename: session.readyFilename });
    await cleanup(session, { finalText: `✅ Sent to Telegram\n\n${session.readyFilename}\nSize: ${humanBytes(stat.size)}` });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    await showRecoverableError(session, error, 'download');
  }
}

async function uploadPrepared(session, filePath, filename, mimeType = 'video/x-matroska') {
  const stat = await fsp.stat(filePath);
  session.uploadFinalizingShown = false;

  return enqueueSessionStage(
    session,
    'upload',
    async ({ signal }) => {
      await setStatus(
        session,
        `☁️ Uploading to Google Drive\n\n${filename}\n\nProgress: 0%\nSent: 0 B / ${humanBytes(stat.size)}\nSpeed: calculating...\nETA: calculating...\n\nRoute: CRZ → EZ → Google Drive`
      );

      const result = await uploadFileViaEz({
        telegramId: session.userId,
        filePath,
        filename,
        mimeType,
        signal,
        onProgress: p => {
          if (p.percent >= 100 || p.sentBytes >= p.totalBytes) {
            if (!session.uploadFinalizingShown) {
              session.uploadFinalizingShown = true;
              jobManager.markFinalizing(session.id);

              void setStatus(
                session,
                `☁️ Uploading to Google Drive\n\n${filename}\n\nProgress: 100%\nSent: ${humanBytes(p.sentBytes)} / ${humanBytes(p.totalBytes)}\n\n⏳ Finalizing with Google Drive...\nWaiting for EZ/Google confirmation.\n\nRoute: CRZ → EZ → Google Drive`,
                cancelKeyboard(session.id)
              );
            }
            return;
          }

          void setStatus(
            session,
            `☁️ Uploading to Google Drive\n\n${filename}\n\nProgress: ${p.percent}%\nSent: ${humanBytes(p.sentBytes)} / ${humanBytes(p.totalBytes)}\nSpeed: ${humanBytes(p.speed)}/s\nElapsed: ${humanDuration(p.elapsedSeconds)}\nETA: ${humanDuration(p.etaSeconds)}\n\nRoute: CRZ → EZ → Google Drive`
          );
        }
      });

      return result;
    },
    {
      queuedDetail: `${filename}\n${humanBytes(stat.size)}`,
      startingDetail: filename
    }
  );
}

async function presentMediaSelection(
  session,
  filePath,
  filename,
  media
) {
  if (!media.audio.length) {
    throw new Error('No audio streams found in this MKV');
  }

  session.inputPath = filePath;
  session.filename = filename;
  session.media = media;

  if (media.audio.length === 1) {
    session.selectedAudio = media.audio[0];

    await setStatus(
      session,
      `🎧 Audio Track\n\n${filename}\n\nOnly one audio track was found:\n${media.audio[0].language} · ${media.audio[0].codec.toUpperCase()}${media.audio[0].channels ? ` · ${media.audio[0].channels}ch` : ''}\n\nUsing this track automatically...`
    );

    return askSubtitle(session);
  }

  session.selectedAudio = null;
  const shownAudio = media.audio.slice(0, 12);

  const isEnglishAudio = a =>
    String(a.language || '').trim().toLowerCase() === 'english';

  const rows = shownAudio.map((a, i) => [
    Markup.button.callback(
      `${isEnglishAudio(a) ? '⭐ ' : ''}${a.language} · ${a.codec.toUpperCase()}${a.channels ? ` · ${a.channels}ch` : ''}`,
      `mt-audio:${session.id}:${i}`
    )
  ]);

  rows.push([
    Markup.button.callback('🛑 Cancel', `mt-cancel:${session.id}`)
  ]);

  const summary = shownAudio
    .map(
      (a, i) =>
        `${i + 1}. ${isEnglishAudio(a) ? '⭐ ' : ''}${a.language} · ${a.codec.toUpperCase()}${a.channels ? ` · ${a.channels}ch` : ''}${a.supported ? ' ✅' : ' → conversion'}`
    )
    .join('\n');

  await setStatus(
    session,
    `🎧 Choose Audio\n\n${filename}\n\n${summary}\n\n⭐ = English recommended\nNo audio track is selected automatically.`,
    Markup.inlineKeyboard(rows)
  );
}

async function processDownloadedFile(session, filePath, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext !== '.mkv') {
    await setStatus(
      session,
      `✅ Download Complete\n\n${filename}\n\nNot an MKV. Uploading original file to Drive...`
    );

    const result = await uploadPrepared(
      session,
      filePath,
      filename,
      'application/octet-stream'
    );

    jobManager.markCompleted(session.id, {
      stage: 'upload',
      confirmed: true,
      result: result || null
    });

    await setStatus(
      session,
      `✅ Complete\n\n${filename}\n\nUploaded to Google Drive.\nFinal confirmation received.`,
      Markup.inlineKeyboard([])
    );

    return cleanup(session);
  }

  let media = null;

  if (isCatalogOwner(session.userId) && session.catalogSourceId) {
    const savedMetadata = await catalogStore.getMediaMetadata(
      session.catalogSourceId,
      session.userId
    );

    if (savedMetadata?.media) {
      media = savedMetadata.media;

      await setStatus(
        session,
        `♻️ Reusing Saved Analysis\n\n${filename}\n\nSkipping ffprobe.`
      );
    }
  }

  if (!media) {
    await setStatus(
      session,
      `🔎 Analyzing MKV\n\n${filename}\n\nReading video, audio and subtitle tracks...`
    );

    media = await probeMedia(filePath);

    if (isCatalogOwner(session.userId) && session.catalogSourceId) {
      try {
        await catalogStore.saveMediaMetadata({
          sourceId: session.catalogSourceId,
          media,
          ownerId: session.userId
        });
      } catch (error) {
        console.error(
          `[catalog] failed to persist media metadata for job ${session.id}:`,
          error
        );
      }
    }
  }

  return presentMediaSelection(
    session,
    filePath,
    filename,
    media
  );
}

async function askSubtitle(session) {
  const a = session.selectedAudio;
  const trackNotice = session.media?.audio?.length === 1
    ? 'ℹ️ Only 1 audio track found in this MKV.\nUsing it automatically.\n\n'
    : '';
  const conversion = a.supported
    ? `${a.codec.toUpperCase()} is supported → audio will be copied`
    : `${a.codec.toUpperCase()} is unsupported → audio-only conversion required`;

  if (!session.media.englishSubtitle) {
    session.keepEnglishSubtitle = false;
    await setStatus(session,
      `🎧 Audio Selected: ${a.language}\n\n${trackNotice}${conversion}\n\nEnglish subtitle: not found\n\nStarting MKV preparation...`
    );
    return runMediaPrep(session);
  }

  await setStatus(session,
    `🎧 Audio Selected: ${a.language}\nCodec: ${a.codec.toUpperCase()}${a.channels ? ` · ${a.channels}ch` : ''}\n\n${trackNotice}${conversion}\n\nKeep English subtitle?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Yes', `mt-sub:${session.id}:yes`),
        Markup.button.callback('❌ No', `mt-sub:${session.id}:no`)
      ],
      [Markup.button.callback('🛑 Cancel', `mt-cancel:${session.id}`)]
    ])
  );
}

function selectedOutputCodec(session) {
  if (session.selectedAudio.supported) {
    return session.selectedAudio.codec;
  }

  return String(
    process.env.MIRROR_AUDIO_TARGET || 'AAC'
  ).toLowerCase();
}

async function applySavedVariant(session, variant) {
  session.readyFilePath = variant.path;
  session.readyFilename = variant.filename;
  session.readyMimeType = 'video/x-matroska';
  session.readySize = variant.size;
  session.readyOutputCodec = variant.outputCodec;
  session.catalogVariantId = variant.id;

  jobManager.markWaitingUser(session.id, {
    variantReused: true,
    catalogVariantId: variant.id
  });

  jobManager.update(session.id, {
    stage: 'prepared'
  });

  await setStatus(
    session,
    `♻️ Prepared Variant Already Exists\n\n${variant.filename}\nSize: ${humanBytes(variant.size)}\n\nSkipping FFmpeg.`
  );

  await showPreparedChoices(session);
}

async function runMediaPrep(session) {
  const base = path.basename(
    session.filename,
    path.extname(session.filename)
  );

  const lang = session.selectedAudio.language || 'Audio';
  const outputCodec = selectedOutputCodec(session);

  if (isCatalogOwner(session.userId) && session.catalogSourceId) {
    const existing = await catalogStore.findVariant({
      sourceId: session.catalogSourceId,
      audioIndex: session.selectedAudio.index,
      keepEnglishSubtitle: session.keepEnglishSubtitle,
      outputCodec,
      ownerId: session.userId
    });

    if (existing) {
      return applySavedVariant(session, existing);
    }
  }

  const outputPath = path.join(
    session.workDir,
    `${base} [${lang}].mkv`
  );

  try {
    const inputStat = await fsp.stat(session.inputPath);
    await ensureServerSpace(
      inputStat.size,
      1.15,
      session.workDir || os.tmpdir()
    );
  } catch (error) {
    return showRecoverableError(session, error, 'process');
  }

  try {
    const result = await enqueueSessionStage(
      session,
      'processing',
      async ({ signal }) => {
        const started = Date.now();

        await setStatus(
          session,
          `🔧 Preparing MKV\n\nAudio: ${lang}\n${session.selectedAudio.codec.toUpperCase()} → ${session.selectedAudio.supported ? 'COPY' : String(process.env.MIRROR_AUDIO_TARGET || 'AAC').toUpperCase()}\nVideo: COPY\n\nProgress: starting...`
        );

        return prepareMkv({
          inputPath: session.inputPath,
          outputPath,
          audioStream: session.selectedAudio,
          englishSubtitle: session.media.englishSubtitle,
          keepEnglishSubtitle: session.keepEnglishSubtitle,
          durationSeconds: session.media.durationSeconds,
          signal,
          onProgress: p => {
            const elapsed = (Date.now() - started) / 1000;

            void setStatus(
              session,
              `🔧 Preparing MKV\n\nAudio: ${lang}\n${p.inputCodec.toUpperCase()} → ${p.converting ? p.outputCodec.toUpperCase() : 'COPY'}\nVideo: COPY\n\nProgress: ${p.percent ?? '?'}%\nSpeed: ${p.speed ? `${p.speed.toFixed(2)}x` : 'calculating...'}\nProcessed: ${humanDuration(p.processedSeconds)} / ${humanDuration(session.media.durationSeconds)}\nElapsed: ${humanDuration(elapsed)}\nETA: ${humanDuration(p.etaSeconds)}`
            );
          }
        });
      },
      {
        queuedDetail: `${session.filename}\nAudio: ${lang}`,
        startingDetail: `${session.filename}\nAudio: ${lang}`
      }
    );

    let finalPath = result.outputPath;
    let finalName = path.basename(result.outputPath);
    let finalSize = result.size;
    let variant = null;

    if (isCatalogOwner(session.userId) && session.catalogSourceId) {
      try {
        variant = await catalogStore.persistVariantFile({
          sourceId: session.catalogSourceId,
          audioIndex: session.selectedAudio.index,
          audioLanguage: session.selectedAudio.language,
          keepEnglishSubtitle: session.keepEnglishSubtitle,
          outputCodec: result.outputCodec,
          variantPath: result.outputPath,
          filename: finalName,
          size: result.size,
          ownerId: session.userId
        });

        finalPath = variant.path;
        finalName = variant.filename;
        finalSize = variant.size;
        session.catalogVariantId = variant.id;
      } catch (error) {
        console.error(
          `[catalog] failed to persist variant for job ${session.id}:`,
          error
        );
      }
    }

    session.readyFilePath = finalPath;
    session.readyFilename = finalName;
    session.readyMimeType = 'video/x-matroska';
    session.readySize = finalSize;
    session.readyOutputCodec = result.outputCodec;

    jobManager.markWaitingUser(session.id, {
      processingComplete: true,
      readyFilePath: session.readyFilePath,
      readyFilename: session.readyFilename,
      catalogVariantId: variant?.id || null
    });

    jobManager.update(session.id, {
      stage: 'prepared'
    });

    await showPreparedChoices(session);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    await showRecoverableError(session, error, 'process');
  }
}

async function runTorrentPreflightQueued(session) {
  return enqueueSessionStage(
    session,
    'preflight',
    async ({ signal }) => {
      const result = await preflightTorrent(
        session.source,
        session.workDir,
        {
          signal,
          onEvent: event => {
            if (event.type === 'metadata') {
              void setStatus(
                session,
                `🧲 Torrent Check\n\nFetching metadata...\nElapsed: ${humanDuration(event.elapsed)}\nPeers seen: ${event.peers}\nSeeds seen: ${event.seeds}`
              );
            } else if (event.type === 'health') {
              void setStatus(
                session,
                `🧲 Torrent Check\n\nMetadata received ✅\nChecking swarm...\n\nHealth: ${event.health}\nSeeds seen: ${event.seeds}\nPeers seen: ${event.peers}\nTrackers: ${event.trackers}\nElapsed: ${humanDuration(event.elapsed)}`
              );
            }
          }
        }
      );

      jobManager.markWaitingUser(session.id, {
        preflightComplete: true
      });
      jobManager.update(session.id, {
        stage: 'torrent-selection'
      });

      return result;
    },
    {
      queuedDetail: 'Waiting for a torrent-check slot.',
      startingDetail: 'Fetching metadata and checking swarm health.'
    }
  );
}

async function showTorrentReady(session, result, fallbackName = 'Torrent') {
  session.torrentInfo = result;

  if (isCatalogOwner(session.userId)) {
    try {
      const savedTorrent = await catalogStore.saveTorrent({
        source: session.source,
        info: result,
        ownerId: session.userId
      });

      session.catalogTorrentId = savedTorrent.id;
    } catch (error) {
      console.error(
        `[catalog] failed to persist torrent for job ${session.id}:`,
        error
      );
    }
  }

  const videoFiles = result.files
    .filter(f => VIDEO_EXTS.has(path.extname(f.name).toLowerCase()))
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);

  if (!videoFiles.length) throw new Error('No supported video files found in this torrent');

  const rows = videoFiles.map(f => [
    Markup.button.callback(
      `▶️ ${f.name.slice(0, 42)} · ${humanBytes(f.size)}`,
      `mt-tfile:${session.id}:${f.index}`
    )
  ]);
  rows.push([Markup.button.callback('🛑 Cancel / Try Another', `mt-cancel:${session.id}`)]);

  await setStatus(
    session,
    `🧲 Torrent Ready\n\n${result.name || fallbackName}\n\nHealth: ${result.health}\nSeeds seen: ${result.seeds}\nPeers seen: ${result.peers}\nTrackers: ${result.trackers}\n\nChoose the movie to download.`,
    Markup.inlineKeyboard(rows)
  );
}

async function beginTorrentPreflight(ctx, source) {
  const session = newSession(ctx, { source, kind: 'torrent' });
  session.workDir = workDir(session);
  await fsp.mkdir(session.workDir, { recursive: true });

  try {
    const result = await runTorrentPreflightQueued(session);
    await showTorrentReady(session, result);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    throw error;
  }
}

async function executeTorrentDownload(session, fileIndex, signal) {
  session.selectedTorrentFileIndex = Number(fileIndex);
  const selectedTorrentFile = session.torrentInfo?.files?.find(
    f => Number(f.index) === Number(fileIndex)
  );

  if (selectedTorrentFile?.size) {
    await ensureServerSpace(
      Number(selectedTorrentFile.size),
      2.15,
      session.workDir || os.tmpdir()
    );
  }

  return downloadTorrent(session.source, session.workDir, fileIndex, {
    signal,
    onEvent: event => {
      if (event.type === 'metadata') {
        void setStatus(
          session,
          `🧲 Starting Torrent\n\nFetching metadata...\nPeers: ${event.peers}\nSeeds: ${event.seeds}\nElapsed: ${humanDuration(event.elapsed)}`
        );
      } else if (event.type === 'progress') {
        const warning = event.elapsed >= 20 && event.speed < 512 * 1024
          ? '\n\n⚠️ Torrent is currently slow. You can cancel and try another.'
          : '';
        void setStatus(
          session,
          `🧲 Torrent Download\n\nProgress: ${event.percent}%\nDownloaded: ${humanBytes(event.done)} / ${humanBytes(event.total)}\nSpeed: ${humanBytes(event.speed)}/s\nSeeds: ${event.seeds}\nPeers: ${event.peers}\nElapsed: ${humanDuration(event.elapsed)}\nETA: ${humanDuration(event.eta)}${warning}`
        );
      }
    }
  });
}

async function runTorrentDownload(session, fileIndex) {
  const selectedTorrentFile = session.torrentInfo?.files?.find(
    f => Number(f.index) === Number(fileIndex)
  );

  const result = await enqueueSessionStage(
    session,
    'download',
    async ({ signal }) => executeTorrentDownload(session, fileIndex, signal),
    {
      queuedDetail: selectedTorrentFile
        ? `${selectedTorrentFile.name}\n${humanBytes(selectedTorrentFile.size)}`
        : 'Waiting for a movie-download slot.',
      startingDetail: selectedTorrentFile?.name || ''
    }
  );

  if (
    isCatalogOwner(session.userId) &&
    session.catalogTorrentId
  ) {
    try {
      const savedSource = await catalogStore.persistSourceFile({
        torrentId: session.catalogTorrentId,
        fileIndex,
        sourcePath: result.file_path,
        filename: result.filename,
        size: result.size,
        ownerId: session.userId
      });

      result.file_path = savedSource.path;
      result.filename = savedSource.filename;
      result.size = savedSource.size;
      session.catalogSourceId = savedSource.id;
    } catch (error) {
      console.error(
        `[catalog] failed to persist source for job ${session.id}:`,
        error
      );
    }
  }

  // Download queue slot is free before ffprobe/media analysis begins.
  jobManager.update(session.id, {
    state: 'running',
    stage: 'analysis',
    queueName: null,
    queuePosition: null
  });

  await setStatus(
    session,
    `✅ Torrent Download Complete\n\n${result.filename}\nSize: ${humanBytes(result.size)}\n\n🔎 Analyzing file immediately...`
  );

  await processDownloadedFile(session, result.file_path, result.filename);

  if (sessions.has(session.id)) {
    const job = jobManager.get(session.id);
    if (job && !jobManager.isTerminal(job)) {
      jobManager.markWaitingUser(session.id, { downloadComplete: true });
    }
  }
}

async function beginResolvedSource(ctx, source) {
  const session = newSession(ctx, { source, kind: 'http' });
  session.workDir = workDir(session);

  await setStatus(session,
    `🔗 Source Ready\n\n${source.filename || filenameFromUrl(source.url)}\nMethod: ${source.method || 'direct'}\n\nStarting download...`
  );

  const started = Date.now();
  const result = await downloadHttpSource(source, session.workDir, {
    signal: session.abort.signal,
    onProgress: p => {
      const elapsed = (Date.now() - started) / 1000;
      void setStatus(session,
        `⬇️ Downloading Source\n\n${source.filename || filenameFromUrl(source.url)}\n\nProgress: ${p.percent ?? '?'}%\nDownloaded: ${humanBytes(p.doneBytes)}${p.totalBytes ? ` / ${humanBytes(p.totalBytes)}` : ''}\nSpeed: ${humanBytes(p.speed)}/s\nElapsed: ${humanDuration(elapsed)}\nETA: ${humanDuration(p.etaSeconds)}`
      );
    }
  });

  return processDownloadedFile(session, result.filePath, result.filename);
}

async function handleUrl(ctx, rawUrl) {
  const waiting = await ctx.reply('🔎 Resolving link...\n\nChecking for a downloadable source.');
  let resolved;
  try {
    resolved = await resolveUrl(rawUrl);
  } catch (error) {
    return ctx.telegram.editMessageText(ctx.chat.id, waiting.message_id, undefined,
      `❌ Could not resolve link\n\n${error.message}`);
  }

  if (resolved.kind === 'choices') {
    const session = newSession(ctx, { kind: 'choice', choices: resolved.choices });
    session.statusMessageId = waiting.message_id;
    const rows = resolved.choices.slice(0, 8).map((choice, i) => [
      Markup.button.callback(
        String(choice.label || choice.name || filenameFromUrl(choice.url) || `Source ${i + 1}`).slice(0, 48),
        `mt-source:${session.id}:${i}`
      )
    ]);
    rows.push([Markup.button.callback('🛑 Cancel', `mt-cancel:${session.id}`)]);
    await setStatus(session, '🔗 Multiple Sources Found\n\nChoose the download source:', Markup.inlineKeyboard(rows));
    return;
  }

  await ctx.telegram.deleteMessage(ctx.chat.id, waiting.message_id).catch(() => {});
  return beginResolvedSource(ctx, resolved);
}

async function runTelegramMkvCopy(session) {
  const doc = session.telegramDoc;
  const filename = session.filename;
  const started = Date.now();

  try {
    if (doc.file_size) {
      await ensureServerSpace(Number(doc.file_size), 2.15, session.workDir || os.tmpdir());
    }

    await setStatus(
      session,
      `⬇️ Local Copy\n\n${filename}\nSize: ${humanBytes(doc.file_size)}\n\nProgress: 0%\nCopied: 0 B${doc.file_size ? ` / ${humanBytes(doc.file_size)}` : ''}\nSpeed: calculating...\nElapsed: 0s\nETA: calculating...`
    );

    const tgFile = await mirrorBot.telegram.getFile(doc.file_id);
    let result;

    if (tgFile.file_path && path.isAbsolute(tgFile.file_path)) {
      result = await copyLocalTelegramFile(tgFile.file_path, session.workDir, filename, {
        signal: session.abort.signal,
        onProgress: p => void setStatus(
          session,
          `⬇️ Local Copy\n\n${filename}\n\nProgress: ${p.percent ?? '?'}%\nCopied: ${humanBytes(p.doneBytes)} / ${humanBytes(p.totalBytes)}\nSpeed: ${humanBytes(p.speed)}/s\nElapsed: ${humanDuration((Date.now() - started) / 1000)}\nETA: ${humanDuration(p.etaSeconds)}`
        )
      });
    } else {
      const url = `${config.telegramApiRoot}/file/bot${token}/${tgFile.file_path}`;
      result = await downloadHttpSource(
        { url, filename, headers: {}, mimeType: doc.mime_type || 'video/x-matroska' },
        session.workDir,
        {
          signal: session.abort.signal,
          onProgress: p => void setStatus(
            session,
            `⬇️ Local Copy\n\n${filename}\n\nProgress: ${p.percent ?? '?'}%\nCopied: ${humanBytes(p.doneBytes)}${p.totalBytes ? ` / ${humanBytes(p.totalBytes)}` : ''}\nSpeed: ${humanBytes(p.speed)}/s\nElapsed: ${humanDuration((Date.now() - started) / 1000)}\nETA: ${humanDuration(p.etaSeconds)}`
          )
        }
      );
    }

    await setStatus(
      session,
      `✅ Local Copy Complete\n\n${filename}\nSize: ${humanBytes(result.totalBytes)}\nElapsed: ${humanDuration((Date.now() - started) / 1000)}\n\nAnalyzing MKV...`
    );

    return processDownloadedFile(session, result.filePath, filename);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    await showRecoverableError(session, error, 'copy');
  }
}

async function handleTelegramDocument(ctx, doc) {
  const filename = doc.file_name || `telegram-${Date.now()}`;
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.torrent') {
    const session = newSession(ctx, { kind: 'torrent-upload' });
    session.workDir = workDir(session);
    await fsp.mkdir(session.workDir, { recursive: true });
    await setStatus(session, `📦 Torrent file received\n\n${filename}\n\nPreparing torrent health check...`);

    const tgFile = await ctx.telegram.getFile(doc.file_id);
    let torrentPath;
    if (tgFile.file_path && path.isAbsolute(tgFile.file_path)) {
      torrentPath = path.join(session.workDir, path.basename(filename));
      await fsp.copyFile(tgFile.file_path, torrentPath);
    } else {
      const url = `${config.telegramApiRoot}/file/bot${token}/${tgFile.file_path}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
      torrentPath = path.join(session.workDir, path.basename(filename));
      await fsp.writeFile(torrentPath, Buffer.from(await response.arrayBuffer()));
    }

    // Reuse the same session id/status message by running preflight directly.
    session.kind = 'torrent';
    session.source = { kind: 'torrent', value: torrentPath };

    try {
      const result = await runTorrentPreflightQueued(session);
      await showTorrentReady(session, result, filename);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      throw error;
    }

    return;
  }

  if (ext !== '.mkv') {
    return ctx.reply('For direct Telegram files, send an MKV or a .torrent file.');
  }

  const session = newSession(ctx, { kind: 'telegram-mkv' });
  session.workDir = workDir(session);
  session.filename = filename;
  session.telegramDoc = {
    file_id: doc.file_id,
    file_name: filename,
    file_size: doc.file_size || null,
    mime_type: doc.mime_type || 'video/x-matroska'
  };
  await fsp.mkdir(session.workDir, { recursive: true });

  return runTelegramMkvCopy(session);
}

mirrorBot.start(ctx => ctx.reply(
  'Send me:\n\n🧲 Magnet link\n📦 .torrent file\n🔗 Mirror/direct download link\n🎬 MKV file\n\nI will show progress for download → MKV preparation → Google Drive upload.',
  Markup.inlineKeyboard([
    [Markup.button.webApp('☁️ Open Drive Uploader', config.webappUrl)]
  ])
));

mirrorBot.command('help', ctx => ctx.reply(
  'Reliable workflow:\n\n1. Send torrent/magnet/link/MKV\n2. Torrent health is checked first\n3. Choose movie/audio\n4. Unsupported audio is converted for browser playback\n5. Final file uploads to the same Google Drive account\n\n/cancel - cancel your latest active job'
));

mirrorBot.command('cancel', async ctx => {
  const active = [...sessions.values()]
    .filter(s => s.userId === String(ctx.from.id))
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (!active) {
    return ctx.reply('No active job.');
  }

  await cancelSession(active);
});

mirrorBot.on('text', async (ctx, next) => {
  const text = String(ctx.message.text || '').trim();

  // Commands registered later in this file must continue through
  // Telegraf's middleware chain instead of being swallowed here.
  if (text.startsWith('/')) {
    return next();
  }

  if (!text) return;

  try {
    if (text.startsWith('magnet:?')) {
      return await beginTorrentPreflight(ctx, { kind: 'magnet', value: text });
    }
    if (/^https?:\/\//i.test(text)) {
      return await handleUrl(ctx, text);
    }
    await ctx.reply('Send a magnet link, HTTP/HTTPS mirror/direct link, MKV, or .torrent file.');
  } catch (error) {
    await ctx.reply(`❌ ${error.message}`);
  }
});

mirrorBot.on('document', async ctx => {
  try {
    await handleTelegramDocument(ctx, ctx.message.document);
  } catch (error) {
    const info = friendlyError(error);
    await ctx.reply(`❌ ${info.title}\n\n${info.text}`);
  }
});

mirrorBot.action(/^mt-cancel:(\d+)$/, async ctx => {
  const s = getSession(ctx.match[1], ctx.from.id);

  // Telegram callback queries can only be answered once reliably.
  // Return a useful stale-button message instead of ACKing twice.
  if (!s) {
    await ctx.answerCbQuery('This job is no longer active.').catch(() => {});
    return;
  }

  // ACK immediately before any cancellation/cleanup work.
  await ctx.answerCbQuery('Cancelling...').catch(() => {});

  await cancelSession(s);
});

async function showProcessedMovies(ctx) {
  if (!isCatalogOwner(ctx.from.id)) {
    await ctx.reply('This menu is owner-only.');
    return;
  }

  const movies = await catalogStore.listProcessedMovies(ctx.from.id);

  if (!movies.length) {
    await ctx.reply(
      '🎬 Processed Movies\n\nNo persistent movie sources yet.'
    );
    return;
  }

  const shown = movies.slice(0, 20);

  const rows = shown.map(item => [
    Markup.button.callback(
      `🎬 ${String(item.source.filename).slice(0, 40)} · ${item.variants.length} variant${item.variants.length === 1 ? '' : 's'}`,
      `mt-catalog-movie:${item.source.id}`
    )
  ]);

  await ctx.reply(
    `🎬 Processed Movies\n\nSources: ${movies.length}\nShowing: ${shown.length}\n\nOpen a movie to reuse its saved analysis and create/reopen variants.`,
    Markup.inlineKeyboard(rows)
  );
}

mirrorBot.command('movies', showProcessedMovies);

mirrorBot.action(
  /^mt-catalog-movie:(.+)$/,
  async ctx => {
    if (!isCatalogOwner(ctx.from.id)) {
      await ctx.answerCbQuery('Owner only.').catch(() => {});
      return;
    }

    const all = await catalogStore.listProcessedMovies(ctx.from.id);
    const record = all.find(
      item => item.source.id === ctx.match[1]
    );

    if (!record) {
      await ctx.answerCbQuery(
        'This saved movie is unavailable.'
      ).catch(() => {});
      return;
    }

    await ctx.answerCbQuery('Opening saved movie...').catch(() => {});

    const session = newSession(ctx, {
      kind: 'catalog-source',
      catalogSourceId: record.source.id
    });

    session.workDir = workDir(session);
    await fsp.mkdir(session.workDir, { recursive: true });

    let media = record.metadata?.media || null;

    if (!media) {
      await setStatus(
        session,
        `🔎 Analyzing Saved MKV\n\n${record.source.filename}\n\nNo cached analysis found. Running ffprobe once...`
      );

      media = await probeMedia(record.source.path);

      await catalogStore.saveMediaMetadata({
        sourceId: record.source.id,
        media,
        ownerId: session.userId
      });
    } else {
      await setStatus(
        session,
        `♻️ Saved Analysis Loaded\n\n${record.source.filename}\n\nNo ffprobe needed.`
      );
    }

    await presentMediaSelection(
      session,
      record.source.path,
      record.source.filename,
      media
    );
  }
);

async function showAvailableTorrents(ctx) {
  if (!isCatalogOwner(ctx.from.id)) {
    await ctx.reply('This menu is owner-only.');
    return;
  }

  const torrents = await catalogStore.listTorrents(ctx.from.id);

  if (!torrents.length) {
    await ctx.reply('📚 Available Torrents\n\nNo saved torrents yet.');
    return;
  }

  const shown = torrents.slice(0, 20);

  const rows = shown.map(item => [
    Markup.button.callback(
      `🧲 ${String(item.name || 'Torrent').slice(0, 48)}`,
      `mt-catalog-torrent:${item.id}`
    )
  ]);

  await ctx.reply(
    `📚 Available Torrents\n\nSaved: ${torrents.length}\nShowing: ${shown.length}\n\nThese entries survive CRZ restarts.`,
    Markup.inlineKeyboard(rows)
  );
}

mirrorBot.command('torrents', showAvailableTorrents);

mirrorBot.action(/^mt-catalog-torrent:([a-f0-9]{16})$/, async ctx => {
  if (!isCatalogOwner(ctx.from.id)) {
    await ctx.answerCbQuery('Owner only.').catch(() => {});
    return;
  }

  const record = await catalogStore.getTorrent(
    ctx.match[1],
    ctx.from.id
  );

  if (!record) {
    await ctx.answerCbQuery(
      'This saved torrent is unavailable.'
    ).catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Opening saved torrent...').catch(() => {});

  const session = newSession(ctx, {
    source: record.source,
    kind: 'torrent',
    catalogTorrentId: record.id
  });

  session.workDir = workDir(session);
  await fsp.mkdir(session.workDir, { recursive: true });

  await showTorrentReady(
    session,
    {
      name: record.name,
      health: record.health,
      seeds: record.seeds,
      peers: record.peers,
      trackers: record.trackers,
      files: record.files
    },
    record.name
  );
});

mirrorBot.action(/^mt-tfile:(\d+):(\d+)$/, async ctx => {
  const s = getSession(ctx.match[1], ctx.from.id);

  if (!s) {
    await ctx.answerCbQuery('This job is no longer active.').catch(() => {});
    return;
  }

  const job = jobManager.get(s.id);

  if (
    s.activePromise ||
    job?.state === 'queued' ||
    job?.state === 'running' ||
    job?.state === 'cancelling'
  ) {
    await ctx.answerCbQuery('This job is already active.').catch(() => {});
    return;
  }

  const fileIndex = Number(ctx.match[2]);

  if (
    isCatalogOwner(s.userId) &&
    s.catalogTorrentId
  ) {
    const savedSource = await catalogStore.findSource({
      torrentId: s.catalogTorrentId,
      fileIndex,
      ownerId: s.userId
    });

    if (savedSource) {
      await ctx.answerCbQuery('Using saved movie source.').catch(() => {});
      resetSessionAbort(s);
      s.catalogSourceId = savedSource.id;

      jobManager.update(s.id, {
        state: 'running',
        stage: 'analysis',
        queueName: null,
        queuePosition: null
      });

      try {
        await setStatus(
          s,
          `♻️ Reusing Saved Source\n\n${savedSource.filename}\nSize: ${humanBytes(savedSource.size)}\n\nSkipping torrent download.`
        );

        await processDownloadedFile(
          s,
          savedSource.path,
          savedSource.filename
        );

        if (sessions.has(s.id)) {
          jobManager.markWaitingUser(s.id, {
            sourceReused: true,
            catalogSourceId: savedSource.id
          });
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
        await showRecoverableError(s, error, 'torrent');
      }

      return;
    }
  }

  await ctx.answerCbQuery('Movie added to download queue.').catch(() => {});

  try {
    await runTorrentDownload(s, fileIndex);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    await showRecoverableError(s, error, 'torrent');
  }
});

mirrorBot.action(/^mt-source:(\d+):(\d+)$/, async ctx => {
  await ctx.answerCbQuery('Source selected').catch(() => {});
  const s = getSession(ctx.match[1], ctx.from.id);
  if (!s) return;
  const choice = s.choices?.[Number(ctx.match[2])];
  if (!choice?.url) return setStatus(s, '❌ Invalid source selection', undefined);

  try {
    await cleanup(s);
    await handleUrl(ctx, choice.url);
  } catch (error) {
    await ctx.reply(`❌ ${error.message}`);
  }
});

mirrorBot.action(/^mt-audio:(\d+):(\d+)$/, async ctx => {
  await ctx.answerCbQuery('Audio selected').catch(() => {});
  const s = getSession(ctx.match[1], ctx.from.id);
  if (!s) return;
  const audio = s.media?.audio?.[Number(ctx.match[2])];
  if (!audio) return;
  s.selectedAudio = audio;
  try {
    await askSubtitle(s);
  } catch (error) {
    await showRecoverableError(s, error, 'process');
  }
});

mirrorBot.action(/^mt-sub:(\d+):(yes|no)$/, async ctx => {
  await ctx.answerCbQuery('Starting processing...').catch(() => {});
  const s = getSession(ctx.match[1], ctx.from.id);
  if (!s) return;
  s.keepEnglishSubtitle = ctx.match[2] === 'yes';

  try {
    await runMediaPrep(s);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    await showRecoverableError(s, error, 'process');
  }
});

mirrorBot.action(/^mt-ready-upload:(\d+)$/, async ctx => {
  const s = getSession(ctx.match[1], ctx.from.id);

  if (!s) {
    await ctx.answerCbQuery('This job is no longer active.').catch(() => {});
    return;
  }

  if (s.activePromise) {
    await ctx.answerCbQuery('This job is already active.').catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Drive upload queued.').catch(() => {});
  resetSessionAbort(s);
  await uploadReadyFile(s);
});

mirrorBot.action(/^mt-ready-download:(\d+)$/, async ctx => {
  await ctx.answerCbQuery('Preparing download...').catch(() => {});
  const s = getSession(ctx.match[1], ctx.from.id);
  if (!s) return;
  resetSessionAbort(s);
  await downloadReadyFile(s);
});

mirrorBot.action(/^mt-ready-delete:(\d+)$/, async ctx => {
  const s = getSession(ctx.match[1], ctx.from.id);

  if (!s) {
    await ctx.answerCbQuery(
      'This job is no longer active.'
    ).catch(() => {});
    return;
  }

  await ctx.answerCbQuery(
    'Deleting prepared variant...'
  ).catch(() => {});

  if (isCatalogOwner(s.userId) && s.catalogVariantId) {
    await catalogStore.deleteVariant(
      s.catalogVariantId,
      s.userId
    );
  }

  await cleanup(
    s,
    { finalText: '🗑 Prepared variant deleted' }
  );
});

mirrorBot.action(/^mt-retry-upload:(\d+)$/, async ctx => {
  const s = getSession(ctx.match[1], ctx.from.id);

  if (!s) {
    await ctx.answerCbQuery('This job is no longer active.').catch(() => {});
    return;
  }

  if (s.activePromise) {
    await ctx.answerCbQuery('This job is already active.').catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Retry upload queued.').catch(() => {});
  resetSessionAbort(s);
  await uploadReadyFile(s);
});

mirrorBot.action(/^mt-retry-process:(\d+)$/, async ctx => {
  const s = getSession(ctx.match[1], ctx.from.id);

  if (!s) {
    await ctx.answerCbQuery('This job is no longer active.').catch(() => {});
    return;
  }

  if (s.activePromise) {
    await ctx.answerCbQuery('This job is already active.').catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Retry processing queued.').catch(() => {});
  resetSessionAbort(s);
  await runMediaPrep(s);
});

mirrorBot.action(/^mt-retry-copy:(\d+)$/, async ctx => {
  await ctx.answerCbQuery('Retrying local copy...').catch(() => {});
  const s = getSession(ctx.match[1], ctx.from.id);
  if (!s) return;
  resetSessionAbort(s);
  await runTelegramMkvCopy(s);
});

mirrorBot.action(/^mt-retry-torrent:(\d+)$/, async ctx => {
  await ctx.answerCbQuery('Retrying torrent...').catch(() => {});
  const s = getSession(ctx.match[1], ctx.from.id);
  if (!s || s.selectedTorrentFileIndex == null) return;
  resetSessionAbort(s);
  await runTorrentDownload(s, s.selectedTorrentFileIndex);
});



async function ownerOnly(ctx) {
  if (isCatalogOwner(ctx.from.id)) {
    return true;
  }

  await ctx.reply('This menu is owner-only.');
  return false;
}

mirrorBot.command('jobs', async ctx => {
  if (!(await ownerOnly(ctx))) return;

  const interrupted =
    await getInterruptedMirrorJobs();

  await ctx.reply(
    buildOwnerJobsText({
      jobs: jobManager.snapshot().jobs,
      interrupted
    })
  );
});

mirrorBot.command('queues', async ctx => {
  if (!(await ownerOnly(ctx))) return;

  await ctx.reply(
    buildQueuesText(
      jobManager.snapshot().queues
    )
  );
});

mirrorBot.command('storage', async ctx => {
  if (!(await ownerOnly(ctx))) return;

  try {
    const summary =
      await getOwnerStorageSummary({
        storageRoot:
          catalogStore.root,
        tempRoot:
          path.join(
            os.tmpdir(),
            'ez-mirror-torrent'
          )
      });

    await ctx.reply(
      buildStorageText(summary)
    );
  } catch (error) {
    await ctx.reply(
      `❌ Could not read CRZ storage status

${error.message}`
    );
  }
});

let runtimePersistenceTimer = null;
let runtimeSweepTimer = null;

function runtimeSessionSnapshot() {
  return [...sessions.values()].map(session => ({
    id: session.id,
    userId: session.userId,
    chatId: session.chatId,
    createdAt: session.createdAt,
    kind: session.kind || null,
    source: session.source || null,
    workDir: session.workDir || null,
    filename: session.filename || null,
    inputPath: session.inputPath || null,
    readyFilePath: session.readyFilePath || null,
    readyFilename: session.readyFilename || null,
    selectedTorrentFileIndex:
      session.selectedTorrentFileIndex ?? null,
    catalogTorrentId:
      session.catalogTorrentId || null,
    catalogSourceId:
      session.catalogSourceId || null,
    catalogVariantId:
      session.catalogVariantId || null
  }));
}

async function persistMirrorRuntime() {
  await runtimeState.saveRuntime({
    jobs: jobManager.snapshot().jobs,
    sessions: runtimeSessionSnapshot()
  });
}

async function sweepMirrorTemp() {
  const protectedPaths =
    [...sessions.values()]
      .map(session => session.workDir)
      .filter(Boolean);

  const result =
    await runtimeState.sweepTemp({
      protectedPaths
    });

  if (result.removed > 0) {
    console.log(
      `CRZ temp cleanup: removed=${result.removed} freed=${result.freedBytes}`
    );
  }

  return result;
}

export async function initializeMirrorRuntime() {
  const interrupted =
    await runtimeState
      .markPreviousRunInterrupted();

  if (interrupted.length) {
    console.log(
      `CRZ recovery: ${interrupted.length} interrupted job(s) marked retryable`
    );
  }

  await sweepMirrorTemp();

  if (!runtimePersistenceTimer) {
    runtimePersistenceTimer =
      setInterval(
        () => {
          persistMirrorRuntime()
            .catch(error => {
              console.error(
                'CRZ runtime persistence error:',
                error.message
              );
            });
        },
        5000
      );

    runtimePersistenceTimer.unref();
  }

  if (!runtimeSweepTimer) {
    runtimeSweepTimer =
      setInterval(
        () => {
          sweepMirrorTemp()
            .catch(error => {
              console.error(
                'CRZ temp sweep error:',
                error.message
              );
            });
        },
        10 * 60 * 1000
      );

    runtimeSweepTimer.unref();
  }
}

export async function shutdownMirrorRuntime() {
  if (runtimePersistenceTimer) {
    clearInterval(runtimePersistenceTimer);
    runtimePersistenceTimer = null;
  }

  if (runtimeSweepTimer) {
    clearInterval(runtimeSweepTimer);
    runtimeSweepTimer = null;
  }

  await persistMirrorRuntime();
}

export async function getInterruptedMirrorJobs() {
  return runtimeState.listInterrupted();
}


/*
 * Final callback fallback.
 *
 * Specific mt-* handlers above get first chance to handle valid actions.
 * Any old/stale button that reaches this point is acknowledged once with a
 * safe message instead of timing out or throwing.
 */
mirrorBot.action(/^mt-/, async ctx => {
  await ctx.answerCbQuery(
    staleCallbackText()
  ).catch(() => {});
});

export async function registerMirrorBotCommands() {
  await mirrorBot.telegram.setMyCommands([
    { command: 'start', description: 'Open CRZ Bot' },
    { command: 'help', description: 'Show supported inputs' },
    { command: 'torrents', description: 'Open saved torrent catalog' },
    { command: 'movies', description: 'Open processed movie catalog' },
    { command: 'jobs', description: 'Show active CRZ jobs' },
    { command: 'queues', description: 'Show CRZ queue usage' },
    { command: 'storage', description: 'Show CRZ storage usage' },
    { command: 'cancel', description: 'Cancel current job' }
  ]);
}
