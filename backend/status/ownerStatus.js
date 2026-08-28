import fsp from 'node:fs/promises';
import path from 'node:path';

export function humanBytes(n) {
  if (!Number.isFinite(Number(n))) return 'unknown';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(n);
  let i = 0;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }

  return `${value >= 10 || i === 0 ? value.toFixed(1) : value.toFixed(2)} ${units[i]}`;
}

export function staleCallbackText() {
  return 'This button is no longer active. Open the latest menu and try again.';
}

export function buildOwnerJobsText({
  jobs = [],
  interrupted = []
} = {}) {
  const active = jobs.filter(job =>
    !['completed', 'failed', 'cancelled', 'deleted'].includes(
      String(job.state)
    )
  );

  const lines = [
    '🧩 Active Jobs',
    '',
    `Active: ${active.length}`,
    `Interrupted / retryable: ${interrupted.length}`
  ];

  if (!active.length) {
    lines.push('', 'No active jobs.');
  } else {
    lines.push('');

    for (const job of active.slice(0, 20)) {
      const queue = job.queueName
        ? ` · ${job.queueName}${job.queuePosition ? ` #${job.queuePosition}` : ''}`
        : '';

      lines.push(
        `• #${job.id} · ${job.state}${queue}`,
        `  stage: ${job.stage || '-'} · type: ${job.type || '-'}`
      );
    }
  }

  if (interrupted.length) {
    lines.push('', 'Interrupted:');

    for (const job of interrupted.slice(0, 10)) {
      lines.push(
        `• #${job.id} · ${job.stage || job.state || 'unknown'} · retryable`
      );
    }
  }

  return lines.join('\n');
}

export function buildQueuesText(queues = {}) {
  const names = ['preflight', 'download', 'processing', 'upload'];

  const lines = [
    '🚦 CRZ Queues',
    ''
  ];

  for (const name of names) {
    const q = queues[name];

    if (!q) {
      lines.push(`• ${name}: unavailable`);
      continue;
    }

    lines.push(
      `• ${name}: ${q.active.length}/${q.concurrency} active · ${q.waiting.length} waiting`
    );

    if (q.waiting.length) {
      const positions = q.waiting
        .slice(0, 10)
        .map(item => `#${item.id}@${item.position}`)
        .join(', ');

      lines.push(`  waiting: ${positions}`);
    }
  }

  return lines.join('\n');
}

async function directorySize(root) {
  let total = 0;
  let files = 0;

  async function walk(current) {
    let entries;

    try {
      entries = await fsp.readdir(
        current,
        { withFileTypes: true }
      );
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }

      try {
        const stat = await fsp.stat(full);
        total += Number(stat.size || 0);
        files++;
      } catch {
        // File disappeared while measuring.
      }
    }
  }

  await walk(root);

  return {
    bytes: total,
    files
  };
}

export async function getOwnerStorageSummary({
  storageRoot,
  tempRoot
}) {
  const stat = await fsp.statfs(storageRoot);
  const blockSize = Number(stat.bsize);
  const totalBytes = Number(stat.blocks) * blockSize;
  const availableBytes = Number(stat.bavail) * blockSize;
  const usedBytes = totalBytes - availableBytes;
  const freePercent = totalBytes > 0
    ? availableBytes * 100 / totalBytes
    : 0;

  const [persistent, temp] = await Promise.all([
    directorySize(storageRoot),
    directorySize(tempRoot)
  ]);

  const reserveBytes = Math.max(
    5 * 1024 * 1024 * 1024,
    Math.ceil(totalBytes * 0.10)
  );

  return {
    totalBytes,
    usedBytes,
    availableBytes,
    freePercent,
    reserveBytes,
    persistentBytes: persistent.bytes,
    persistentFiles: persistent.files,
    tempBytes: temp.bytes,
    tempFiles: temp.files,
    belowReserve: availableBytes < reserveBytes
  };
}

export function buildStorageText(summary) {
  return [
    '💾 CRZ Storage',
    '',
    `Filesystem free: ${humanBytes(summary.availableBytes)} / ${humanBytes(summary.totalBytes)} (${summary.freePercent.toFixed(1)}%)`,
    `Safety reserve: ${humanBytes(summary.reserveBytes)}`,
    `Persistent CRZ storage: ${humanBytes(summary.persistentBytes)} · ${summary.persistentFiles} files`,
    `Temporary jobs: ${humanBytes(summary.tempBytes)} · ${summary.tempFiles} files`,
    '',
    summary.belowReserve
      ? '⚠️ Free space is below the CRZ safety reserve.'
      : '✅ Storage is above the CRZ safety reserve.'
  ].join('\n');
}
