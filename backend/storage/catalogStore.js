import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(
  process.env.CRZ_STORAGE_ROOT ||
  path.join(HERE, '..', '..', 'data', 'storage')
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashText(value) {
  return crypto.createHash('sha256')
    .update(String(value))
    .digest('hex');
}

function safeName(value) {
  return String(value || 'file')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'file';
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return hash.digest('hex');
}

export class CatalogStore {
  constructor(root = DEFAULT_ROOT) {
    this.root = path.resolve(root);
    this.torrentsDir = path.join(this.root, 'torrents');
    this.sourcesDir = path.join(this.root, 'sources');
    this.metadataDir = path.join(this.root, 'metadata');
    this.stateDir = path.join(this.root, 'state');
    this.stateFile = path.join(this.stateDir, 'catalog.json');

    this.state = {
      version: 1,
      torrents: {},
      sources: {}
    };

    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (this.loaded) return this;

    await Promise.all([
      fsp.mkdir(this.torrentsDir, { recursive: true }),
      fsp.mkdir(this.sourcesDir, { recursive: true }),
      fsp.mkdir(this.metadataDir, { recursive: true }),
      fsp.mkdir(this.stateDir, { recursive: true })
    ]);

    try {
      const parsed = JSON.parse(
        await fsp.readFile(this.stateFile, 'utf8')
      );

      this.state = {
        version: 1,
        torrents: parsed?.torrents || {},
        sources: parsed?.sources || {}
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    this.loaded = true;
    return this;
  }

  async flush() {
    await this.init();
    const snapshot = JSON.stringify(this.state, null, 2);

    const write = async () => {
      const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, this.stateFile);
    };

    this.writeChain = this.writeChain.then(write, write);
    await this.writeChain;
  }

  async sourceIdentity(source) {
    if (!source) throw new Error('Torrent source is required');

    if (
      source.kind === 'torrent' &&
      source.value &&
      await exists(source.value)
    ) {
      return `torrent:${await hashFile(source.value)}`;
    }

    return `${source.kind || 'unknown'}:${hashText(source.value || '')}`;
  }

  async saveTorrent({ source, info, ownerId }) {
    await this.init();

    const identity = await this.sourceIdentity(source);
    const id = hashText(identity).slice(0, 16);
    const previous = this.state.torrents[id];
    const now = Date.now();

    let durableSource = clone(source);

    if (
      source?.kind === 'torrent' &&
      source.value &&
      await exists(source.value)
    ) {
      const destination = path.join(this.torrentsDir, `${id}.torrent`);

      if (!(await exists(destination))) {
        await fsp.copyFile(source.value, destination);
      }

      durableSource = {
        kind: 'torrent',
        value: destination
      };
    }

    const record = {
      id,
      ownerId: String(ownerId),
      source: durableSource,
      name: info?.name || previous?.name || 'Torrent',
      health: info?.health ?? previous?.health ?? null,
      seeds: info?.seeds ?? previous?.seeds ?? null,
      peers: info?.peers ?? previous?.peers ?? null,
      trackers: info?.trackers ?? previous?.trackers ?? null,
      files: Array.isArray(info?.files)
        ? clone(info.files)
        : previous?.files || [],
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };

    this.state.torrents[id] = record;

    await fsp.writeFile(
      path.join(this.metadataDir, `${id}.json`),
      JSON.stringify(record, null, 2),
      'utf8'
    );

    await this.flush();
    return clone(record);
  }

  async listTorrents(ownerId) {
    await this.init();

    return Object.values(this.state.torrents)
      .filter(item => String(item.ownerId) === String(ownerId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(clone);
  }

  async getTorrent(id, ownerId) {
    await this.init();

    const item = this.state.torrents[String(id)];

    if (
      !item ||
      String(item.ownerId) !== String(ownerId)
    ) {
      return null;
    }

    if (
      item.source?.kind === 'torrent' &&
      !(await exists(item.source.value))
    ) {
      return null;
    }

    return clone(item);
  }

  async persistSourceFile({
    torrentId,
    fileIndex,
    sourcePath,
    filename,
    size,
    ownerId
  }) {
    await this.init();

    if (!(await exists(sourcePath))) {
      throw new Error('Downloaded source file is missing');
    }

    const sourceId = `${String(torrentId)}-${Number(fileIndex)}`;
    const ext = path.extname(filename || sourcePath);
    const base = safeName(path.basename(filename || sourcePath, ext));
    const destination = path.join(
      this.sourcesDir,
      `${sourceId}-${base}${ext}`
    );

    if (path.resolve(sourcePath) !== path.resolve(destination)) {
      try {
        await fsp.rename(sourcePath, destination);
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        await fsp.copyFile(sourcePath, destination);
        await fsp.unlink(sourcePath);
      }
    }

    const stat = await fsp.stat(destination);
    const previous = this.state.sources[sourceId];
    const now = Date.now();

    const record = {
      id: sourceId,
      torrentId: String(torrentId),
      fileIndex: Number(fileIndex),
      ownerId: String(ownerId),
      path: destination,
      filename: filename || path.basename(destination),
      size: Number(size || stat.size),
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };

    this.state.sources[sourceId] = record;
    await this.flush();
    return clone(record);
  }

  async findSource({ torrentId, fileIndex, ownerId }) {
    await this.init();

    const sourceId = `${String(torrentId)}-${Number(fileIndex)}`;
    const item = this.state.sources[sourceId];

    if (
      !item ||
      String(item.ownerId) !== String(ownerId)
    ) {
      return null;
    }

    if (!(await exists(item.path))) {
      delete this.state.sources[sourceId];
      await this.flush();
      return null;
    }

    return clone(item);
  }

  async snapshot() {
    await this.init();
    return clone(this.state);
  }
}

export const catalogStore = new CatalogStore();

export function isCatalogOwner(userId) {
  const owner = String(
    process.env.CRZ_OWNER_TELEGRAM_ID || ''
  ).trim();

  return Boolean(owner) && String(userId) === owner;
}
