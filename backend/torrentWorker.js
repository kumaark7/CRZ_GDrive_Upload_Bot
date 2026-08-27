import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worker = path.resolve(__dirname, '../workers/torrent_worker.py');
const python = process.env.PYTHON_BIN || 'python3';

export function runTorrentWorker(args, { signal, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [worker, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],

      // Linux: make the torrent worker its own process group.
      // This lets Cancel terminate the complete worker tree.
      detached: true
    });

    let stdout = '';
    let stderr = '';
    let finalResult = null;
    let cancelled = false;
    let settled = false;
    let killTimer = null;

    const killGroup = sig => {
      if (!child.pid) return;

      try {
        // Negative PID = entire process group on Linux.
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };

    const abort = () => {
      if (cancelled) return;

      cancelled = true;

      // Stop gracefully first.
      killGroup('SIGTERM');

      // Force kill if libtorrent/Python does not exit.
      killTimer = setTimeout(() => {
        if (!settled) {
          killGroup('SIGKILL');
        }
      }, 3000);

      killTimer.unref();
    };

    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => {
      // Do not update Telegram after Cancel was pressed.
      if (cancelled) return;

      stdout += chunk;

      const lines = stdout.split('\n');
      stdout = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);

          if (event.type === 'result') {
            finalResult = event;
          }

          if (!cancelled) {
            onEvent?.(event);
          }
        } catch {}
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk;

      if (stderr.length > 128 * 1024) {
        stderr = stderr.slice(-128 * 1024);
      }
    });

    child.once('error', error => {
      if (settled) return;

      settled = true;

      if (killTimer) {
        clearTimeout(killTimer);
      }

      signal?.removeEventListener('abort', abort);

      if (cancelled || signal?.aborted) {
        reject(new DOMException('Cancelled', 'AbortError'));
        return;
      }

      reject(error);
    });

    child.once('close', code => {
      if (settled) return;

      settled = true;

      if (killTimer) {
        clearTimeout(killTimer);
      }

      signal?.removeEventListener('abort', abort);

      if (cancelled || signal?.aborted) {
        reject(new DOMException('Cancelled', 'AbortError'));
        return;
      }

      if (code === 0 && finalResult) {
        resolve(finalResult);
        return;
      }

      reject(
        new Error(
          stderr.trim() ||
          `Torrent worker exited with code ${code}`
        )
      );
    });
  });
}

export async function preflightTorrent(source, workDir, opts = {}) {
  const sourceArgs = source.kind === 'magnet'
    ? ['--magnet', source.value]
    : ['--torrent', source.value];

  return runTorrentWorker([
    'preflight',
    ...sourceArgs,
    '--save-path', workDir,
    '--sample-seconds',
    String(Number(process.env.TORRENT_PREFLIGHT_SECONDS || 12))
  ], opts);
}

export async function downloadTorrent(
  source,
  workDir,
  fileIndex,
  opts = {}
) {
  const sourceArgs = source.kind === 'magnet'
    ? ['--magnet', source.value]
    : ['--torrent', source.value];

  return runTorrentWorker([
    'download',
    ...sourceArgs,
    '--save-path', workDir,
    '--file-index', String(fileIndex)
  ], opts);
}
