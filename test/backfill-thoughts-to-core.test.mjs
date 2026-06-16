import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { backfillThoughtsToCore } from '../tools/backfill-thoughts-to-core.mjs';

test('backfillThoughtsToCore imports telegram thought markdown into core.thought', async () => {
  const tempRoot = await fsMkdtemp('thoughts-backfill-');
  const postsDir = path.join(tempRoot, 'source', '_posts');
  await mkdir(postsDir, { recursive: true });
  await writeFile(
    path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
    `---\n` +
      `tags:\n` +
      `  - 训练\n` +
      `  - 随想\n` +
      `  - Telegram\n` +
      `thought_module: misc\n` +
      `telegram_message_id: 126\n` +
      `telegram_chat_id: 6314355239\n` +
      `photos:\n` +
      `  - /images/thoughts/2026/05/2026-05-17-telegram-thought-126-1.jpg\n` +
      `date: 2026-05-17 11:28:14\n` +
      `---\n\n` +
      `今天骑行 40公里。\n`,
    'utf8',
  );

  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select telegram_message_id from core\.thought/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await backfillThoughtsToCore({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
  });

  assert.equal(result.status, 'stored');
  assert.equal(result.importedCount, 1);
  const thoughtInsert = calls.find(
    ([sql]) => typeof sql === 'string' && /insert into core\.thought/i.test(sql),
  );
  assert.ok(thoughtInsert);
  assert.equal(thoughtInsert[1][0], 126);
  assert.equal(thoughtInsert[1][3], 'telegram');
  assert.equal(thoughtInsert[1][5], '今天骑行 40公里。');
  assert.equal(thoughtInsert[1][6], 'misc');
  assert.equal(thoughtInsert[1][9], 'source/_posts/2026-05-17-telegram-thought-126.md');
  assert.deepEqual(JSON.parse(thoughtInsert[1][10]), [
    '/images/thoughts/2026/05/2026-05-17-telegram-thought-126-1.jpg',
  ]);
});

test('backfillThoughtsToCore treats legacy telegram thoughts without thought_module as workout', async () => {
  const tempRoot = await fsMkdtemp('thoughts-backfill-legacy-');
  const postsDir = path.join(tempRoot, 'source', '_posts');
  await mkdir(postsDir, { recursive: true });
  await writeFile(
    path.join(postsDir, '2026-05-18-telegram-thought-127.md'),
    `---\n` +
      `tags:\n` +
      `  - 训练\n` +
      `  - 随想\n` +
      `  - Telegram\n` +
      `telegram_message_id: 127\n` +
      `telegram_chat_id: 6314355239\n` +
      `date: 2026-05-18 11:28:14\n` +
      `---\n\n` +
      `历史随想。\n`,
    'utf8',
  );

  const calls = [];
  const result = await backfillThoughtsToCore({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return {
        async connect() {
          calls.push(['connect']);
        },
        async query(sql, params) {
          calls.push([sql, params]);
          return { rows: [] };
        },
        async end() {
          calls.push(['end']);
        },
      };
    },
  });

  const thoughtInsert = calls.find(
    ([sql]) => typeof sql === 'string' && /insert into core\.thought/i.test(sql),
  );
  assert.equal(result.status, 'stored');
  assert.equal(thoughtInsert[1][3], 'telegram');
  assert.equal(thoughtInsert[1][6], 'workout');
});

test('backfillThoughtsToCore defers instead of throwing when database is unavailable', async () => {
  const stderrChunks = [];

  const result = await backfillThoughtsToCore({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return {
        async connect() {
          throw new Error('timeout expired');
        },
        async end() {},
      };
    },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
  });

  assert.deepEqual(result, {
    status: 'deferred',
    error: 'timeout expired',
  });
  assert.match(stderrChunks.join(''), /timeout expired/);
});

async function fsMkdtemp(prefix) {
  return await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), prefix)));
}
