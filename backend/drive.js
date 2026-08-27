import { Readable } from 'node:stream';
import path from 'node:path';
import { google } from 'googleapis';
import { config } from './config.js';
import { getRefreshToken } from './db.js';

const CHUNK_SIZE = 8 * 1024 * 1024;
const ROOT_FOLDER = 'EZ Uploads';

const EXTENSIONS = {
  Videos: new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.mpeg', '.mpg', '.ts', '.3gp']),
  Images: new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg', '.heic', '.avif']),
  Audios: new Set(['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg', '.opus', '.wma', '.aiff']),
  Documents: new Set(['.pdf', '.txt', '.md', '.rtf', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.epub']),
  Archives: new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst'])
};

const ARCHIVE_MIMES = new Set([
  'application/zip', 'application/x-zip-compressed', 'application/vnd.rar',
  'application/x-rar-compressed', 'application/x-7z-compressed', 'application/x-tar',
  'application/gzip', 'application/x-gzip', 'application/x-bzip2', 'application/x-xz',
  'application/zstd'
]);

const DOCUMENT_MIMES = new Set([
  'application/pdf', 'application/rtf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation', 'application/epub+zip'
]);

function getAuth(telegramId) {
  const refreshToken = getRefreshToken(telegramId);
  if (!refreshToken) throw new Error('Google Drive is not connected');

  const auth = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    config.googleRedirectUri
  );
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function sanitizeFilename(filename) {
  const cleaned = String(filename || '').replace(/[\u0000-\u001f]/g, '').trim();
  return cleaned || `upload-${Date.now()}`;
}

export function categoryForFile(filename, mimeType) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('video/')) return 'Videos';
  if (mime.startsWith('image/')) return 'Images';
  if (mime.startsWith('audio/')) return 'Audios';
  if (ARCHIVE_MIMES.has(mime)) return 'Archives';
  if (mime.startsWith('text/') || DOCUMENT_MIMES.has(mime)) return 'Documents';

  const ext = path.extname(String(filename || '')).toLowerCase();
  for (const [category, extensions] of Object.entries(EXTENSIONS)) {
    if (extensions.has(ext)) return category;
  }
  return 'Others';
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function ensureFolder(drive, name, parentId = null) {
  const parentClause = parentId ? ` and '${escapeDriveQuery(parentId)}' in parents` : '';
  const q = `name = '${escapeDriveQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentClause}`;

  const listed = await drive.files.list({ q, spaces: 'drive', fields: 'files(id,name)', pageSize: 1 });
  if (listed.data.files?.[0]?.id) return listed.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {})
    },
    fields: 'id'
  });

  if (!created.data.id) throw new Error(`Could not create Google Drive folder: ${name}`);
  return created.data.id;
}

async function uploadFolderId(auth, filename, mimeType) {
  const drive = google.drive({ version: 'v3', auth });
  const rootId = await ensureFolder(drive, ROOT_FOLDER);
  return ensureFolder(drive, categoryForFile(filename, mimeType), rootId);
}

async function startSession({ auth, filename, mimeType, totalBytes, parentId, signal }) {
  if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
  const tokenResult = await auth.getAccessToken();
  const accessToken = tokenResult?.token;
  if (!accessToken) throw new Error('Could not obtain Google access token');

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType || 'application/octet-stream'
  };
  if (Number.isFinite(totalBytes) && totalBytes >= 0) {
    headers['X-Upload-Content-Length'] = String(totalBytes);
  }

  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,parents',
    {
      method: 'POST', headers, signal,
      body: JSON.stringify({ name: sanitizeFilename(filename), parents: [parentId] })
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Google upload session failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
  }

  const sessionUrl = response.headers.get('location');
  if (!sessionUrl) throw new Error('Google did not return an upload session URL');
  return sessionUrl;
}

async function sendChunk(sessionUrl, chunk, start, totalBytes, isFinal, signal) {
  let consumed = 0;
  let attempts = 0;

  while (consumed < chunk.length) {
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    const part = chunk.subarray(consumed);
    const partStart = start + consumed;
    const partEnd = partStart + part.length - 1;
    const totalMarker = isFinal ? String(totalBytes) : (Number.isFinite(totalBytes) ? String(totalBytes) : '*');

    let response;
    try {
      response = await fetch(sessionUrl, {
        method: 'PUT', signal,
        headers: {
          'Content-Length': String(part.length),
          'Content-Range': `bytes ${partStart}-${partEnd}/${totalMarker}`
        },
        body: part
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (++attempts <= 3) continue;
      throw error;
    }

    if (response.ok) return { complete: true, file: await response.json() };

    if (response.status === 308) {
      attempts = 0;
      const range = response.headers.get('range');
      if (!range) { consumed = 0; continue; }
      const match = range.match(/bytes=0-(\d+)/i);
      if (!match) throw new Error('Unexpected Google upload Range response');
      consumed = Math.max(0, Number(match[1]) + 1 - start);
      continue;
    }

    if (response.status >= 500 && ++attempts <= 3) continue;
    const detail = await response.text().catch(() => '');
    throw new Error(`Google upload failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
  }

  return { complete: false, file: null };
}

async function createEmptyFile({ auth, filename, mimeType, parentId }) {
  const drive = google.drive({ version: 'v3', auth });
  const response = await drive.files.create({
    requestBody: { name: sanitizeFilename(filename), parents: [parentId] },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(Buffer.alloc(0)) },
    fields: 'id,name,size,parents'
  });
  return response.data;
}

export async function uploadStream({ telegramId, filename, mimeType, totalBytes, stream, signal, onProgress }) {
  const knownTotal = Number.isFinite(totalBytes) && totalBytes >= 0 ? Number(totalBytes) : null;
  const auth = getAuth(telegramId);
  const parentId = await uploadFolderId(auth, filename, mimeType);

  if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');

  if (knownTotal === 0) {
    onProgress?.(0);
    return createEmptyFile({ auth, filename, mimeType, parentId });
  }

  const sessionUrl = await startSession({
    auth, filename, mimeType, totalBytes: knownTotal, parentId, signal
  });

  let buffered = Buffer.alloc(0);
  let offset = 0;
  let completedFile = null;

  for await (const incoming of stream) {
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;

    while (buffered.length > CHUNK_SIZE) {
      const uploadChunk = buffered.subarray(0, CHUNK_SIZE);
      buffered = buffered.subarray(CHUNK_SIZE);
      const result = await sendChunk(sessionUrl, uploadChunk, offset, knownTotal, false, signal);
      offset += uploadChunk.length;
      onProgress?.(offset);
      if (result.complete) completedFile = result.file;
    }
  }

  const actualTotal = offset + buffered.length;
  if (knownTotal !== null && actualTotal !== knownTotal) {
    throw new Error(`Source size changed: received ${actualTotal} of ${knownTotal} bytes`);
  }

  if (buffered.length) {
    const result = await sendChunk(sessionUrl, buffered, offset, actualTotal, true, signal);
    offset += buffered.length;
    onProgress?.(offset);
    if (result.complete) completedFile = result.file;
  } else if (actualTotal === 0) {
    return createEmptyFile({ auth, filename, mimeType, parentId });
  }

  if (!completedFile) throw new Error('Google upload did not finalize');
  return completedFile;
}
