import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { CatalogStore } from '../backend/storage/catalogStore.js';

async function fixture() {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'crz-phase6-')
  );

  const store = new CatalogStore(path.join(root, 'storage'));
  const sourcePath = path.join(root, 'source.mkv');

  await fsp.writeFile(sourcePath, Buffer.alloc(64));

  const source = await store.persistSourceFile({
    torrentId: 'torrent-phase6',
    fileIndex: 0,
    sourcePath,
    filename: 'source.mkv',
    size: 64,
    ownerId: '42'
  });

  return { root, store, source };
}

test('ffprobe metadata survives a new catalog instance', async () => {
  const { root, store, source } = await fixture();

  try {
    await store.saveMediaMetadata({
      sourceId: source.id,
      ownerId: '42',
      media: {
        durationSeconds: 100,
        audio: [
          {
            index: 1,
            codec: 'aac',
            language: 'English',
            supported: true
          }
        ],
        subtitles: [],
        englishSubtitle: null,
        video: []
      }
    });

    const second = new CatalogStore(path.join(root, 'storage'));
    const saved = await second.getMediaMetadata(source.id, '42');

    assert.equal(saved.media.durationSeconds, 100);
    assert.equal(saved.media.audio[0].language, 'English');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('identical variant profile is reused', async () => {
  const { root, store, source } = await fixture();

  try {
    const variantPath = path.join(root, 'prepared.mkv');
    await fsp.writeFile(variantPath, Buffer.alloc(32));

    const saved = await store.persistVariantFile({
      sourceId: source.id,
      audioIndex: 1,
      audioLanguage: 'English',
      keepEnglishSubtitle: false,
      outputCodec: 'aac',
      variantPath,
      filename: 'prepared.mkv',
      size: 32,
      ownerId: '42'
    });

    const reused = await store.findVariant({
      sourceId: source.id,
      audioIndex: 1,
      keepEnglishSubtitle: false,
      outputCodec: 'aac',
      ownerId: '42'
    });

    assert.equal(reused.id, saved.id);
    assert.equal(reused.path, saved.path);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('subtitle choice creates a distinct variant identity', async () => {
  const { root, store, source } = await fixture();

  try {
    const noSub = store.variantId({
      sourceId: source.id,
      audioIndex: 1,
      keepEnglishSubtitle: false,
      outputCodec: 'aac'
    });

    const withSub = store.variantId({
      sourceId: source.id,
      audioIndex: 1,
      keepEnglishSubtitle: true,
      outputCodec: 'aac'
    });

    assert.notEqual(noSub, withSub);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('processed movie list includes prepared variants', async () => {
  const { root, store, source } = await fixture();

  try {
    const variantPath = path.join(root, 'variant.mkv');
    await fsp.writeFile(variantPath, Buffer.alloc(16));

    await store.persistVariantFile({
      sourceId: source.id,
      audioIndex: 2,
      audioLanguage: 'Tamil',
      keepEnglishSubtitle: true,
      outputCodec: 'aac',
      variantPath,
      filename: 'variant.mkv',
      size: 16,
      ownerId: '42'
    });

    const movies = await store.listProcessedMovies('42');

    assert.equal(movies.length, 1);
    assert.equal(movies[0].variants.length, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
