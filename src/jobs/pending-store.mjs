import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_PENDING_QUEUE_SIZE = 1000;

export function createFilePendingStore({ queuePath, maxSize = MAX_PENDING_QUEUE_SIZE } = {}) {
  if (!queuePath) {
    throw new Error('queuePath is required for file pending store');
  }

  return {
    kind: 'file',
    async read() {
      return readPendingFallbackBatchesRaw(queuePath);
    },
    async write(entries) {
      await writePendingFallbackBatchesRaw(queuePath, entries, maxSize);
    },
    async append(payload) {
      const existing = await readPendingFallbackBatchesRaw(queuePath);
      const deduped = existing.filter((entry) => entry.batch?.batchId !== payload.batch?.batchId);
      const trimmed = deduped.length >= maxSize ? deduped.slice(-maxSize + 1) : deduped;
      trimmed.push(payload);
      await writePendingFallbackBatchesRaw(queuePath, trimmed, maxSize);
    },
  };
}

export function createPendingStore({
  queuePath,
  storeKind = 'file',
  dbStore = null,
  maxSize = MAX_PENDING_QUEUE_SIZE,
} = {}) {
  if (storeKind === 'database' && dbStore) {
    return {
      kind: 'database',
      read: (...args) => dbStore.read(...args),
      write: (...args) => dbStore.write(...args),
      append: (...args) => dbStore.append(...args),
    };
  }

  return createFilePendingStore({ queuePath, maxSize });
}

async function readPendingFallbackBatchesRaw(queuePath) {
  try {
    const raw = await readFile(queuePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function writePendingFallbackBatchesRaw(queuePath, entries, maxSize) {
  await mkdir(path.dirname(queuePath), { recursive: true });
  const trimmed = entries.length > maxSize ? entries.slice(-maxSize) : entries;
  const content = trimmed.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(queuePath, content ? `${content}\n` : '', 'utf8');
}
