import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  RuntimeStateStore
} from '../backend/storage/runtimeState.js';

async function makeFixture(
  retentionMs = 100
) {
  const root =
    await fsp.mkdtemp(
      path.join(
        os.tmpdir(),
        'crz-runtime-state-'
      )
    );

  const tempRoot =
    path.join(
      root,
      'temp'
    );

  const stateFile =
    path.join(
      root,
      'state',
      'runtime.json'
    );

  const store =
    new RuntimeStateStore({
      stateFile,
      tempRoot,
      retentionMs
    });

  return {
    root,
    tempRoot,
    stateFile,
    store
  };
}

test(
  'previous active jobs become interrupted retryable',
  async () => {
    const fixture =
      await makeFixture();

    try {
      await fixture.store.saveRuntime({
        jobs: [
          {
            id: 'a',
            state: 'running',
            stage: 'download'
          },
          {
            id: 'b',
            state: 'completed',
            stage: 'upload'
          }
        ],
        sessions: [
          {
            id: 'a',
            kind: 'torrent',
            selectedTorrentFileIndex: 2
          }
        ]
      });

      const second =
        new RuntimeStateStore({
          stateFile:
            fixture.stateFile,
          tempRoot:
            fixture.tempRoot,
          retentionMs: 100
        });

      const interrupted =
        await second
          .markPreviousRunInterrupted();

      assert.equal(
        interrupted.length,
        1
      );

      assert.equal(
        interrupted[0].id,
        'a'
      );

      assert.equal(
        interrupted[0].state,
        'interrupted_retryable'
      );

      assert.equal(
        interrupted[0]
          .session
          .selectedTorrentFileIndex,
        2
      );
    } finally {
      await fsp.rm(
        fixture.root,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);

test(
  'stale temporary jobs are swept',
  async () => {
    const fixture =
      await makeFixture(10);

    try {
      const stale =
        path.join(
          fixture.tempRoot,
          'job-old'
        );

      await fsp.mkdir(
        stale,
        {
          recursive: true
        }
      );

      await fsp.writeFile(
        path.join(
          stale,
          'file.bin'
        ),
        Buffer.alloc(64)
      );

      const old =
        new Date(
          Date.now() - 60_000
        );

      await fsp.utimes(
        stale,
        old,
        old
      );

      const result =
        await fixture.store.sweepTemp();

      assert.equal(
        result.removed,
        1
      );

      await assert.rejects(
        fsp.access(stale)
      );
    } finally {
      await fsp.rm(
        fixture.root,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);

test(
  'protected active temporary job is never swept',
  async () => {
    const fixture =
      await makeFixture(10);

    try {
      const active =
        path.join(
          fixture.tempRoot,
          'job-active'
        );

      await fsp.mkdir(
        active,
        {
          recursive: true
        }
      );

      const old =
        new Date(
          Date.now() - 60_000
        );

      await fsp.utimes(
        active,
        old,
        old
      );

      const result =
        await fixture.store.sweepTemp({
          protectedPaths: [
            active
          ]
        });

      assert.equal(
        result.removed,
        0
      );

      await fsp.access(active);
    } finally {
      await fsp.rm(
        fixture.root,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);

test(
  'interrupted ledger survives restart',
  async () => {
    const fixture =
      await makeFixture();

    try {
      await fixture.store.saveRuntime({
        jobs: [
          {
            id: 'recover-me',
            state: 'finalizing',
            stage: 'upload'
          }
        ],
        sessions: [
          {
            id: 'recover-me',
            readyFilename:
              'movie.mkv'
          }
        ]
      });

      await fixture.store
        .markPreviousRunInterrupted();

      const second =
        new RuntimeStateStore({
          stateFile:
            fixture.stateFile,
          tempRoot:
            fixture.tempRoot
        });

      const list =
        await second.listInterrupted();

      assert.equal(
        list.length,
        1
      );

      assert.equal(
        list[0].id,
        'recover-me'
      );
    } finally {
      await fsp.rm(
        fixture.root,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);
