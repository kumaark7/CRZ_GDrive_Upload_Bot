import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const SUPPORTED_AUDIO = new Set(['aac', 'mp3', 'flac', 'vorbis', 'opus']);

function langName(tags = {}) {
  const raw = String(tags.language || tags.LANGUAGE || '').toLowerCase();
  const title = String(tags.title || tags.TITLE || '').trim();
  const map = {
    tam: 'Tamil', ta: 'Tamil',
    tel: 'Telugu', te: 'Telugu',
    hin: 'Hindi', hi: 'Hindi',
    eng: 'English', en: 'English',
    mal: 'Malayalam', ml: 'Malayalam',
    kan: 'Kannada', kn: 'Kannada',
    jpn: 'Japanese', ja: 'Japanese',
    kor: 'Korean', ko: 'Korean'
  };
  return map[raw] || title || raw.toUpperCase() || 'Unknown';
}

function isEnglish(stream) {
  const lang = String(stream.tags?.language || '').toLowerCase();
  const title = String(stream.tags?.title || '').toLowerCase();
  return ['eng', 'en', 'english'].includes(lang) || title.includes('english');
}

export async function probeMedia(filePath) {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    filePath
  ], { maxBuffer: 16 * 1024 * 1024 });

  const info = JSON.parse(stdout);
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const durationSeconds = Number(info.format?.duration || 0);

  const audio = streams
    .filter(s => s.codec_type === 'audio')
    .map(s => ({
      index: Number(s.index),
      codec: String(s.codec_name || 'unknown').toLowerCase(),
      channels: Number(s.channels || 0),
      language: langName(s.tags),
      title: s.tags?.title || null,
      supported: SUPPORTED_AUDIO.has(String(s.codec_name || '').toLowerCase())
    }));

  const subtitles = streams
    .filter(s => s.codec_type === 'subtitle')
    .map(s => ({
      index: Number(s.index),
      codec: String(s.codec_name || 'unknown'),
      language: langName(s.tags),
      title: s.tags?.title || null,
      english: isEnglish(s)
    }));

  const video = streams
    .filter(s => s.codec_type === 'video')
    .map(s => ({
      index: Number(s.index),
      codec: String(s.codec_name || 'unknown'),
      width: Number(s.width || 0),
      height: Number(s.height || 0)
    }));

  return {
    durationSeconds,
    audio,
    subtitles,
    englishSubtitle: subtitles.find(s => s.english) || null,
    video
  };
}

function parseProgressBlock(block) {
  const out = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function audioArgs(target) {
  if (target === 'opus') return ['-c:a', 'libopus', '-ac', '2', '-b:a', '160k'];
  if (target === 'mp3') return ['-c:a', 'libmp3lame', '-ac', '2', '-b:a', '192k'];
  return ['-c:a', 'aac', '-ac', '2', '-b:a', '256k'];
}

export async function prepareMkv({
  inputPath,
  outputPath,
  audioStream,
  englishSubtitle,
  keepEnglishSubtitle,
  durationSeconds,
  signal,
  onProgress
}) {
  const target = String(process.env.MIRROR_AUDIO_TARGET || 'aac').toLowerCase();
  const shouldConvert = !SUPPORTED_AUDIO.has(audioStream.codec);

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', `0:${audioStream.index}`
  ];

  if (keepEnglishSubtitle && englishSubtitle) {
    args.push('-map', `0:${englishSubtitle.index}`);
  }

  args.push(
    '-map', '0:t?',
    '-map_metadata', '0',
    '-map_chapters', '0',
    '-c', 'copy'
  );

  if (shouldConvert) args.push(...audioArgs(target));
  else args.push('-c:a', 'copy');

  args.push(
    '-progress', 'pipe:1',
    '-nostats',
    outputPath
  );

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let lastEmit = 0;

    const abort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => {
      stdout += chunk;
      let idx;
      while ((idx = stdout.indexOf('\nprogress=')) >= 0) {
        let end = stdout.indexOf('\n', idx + 1);
        if (end < 0) break;
        const block = stdout.slice(0, end);
        stdout = stdout.slice(end + 1);
        const data = parseProgressBlock(block);

        const outUs = Number(data.out_time_us || data.out_time_ms || 0);
        const processedSeconds = outUs > 0 ? outUs / 1_000_000 : 0;
        const speed = Number(String(data.speed || '').replace(/x$/i, '')) || null;
        const percent = durationSeconds > 0
          ? Math.max(0, Math.min(100, Math.floor(processedSeconds * 100 / durationSeconds)))
          : null;
        const etaSeconds = durationSeconds > 0 && speed
          ? Math.max(0, Math.round((durationSeconds - processedSeconds) / speed))
          : null;

        const now = Date.now();
        if (data.progress === 'end' || now - lastEmit >= 2500) {
          lastEmit = now;
          onProgress?.({
            percent: data.progress === 'end' ? 100 : percent,
            speed,
            processedSeconds,
            etaSeconds,
            converting: shouldConvert,
            inputCodec: audioStream.codec,
            outputCodec: shouldConvert ? target : audioStream.codec
          });
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 128 * 1024) stderr = stderr.slice(-128 * 1024);
    });

    child.once('error', reject);
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });

  const stat = await fsp.stat(outputPath);
  return {
    outputPath,
    size: stat.size,
    converted: shouldConvert,
    inputCodec: audioStream.codec,
    outputCodec: shouldConvert ? target : audioStream.codec
  };
}
