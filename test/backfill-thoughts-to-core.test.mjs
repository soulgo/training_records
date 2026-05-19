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
  assert.equal(thoughtInsert[1][4], '今天骑行 40公里。');
  assert.equal(thoughtInsert[1][7], 'source/_posts/2026-05-17-telegram-thought-126.md');
  assert.deepEqual(JSON.parse(thoughtInsert[1][8]), [
    '/images/thoughts/2026/05/2026-05-17-telegram-thought-126-1.jpg',
  ]);
});

async function fsMkdtemp(prefix) {
  return await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), prefix)));
}
