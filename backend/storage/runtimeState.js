import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ACTIVE_STATES = new Set([
  'created',
  'queued',
  'running',
  'waiting_user',
  'finalizing',
  'cancelling'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class RuntimeStateStore {
  constructor({
    stateFile,
    tempRoot,
    retentionMs = 30 * 60 * 1000
  } = {}) {
    const projectRoot = path.resolve(
      new URL('../../', import.meta.url).pathname
    );

    this.stateFile =
      stateFile ||
      path.join(
        projectRoot,
        'data',
        'storage',
        'state',
        'runtime-jobs.json'
      );

    this.tempRoot =
      tempRoot ||
      path.join(
        os.tmpdir(),
        'ez-mirror-torrent'
      );

    this.retentionMs =
      Number(retentionMs) > 0
        ? Number(retentionMs)
        : 30 * 60 * 1000;

    this.state = {
      version: 1,
      updatedAt: null,
      jobs: [],
      sessions: [],
      interrupted: []
    };

    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (this.loaded) return this;

    await fsp.mkdir(
      path.dirname(this.stateFile),
      { recursive: true }
    );

    try {
      const parsed = JSON.parse(
        await fsp.readFile(
          this.stateFile,
          'utf8'
        )
      );

      this.state = {
        version: 1,
        updatedAt:
          parsed?.updatedAt || null,
        jobs:
          Array.isArray(parsed?.jobs)
            ? parsed.jobs
            : [],
        sessions:
          Array.isArray(parsed?.sessions)
            ? parsed.sessions
            : [],
        interrupted:
          Array.isArray(parsed?.interrupted)
            ? parsed.interrupted
            : []
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    this.loaded = true;
    return this;
  }

  async flush() {
    await this.init();

    const snapshot =
      JSON.stringify(
        this.state,
        null,
        2
      );

    const write = async () => {
      const tmp =
        `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;

      await fsp.writeFile(
        tmp,
        snapshot,
        'utf8'
      );

      await fsp.rename(
        tmp,
        this.stateFile
      );
    };

    this.writeChain =
      this.writeChain.then(
        write,
        write
      );

    await this.writeChain;
  }

  async saveRuntime({
    jobs = [],
    sessions = []
  } = {}) {
    await this.init();

    this.state.jobs =
      clone(jobs);

    this.state.sessions =
      clone(sessions);

    this.state.updatedAt =
      Date.now();

    await this.flush();
  }

  async markPreviousRunInterrupted() {
    await this.init();

    const byId =
      new Map(
        this.state.sessions.map(
          session => [
            String(session.id),
            session
          ]
        )
      );

    const interrupted = [];

    for (const job of this.state.jobs) {
      if (
        !ACTIVE_STATES.has(
          String(job.state)
        )
      ) {
        continue;
      }

      const session =
        byId.get(
          String(job.id)
        ) || null;

      interrupted.push({
        ...clone(job),
        state:
          'interrupted_retryable',
        interruptedAt:
          Date.now(),
        session:
          session
            ? clone(session)
            : null
      });
    }

    if (interrupted.length) {
      const existing =
        new Map(
          this.state.interrupted.map(
            item => [
              String(item.id),
              item
            ]
          )
        );

      for (const item of interrupted) {
        existing.set(
          String(item.id),
          item
        );
      }

      this.state.interrupted =
        [...existing.values()]
          .sort(
            (a, b) =>
              Number(b.interruptedAt || 0) -
              Number(a.interruptedAt || 0)
          )
          .slice(0, 100);
    }

    this.state.jobs = [];
    this.state.sessions = [];
    this.state.updatedAt =
      Date.now();

    await this.flush();

    return clone(interrupted);
  }

  async listInterrupted() {
    await this.init();
    return clone(
      this.state.interrupted
    );
  }

  async clearInterrupted(id) {
    await this.init();

    const before =
      this.state.interrupted.length;

    this.state.interrupted =
      this.state.interrupted.filter(
        item =>
          String(item.id) !==
          String(id)
      );

    if (
      this.state.interrupted.length !==
      before
    ) {
      await this.flush();
      return true;
    }

    return false;
  }

  async sweepTemp({
    protectedPaths = []
  } = {}) {
    const protectedRoots =
      protectedPaths
        .filter(Boolean)
        .map(value =>
          path.resolve(value)
        );

    if (!(await exists(this.tempRoot))) {
      return {
        removed: 0,
        kept: 0,
        freedBytes: 0
      };
    }

    const now = Date.now();
    let removed = 0;
    let kept = 0;
    let freedBytes = 0;

    let entries;

    try {
      entries =
        await fsp.readdir(
          this.tempRoot,
          {
            withFileTypes: true
          }
        );
    } catch {
      return {
        removed,
        kept,
        freedBytes
      };
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const full =
        path.join(
          this.tempRoot,
          entry.name
        );

      const resolved =
        path.resolve(full);

      if (
        protectedRoots.some(
          protectedPath =>
            resolved === protectedPath ||
            resolved.startsWith(
              `${protectedPath}${path.sep}`
            ) ||
            protectedPath.startsWith(
              `${resolved}${path.sep}`
            )
        )
      ) {
        kept++;
        continue;
      }

      let stat;

      try {
        stat =
          await fsp.stat(full);
      } catch {
        continue;
      }

      const age =
        now -
        Number(
          stat.mtimeMs ||
          stat.ctimeMs ||
          now
        );

      if (age < this.retentionMs) {
        kept++;
        continue;
      }

      const size =
        await this.directorySize(full);

      await fsp.rm(
        full,
        {
          recursive: true,
          force: true
        }
      );

      removed++;
      freedBytes += size;
    }

    return {
      removed,
      kept,
      freedBytes
    };
  }

  async directorySize(root) {
    let total = 0;

    async function walk(current) {
      let entries;

      try {
        entries =
          await fsp.readdir(
            current,
            {
              withFileTypes: true
            }
          );
      } catch {
        return;
      }

      for (const entry of entries) {
        const full =
          path.join(
            current,
            entry.name
          );

        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }

        try {
          const stat =
            await fsp.stat(full);

          total += Number(
            stat.size || 0
          );
        } catch {
          // Ignore files removed during sweep.
        }
      }
    }

    await walk(root);
    return total;
  }
}

export const runtimeState =
  new RuntimeStateStore({
    retentionMs:
      Number(
        process.env
          .CRZ_TEMP_RETENTION_MS ||
        30 * 60 * 1000
      )
  });
