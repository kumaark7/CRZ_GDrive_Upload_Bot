import fs from 'node:fs';
import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import { isConnected } from './db.js';
import {
  cancelUpload,
  createUpload,
  fileSourceFactory,
  filenameFromDisposition,
  filenameFromUrl,
  getJob,
  getUserJobs,
  publicJob,
  safeFetch,
  trustedUrlSourceFactory,
  urlSourceFactory
} from './upload.js';
import { resolveUrl } from './resolver.js';

export const bot = new Telegraf(config.telegramToken, {
  telegram: { apiRoot: config.telegramApiRoot }
});

const autoRefreshTimers = new Map();
const resolverSessions = new Map();
let nextResolverSessionId = 1;

function saveResolverSession(userId, payload) {
  const id = String(nextResolverSessionId++);
  resolverSessions.set(id, {
    userId: String(userId),
    payload,
    expiresAt: Date.now() + 15 * 60 * 1000
  });
  return id;
}

function getResolverSession(id, userId) {
  const session = resolverSessions.get(String(id));
  if (!session || session.userId !== String(userId)) return null;
  if (Date.now() > session.expiresAt) {
    resolverSessions.delete(String(id));
    return null;
  }
  return session;
}

function resolverSourceKeyboard(sessionId, source) {
  const row = [];
  if (source.shareable !== false && /^https?:\/\//i.test(source.url)) {
    row.push(Markup.button.url('⬇️ Direct Link', source.url));
  }
  row.push(Markup.button.callback('☁️ Upload to Drive', `resolver-upload:${sessionId}`));
  return Markup.inlineKeyboard([row, [Markup.button.callback('❌ Cancel', `resolver-cancel:${sessionId}`)]]);
}

function appButton() {
  return Markup.inlineKeyboard([
    Markup.button.webApp('Open Drive Uploader', config.webappUrl)
  ]);
}

bot.start(ctx => ctx.reply(
  'Send me any file or direct HTTP/HTTPS file URL and I will upload it to your Google Drive.',
  appButton()
));

bot.command('help', ctx => ctx.reply(
  '1. Tap Open Drive Uploader\n2. Connect Google Drive\n3. Return here\n4. Send any Telegram file/media or direct HTTP/HTTPS file URL\n\nTwo uploads can run at once. Files are sorted inside My Drive/EZ Uploads.'
));

function statusText(job) {
  const p = publicJob(job);

  if (p.state === 'waiting') {
    return `⏳ Waiting\n\n${p.filename}${p.queuePosition ? `\n\nQueue position: ${p.queuePosition}` : ''}`;
  }

  if (p.state === 'uploading') {
    const progress = p.percent === null
      ? `${p.uploaded || '0 B'} uploaded\nSize: unknown`
      : `${p.percent}%\n${p.uploaded} / ${p.total}`;
    return `⬆️ Uploading\n\n${p.filename}\n\n${progress}${p.elapsed ? `\n⏱ ${p.elapsed}` : ''}${p.averageSpeed ? `\n⚡ ${p.averageSpeed}` : ''}\n📁 ${p.destination}`;
  }

  if (p.state === 'done') {
    return `✅ Upload Complete\n\n${p.filename}\n\n100%\n${p.total || p.uploaded}${p.elapsed ? `\n⏱ Time: ${p.elapsed}` : ''}${p.averageSpeed ? `\n⚡ Average: ${p.averageSpeed}` : ''}\n📁 ${p.destination}`;
  }

  if (p.state === 'cancelled') return `🛑 Upload Cancelled\n\n${p.filename}`;
  return `❌ Upload Failed\n\n${p.filename}${p.error ? `\n\n${p.error}` : ''}`;
}

function jobKeyboard(job) {
  if (!['waiting', 'uploading'].includes(job.state)) return undefined;
  return Markup.inlineKeyboard([
    Markup.button.callback('🔄 Refresh', `refresh:${job.id}`),
    Markup.button.callback('❌ Cancel', `cancel:${job.id}`)
  ]);
}

async function editJobMessage(job) {
  if (!job.messageId) return;
  const text = statusText(job);
  try {
    await job.bot.telegram.editMessageText(job.chatId, job.messageId, undefined, text, jobKeyboard(job));
  } catch (error) {
    if (!/message is not modified/i.test(error.message)) throw error;
  }
}

function startAutoRefresh(job) {
  if (autoRefreshTimers.has(job.id)) clearInterval(autoRefreshTimers.get(job.id));
  const timer = setInterval(async () => {
    try {
      await editJobMessage(job);
      if (!['waiting', 'uploading'].includes(job.state)) {
        clearInterval(timer);
        autoRefreshTimers.delete(job.id);
      }
    } catch (error) {
      console.error(`Auto refresh failed for upload ${job.id}:`, error.message);
    }
  }, 4000);
  timer.unref?.();
  autoRefreshTimers.set(job.id, timer);
}

async function sendJobMessage(ctx, job) {
  const msg = await ctx.reply(statusText(job), jobKeyboard(job));
  job.messageId = msg.message_id;
  startAutoRefresh(job);
}

async function createResolvedUpload(ctx, source) {
  let totalBytes = null;
  let mimeType = source.mimeType || 'application/octet-stream';
  let filename = source.filename || filenameFromUrl(source.url);
  const headers = source.headers || {};

  try {
    const head = await safeFetch(source.url, { method: 'HEAD', headers });
    if (head.ok) {
      const length = head.headers.get('content-length');
      if (length !== null && /^\d+$/.test(length)) totalBytes = Number(length);
      mimeType = head.headers.get('content-type') || mimeType;
      filename = filenameFromDisposition(head.headers.get('content-disposition')) || filename;
    }
  } catch {}

  const job = createUpload({
    telegramId: ctx.from.id,
    chatId: ctx.chat.id,
    filename,
    mimeType,
    totalBytes,
    sourceFactory: urlSourceFactory(source.url, { filename, mimeType }, headers),
    bot
  });
  await sendJobMessage(ctx, job);
}

async function showResolvedSource(ctx, source, edit = false) {
  const sessionId = saveResolverSession(ctx.from.id, { type: 'source', source });
  const headerNote = source.shareable === false
    ? '\n\n🔐 This source needs request headers, so use Upload to Drive.'
    : '';
  const text = `🔗 Link Resolved\n\n${source.title || source.filename || filenameFromUrl(source.url)}\n\nMethod: ${source.method}${headerNote}`;
  if (edit) return ctx.editMessageText(text, resolverSourceKeyboard(sessionId, source));
  return ctx.reply(text, resolverSourceKeyboard(sessionId, source));
}

async function showResolverChoices(ctx, result, edit = false) {
  const sessionId = saveResolverSession(ctx.from.id, { type: 'choices', choices: result.choices });
  const buttons = result.choices.slice(0, 8).map((choice, index) => [
    Markup.button.callback(
      `${choice.type === 'stream' ? '▶️' : '⬇️'} ${choice.label || `Source ${index + 1}`}`.slice(0, 60),
      `resolver-choice:${sessionId}:${index}`
    )
  ]);
  buttons.push([Markup.button.callback('❌ Cancel', `resolver-cancel:${sessionId}`)]);
  const text = `🔗 ${result.choices.length} sources found\n\nChoose which source to use:`;
  if (edit) return ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
  return ctx.reply(text, Markup.inlineKeyboard(buttons));
}

bot.action(/^resolver-choice:(\d+):(\d+)$/, async ctx => {
  const session = getResolverSession(ctx.match[1], ctx.from.id);
  if (!session || session.payload.type !== 'choices') return ctx.answerCbQuery('Resolver session expired');
  const choice = session.payload.choices[Number(ctx.match[2])];
  if (!choice) return ctx.answerCbQuery('Source not found');

  await ctx.answerCbQuery('Resolving source...');
  try {
    const result = await resolveUrl(choice.url);
    if (result.kind === 'choices') return showResolverChoices(ctx, result, true);
    return showResolvedSource(ctx, result, true);
  } catch (error) {
    return ctx.editMessageText(`❌ Could not resolve selected source\n\n${error.message}`);
  }
});

bot.action(/^resolver-upload:(\d+)$/, async ctx => {
  const session = getResolverSession(ctx.match[1], ctx.from.id);
  if (!session || session.payload.type !== 'source') return ctx.answerCbQuery('Resolver session expired');
  if (!isConnected(ctx.from.id)) return ctx.answerCbQuery('Connect Google Drive first');

  await ctx.answerCbQuery('Starting upload...');
  await createResolvedUpload(ctx, session.payload.source);
});

bot.action(/^resolver-cancel:(\d+)$/, async ctx => {
  const session = getResolverSession(ctx.match[1], ctx.from.id);
  if (session) resolverSessions.delete(String(ctx.match[1]));
  await ctx.answerCbQuery('Cancelled');
  try { await ctx.editMessageText('❌ Resolution cancelled'); } catch {}
});

bot.action(/^refresh:(\d+)$/, async ctx => {
  const job = getJob(ctx.match[1], ctx.from.id);

  if (!job) {
    return ctx.answerCbQuery('Upload expired or bot restarted');
  }

  const text = statusText(job);

  if (ctx.callbackQuery.message?.text === text) {
    return ctx.answerCbQuery('No change yet');
  }

  await ctx.answerCbQuery('Updated');

  try {
    await ctx.editMessageText(text, jobKeyboard(job));
  } catch (error) {
    if (/message is not modified/i.test(error.message)) {
      return;
    }

    console.error('Manual refresh failed:', error);
  }
});

bot.action(/^cancel:(\d+)$/, async ctx => {
  const job = cancelUpload(ctx.from.id, ctx.match[1]);
  if (!job) return ctx.answerCbQuery('Upload not found');
  await ctx.answerCbQuery('Cancelling...');
  await ctx.editMessageText(statusText(job));
});

bot.command('status', async ctx => {
  const items = getUserJobs(ctx.from.id).filter(item => ['waiting', 'uploading'].includes(item.state));
  if (!items.length) return ctx.reply('No active uploads.');
  const text = items.map(item => {
    if (item.state === 'waiting') return `⏳ ${item.filename} · waiting${item.queuePosition ? ` #${item.queuePosition}` : ''}`;
    const progress = item.percent == null ? item.uploaded : `${item.percent}% · ${item.uploaded} / ${item.total}`;
    return `⬆️ ${item.filename}\n${progress}${item.averageSpeed ? ` · ${item.averageSpeed}` : ''}`;
  }).join('\n\n');
  return ctx.reply(text);
});

bot.command('cancel', async ctx => {
  const job = cancelUpload(ctx.from.id);
  if (!job) return ctx.reply('No active upload to cancel.');
  return ctx.reply(`🛑 Cancelling\n\n${job.filename}`);
});

function telegramMedia(message) {
  if (message.document) return { item: message.document, filename: message.document.file_name };
  if (message.video) return { item: message.video, filename: message.video.file_name || `video-${message.video.file_unique_id}.mp4` };
  if (message.audio) return { item: message.audio, filename: message.audio.file_name || `audio-${message.audio.file_unique_id}` };
  if (message.animation) return { item: message.animation, filename: message.animation.file_name || `animation-${message.animation.file_unique_id}.mp4` };
  if (message.voice) return { item: message.voice, filename: `voice-${message.voice.file_unique_id}.ogg` };
  if (message.video_note) return { item: message.video_note, filename: `video-note-${message.video_note.file_unique_id}.mp4` };
  if (message.photo?.length) {
    const item = message.photo[message.photo.length - 1];
    return { item, filename: `photo-${item.file_unique_id}.jpg`, mimeType: 'image/jpeg' };
  }
  return null;
}

bot.on(['document', 'video', 'audio', 'animation', 'voice', 'video_note', 'photo'], async ctx => {
  if (!isConnected(ctx.from.id)) return ctx.reply('Connect Google Drive first.', appButton());

  const media = telegramMedia(ctx.message);
  if (!media) return;
  const { item } = media;
  const filename = media.filename || `telegram-${item.file_unique_id}`;

  try {
    const telegramFile = await ctx.telegram.getFile(item.file_id);
    let sourceFactory;

    if (telegramFile.file_path && fs.existsSync(telegramFile.file_path)) {
      sourceFactory = fileSourceFactory(telegramFile.file_path);
    } else {
      const url = `${config.telegramApiRoot}/file/bot${config.telegramToken}/${telegramFile.file_path}`;
      sourceFactory = trustedUrlSourceFactory(url);
    }

    const totalBytes = item.file_size ?? telegramFile.file_size ?? null;
    const job = createUpload({
      telegramId: ctx.from.id,
      chatId: ctx.chat.id,
      filename,
      mimeType: media.mimeType || item.mime_type || 'application/octet-stream',
      totalBytes,
      sourceFactory,
      bot
    });
    await sendJobMessage(ctx, job);
  } catch (error) {
    const extra = /20.?MB|file is too big/i.test(error.message)
      ? '\n\nFor large Telegram files, configure a local Telegram Bot API server on the VPS.'
      : '';
    await ctx.reply(`❌ Could not read Telegram file.\n${error.message}${extra}`);
  }
});

// Resolver middleware. True direct files keep the existing instant-upload behavior.
// Web/media pages go through yt-dlp and then the generic resolver as fallbacks.
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();

  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return next();
  } catch {
    return next();
  }

  if (!isConnected(ctx.from.id)) return next();

  const working = await ctx.reply('🔎 Resolving link...');
  try {
    const result = await resolveUrl(text);
    if (result.kind === 'source' && result.method === 'direct') {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, working.message_id); } catch {}
      return next();
    }

    try { await ctx.telegram.deleteMessage(ctx.chat.id, working.message_id); } catch {}
    if (result.kind === 'choices') return showResolverChoices(ctx, result);
    return showResolvedSource(ctx, result);
  } catch (error) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, working.message_id); } catch {}
    return ctx.reply(`❌ Could not resolve this URL\n\n${error.message}`);
  }
});

bot.on('text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return;
  } catch { return; }

  if (!isConnected(ctx.from.id)) return ctx.reply('Connect Google Drive first.', appButton());

  let totalBytes = null;
  let mimeType = 'application/octet-stream';
  let filename = filenameFromUrl(text);

  try {
    const head = await safeFetch(text, { method: 'HEAD' });
    if (head.ok) {
      const length = head.headers.get('content-length');
      if (length !== null && /^\d+$/.test(length)) totalBytes = Number(length);
      mimeType = head.headers.get('content-type') || mimeType;
      filename = filenameFromDisposition(head.headers.get('content-disposition')) || filename;
    }
  } catch {}

  const job = createUpload({
    telegramId: ctx.from.id,
    chatId: ctx.chat.id,
    filename,
    mimeType,
    totalBytes,
    sourceFactory: urlSourceFactory(text, { filename, mimeType }),
    bot
  });
  await sendJobMessage(ctx, job);
});

export async function registerBotCommands() {
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'How to use the bot' },
    { command: 'status', description: 'Show active uploads' },
    { command: 'cancel', description: 'Cancel latest upload' }
  ]);
}
