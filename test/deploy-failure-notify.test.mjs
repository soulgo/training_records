import test from 'node:test';
import assert from 'node:assert/strict';

import { notifyTelegramActionFailure } from '../tools/telegram-action-monitor.mjs';
import { notifyFeishuActionFailure } from '../tools/feishu-action-monitor.mjs';

test('Telegram deploy failure notification accepts a direct workflow input target', async () => {
  const sent = [];
  const result = await notifyTelegramActionFailure({
    env: {
      NOTIFICATION_CHAT_ID: '42',
      NOTIFICATION_MESSAGE_ID: '701',
      TELEGRAM_BOT_TOKEN: 'token',
      STEP_DEPLOY_OUTCOME: 'failure',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_RUN_ID: '123',
    },
    sendTelegramMessage: async (message) => sent.push(message),
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureStage, '站点部署/页面刷新');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, '42');
  assert.equal(sent[0].replyToMessageId, '701');
});

test('Feishu deploy failure notification accepts a direct workflow input target', async () => {
  const sent = [];
  const result = await notifyFeishuActionFailure({
    env: {
      NOTIFICATION_CHAT_ID: 'oc_chat_1',
      STEP_DEPLOY_OUTCOME: 'failure',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_RUN_ID: '456',
    },
    sendFeishuMessage: async (message) => sent.push(message),
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureStage, '站点部署/页面刷新');
  assert.deepEqual(sent, [{ chatId: 'oc_chat_1', text: sent[0].text }]);
});
