import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertPublicUrl, filenameFromDisposition, filenameFromUrl, safeFetch } from './upload.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const genericResolver = path.join(projectRoot, 'resolver', 'generic.py');
const pythonBin = process.env.PYTHON_BIN || 'python3';
const ytdlpBin = process.env.YTDLP_BIN || 'yt-dlp';
const ytdlpCookies = process.env.YTDLP_COOKIES_FILE || '';

function cleanHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    const lower = key.toLowerCase();
    if (['cookie', 'authorization', 'proxy-authorization'].includes(lower)) continue;
    out[key] = String(value);
  }
  return out;
}

function looksLikeHtml(contentType = '') {
  const type = contentType.toLowerCase();
  return type.includes('text/html') || type.includes('application/xhtml+xml');
}

async function directProbe(url) {
  try {
    const head = await safeFetch(url, { method: 'HEAD' });
    if (head.ok) {
      const contentType = head.headers.get('content-type') || '';
      const disposition = head.headers.get('content-disposition') || '';
      if (disposition || (contentType && !looksLikeHtml(contentType))) {
        return {
          kind: 'source',
          method: 'direct',
          url: head.url || url,
          filename: filenameFromDisposition(disposition) || filenameFromUrl(head.url || url),
          mimeType: contentType || 'application/octet-stream',
          headers: {},
          shareable: true
        };
      }
    }
  } catch {}

  // Some download hosts reject HEAD. A 1-byte range probe avoids downloading the file.
  try {
    const response = await safeFetch(url, { headers: { Range: 'bytes=0-0' } });
    const contentType = response.headers.get('content-type') || '';
    const disposition = response.headers.get('content-disposition') || '';
    const isFile = response.ok && (disposition || (contentType && !looksLikeHtml(contentType)));
    await response.body?.cancel().catch(() => {});
    if (isFile) {
      return {
        kind: 'source',
        method: 'direct',
        url: response.url || url,
        filename: filenameFromDisposition(disposition) || filenameFromUrl(response.url || url),
        mimeType: contentType || 'application/octet-stream',
        headers: {},
        shareable: true
      };
    }
  } catch {}

  return null;
}

async function resolveWithYtDlp(url) {
  const args = ['--no-warnings', '--no-playlist', '--skip-download', '--dump-single-json'];
  if (ytdlpCookies) args.push('--cookies', ytdlpCookies);
  args.push(url);

  try {
    const { stdout } = await execFileAsync(ytdlpBin, args, {
      timeout: 45000,
      maxBuffer: 16 * 1024 * 1024
    });
    const info = JSON.parse(stdout);
    const selected = info.requested_downloads?.[0] || info;
    const resolvedUrl = selected.url || info.url;
    if (!resolvedUrl?.startsWith('http')) return null;

    const headers = cleanHeaders(selected.http_headers || info.http_headers || {});
    return {
      kind: 'source',
      method: 'yt-dlp',
      url: resolvedUrl,
      filename: selected.filename || info._filename || info.filename || `${info.title || 'media'}.${selected.ext || info.ext || 'bin'}`,
      mimeType: selected.mime_type || 'application/octet-stream',
      headers,
      // URLs requiring Referer/User-Agent headers are often temporary and not useful as a bare link.
      shareable: Object.keys(headers).length === 0,
      title: info.title || null
    };
  } catch {
    return null;
  }
}

async function resolveWithGeneric(url) {
  try {
    const { stdout } = await execFileAsync(pythonBin, [genericResolver, url, '--json'], {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024
    });
    const result = JSON.parse(stdout.trim());
    if (!result.success) return null;

    const choices = Array.isArray(result.metadata?.choices) ? result.metadata.choices : [];
    if (choices.length > 1) {
      return { kind: 'choices', method: 'generic', choices: choices.slice(0, 8) };
    }

    const chosen = choices[0]?.url || result.url;
    if (!chosen) return null;
    return {
      kind: 'source',
      method: 'generic',
      url: chosen,
      filename: filenameFromUrl(chosen),
      mimeType: 'application/octet-stream',
      headers: {},
      shareable: true
    };
  } catch {
    return null;
  }
}

export async function resolveUrl(url, depth = 0) {
  if (depth > 4) throw new Error('Resolver chain is too deep');
  await assertPublicUrl(url);

  const direct = await directProbe(url);
  if (direct) return direct;

  const ytdlp = await resolveWithYtDlp(url);
  if (ytdlp) return ytdlp;

  const generic = await resolveWithGeneric(url);
  if (!generic) throw new Error('Unsupported URL or no downloadable source was found');
  if (generic.kind === 'choices') return generic;

  // A generic page often resolves to another hosting page. Run it through the router again.
  if (generic.url !== url) {
    try {
      const nested = await resolveUrl(generic.url, depth + 1);
      if (nested) return nested;
    } catch {}
  }
  return generic;
}
