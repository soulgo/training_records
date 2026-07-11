import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Feishu sync notify CLI loads the canonical use case and sends the stored batch result', async () => {
  const { notifyFeishuSyncFromEnv } = await import('../tools/feishu-sync-notify.mjs');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-notify-cli-'));
  const resultPath = path.join(tempRoot, 'result.json');
  const sent = [];

  await writeFile(
    resultPath,
    JSON.stringify({
      batches: [
        {
          kind: 'image',
          status: 'ready',
          batchId: 'feishu-image-1',
          archivedDate: '2026-07-10',
          persistenceStatus: 'stored',
          sourceImageCount: 2,
          recognizedImageCount: 2,
          failedImageCount: 0,
          messages: [{ chatId: 'oc_chat_1', messageId: 'om_1' }],
        },
      ],
    }),
    'utf8',
  );

  const result = await notifyFeishuSyncFromEnv({
    env: {
      FEISHU_SYNC_NOTIFY: 'true',
      FEISHU_SYNC_NOTIFY_STAGE: 'after_action',
      FEISHU_SYNC_TRANSPORT: 'webhook',
      FEISHU_SYNC_RESULT_PATH: resultPath,
      FEISHU_APP_ID: 'cli_a',
      FEISHU_APP_SECRET: 'secret',
    },
    sendMessage: async (message) => {
      sent.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'oc_chat_1');
  assert.match(sent[0].text, /成功/);
  assert.match(sent[0].text, /2/);
});
