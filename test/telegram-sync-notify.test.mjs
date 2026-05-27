import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { notifyTelegramSyncResultFromFile } from '../tools/telegram-sync.mjs';

test('telegram sync notifier reads the result file and sends the deferred success message', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notifier-'));
  const resultPath = path.join(tempRoot, 'result.json');
  const sentMessages = [];

  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'thought',
          status: 'ready',
          batchId: 'thought-1',
          messages: [
            {
              chatId: 42,
              messageId: 906,
            },
          ],
          thoughtWriteStatus: 'written',
          persistenceStatus: 'stored',
        },
      ],
    }),
    'utf8',
  );

  const result = await notifyTelegramSyncResultFromFile({
    resultPath,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_SYNC_NOTIFY: 'true',
      TELEGRAM_SYNC_TRANSPORT: 'webhook',
    },
    sendMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9901 };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0], {
    chatId: 42,
    text: '随想写入成功，已入库',
    replyToMessageId: 906,
  });
});
