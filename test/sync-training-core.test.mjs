import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { syncTrainingCore } from '../tools/sync-training-core.mjs';

test('syncTrainingCore aggregates archive markdown and thought sync results', async () => {
  const calls = [];

  const result = await syncTrainingCore({
    backfillTrainingCoreFromArchive: async () => {
      calls.push('archive');
      return { status: 'unchanged', daysBackfilled: 0 };
    },
    reconcileTrainingMarkdownToCore: async () => {
      calls.push('markdown');
      return { status: 'stored', days: 2 };
    },
    backfillThoughtsToCore: async () => {
      calls.push('thoughts');
      return { status: 'stored', importedCount: 1 };
    },
    stdout: { write() {} },
  });

  assert.deepEqual(calls, ['archive', 'markdown', 'thoughts']);
  assert.deepEqual(result, {
    status: 'stored',
    archive: { status: 'unchanged', daysBackfilled: 0 },
    markdown: { status: 'stored', days: 2 },
    thoughts: { status: 'stored', importedCount: 1 },
  });
});

test('syncTrainingCore keeps running when one sync phase defers', async () => {
  const stderrChunks = [];

  const result = await syncTrainingCore({
    backfillTrainingCoreFromArchive: async () => ({ status: 'stored', daysBackfilled: 1 }),
    reconcileTrainingMarkdownToCore: async () => {
      throw new Error('database unavailable');
    },
    backfillThoughtsToCore: async () => ({ status: 'unchanged', importedCount: 0 }),
    stdout: { write() {} },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.markdown, {
    status: 'deferred',
    error: 'database unavailable',
  });
  assert.equal(result.archive.status, 'stored');
  assert.equal(result.thoughts.status, 'unchanged');
  assert.match(stderrChunks.join(''), /database unavailable/);
});

test('syncTrainingCore reports skipped when every phase is skipped or unchanged', async () => {
  const result = await syncTrainingCore({
    backfillTrainingCoreFromArchive: async () => ({ status: 'unchanged' }),
    reconcileTrainingMarkdownToCore: async () => ({ status: 'unchanged' }),
    backfillThoughtsToCore: async () => ({ status: 'skipped' }),
    stdout: { write() {} },
  });

  assert.equal(result.status, 'unchanged');
});

test('syncTrainingCore reuses one client for archive and markdown phases', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sync-training-core-shared-client-'));
  await mkdir(path.join(tempRoot, 'source', '_posts'), { recursive: true });
  await writeFile(
    path.join(tempRoot, '训练记录.md'),
    '# 训练记录\n\n### 2026-04-03\n',
    'utf8',
  );

  const clients = [];
  function createClient() {
    const calls = [];
    const client = {
      calls,
      async connect() {
        calls.push(['connect']);
      },
      async query(sql, params) {
        calls.push([sql, params]);
        if (/from archive\.training_day\s+a/i.test(sql)) {
          return { rows: [] };
        }
        if (/from archive\.training_day/i.test(sql)) {
          return { rows: [{ archived_date: '2026-04-03' }] };
        }
        if (/from core\.training_day/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-04-03',
                total_activities: 0,
                total_duration_seconds: 0,
                training_calories: 0,
                workout_duration_minutes: null,
                active_hours: null,
                cycling_distance_km: 0,
                intake_calories: null,
                nutrition_details_json: [],
              },
            ],
          };
        }
        if (/from core\.measurement/i.test(sql) || /from core\.activity/i.test(sql) || /from core\.meal/i.test(sql)) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      async end() {
        calls.push(['end']);
      },
    };
    clients.push(client);
    return client;
  }

  const result = await syncTrainingCore({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient,
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
    stdout: { write() {} },
  });

  assert.equal(result.archive.status, 'unchanged');
  assert.equal(result.markdown.status, 'unchanged');
  assert.equal(result.thoughts.status, 'stored');
  assert.equal(clients.length, 2);
  assert.ok(clients[0].calls.some(([sql]) => /from archive\.training_day/i.test(sql)));
  assert.ok(clients[0].calls.some(([sql]) => /from core\.training_day/i.test(sql)));
}
);

test('syncTrainingCore defers phases when closing shared client fails', async () => {
  const stderrChunks = [];
  function createClient() {
    return {
      async connect() {
        throw new Error('connect unavailable');
      },
      async query() {
        throw new Error('unexpected query');
      },
      async end() {
        throw new Error('close unavailable');
      },
    };
  }

  const result = await syncTrainingCore({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient,
    backfillThoughtsToCore: async () => ({ status: 'skipped' }),
    stdout: { write() {} },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.archive, {
    status: 'deferred',
    error: 'connect unavailable',
  });
  assert.deepEqual(result.markdown, {
    status: 'deferred',
    error: 'connect unavailable',
  });
  assert.equal(result.thoughts.status, 'skipped');
  assert.match(stderrChunks.join(''), /connect unavailable/);
  assert.match(stderrChunks.join(''), /close unavailable/);
});
