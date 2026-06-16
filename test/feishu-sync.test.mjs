import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildStableSafeInteger,
  groupFeishuUpdates,
  normalizeFeishuMessage,
} from '../src/adapters/feishu/index.mjs';
import { recognizeBatch } from '../tools/telegram-sync-image-processing.mjs';
import { notifyFeishuActionFailure } from '../tools/feishu-action-monitor.mjs';
import { buildFeishuSyncReport, notifyFeishuSyncResultFromFile, runFeishuSync } from '../tools/feishu-sync.mjs';

test('normalizeFeishuMessage keeps Feishu source ids while exposing Telegram-compatible fields', () => {
  const normalized = normalizeFeishuMessage(createFeishuImageEvent({
    eventId: 'evt-image-1',
    messageId: 'om_feishu_1',
    chatId: 'oc_chat_1',
    imageKey: 'img_v3_1',
    createTime: '1781398800000',
  }));

  assert.equal(normalized.sourceChannel, 'feishu');
  assert.equal(normalized.eventId, 'evt-image-1');
  assert.equal(normalized.sourceMessageId, 'om_feishu_1');
  assert.equal(normalized.chatId, 'oc_chat_1');
  assert.equal(normalized.imageKey, 'img_v3_1');
  assert.equal(typeof normalized.messageId, 'number');
  assert.ok(Number.isSafeInteger(normalized.messageId));
});

test('groupFeishuUpdates groups image bursts and preserves source metadata', () => {
  const batches = groupFeishuUpdates([
    createFeishuImageEvent({
      eventId: 'evt-image-1',
      messageId: 'om_feishu_1',
      chatId: 'oc_chat_1',
      imageKey: 'img_v3_1',
      createTime: '1781398800000',
    }),
    createFeishuImageEvent({
      eventId: 'evt-image-2',
      messageId: 'om_feishu_2',
      chatId: 'oc_chat_1',
      imageKey: 'img_v3_2',
      createTime: '1781398802000',
    }),
    createFeishuImageEvent({
      eventId: 'evt-image-3',
      messageId: 'om_feishu_3',
      chatId: 'oc_chat_1',
      imageKey: 'img_v3_3',
      createTime: '1781398810000',
    }),
  ], { imageWindowMs: 3_000 });

  assert.equal(batches.length, 2);
  assert.equal(batches[0].sourceChannel, 'feishu');
  assert.equal(batches[0].kind, 'image');
  assert.equal(batches[0].messages.length, 2);
  assert.deepEqual(
    batches[0].messages.map((message) => message.sourceMessageId),
    ['om_feishu_1', 'om_feishu_2'],
  );
  assert.deepEqual(
    batches[0].messages.map((message) => message.photos.at(-1)?.fileId),
    ['img_v3_1', 'img_v3_2'],
  );
  assert.equal(batches[1].messages[0].sourceMessageId, 'om_feishu_3');
});

test('groupFeishuUpdates reuses existing thought command parsing for Feishu text', () => {
  const [batch] = groupFeishuUpdates([
    createFeishuTextEvent({
      eventId: 'evt-thought-1',
      messageId: 'om_thought_1',
      chatId: 'oc_chat_1',
      text: '/随想 今天练腿后髋部有点紧',
      createTime: '1781398800000',
    }),
  ]);

  assert.equal(batch.sourceChannel, 'feishu');
  assert.equal(batch.kind, 'thought');
  assert.equal(batch.thought.body, '今天练腿后髋部有点紧');
  assert.equal(batch.messages[0].sourceMessageId, 'om_thought_1');
});

test('groupFeishuUpdates parses explicit Feishu thought edit module updates', () => {
  const [batch] = groupFeishuUpdates([
    createFeishuTextEvent({
      eventId: 'evt-thought-edit-1',
      messageId: 'om_thought_edit_1',
      chatId: 'oc_chat_1',
      text: '/随想编 272 杂七杂八 新正文',
      createTime: '1781398810000',
    }),
  ]);

  assert.equal(batch.sourceChannel, 'feishu');
  assert.equal(batch.kind, 'thought_edit');
  assert.equal(batch.thoughtEdit.sourceChannel, 'feishu');
  assert.equal(batch.thoughtEdit.targetMessageId, 272);
  assert.equal(batch.thoughtEdit.thoughtModule, 'misc');
  assert.equal(batch.thoughtEdit.body, '新正文');
});

test('groupFeishuUpdates rejects ambiguous /随想 id module body messages before creating a thought', () => {
  const [batch] = groupFeishuUpdates([
    createFeishuTextEvent({
      eventId: 'evt-thought-ambiguous-1',
      messageId: 'om_thought_ambiguous_1',
      chatId: 'oc_chat_1',
      text: '/随想 272 杂七杂八 新正文',
      createTime: '1781398810000',
    }),
  ]);

  assert.equal(batch.sourceChannel, 'feishu');
  assert.equal(batch.kind, 'thought');
  assert.equal(batch.thought.sourceChannel, 'feishu');
  assert.equal(batch.thought.invalidReason, '疑似编辑命令，请使用 /随想编 id 模块 内容');
});

test('groupFeishuUpdates maps Feishu reply metadata to reply-based thought delete targets', () => {
  const [batch] = groupFeishuUpdates([
    createFeishuTextEvent({
      eventId: 'evt-delete-1',
      messageId: 'om_delete_1',
      chatId: 'oc_chat_1',
      text: '/随想删',
      createTime: '1781398820000',
      parentId: 'om_thought_1',
    }),
  ]);
  const expectedTargetId = buildStableSafeInteger('feishu:message:om_thought_1');

  assert.equal(batch.sourceChannel, 'feishu');
  assert.equal(batch.kind, 'thought_delete');
  assert.equal(batch.thoughtDelete.targetMessageId, expectedTargetId);
  assert.equal(batch.thoughtDelete.replyToMessageId, expectedTargetId);
  assert.equal(batch.messages[0].replyToMessageId, expectedTargetId);
});

test('recognizeBatch can send Feishu image bytes as inline AI input', async () => {
  const requestedImageUrls = [];
  const downloaded = [];

  const result = await recognizeBatch(
    {
      batchId: 'feishu-oc_chat_1-1781398800000',
      sourceChannel: 'feishu',
      messages: [
        {
          messageId: 101,
          sourceMessageId: 'om_feishu_1',
          updateId: 201,
          mediaGroupId: 'feishu-oc_chat_1-1781398800000',
          caption: '',
          text: '',
          chatId: 'oc_chat_1',
          dateUnix: 1781398800,
          sourceChannel: 'feishu',
          photos: [{ fileId: 'img_v3_1', fileUniqueId: 'img_v3_1', source: 'feishu_image' }],
        },
      ],
    },
    {
      botToken: 'unused',
      aiConcurrency: 1,
    },
    {
      sourceChannel: 'feishu',
      rawEnv: {
        FEISHU_RECOGNITION_IMAGE_INPUT_MODE: 'inline',
      },
      fetchImageFileById: async (imageKey, context) => {
        downloaded.push({
          imageKey,
          sourceMessageId: context.message.sourceMessageId,
        });
        return {
          filePath: 'feishu/img_v3_1.jpg',
          contentType: 'image/jpeg',
          data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        };
      },
      aiProvider: createRecognitionProvider(requestedImageUrls),
    },
  );

  assert.deepEqual(downloaded, [{ imageKey: 'img_v3_1', sourceMessageId: 'om_feishu_1' }]);
  assert.match(requestedImageUrls[0], /^data:image\/jpeg;base64,/);
  assert.equal(result.recognitions.length, 1);
  assert.equal(result.recognitions[0].sourceMessageId, 'om_feishu_1');
  assert.equal(result.recognitionErrors.length, 0);
});

test('runFeishuSync handles image and thought batches through the shared sync pipeline', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-runner-'));
  const persisted = [];
  const sent = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: feishuSyncEnv(),
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuImageEvent({
            eventId: 'evt-image-1',
            messageId: 'om_feishu_1',
            chatId: 'oc_chat_1',
            imageKey: 'img_v3_1',
            createTime: '1781398800000',
          }),
          createFeishuTextEvent({
            eventId: 'evt-thought-1',
            messageId: 'om_thought_1',
            chatId: 'oc_chat_1',
            text: '/随想 今天练腿后髋部有点紧',
            createTime: '1781398810000',
          }),
        ],
      },
    },
    recognizeBatch: async (batch) => ({
      recognitions: batch.messages.map((message) => ({
        messageId: message.messageId,
        sourceMessageId: message.sourceMessageId,
        imageType: 'nutrition',
        detectedDate: '2026-05-31',
        dateEvidence: 'image header',
        confidence: 0.98,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 868, recommendedMin: 310, recommendedMax: 723 }],
          totalCalories: 868,
          details: ['晚餐 868 千卡'],
          dailyWorkoutSummary: null,
        },
      })),
      recognitionErrors: [],
    }),
    persistNormalizedBatch: async ({ batch, sourceChannel }) => {
      persisted.push({ batch, sourceChannel });
      return { status: 'stored', archivedDate: batch.archivedDate ?? null };
    },
    sendFeishuMessage: async (input) => {
      sent.push(input);
      return { ok: true };
    },
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 2);
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted.map((entry) => entry.sourceChannel), ['feishu', 'feishu']);
  assert.deepEqual(persisted.map((entry) => entry.batch.kind), ['image', 'thought']);
  assert.equal(result.batchResults[0].sourceChannel, 'feishu');
  assert.equal(result.batchResults[1].sourceChannel, 'feishu');

  const thoughtBatch = result.batchResults.find((batch) => batch.kind === 'thought');
  assert.equal(thoughtBatch.thought.sourceChannel, 'feishu');
  assert.equal(thoughtBatch.thought.telegramMessageId, thoughtBatch.messages[0].messageId);
  assert.equal(thoughtBatch.messages[0].sourceMessageId, 'om_thought_1');
  assert.deepEqual(thoughtBatch.thought.tags, ['训练', '随想', '飞书']);
  assert.equal(thoughtBatch.thoughtWriteStatus, 'no_images');
  assert.equal(sent.length, 0);

  const report = buildFeishuSyncReport(result);
  assert.deepEqual(report.batches.map((batch) => batch.chatIds), [['oc_chat_1'], ['oc_chat_1']]);
  assert.match(report.batches[0].sourceId, /^feishu:chat:oc_chat_1:/);
});

test('runFeishuSync persists explicit Feishu thought edit module updates through the shared pipeline', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-runner-edit-'));
  const persisted = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: feishuSyncEnv(),
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-edit-1',
            messageId: 'om_edit_1',
            chatId: 'oc_chat_1',
            text: '/随想编 272 杂七杂八 新正文',
            createTime: '1781398820000',
          }),
        ],
      },
    },
    persistNormalizedBatch: async ({ batch, sourceChannel }) => {
      persisted.push({ batch, sourceChannel });
      return { status: 'stored', archivedDate: batch.archivedDate ?? null };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 1);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].status, 'ready');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_edit_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].sourceChannel, 'feishu');
  assert.equal(persisted[0].batch.kind, 'thought_edit');
  assert.equal(persisted[0].batch.thoughtEdit.sourceChannel, 'feishu');
  assert.equal(persisted[0].batch.thoughtEdit.targetMessageId, 272);
  assert.equal(persisted[0].batch.thoughtEdit.thoughtModule, 'misc');
  assert.equal(persisted[0].batch.thoughtEdit.body, '新正文');
  assert.deepEqual(persisted[0].batch.thoughtEdit.tags, ['杂七杂八', '随想', '飞书']);
});

test('runFeishuSync skips ambiguous /随想 id module body messages without persistence', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-runner-ambiguous-'));
  const persisted = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: feishuSyncEnv(),
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-ambiguous-1',
            messageId: 'om_ambiguous_1',
            chatId: 'oc_chat_1',
            text: '/随想 272 杂七杂八 新正文',
            createTime: '1781398820000',
          }),
        ],
      },
    },
    persistNormalizedBatch: async ({ batch, sourceChannel }) => {
      persisted.push({ batch, sourceChannel });
      return { status: 'stored', archivedDate: batch.archivedDate ?? null };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 1);
  assert.equal(persisted.length, 0);
  assert.equal(result.changed, false);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[0].persistenceStatus ?? null, null);
  assert.match(result.batchResults[0].reason, /疑似编辑命令/);
  assert.doesNotMatch(result.batchResults[0].reason, /写入成功/);
});

test('Feishu sync notifier reports skipped ambiguous thoughts as failures', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-notify-ambiguous-'));
  const resultPath = path.join(tempRoot, 'result.json');
  const sent = [];

  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'thought',
          status: 'skipped',
          batchId: 'thought-ambiguous-1',
          messages: [{ chatId: 'oc_chat_1', messageId: 272 }],
          reason: '疑似编辑命令，请使用 /随想编 id 模块 内容',
          failureCategory: 'user_input',
          failureReason: '疑似编辑命令，请使用 /随想编 id 模块 内容',
        },
      ],
    }),
    'utf8',
  );

  const result = await notifyFeishuSyncResultFromFile({
    resultPath,
    env: {
      FEISHU_SYNC_NOTIFY: 'true',
      FEISHU_SYNC_TRANSPORT: 'webhook',
      FEISHU_APP_ID: 'cli_a',
      FEISHU_APP_SECRET: 'secret',
      FEISHU_ALLOWED_CHAT_IDS: 'oc_chat_1',
    },
    sendMessage: async (message) => {
      sent.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'oc_chat_1');
  assert.match(sent[0].text, /随想写入失败/);
  assert.match(sent[0].text, /\/随想编 id 模块 内容/);
  assert.doesNotMatch(sent[0].text, /成功/);
  assert.doesNotMatch(sent[0].text, /已入库/);
});

test('runFeishuSync handles reply-based Feishu thought delete batches through the shared pipeline', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-runner-delete-'));
  const persisted = [];
  const targetMessageId = buildStableSafeInteger('feishu:message:om_thought_1');

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: feishuSyncEnv(),
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-delete-1',
            messageId: 'om_delete_1',
            chatId: 'oc_chat_1',
            text: '/随想删',
            createTime: '1781398820000',
            parentId: 'om_thought_1',
          }),
        ],
      },
    },
    persistNormalizedBatch: async ({ batch, sourceChannel }) => {
      persisted.push({ batch, sourceChannel });
      return { status: 'stored', archivedDate: batch.archivedDate ?? null };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 1);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_delete');
  assert.equal(result.batchResults[0].status, 'ready');
  assert.equal(result.batchResults[0].thoughtDelete.targetMessageId, targetMessageId);
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_delete_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].sourceChannel, 'feishu');
  assert.equal(persisted[0].batch.kind, 'thought_delete');
  assert.equal(persisted[0].batch.thoughtDelete.targetMessageId, targetMessageId);
});

test('feishu action monitor reports failed workflow stages to the original Feishu chat', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-action-monitor-'));
  const eventPath = path.join(tempRoot, 'event.json');
  const sentMessages = [];

  await writeFile(
    eventPath,
    JSON.stringify({
      client_payload: {
        feishu_updates: [
          createFeishuImageEvent({
            eventId: 'evt-action-fail-1',
            messageId: 'om_action_fail_1',
            chatId: 'oc_chat_1',
            imageKey: 'img_action_fail_1',
            createTime: '1781398800000',
          }),
          createFeishuImageEvent({
            eventId: 'evt-action-fail-2',
            messageId: 'om_action_fail_2',
            chatId: 'oc_chat_1',
            imageKey: 'img_action_fail_2',
            createTime: '1781398802000',
          }),
        ],
      },
    }),
    'utf8',
  );

  const result = await notifyFeishuActionFailure({
    env: {
      GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_RUN_ID: '123456',
      STEP_SYNC_OUTCOME: 'failure',
    },
    sendFeishuMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureCategory, 'github_action');
  assert.equal(result.failureStage, 'Sync Feishu updates');
  assert.deepEqual(sentMessages.map((message) => message.chatId), ['oc_chat_1']);
  assert.match(sentMessages[0].text, /GitHub Action 执行失败：Sync Feishu updates/);
  assert.match(sentMessages[0].text, /https:\/\/github\.com\/soulgo\/training_records\/actions\/runs\/123456/);
});

function createRecognitionProvider(requestedImageUrls) {
  return {
    env: { model: 'gpt-vision-fast' },
    async requestChatCompletion(input) {
      const imagePart = input.messages?.[1]?.content?.find((part) => part.type === 'image_url');
      requestedImageUrls.push(imagePart?.image_url?.url ?? '');
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    imageType: 'nutrition',
                    detectedDate: '2026-05-31',
                    dateEvidence: 'image header',
                    confidence: 0.98,
                    warnings: [],
                    records: {
                      measurement: null,
                      activities: [],
                      meals: [{ name: '晚餐', calories: 868, recommendedMin: 310, recommendedMax: 723 }],
                      totalCalories: 868,
                      details: ['晚餐 868 千卡'],
                      dailyWorkoutSummary: null,
                    },
                  }),
                },
              },
            ],
          };
        },
      };
    },
  };
}

function createFeishuImageEvent({ eventId, messageId, chatId, imageKey, createTime }) {
  return createFeishuEvent({
    eventId,
    messageId,
    chatId,
    messageType: 'image',
    content: { image_key: imageKey },
    createTime,
  });
}

function createFeishuTextEvent({ eventId, messageId, chatId, text, createTime, parentId, rootId }) {
  return createFeishuEvent({
    eventId,
    messageId,
    chatId,
    messageType: 'text',
    content: { text },
    createTime,
    parentId,
    rootId,
  });
}

function createFeishuEvent({ eventId, messageId, chatId, messageType, content, createTime, parentId, rootId }) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'im.message.receive_v1',
      create_time: createTime,
      token: 'verification-token',
      app_id: 'cli_a',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_sender_1' },
        sender_type: 'user',
      },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: 'group',
        message_type: messageType,
        content: JSON.stringify(content),
        create_time: createTime,
        ...(parentId ? { parent_id: parentId } : {}),
        ...(rootId ? { root_id: rootId } : {}),
      },
    },
  };
}

function feishuSyncEnv() {
  return {
    FEISHU_APP_ID: 'cli_a',
    FEISHU_APP_SECRET: 'secret',
    FEISHU_ALLOWED_CHAT_IDS: 'oc_chat_1',
    FEISHU_SYNC_TRANSPORT: 'webhook',
    FEISHU_SYNC_NOTIFY_STAGE: 'after_action',
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
    AI_CONCURRENCY: '1',
    TRAINING_DB_ENABLED: 'true',
    TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
  };
}
