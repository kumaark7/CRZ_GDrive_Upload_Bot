function makeAbortError(message = 'Cancelled') {
  return new DOMException(message, 'AbortError');
}

export class WorkQueue {
  constructor(name, concurrency) {
    const limit = Number(concurrency);

    if (!name) {
      throw new Error('Queue name is required');
    }

    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `Invalid concurrency for queue ${name}: ${concurrency}`
      );
    }

    this.name = name;
    this.concurrency = limit;

    this.waiting = [];
    this.active = new Map();
  }

  get activeCount() {
    return this.active.size;
  }

  get waitingCount() {
    return this.waiting.length;
  }

  has(id) {
    const key = String(id);

    return (
      this.active.has(key) ||
      this.waiting.some(item => item.id === key)
    );
  }

  getPosition(id) {
    const key = String(id);

    const index = this.waiting.findIndex(
      item => item.id === key
    );

    return index === -1
      ? null
      : index + 1;
  }

  enqueue({
    id,
    signal,
    run,
    onQueued,
    onStart,
    onFinish
  }) {
    const key = String(id);

    if (!key) {
      throw new Error('Queue job ID is required');
    }

    if (typeof run !== 'function') {
      throw new Error(
        `Queue ${this.name}: run() is required`
      );
    }

    if (this.has(key)) {
      throw new Error(
        `Queue ${this.name}: duplicate job ${key}`
      );
    }

    return new Promise((resolve, reject) => {
      const item = {
        id: key,
        signal,
        run,
        onQueued,
        onStart,
        onFinish,
        resolve,
        reject,
        settled: false
      };

      if (signal?.aborted) {
        item.settled = true;
        reject(makeAbortError());
        return;
      }

      this.waiting.push(item);

      this.#notifyWaiting();
      this.#drain();
    });
  }

  cancel(id) {
    const key = String(id);

    const waitingIndex = this.waiting.findIndex(
      item => item.id === key
    );

    if (waitingIndex !== -1) {
      const [item] = this.waiting.splice(
        waitingIndex,
        1
      );

      if (!item.settled) {
        item.settled = true;
        item.reject(
          makeAbortError()
        );
      }

      this.#notifyWaiting();
      this.#drain();

      return {
        found: true,
        state: 'queued',
        cancelled: true
      };
    }

    if (this.active.has(key)) {
      return {
        found: true,
        state: 'active',
        cancelled: false
      };
    }

    return {
      found: false,
      state: null,
      cancelled: false
    };
  }

  snapshot() {
    return {
      name: this.name,
      concurrency: this.concurrency,

      active: [
        ...this.active.keys()
      ],

      waiting: this.waiting.map(
        (item, index) => ({
          id: item.id,
          position: index + 1
        })
      )
    };
  }

  async #start(item) {
    if (
      item.settled ||
      item.signal?.aborted
    ) {
      if (!item.settled) {
        item.settled = true;
        item.reject(
          makeAbortError()
        );
      }

      return;
    }

    this.active.set(
      item.id,
      item
    );

    try {
      item.onStart?.({
        queue: this.name,
        active: this.activeCount,
        concurrency: this.concurrency
      });
    } catch (error) {
      console.error(
        `[queue:${this.name}] onStart error:`,
        error
      );
    }

    try {
      const result =
        await item.run();

      if (!item.settled) {
        item.settled = true;
        item.resolve(result);
      }
    } catch (error) {
      if (!item.settled) {
        item.settled = true;
        item.reject(error);
      }
    } finally {
      this.active.delete(item.id);

      try {
        await item.onFinish?.({
          queue: this.name,
          active: this.activeCount,
          concurrency: this.concurrency
        });
      } catch (error) {
        console.error(
          `[queue:${this.name}] onFinish error:`,
          error
        );
      }

      this.#notifyWaiting();
      this.#drain();
    }
  }

  #drain() {
    while (
      this.activeCount < this.concurrency &&
      this.waiting.length > 0
    ) {
      const item =
        this.waiting.shift();

      if (!item || item.settled) {
        continue;
      }

      this.#start(item).catch(error => {
        console.error(
          `[queue:${this.name}] unexpected failure:`,
          error
        );
      });
    }

    this.#notifyWaiting();
  }

  #notifyWaiting() {
    for (
      let index = 0;
      index < this.waiting.length;
      index++
    ) {
      const item =
        this.waiting[index];

      try {
        item.onQueued?.({
          queue: this.name,
          position: index + 1,
          active: this.activeCount,
          concurrency: this.concurrency
        });
      } catch (error) {
        console.error(
          `[queue:${this.name}] position callback error:`,
          error
        );
      }
    }
  }
}

export class QueueManager {
  constructor(config = {}) {
    this.queues = new Map();

    for (
      const [name, concurrency]
      of Object.entries(config)
    ) {
      this.addQueue(
        name,
        concurrency
      );
    }
  }

  addQueue(name, concurrency) {
    if (this.queues.has(name)) {
      throw new Error(
        `Queue already exists: ${name}`
      );
    }

    const queue =
      new WorkQueue(
        name,
        concurrency
      );

    this.queues.set(
      name,
      queue
    );

    return queue;
  }

  get(name) {
    const queue =
      this.queues.get(name);

    if (!queue) {
      throw new Error(
        `Unknown queue: ${name}`
      );
    }

    return queue;
  }

  cancel(queueName, jobId) {
    return this
      .get(queueName)
      .cancel(jobId);
  }

  snapshot() {
    const result = {};

    for (
      const [name, queue]
      of this.queues
    ) {
      result[name] =
        queue.snapshot();
    }

    return result;
  }
}

/*
 * CRZ agreed concurrency limits.
 *
 * ffprobe is intentionally NOT queued.
 * It runs immediately when a movie download completes.
 */
export const crzQueues =
  new QueueManager({
    preflight: Number(
      process.env.CRZ_MAX_PREFLIGHTS || 3
    ),

    download: Number(
      process.env.CRZ_MAX_DOWNLOADS || 2
    ),

    processing: Number(
      process.env.CRZ_MAX_PROCESSING || 2
    ),

    upload: Number(
      process.env.CRZ_MAX_UPLOADS || 2
    )
  });
