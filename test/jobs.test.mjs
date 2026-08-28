import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QueueManager
} from '../backend/jobs/queueManager.js';

import {
  JobManager
} from '../backend/jobs/jobManager.js';

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

test(
  'download queue never exceeds concurrency 2',
  async () => {
    const queues =
      new QueueManager({
        download: 2
      });

    const jobs =
      new JobManager({
        queues
      });

    let active = 0;
    let maximum = 0;

    const promises = [];

    for (
      let i = 0;
      i < 6;
      i++
    ) {
      const job =
        jobs.create({
          id: `movie-${i}`,
          type:
            'movie-download',
          userId:
            '1',
          chatId:
            1
        });

      promises.push(
        jobs.enqueue(
          job.id,
          'download',
          async () => {
            active++;

            maximum =
              Math.max(
                maximum,
                active
              );

            await sleep(40);

            active--;

            return i;
          }
        )
      );
    }

    await Promise.all(
      promises
    );

    assert.equal(
      maximum,
      2
    );
  }
);

test(
  'queued cancel removes only that job',
  async () => {
    const queues =
      new QueueManager({
        download: 1
      });

    const jobs =
      new JobManager({
        queues
      });

    const first =
      jobs.create({
        id: 'first',
        type:
          'movie-download',
        userId:
          '1',
        chatId:
          1
      });

    const second =
      jobs.create({
        id: 'second',
        type:
          'movie-download',
        userId:
          '1',
        chatId:
          1
      });

    const p1 =
      jobs.enqueue(
        first.id,
        'download',
        async () => {
          await sleep(100);
          return 'first';
        }
      );

    const p2 =
      jobs.enqueue(
        second.id,
        'download',
        async () =>
          'second'
      );

    await sleep(10);

    const result =
      jobs.cancel(
        second.id,
        {
          userId: '1'
        }
      );

    assert.equal(
      result.ok,
      true
    );

    await assert.rejects(
      p2,
      error =>
        error.name ===
        'AbortError'
    );

    assert.equal(
      jobs.get(
        second.id
      ).state,
      'cancelled'
    );

    assert.equal(
      await p1,
      'first'
    );

    assert.equal(
      jobs.get(
        first.id
      ).state,
      'completed'
    );
  }
);

test(
  'active cancellation signals only target job',
  async () => {
    const queues =
      new QueueManager({
        download: 2
      });

    const jobs =
      new JobManager({
        queues
      });

    const one =
      jobs.create({
        id: 'one',
        type:
          'movie-download',
        userId:
          '1',
        chatId:
          1
      });

    const two =
      jobs.create({
        id: 'two',
        type:
          'movie-download',
        userId:
          '1',
        chatId:
          1
      });

    function runner({
      signal
    }) {
      return new Promise(
        (resolve, reject) => {
          const timer =
            setTimeout(
              () =>
                resolve('done'),
              100
            );

          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(
                timer
              );

              reject(
                new DOMException(
                  'Cancelled',
                  'AbortError'
                )
              );
            },
            {
              once: true
            }
          );
        }
      );
    }

    const p1 =
      jobs.enqueue(
        one.id,
        'download',
        runner
      );

    const p2 =
      jobs.enqueue(
        two.id,
        'download',
        runner
      );

    await sleep(10);

    jobs.cancel(
      one.id,
      {
        userId: '1'
      }
    );

    await assert.rejects(
      p1,
      error =>
        error.name ===
        'AbortError'
    );

    assert.equal(
      jobs.get(
        one.id
      ).state,
      'cancelled'
    );

    assert.equal(
      await p2,
      'done'
    );

    assert.equal(
      jobs.get(
        two.id
      ).state,
      'completed'
    );
  }
);

test(
  'agreed CRZ queue limits are correct',
  async () => {
    const queues =
      new QueueManager({
        preflight: 3,
        download: 2,
        processing: 2,
        upload: 2
      });

    assert.equal(
      queues
        .get('preflight')
        .concurrency,
      3
    );

    assert.equal(
      queues
        .get('download')
        .concurrency,
      2
    );

    assert.equal(
      queues
        .get('processing')
        .concurrency,
      2
    );

    assert.equal(
      queues
        .get('upload')
        .concurrency,
      2
    );
  }
);


test(
  'queue lifecycle hooks report queued position and start',
  async () => {
    const queues = new QueueManager({ preflight: 1 });
    const jobs = new JobManager({ queues });
    const one = jobs.create({ id: 'hook-one', type: 'preflight', userId: '1', chatId: 1 });
    const two = jobs.create({ id: 'hook-two', type: 'preflight', userId: '1', chatId: 1 });
    const events = [];

    const p1 = jobs.enqueue(one.id, 'preflight', async () => {
      await sleep(60);
      return 'one';
    });

    const p2 = jobs.enqueue(two.id, 'preflight', async () => 'two', {
      onQueued: info => events.push(`queued:${info.position}`),
      onStart: () => events.push('started')
    });

    await Promise.all([p1, p2]);
    assert.ok(events.some(value => value.startsWith('queued:')));
    assert.ok(events.includes('started'));
  }
);

test(
  'preflight and download queues do not block each other',
  async () => {
    const queues = new QueueManager({ preflight: 1, download: 1 });
    const jobs = new JobManager({ queues });
    const preflight = jobs.create({ id: 'independent-preflight', type: 'preflight', userId: '1', chatId: 1 });
    const download = jobs.create({ id: 'independent-download', type: 'download', userId: '1', chatId: 1 });
    let downloadStarted = false;

    const p1 = jobs.enqueue(preflight.id, 'preflight', async () => {
      await sleep(80);
      return 'preflight';
    });

    const p2 = jobs.enqueue(download.id, 'download', async () => {
      downloadStarted = true;
      await sleep(10);
      return 'download';
    });

    await sleep(20);
    assert.equal(downloadStarted, true);
    await Promise.all([p1, p2]);
  }
);
