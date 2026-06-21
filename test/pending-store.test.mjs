import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createFilePendingStore,
  createPendingStore,
} from '../src/jobs/index.mjs';
import {
  formatPendingFallbackInspection,
  inspectPendingFallbackQueue,
} from '../tools/telegram-sync-fallback.mjs';

test('file pending store preserves ndjson format and deduplicates by batch id', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pending-store-'));
  const queuePath = path.join(dir, 'runtime', 'telegram-sync-pending.ndjson');
  const store = createFilePendingStore({ queuePath });

  await store.append({ batch: { batchId: 'batch-1', archivedDate: '2026-05-09' }, failedAt: '2026-05-09T10:00:00.000Z', error: 'first' });
  await store.append({ batch: { batchId: 'batch-1', archivedDate: '2026-05-09' }, failedAt: '2026-05-09T10:01:00.000Z', error: 'second' });

  const raw = await readFile(queuePath, 'utf8');
  const entries = await store.read();

  assert.match(raw, /"batchId":"batch-1"/);
  assert.equal((raw.match(/batch-1/g) ?? []).length, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].error, 'second');
});

test('pending store factory requires an explicit file store selection for file queues', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pending-store-default-'));
  const queuePath = path.join(dir, 'runtime', 'telegram-sync-pending.ndjson');
  const store = createPendingStore({ storeKind: 'file', queuePath });

  assert.equal(store.kind, 'file');
  await store.write([{ batch: { batchId: 'batch-2' }, failedAt: '2026-05-09T10:00:00.000Z', error: 'oops' }]);
  const entries = await store.read();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].batch.batchId, 'batch-2');
});

test('pending store factory can switch to an injected database store', async () => {
  const dbStore = {
    readCalls: 0,
    writeCalls: 0,
    appendCalls: 0,
    async read() {
      return [{ batch: { batchId: 'db-batch' } }];
    },
    async write(entries) {
      this.writeCalls += 1;
      this.lastWrite = entries;
    },
    async append(payload) {
      this.appendCalls += 1;
      this.lastAppend = payload;
    },
  };

  const store = createPendingStore({
    storeKind: 'database',
    dbStore,
    queuePath: path.join(os.tmpdir(), 'unused.ndjson'),
  });

  assert.equal(store.kind, 'database');
  await store.read();
  await store.write([{ batch: { batchId: 'db-batch-2' } }]);
  await store.append({ batch: { batchId: 'db-batch-3' } });
  assert.equal(dbStore.writeCalls, 1);
  assert.equal(dbStore.appendCalls, 1);
  assert.deepEqual(dbStore.lastWrite, [{ batch: { batchId: 'db-batch-2' } }]);
  assert.deepEqual(dbStore.lastAppend, { batch: { batchId: 'db-batch-3' } });
});

test('NDJSON fallback inspection is read-only and summarizes replay candidates', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pending-store-inspect-'));
  const queuePath = path.join(dir, 'runtime', 'telegram-sync-pending.ndjson');
  await mkdir(path.dirname(queuePath), { recursive: true });
  const originalContent = [
    JSON.stringify({
      batch: {
        batchId: 'legacy-image',
        kind: 'image',
        archivedDate: '2026-05-09',
        status: 'ready',
      },
      failedAt: '2026-05-09T10:00:00.000Z',
      error: 'database timeout',
    }),
    JSON.stringify({
      batch: {
        batchId: 'legacy-thought',
        kind: 'thought',
        archivedDate: null,
        status: 'ready',
      },
      failedAt: '2026-05-09T10:01:00.000Z',
      error: 'connection reset',
    }),
    '',
  ].join('\n');
  await writeFile(queuePath, originalContent, 'utf8');

  const inspection = await inspectPendingFallbackQueue({ queuePath });
  const formatted = formatPendingFallbackInspection(inspection);

  assert.equal(await readFile(queuePath, 'utf8'), originalContent);
  assert.equal(inspection.status, 'ok');
  assert.equal(inspection.totalEntries, 2);
  assert.deepEqual(
    inspection.entries.map((entry) => ({
      batchId: entry.batchId,
      kind: entry.kind,
      archivedDate: entry.archivedDate,
      status: entry.status,
      failedAt: entry.failedAt,
      error: entry.error,
    })),
    [
      {
        batchId: 'legacy-image',
        kind: 'image',
        archivedDate: '2026-05-09',
        status: 'ready',
        failedAt: '2026-05-09T10:00:00.000Z',
        error: 'database timeout',
      },
      {
        batchId: 'legacy-thought',
        kind: 'thought',
        archivedDate: null,
        status: 'ready',
        failedAt: '2026-05-09T10:01:00.000Z',
        error: 'connection reset',
      },
    ],
  );
  assert.match(formatted, /legacy-image/);
  assert.match(formatted, /legacy-thought/);
  assert.match(formatted, /read-only/i);
});
