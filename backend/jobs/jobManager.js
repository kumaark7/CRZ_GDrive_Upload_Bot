import { randomUUID } from 'node:crypto';
import { crzQueues } from './queueManager.js';

const TERMINAL_STATES =
  new Set([
    'completed',
    'failed',
    'cancelled',
    'deleted'
  ]);

function timestamp() {
  return Date.now();
}

function isAbortError(error) {
  return (
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR'
  );
}

export class JobManager {
  constructor({
    queues = crzQueues
  } = {}) {
    this.jobs = new Map();
    this.queues = queues;
  }

  create({
    id = randomUUID(),
    type,
    userId,
    chatId,
    parentId = null,
    metadata = {}
  }) {
    const key =
      String(id);

    if (!type) {
      throw new Error(
        'Job type is required'
      );
    }

    if (
      userId === undefined ||
      userId === null
    ) {
      throw new Error(
        'Job userId is required'
      );
    }

    if (this.jobs.has(key)) {
      throw new Error(
        `Duplicate job ID: ${key}`
      );
    }

    const job = {
      id: key,

      type,

      userId:
        String(userId),

      chatId,

      parentId:
        parentId === null
          ? null
          : String(parentId),

      state: 'created',

      stage: null,

      queueName: null,
      queuePosition: null,

      createdAt:
        timestamp(),

      queuedAt: null,
      startedAt: null,
      finishedAt: null,
      updatedAt:
        timestamp(),

      abortController:
        new AbortController(),

      statusMessageId: null,

      metadata: {
        ...metadata
      },

      result: null,
      error: null
    };

    this.jobs.set(
      key,
      job
    );

    return job;
  }

  get(id) {
    if (
      id === undefined ||
      id === null
    ) {
      return null;
    }

    return (
      this.jobs.get(
        String(id)
      ) || null
    );
  }

  getForUser(
    id,
    userId
  ) {
    const job =
      this.get(id);

    if (!job) {
      return null;
    }

    if (
      job.userId !==
      String(userId)
    ) {
      return null;
    }

    return job;
  }

  update(
    id,
    patch = {}
  ) {
    const job =
      this.get(id);

    if (!job) {
      return null;
    }

    Object.assign(
      job,
      patch
    );

    job.updatedAt =
      timestamp();

    return job;
  }

  list({
    userId = null,
    states = null,
    parentId = undefined
  } = {}) {
    let jobs = [
      ...this.jobs.values()
    ];

    if (userId !== null) {
      jobs = jobs.filter(
        job =>
          job.userId ===
          String(userId)
      );
    }

    if (
      Array.isArray(states)
    ) {
      const allowed =
        new Set(states);

      jobs = jobs.filter(
        job =>
          allowed.has(
            job.state
          )
      );
    }

    if (
      parentId !== undefined
    ) {
      const wanted =
        parentId === null
          ? null
          : String(parentId);

      jobs = jobs.filter(
        job =>
          job.parentId === wanted
      );
    }

    return jobs.sort(
      (a, b) =>
        a.createdAt -
        b.createdAt
    );
  }

  isTerminal(job) {
    return (
      job &&
      TERMINAL_STATES.has(
        job.state
      )
    );
  }

  async enqueue(
    id,
    queueName,
    runner
  ) {
    const job =
      this.get(id);

    if (!job) {
      throw new Error(
        `Job not found: ${id}`
      );
    }

    if (
      this.isTerminal(job)
    ) {
      throw new Error(
        `Job ${job.id} is already ${job.state}`
      );
    }

    if (
      typeof runner !== 'function'
    ) {
      throw new Error(
        'Job runner is required'
      );
    }

    const queue =
      this.queues.get(
        queueName
      );

    job.queueName =
      queueName;

    job.stage =
      queueName;

    job.state =
      'queued';

    job.queuedAt =
      timestamp();

    job.updatedAt =
      timestamp();

    try {
      const result =
        await queue.enqueue({
          id: job.id,

          signal:
            job.abortController.signal,

          onQueued: info => {
            if (
              job.state ===
              'queued'
            ) {
              job.queuePosition =
                info.position;

              job.updatedAt =
                timestamp();
            }
          },

          onStart: () => {
            job.state =
              'running';

            job.queuePosition =
              null;

            job.startedAt =
              job.startedAt ||
              timestamp();

            job.updatedAt =
              timestamp();
          },

          run: async () => {
            return runner({
              job,

              signal:
                job.abortController.signal
            });
          },

          onFinish: () => {
            job.queuePosition =
              null;

            job.updatedAt =
              timestamp();
          }
        });

      if (
        !this.isTerminal(job) &&
        job.state !==
          'waiting_user' &&
        job.state !==
          'finalizing'
      ) {
        job.state =
          'completed';
      }

      job.result =
        result;

      if (
        job.state ===
        'completed'
      ) {
        job.finishedAt =
          timestamp();
      }

      job.updatedAt =
        timestamp();

      return result;
    } catch (error) {
      if (
        isAbortError(error) ||
        job.abortController.signal.aborted
      ) {
        job.state =
          'cancelled';

        job.error =
          null;
      } else {
        job.state =
          'failed';

        job.error = {
          name:
            error?.name ||
            'Error',

          code:
            error?.code ||
            null,

          message:
            error?.message ||
            String(error)
        };
      }

      job.queuePosition =
        null;

      job.finishedAt =
        timestamp();

      job.updatedAt =
        timestamp();

      throw error;
    }
  }

  cancel(
    id,
    {
      userId = null,
      reason =
        'Cancelled by user'
    } = {}
  ) {
    const job =
      this.get(id);

    if (!job) {
      return {
        ok: false,
        reason: 'not_found'
      };
    }

    if (
      userId !== null &&
      job.userId !==
        String(userId)
    ) {
      return {
        ok: false,
        reason: 'not_found'
      };
    }

    if (
      this.isTerminal(job)
    ) {
      return {
        ok: false,
        reason:
          'already_terminal',

        state:
          job.state,

        job
      };
    }

    if (
      job.state ===
        'cancelling'
    ) {
      return {
        ok: false,
        reason:
          'already_cancelling',

        job
      };
    }

    const previousState =
      job.state;

    /*
     * Queued job:
     * remove only this queue item.
     */
    if (
      job.state === 'queued' &&
      job.queueName
    ) {
      this.queues.cancel(
        job.queueName,
        job.id
      );

      if (
        !job.abortController
          .signal.aborted
      ) {
        job.abortController.abort(
          reason
        );
      }

      job.state =
        'cancelled';

      job.queuePosition =
        null;

      job.finishedAt =
        timestamp();

      job.updatedAt =
        timestamp();

      return {
        ok: true,
        previousState,
        job
      };
    }

    /*
     * Active job:
     * do not mark it cancelled yet.
     *
     * Signal the actual worker and wait for the runner
     * to terminate. enqueue() will then transition the
     * state to cancelled.
     */
    if (
      !job.abortController
        .signal.aborted
    ) {
      job.abortController.abort(
        reason
      );
    }

    job.state =
      'cancelling';

    job.queuePosition =
      null;

    job.updatedAt =
      timestamp();

    return {
      ok: true,
      previousState,
      job
    };
  }

  markWaitingUser(
    id,
    metadata = {}
  ) {
    const job =
      this.get(id);

    if (!job) {
      return null;
    }

    job.state =
      'waiting_user';

    job.metadata = {
      ...job.metadata,
      ...metadata
    };

    job.updatedAt =
      timestamp();

    return job;
  }

  markFinalizing(id) {
    const job =
      this.get(id);

    if (!job) {
      return null;
    }

    job.state =
      'finalizing';

    job.updatedAt =
      timestamp();

    return job;
  }

  markCompleted(
    id,
    result = null
  ) {
    const job =
      this.get(id);

    if (!job) {
      return null;
    }

    job.state =
      'completed';

    job.result =
      result;

    job.finishedAt =
      timestamp();

    job.updatedAt =
      timestamp();

    return job;
  }

  markCancelled(id) {
    const job =
      this.get(id);

    if (!job) {
      return null;
    }

    job.state =
      'cancelled';

    job.finishedAt =
      timestamp();

    job.queuePosition =
      null;

    job.updatedAt =
      timestamp();

    return job;
  }

  delete(id) {
    const job =
      this.get(id);

    if (!job) {
      return false;
    }

    if (
      !this.isTerminal(job)
    ) {
      throw new Error(
        `Cannot delete active job ${job.id}`
      );
    }

    this.jobs.delete(
      job.id
    );

    return true;
  }

  snapshot() {
    return {
      queues:
        this.queues.snapshot(),

      jobs: [
        ...this.jobs.values()
      ].map(job => ({
        id: job.id,

        type:
          job.type,

        userId:
          job.userId,

        parentId:
          job.parentId,

        state:
          job.state,

        stage:
          job.stage,

        queueName:
          job.queueName,

        queuePosition:
          job.queuePosition,

        createdAt:
          job.createdAt,

        startedAt:
          job.startedAt,

        finishedAt:
          job.finishedAt
      }))
    };
  }
}

export const jobManager =
  new JobManager();
