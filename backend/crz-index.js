import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { mirrorBot, registerMirrorBotCommands } from './mirrorBot.js';
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

app.use((req, res, next) =>
  req.path === '/api/upload/file' ? next() : jsonParser(req, res, next)
);

app.use(express.static(path.resolve(__dirname, '../webapp')));

function telegramUser(req) {
  return verifyInitData(req.get('X-Telegram-Init-Data'));
}

function requireConnected(user) {
  if (!isConnected(user.id)) {
    throw new Error('Connect Google Drive first');
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'crz-bot'
  });
});

app.get('/api/status', (req, res) => {
  try {
    const user = telegramUser(req);

    res.json({
      connected: isConnected(user.id),
      uploads: getUserJobs(user.id)
    });
  } catch (error) {
    res.status(401).json({
      error: error.message
    });
  }
});

app.post('/api/connect', (req, res) => {
  try {
    const user = telegramUser(req);

    res.json({
      url: createGoogleAuthUrl(user.id)
    });
  } catch (error) {
    res.status(401).json({
      error: error.message
    });
  }
});

app.post('/api/disconnect', (req, res) => {
  try {
    const user = telegramUser(req);

    disconnect(user.id);

    res.json({
      ok: true
    });
  } catch (error) {
    res.status(401).json({
      error: error.message
    });
  }
});

app.post('/api/upload/url', async (req, res) => {
  try {
    const user = telegramUser(req);
    requireConnected(user);

    const rawUrl = String(req.body?.url || '').trim();
    const parsed = new URL(rawUrl);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only HTTP/HTTPS URLs are allowed');
    }

    let totalBytes = null;
    let mimeType = 'application/octet-stream';
    let filename = filenameFromUrl(rawUrl);

    try {
      const head = await safeFetch(rawUrl, {
        method: 'HEAD'
      });

      if (head.ok) {
        const length = head.headers.get('content-length');

        if (length !== null && /^\d+$/.test(length)) {
          totalBytes = Number(length);
        }

        mimeType =
          head.headers.get('content-type') ||
          mimeType;

        filename =
          filenameFromDisposition(
            head.headers.get('content-disposition')
          ) ||
          filename;
      }
    } catch {
      // HEAD is optional. The actual upload may still work.
    }

    const job = createUpload({
      telegramId: user.id,
      chatId: user.id,
      filename,
      mimeType,
      totalBytes,
      sourceFactory: urlSourceFactory(rawUrl, {
        filename,
        mimeType
      }),
      bot: mirrorBot
    });

    res.status(202).json({
      ok: true,
      jobId: job.id
    });
  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

app.post('/api/upload/file', async (req, res) => {
  let job;

  try {
    const user = telegramUser(req);
    requireConnected(user);

    const encodedName =
      req.get('X-File-Name') || '';

    let filename;

    try {
      filename = decodeURIComponent(encodedName);
    } catch {
      filename = encodedName;
    }

    filename =
      filename.trim() ||
      `upload-${Date.now()}`;

    const contentLength =
      req.get('content-length');

    const totalBytes =
      contentLength &&
      /^\d+$/.test(contentLength)
        ? Number(contentLength)
        : null;

    const mimeType =
      req.get('content-type') ||
      'application/octet-stream';

    job = createUpload({
      telegramId: user.id,
      chatId: user.id,
      filename,
      mimeType,
      totalBytes,
      sourceFactory: streamSourceFactory(req),
      bot: mirrorBot
    });

    await new Promise((resolve, reject) => {
      req.once('end', resolve);
      req.once('error', reject);

      req.once('aborted', () => {
        reject(
          new Error('Browser upload was interrupted')
        );
      });
    });

    if (!res.headersSent) {
      res.status(202).json({
        ok: true,
        jobId: job.id
      });
    }
  } catch (error) {
    if (job) {
      cancelUpload(
        job.telegramId,
        job.id
      );
    }

    if (!res.headersSent) {
      res.status(400).json({
        error: error.message
      });
    }
  }
});

app.post('/api/upload/:id/cancel', (req, res) => {
  try {
    const user = telegramUser(req);

    const job = cancelUpload(
      user.id,
      req.params.id
    );

    if (!job) {
      return res.status(404).json({
        error: 'Upload not found'
      });
    }

    return res.json({
      ok: true
    });
  } catch (error) {
    return res.status(400).json({
      error: error.message
    });
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const telegramId =
      await finishGoogleAuth(
        req.query.code,
        req.query.state
      );

    await mirrorBot.telegram.sendMessage(
      telegramId,
      '✅ Google Drive Connected'
    );

    res.send(
      '<!doctype html>' +
      '<html>' +
      '<body style="font-family:system-ui;text-align:center;padding:40px">' +
      '<h2>✅ Google Drive Connected</h2>' +
      '<p>You can close this page and return to CRZ Bot.</p>' +
      '</body>' +
      '</html>'
    );
  } catch (error) {
    res.status(400).send(
      `Google connection failed: ${error.message}`
    );
  }
});

/*
 * --------------------------------------------------------------------------
 * Server startup
 * --------------------------------------------------------------------------
 */

const server = app.listen(
  config.port,
  () => {
    console.log(
      `CRZ web/API server listening on :${config.port}`
    );
  }
);

/*
 * Large uploads/downloads may legitimately run for a long time.
 */
server.requestTimeout = 0;

/*
 * --------------------------------------------------------------------------
 * Telegram startup
 * --------------------------------------------------------------------------
 */

try {
  await registerMirrorBotCommands();
} catch (error) {
  console.error(
    'Could not register CRZ Bot commands:',
    error.message
  );
}

let shuttingDown = false;

mirrorBot
  .launch()
  .then(() => {
    if (!shuttingDown) {
      console.log('CRZ Bot started');
    }
  })
  .catch(error => {
    if (shuttingDown) {
      return;
    }

    console.error(
      'CRZ Bot failed to start:',
      error
    );

    process.exitCode = 1;
  });

/*
 * --------------------------------------------------------------------------
 * Graceful shutdown
 * --------------------------------------------------------------------------
 *
 * Goals:
 * - stop accepting new Telegram updates
 * - stop accepting new HTTP requests
 * - do not leave systemd waiting 90 seconds
 * - force-close stale HTTP sockets if necessary
 * - prevent SIGINT/SIGTERM from running shutdown twice
 *
 * The upcoming JobManager will later hook into this shutdown path so active
 * torrent/FFmpeg/upload jobs can be cancelled cleanly before process exit.
 */

async function closeHttpServer() {
  if (!server.listening) {
    return;
  }

  await new Promise(resolve => {
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      resolve();
    };

    server.close(() => {
      finish();
    });

    /*
     * First close idle keep-alive sockets.
     */
    setTimeout(() => {
      try {
        server.closeIdleConnections?.();
      } catch {
        // Ignore shutdown-only socket errors.
      }
    }, 1000).unref();

    /*
     * Do not allow a long upload/socket to keep systemd waiting forever.
     */
    setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        // Ignore shutdown-only socket errors.
      }

      finish();
    }, 5000).unref();
  });
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `CRZ shutdown requested: ${signal}`
  );

  /*
   * Ultimate safeguard. systemd should never need its 90-second SIGKILL.
   */
  const forceExitTimer = setTimeout(() => {
    console.error(
      'CRZ graceful shutdown timed out; forcing exit'
    );

    process.exit(1);
  }, 15000);

  forceExitTimer.unref();

  /*
   * Stop receiving Telegram updates first.
   */
  try {
    mirrorBot.stop(signal);
  } catch (error) {
    console.error(
      'Telegram bot stop error:',
      error.message
    );
  }

  /*
   * Then shut down the HTTP/API server.
   */
  try {
    await closeHttpServer();
  } catch (error) {
    console.error(
      'HTTP server shutdown error:',
      error.message
    );
  }

  clearTimeout(forceExitTimer);

  console.log(
    'CRZ shutdown complete'
  );

  process.exit(0);
}

process.once('SIGINT', () => {
  shutdown('SIGINT').catch(error => {
    console.error(
      'SIGINT shutdown failure:',
      error
    );

    process.exit(1);
  });
});

process.once('SIGTERM', () => {
  shutdown('SIGTERM').catch(error => {
    console.error(
      'SIGTERM shutdown failure:',
      error
    );

    process.exit(1);
  });
});

/*
 * Catch unexpected async failures so they are visible in journalctl.
 * Do not silently swallow them.
 */
process.on('unhandledRejection', error => {
  console.error(
    'Unhandled promise rejection:',
    error
  );
});

process.on('uncaughtException', error => {
  console.error(
    'Uncaught exception:',
    error
  );

  shutdown('UNCAUGHT_EXCEPTION')
    .catch(() => {
      process.exit(1);
    });
});