import fs from 'node:fs';
import { Transform } from 'node:stream';
import { config } from './config.js';

function progressStream({ totalBytes, onProgress }) {
  let sent = 0;
  const started = Date.now();
  let last = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
      sent += chunk.length;
      const now = Date.now();

      if (now - last >= 2000 || sent >= totalBytes) {
        last = now;
        const elapsedSeconds = Math.max(0.001, (now - started) / 1000);
        const speed = sent / elapsedSeconds;
        const percent = totalBytes > 0
          ? Math.min(100, Math.floor(sent * 100 / totalBytes))
          : 100;
        const etaSeconds = speed > 0
          ? Math.max(0, Math.round((totalBytes - sent) / speed))
          : null;

        onProgress?.({
          sentBytes: sent,
          totalBytes,
          percent,
          speed,
          etaSeconds,
          elapsedSeconds
        });
      }

      callback(null, chunk);
    }
  });
}

async function ezFetch(pathname, options = {}) {
  try {
    return await fetch(`${config.ezApiBase}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.ezApiSecret}`,
        ...(options.headers || {})
      }
    });
  } catch (cause) {
    const error = new Error('Could not reach the EZ Drive server');
    error.code = 'NETWORK_ERROR';
    error.cause = cause;
    throw error;
  }
}

function makeApiError(result, fallback, status) {
  const error = new Error(result?.error || fallback);
  error.code = result?.code || (status >= 500 ? 'NETWORK_ERROR' : 'EZ_API_ERROR');
  error.retryable = result?.retryable !== false;
  error.httpStatus = status;
  return error;
}

export async function checkEzDriveConnection(telegramId) {
  const response = await ezFetch('/internal/crz/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegramId: String(telegramId) })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw makeApiError(result, `EZ API returned HTTP ${response.status}`, response.status);
  }

  return Boolean(result.connected);
}

export async function uploadFileViaEz({
  telegramId,
  filePath,
  filename,
  mimeType = 'application/octet-stream',
  signal,
  onProgress
}) {
  const stat = await fs.promises.stat(filePath);
  const source = fs.createReadStream(filePath);

  const abort = () => source.destroy(new DOMException('Cancelled', 'AbortError'));
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const body = source.pipe(progressStream({
      totalBytes: stat.size,
      onProgress
    }));

    const response = await ezFetch('/internal/crz/upload', {
      method: 'POST',
      signal,
      duplex: 'half',
      headers: {
        'X-Telegram-User-Id': String(telegramId),
        'X-File-Name': encodeURIComponent(filename),
        'Content-Type': mimeType,
        'Content-Length': String(stat.size)
      },
      body
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw makeApiError(
        result,
        `EZ upload API returned HTTP ${response.status}`,
        response.status
      );
    }

    return result.file || result;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
