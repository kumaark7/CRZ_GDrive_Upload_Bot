import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { CatalogStore } from '../backend/storage/catalogStore.js';

async function tempRoot() {
  return fsp.mkdtemp(
    path.join(os.tmpdir(), 'crz-catalog-test-')
  );
}

test('torrent catalog survives a new store instance', async () => {
  const root = await tempRoot();

  try {
    const first = new CatalogStore(root);

    const saved = await first.saveTorrent({
      source: {
        kind: 'magnet',
        value: 'magnet:?xt=urn:btih:phase5test'
      },
      info: {
        name: 'Phase 5 Movie',
        health: 'healthy',
        files: [
          {
            index: 0,
            name: 'movie.mkv',
            size: 123
          }
        ]
      },
      ownerId: '7'
    });

    const second = new CatalogStore(root);
    const restored = await second.getTorrent(saved.id, '7');

    assert.equal(restored.name, 'Phase 5 Movie');
    assert.equal(restored.files[0].name, 'movie.mkv');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('uploaded torrent file is copied into persistent storage', async () => {
  const root = await tempRoot();
  const incoming = path.join(root, 'incoming.torrent');

  try {
    await fsp.writeFile(
      incoming,
      Buffer.from('fake torrent fixture')
    );

    const store = new CatalogStore(path.join(root, 'storage'));

    const saved = await store.saveTorrent({
      source: {
        kind: 'torrent',
        value: incoming
      },
      info: {
        name: 'Stored Torrent',
        files: []
      },
      ownerId: '9'
    });

    assert.notEqual(
      path.resolve(saved.source.value),
      path.resolve(incoming)
    );

    await fsp.access(saved.source.value);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('downloaded source is reusable by torrent and file index', async () => {
  const root = await tempRoot();
  const work = path.join(root, 'work');
  const source = path.join(work, 'movie.mkv');

  try {
    await fsp.mkdir(work, { recursive: true });
    await fsp.writeFile(source, Buffer.alloc(32));

    const store = new CatalogStore(path.join(root, 'storage'));

    const saved = await store.persistSourceFile({
      torrentId: 'torrent-a',
      fileIndex: 4,
      sourcePath: source,
      filename: 'movie.mkv',
      size: 32,
      ownerId: '11'
    });

    const reused = await store.findSource({
      torrentId: 'torrent-a',
      fileIndex: 4,
      ownerId: '11'
    });

    assert.equal(reused.path, saved.path);
    assert.equal(reused.size, 32);

    await assert.rejects(fsp.access(source));
    await fsp.access(reused.path);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
