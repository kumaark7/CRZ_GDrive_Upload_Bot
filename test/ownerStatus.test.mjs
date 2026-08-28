import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOwnerJobsText,
  buildQueuesText,
  buildStorageText,
  staleCallbackText
} from '../backend/status/ownerStatus.js';

test('jobs UI shows active and interrupted counts', () => {
  const text = buildOwnerJobsText({
    jobs: [
      {
        id: '1',
        type: 'torrent',
        state: 'queued',
        stage: 'download',
        queueName: 'download',
        queuePosition: 2
      },
      {
        id: '2',
        type: 'upload',
        state: 'completed',
        stage: 'upload'
      }
    ],
    interrupted: [
      {
        id: '7',
        state: 'interrupted_retryable',
        stage: 'processing'
      }
    ]
  });

  assert.match(text, /Active: 1/);
  assert.match(text, /Interrupted \/ retryable: 1/);
  assert.match(text, /download #2/);
});

test('queues UI reports configured concurrency and waiting jobs', () => {
  const text = buildQueuesText({
    preflight: {
      concurrency: 3,
      active: ['a'],
      waiting: []
    },
    download: {
      concurrency: 2,
      active: ['b', 'c'],
      waiting: [
        {
          id: 'd',
          position: 1
        }
      ]
    },
    processing: {
      concurrency: 2,
      active: [],
      waiting: []
    },
    upload: {
      concurrency: 2,
      active: [],
      waiting: []
    }
  });

  assert.match(text, /download: 2\/2 active · 1 waiting/);
  assert.match(text, /#d@1/);
});

test('storage UI warns below reserve', () => {
  const text = buildStorageText({
    totalBytes: 100,
    availableBytes: 5,
    freePercent: 5,
    reserveBytes: 10,
    persistentBytes: 20,
    persistentFiles: 2,
    tempBytes: 3,
    tempFiles: 1,
    belowReserve: true
  });

  assert.match(text, /below the CRZ safety reserve/);
});

test('storage UI confirms healthy reserve', () => {
  const text = buildStorageText({
    totalBytes: 100,
    availableBytes: 50,
    freePercent: 50,
    reserveBytes: 10,
    persistentBytes: 20,
    persistentFiles: 2,
    tempBytes: 3,
    tempFiles: 1,
    belowReserve: false
  });

  assert.match(text, /above the CRZ safety reserve/);
});

test('stale callback response is stable and user-safe', () => {
  assert.equal(
    staleCallbackText(),
    'This button is no longer active. Open the latest menu and try again.'
  );
});
