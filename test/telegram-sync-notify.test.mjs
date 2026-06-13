import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { notifyTelegramSyncResultFromFile } from '../tools/telegram-sync.mjs';
import { notifyTelegramSyncFromEnv } from '../tools/telegram-sync-notify.mjs';

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

test('telegram sync notifier passes the bot token to the transport sender', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notifier-token-'));
  const resultPath = path.join(tempRoot, 'result.json');
  const sentMessages = [];

  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'thought',
          status: 'ready',
          batchId: 'thought-2',
          messages: [{ chatId: 42, messageId: 907 }],
          thoughtWriteStatus: 'written',
          persistenceStatus: 'stored',
        },
      ],
    }),
    'utf8',
  );

  const result = await notifyTelegramSyncFromEnv({
    env: {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_SYNC_NOTIFY: 'true',
      TELEGRAM_SYNC_TRANSPORT: 'webhook',
      TELEGRAM_SYNC_RESULT_PATH: resultPath,
    },
    sendMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9902 };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(sentMessages[0].botToken, 'bot-token');
  assert.equal(sentMessages[0].chatId, 42);
});

test('telegram sync notifier reports partial failures instead of success for stored image albums', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notifier-partial-'));
  const resultPath = path.join(tempRoot, 'result.json');
  const sentMessages = [];

  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'image',
          status: 'ready',
          batchId: 'album-2026-05-31',
          archivedDate: '2026-05-31',
          messages: [
            { chatId: 42, messageId: 379 },
            { chatId: 42, messageId: 380 },
          ],
          persistenceStatus: 'stored',
          partialFailure: true,
          failureCategory: 'ai_service',
          failureReason: 'telegram_training_image returned invalid JSON',
          recognitionErrors: [
            {
              messageId: 380,
              error: 'telegram_training_image returned invalid JSON',
              failureCategory: 'ai_service',
            },
          ],
          issues: ['missing recognition for message 380'],
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
      return { message_id: 9903 };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].replyToMessageId, 379);
  assert.match(sentMessages[0].text, /部分解析失败/);
  assert.match(sentMessages[0].text, /380/);
  assert.match(sentMessages[0].text, /invalid JSON/);
  assert.doesNotMatch(sentMessages[0].text, /解析成功/);
});

test('telegram sync notifier sends one reply for each image business batch in a burst dispatch', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notifier-burst-'));
  const resultPath = path.join(tempRoot, 'result.json');
  const sentMessages = [];

  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'image',
          status: 'ready',
          batchId: 'album-workout',
          archivedDate: '2026-06-13',
          messages: [
            { chatId: 42, messageId: 6101, mediaGroupId: 'album-workout' },
            { chatId: 42, messageId: 6102, mediaGroupId: 'album-workout' },
          ],
          persistenceStatus: 'stored',
          sourceImageCount: 2,
          recognizedImageCount: 2,
          failedImageCount: 0,
        },
        {
          kind: 'image',
          status: 'ready',
          batchId: 'single-6103',
          archivedDate: '2026-06-13',
          messages: [{ chatId: 42, messageId: 6103, mediaGroupId: null }],
          persistenceStatus: 'stored',
          sourceImageCount: 1,
          recognizedImageCount: 1,
          failedImageCount: 0,
        },
        {
          kind: 'image',
          status: 'skipped',
          batchId: 'single-6104',
          messages: [{ chatId: 42, messageId: 6104, mediaGroupId: null }],
          failureCategory: 'ai_service',
          recognitionPendingStatus: 'queued',
          failureReason: 'HTTP 429 rate limited',
          sourceImageCount: 1,
          recognizedImageCount: 0,
          failedImageCount: 1,
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
      return { message_id: 9905 };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.sent, 3);
  assert.equal(sentMessages.length, 3);
  assert.deepEqual(
    sentMessages.map((message) => message.replyToMessageId),
    [6101, 6103, 6104],
  );
  assert.match(sentMessages[0].text, /解析成功/);
  assert.match(sentMessages[1].text, /解析成功/);
  assert.match(sentMessages[2].text, /已加入重试队列/);
});

test('telegram sync notifier explains deferred database writes for pending replay image batches', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notifier-fallback-'));
  const resultPath = path.join(tempRoot, 'result.json');
  const sentMessages = [];

  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'image',
          status: 'ready',
          batchId: 'single-125',
          archivedDate: '2026-05-30',
          messages: [{ chatId: 42, messageId: 125 }],
          persistenceStatus: 'pending_replay',
          persistenceError: 'database unavailable',
          sourceImageCount: 1,
          recognizedImageCount: 1,
          failedImageCount: 0,
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
      return { message_id: 9904 };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].replyToMessageId, 125);
  assert.match(sentMessages[0].text, /图片已识别/);
  assert.match(sentMessages[0].text, /数据库写入未完成/);
  assert.match(sentMessages[0].text, /等待数据库重放/);
  assert.doesNotMatch(sentMessages[0].text, /解析成功/);
});
