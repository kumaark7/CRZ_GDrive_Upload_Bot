import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { safeFetch, filenameFromDisposition, filenameFromUrl } from './upload.js';

function progressTransform({ totalBytes, onProgress }) {
  let done = 0;
  const started = Date.now();
  let last = 0;

  return new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      const now = Date.now();
      if (now - last >= 2000) {
        last = now;
        const elapsed = Math.max(0.001, (now - started) / 1000);
        const speed = done / elapsed;
        const percent = Number.isFinite(totalBytes) && totalBytes > 0
          ? Math.min(100, Math.floor(done * 100 / totalBytes))
          : null;
        const etaSeconds = percent !== null && speed > 0
          ? Math.max(0, Math.round((totalBytes - done) / speed))
          : null;
        onProgress?.({ doneBytes: done, totalBytes, percent, speed, etaSeconds });
      }
      cb(null, chunk);
    },
    flush(cb) {
      const now = Date.now();
      const elapsed = Math.max(0.001, (now - started) / 1000);
      onProgress?.({
        doneBytes: done,
        totalBytes: Number.isFinite(totalBytes) ? totalBytes : done,
        percent: 100,
        speed: done / elapsed,
        etaSeconds: 0
      });
      cb();
    }
  });
}

export async function downloadHttpSource(source, destinationDir, { signal, onProgress } = {}) {
  await fsp.mkdir(destinationDir, { recursive: true });

  const response = await safeFetch(source.url, {
    signal,
    headers: source.headers || {}
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  if (!response.body) throw new Error('Source returned no response body');

  const length = response.headers.get('content-length');
  const totalBytes = length && /^\d+$/.test(length) ? Number(length) : null;
  const dispositionName = filenameFromDisposition(response.headers.get('content-disposition'));
  const rawName = dispositionName || source.filename || filenameFromUrl(response.url || source.url);
  const filename = path.basename(rawName || `download-${Date.now()}.bin`);
  const outputPath = path.join(destinationDir, filename);

  await pipeline(
    Readable.fromWeb(response.body),
    progressTransform({ totalBytes, onProgress }),
    fs.createWriteStream(outputPath),
    { signal }
  );

  const stat = await fsp.stat(outputPath);
  return {
    filePath: outputPath,
    filename,
    totalBytes: stat.size,
    mimeType: response.headers.get('content-type') || source.mimeType || 'application/octet-stream'
  };
}

export async function copyLocalTelegramFile(sourcePath, destinationDir, filename, { signal, onProgress } = {}) {
  await fsp.mkdir(destinationDir, { recursive: true });
  const stat = await fsp.stat(sourcePath);
  const safeName = path.basename(filename || path.basename(sourcePath));
  const outputPath = path.join(destinationDir, safeName);

  await pipeline(
    fs.createReadStream(sourcePath),
    progressTransform({ totalBytes: stat.size, onProgress }),
    fs.createWriteStream(outputPath),
    { signal }
  );

  return {
    filePath: outputPath,
    filename: safeName,
    totalBytes: stat.size,
    mimeType: 'application/octet-stream'
  };
}
