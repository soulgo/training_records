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

test('groupFeishuUpdates parses explicit Feishu thought edits moving to body feedback', () => {
  const [batch] = groupFeishuUpdates([
    createFeishuTextEvent({
      eventId: 'evt-thought-edit-body-feedback-1',
      messageId: 'om_thought_edit_body_feedback_1',
      chatId: 'oc_chat_1',
      text: '/随想编 1442054985160403 身体反馈 正式 2026 年 6 月 16 日 12:33:38',
      createTime: '1781398810000',
    }),
  ]);

  assert.equal(batch.sourceChannel, 'feishu');
  assert.equal(batch.kind, 'thought_edit');
  assert.equal(batch.thoughtEdit.targetMessageId, 1442054985160403);
  assert.equal(batch.thoughtEdit.thoughtModule, 'body_feedback');
  assert.equal(batch.thoughtEdit.body, '正式 2026 年 6 月 16 日 12:33:38');
});

test('groupFeishuUpdates accepts /随便编 as a typo alias for explicit thought edits', () => {
  const [batch] = groupFeishuUpdates([
    createFeishuTextEvent({
      eventId: 'evt-thought-edit-typo-1',
      messageId: 'om_thought_edit_typo_1',
      chatId: 'oc_chat_1',
      text: '/随便编 338182848231024 杂七杂八 正式环境编辑移动2026-06-16 09:38:35',
      createTime: '1781398810000',
    }),
  ]);

  assert.equal(batch.sourceChannel, 'feishu');
  assert.equal(batch.kind, 'thought_edit');
  assert.equal(batch.thoughtEdit.command, '/随便编');
  assert.equal(batch.thoughtEdit.targetMessageId, 338182848231024);
  assert.equal(batch.thoughtEdit.thoughtModule, 'misc');
  assert.equal(batch.thoughtEdit.body, '正式环境编辑移动2026-06-16 09:38:35');
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
  assert.equal(result.syncStages.image_download.status, 'succeeded');
  assert.equal(result.syncStages.cache_read.status, 'skipped');
  assert.equal(result.syncStages.ai_schema.status, 'succeeded');
  assert.equal(Number.isFinite(result.syncStages.image_download.durationMs), true);
  assert.equal(Number.isFinite(result.syncStages.ai_schema.durationMs), true);
});

test('recognizeBatch writes started AI call log before Feishu provider call', async () => {
  const events = [];

  await recognizeBatch(
    {
      batchId: 'feishu-started-ai-call-log',
      sourceChannel: 'feishu',
      messages: [
        {
          messageId: 104,
          sourceMessageId: 'om_feishu_started_ai_log',
          updateId: 204,
          mediaGroupId: 'feishu-started-ai-call-log',
          caption: '',
          text: '',
          chatId: 'oc_chat_1',
          dateUnix: 1781398800,
          sourceChannel: 'feishu',
          sourceChatId: 'oc_chat_1',
          photos: [{ fileId: 'img_started_ai_log', fileUniqueId: 'img_started_ai_log', source: 'feishu_image' }],
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
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      fetchImageFileById: async () => ({
        filePath: 'feishu/img_started_ai_log.jpg',
        contentType: 'image/jpeg',
        data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      }),
      writeStartedRecognitionAiCallLog: async (event) => {
        events.push({ type: 'audit', event });
        return { status: 'written' };
      },
      aiProvider: {
        name: 'openai-compatible',
        env: { model: 'gpt-vision-fast' },
        async requestChatCompletion() {
          events.push({ type: 'provider_call' });
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
      },
    },
  );

  assert.equal(events[0].type, 'audit');
  assert.equal(events[0].event.taskId, 'feishu-started-ai-call-log');
  assert.equal(events[0].event.sourceChannel, 'feishu');
  assert.equal(events[0].event.sourceChatId, 'oc_chat_1');
  assert.equal(events[0].event.sourceMessageId, 'om_feishu_started_ai_log');
  assert.equal(events[0].event.status, 'started');
  assert.equal(events[1].type, 'provider_call');
});

test('recognizeBatch records cache read failures separately from Feishu AI schema success', async () => {
  const requestedImageUrls = [];
  const result = await recognizeBatch(
    {
      batchId: 'feishu-oc_chat_1-cache-read-failed',
      sourceChannel: 'feishu',
      messages: [
        {
          messageId: 103,
          sourceMessageId: 'om_feishu_cache_read_failed',
          updateId: 203,
          mediaGroupId: 'feishu-oc_chat_1-cache-read-failed',
          caption: '',
          text: '',
          chatId: 'oc_chat_1',
          dateUnix: 1781398800,
          sourceChannel: 'feishu',
          photos: [{ fileId: 'img_cache_read_failed', fileUniqueId: 'img_cache_read_failed', source: 'feishu_image' }],
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
        TELEGRAM_RECOGNITION_CACHE_ENABLED: 'true',
      },
      fetchImageFileById: async () => ({
        filePath: 'feishu/img_cache_read_failed.jpg',
        contentType: 'image/jpeg',
        data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      }),
      aiProvider: createRecognitionProvider(requestedImageUrls),
      readRecognitionCache: async () => {
        throw new Error('cache database timeout');
      },
    },
  );

  assert.equal(result.recognitions.length, 1);
  assert.equal(requestedImageUrls.length, 1);
  assert.equal(result.syncStages.cache_read.status, 'failed');
  assert.equal(result.syncStages.cache_read.failureCategory, 'database');
  assert.match(result.syncStages.cache_read.failureReason, /cache database timeout/);
  assert.equal(result.syncStages.ai_schema.status, 'succeeded');
});

test('recognizeBatch keeps empty inline image data distinct from unsupported content type', async () => {
  const baseBatch = {
    batchId: 'feishu-oc_chat_1-1781398800000',
    sourceChannel: 'feishu',
    messages: [
      {
        messageId: 101,
        sourceMessageId: 'om_feishu_empty',
        updateId: 201,
        mediaGroupId: 'feishu-oc_chat_1-1781398800000',
        caption: '',
        text: '',
        chatId: 'oc_chat_1',
        dateUnix: 1781398800,
        sourceChannel: 'feishu',
        photos: [{ fileId: 'img_empty', fileUniqueId: 'img_empty', source: 'feishu_image' }],
      },
      {
        messageId: 102,
        sourceMessageId: 'om_feishu_text',
        updateId: 202,
        mediaGroupId: 'feishu-oc_chat_1-1781398800000',
        caption: '',
        text: '',
        chatId: 'oc_chat_1',
        dateUnix: 1781398801,
        sourceChannel: 'feishu',
        photos: [{ fileId: 'img_text', fileUniqueId: 'img_text', source: 'feishu_image' }],
      },
    ],
  };

  const result = await recognizeBatch(
    baseBatch,
    {
      botToken: 'unused',
      aiConcurrency: 1,
    },
    {
      sourceChannel: 'feishu',
      rawEnv: {
        FEISHU_RECOGNITION_IMAGE_INPUT_MODE: 'inline',
      },
      fetchImageFileById: async (imageKey) => {
        if (imageKey === 'img_empty') {
          return {
            filePath: 'feishu/empty.jpg',
            contentType: 'image/jpeg',
            data: new Uint8Array(),
          };
        }
        return {
          filePath: 'feishu/not-image.txt',
          contentType: 'text/plain',
          data: new Uint8Array([1, 2, 3]),
        };
      },
      aiProvider: {
        env: { model: 'gpt-vision-fast' },
        async requestChatCompletion() {
          throw new Error('AI should not be called when inline image input is invalid');
        },
      },
    },
  );

  assert.equal(result.recognitions.length, 0);
  assert.equal(result.recognitionErrors.length, 2);
  assert.deepEqual(
    result.recognitionErrors.map((error) => error.summary.reason),
    ['empty_data', 'unsupported_type'],
  );
  assert.deepEqual(
    result.recognitionErrors.map((error) => error.failureCategory),
    ['user_input', 'user_input'],
  );
  assert.match(result.recognitionErrors[0].error, /empty/i);
  assert.match(result.recognitionErrors[1].error, /unsupported content-type/i);
});

test('buildFeishuSyncReport keeps Feishu image download failure reasons distinct', () => {
  const report = buildFeishuSyncReport({
    batchResults: [
      {
        kind: 'image',
        sourceChannel: 'feishu',
        batchId: 'feishu-image-failures',
        status: 'skipped',
        messages: [
          { messageId: 101, sourceMessageId: 'om_forbidden', chatId: 'oc_chat_1' },
          { messageId: 102, sourceMessageId: 'om_missing', chatId: 'oc_chat_1' },
          { messageId: 103, sourceMessageId: 'om_empty', chatId: 'oc_chat_1' },
          { messageId: 104, sourceMessageId: 'om_text', chatId: 'oc_chat_1' },
        ],
        failureCategory: 'image_download',
        failureReason:
          'Feishu image download failed with HTTP 403; Feishu image download failed with HTTP 404; inline image input is empty; inline image input has unsupported content-type: text/plain',
        recognitionErrors: [
          {
            messageId: 101,
            failureCategory: 'image_download',
            error: 'Feishu image download failed with HTTP 403 (feishu message=om_forbidden image=img_forbidden)',
            summary: {
              phase: 'inline_image_input',
              reason: 'image_download',
              fileId: 'img_forbidden',
              sourceChannel: 'feishu',
              sourceMessageId: 'om_forbidden',
            },
          },
          {
            messageId: 102,
            failureCategory: 'image_download',
            error: 'Feishu image download failed with HTTP 404 (feishu message=om_missing image=img_missing)',
            summary: {
              phase: 'inline_image_input',
              reason: 'image_download',
              fileId: 'img_missing',
              sourceChannel: 'feishu',
              sourceMessageId: 'om_missing',
            },
          },
          {
            messageId: 103,
            failureCategory: 'user_input',
            error: 'inline image input is empty (feishu message=om_empty image=img_empty)',
            summary: {
              phase: 'inline_image_input',
              reason: 'empty_data',
              fileId: 'img_empty',
              sourceChannel: 'feishu',
              sourceMessageId: 'om_empty',
            },
          },
          {
            messageId: 104,
            failureCategory: 'user_input',
            error: 'inline image input has unsupported content-type: text/plain (feishu message=om_text image=img_text)',
            summary: {
              phase: 'inline_image_input',
              reason: 'unsupported_type',
              fileId: 'img_text',
              sourceChannel: 'feishu',
              sourceMessageId: 'om_text',
            },
          },
        ],
        syncStages: {
          image_download: {
            status: 'failed',
            failureCategory: 'image_download',
            failureReason: 'Feishu image download failed with HTTP 403',
          },
        },
      },
    ],
  });

  assert.deepEqual(
    report.batches[0].recognitionErrors.map((error) => error.summary.reason),
    ['feishu_api', 'feishu_api', 'empty_data', 'unsupported_type'],
  );
  assert.deepEqual(
    report.batches[0].recognitionErrors.map((error) => error.failureCategory),
    ['image_download', 'image_download', 'user_input', 'user_input'],
  );
});

test('runFeishuSync keeps inline image download failures visible in the summary', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-inline-download-failure-'));

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: feishuSyncEnv(),
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuImageEvent({
            eventId: 'evt-image-download-fail-1',
            messageId: 'om_image_download_fail_1',
            chatId: 'oc_chat_1',
            imageKey: 'img_download_fail_1',
            createTime: '1781398800000',
          }),
        ],
      },
    },
    fetch: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/tenant_access_token/internal')) {
        return Response.json({
          code: 0,
          tenant_access_token: 'tenant-token',
          expire: 7200,
        });
      }
      if (requestUrl.includes('/resources/img_download_fail_1')) {
        return new Response('forbidden', { status: 403 });
      }
      throw new Error(`Unexpected fetch call: ${requestUrl}`);
    },
    persistNormalizedBatch: async () => {
      throw new Error('should not persist when inline image download fails');
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  const report = buildFeishuSyncReport(result);
  const [batch] = report.batches;
  assert.equal(batch.failureCategory, 'image_download');
  assert.equal(batch.failureDisposition, 'auto_retry');
  assert.equal(batch.recognitionErrors[0].failureCategory, 'image_download');
  assert.deepEqual(batch.syncStages.image_download.status, 'failed');
  assert.equal(batch.syncStages.image_download.failureCategory, 'image_download');
  assert.match(batch.syncStages.image_download.failureReason, /Feishu image download failed with HTTP 403/);
  assert.equal(Number.isFinite(batch.syncStages.image_download.durationMs), true);
  assert.equal(batch.syncStages.cache_read.status, 'skipped');
  assert.equal(batch.syncStages.ai_schema.status, 'skipped');
  assert.equal(batch.syncStages.db_persist.status, 'skipped');
  assert.match(batch.recognitionErrors[0].error, /Feishu image download failed with HTTP 403/);
  assert.match(batch.recognitionErrors[0].error, /img_download_fail_1/);
  assert.doesNotMatch(batch.recognitionErrors[0].error, /tenant-token|secret|open-apis\/im\/v1/);
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
  assert.equal(result.batchResults[0].syncStages.ai_schema.status, 'succeeded');
  assert.equal(result.batchResults[0].syncStages.db_persist.status, 'succeeded');
  assert.equal(Number.isFinite(result.batchResults[0].syncStages.ai_schema.durationMs), true);
  assert.equal(Number.isFinite(result.batchResults[0].syncStages.db_persist.durationMs), true);

  const thoughtBatch = result.batchResults.find((batch) => batch.kind === 'thought');
  assert.equal(thoughtBatch.thought.sourceChannel, 'feishu');
  assert.equal(thoughtBatch.thought.telegramMessageId, thoughtBatch.messages[0].messageId);
  assert.equal(thoughtBatch.messages[0].sourceMessageId, 'om_thought_1');
  assert.deepEqual(thoughtBatch.thought.tags, ['训练', '随想', '飞书']);
  assert.equal(thoughtBatch.thoughtWriteStatus, 'thought_database_only');
  assert.equal(thoughtBatch.persistenceStatus, 'stored');
  assert.equal(thoughtBatch.persistedThoughtMessageId, thoughtBatch.thought.telegramMessageId);
  assert.equal(sent.length, 0);

  const report = buildFeishuSyncReport(result);
  assert.deepEqual(report.batches.map((batch) => batch.chatIds), [['oc_chat_1'], ['oc_chat_1']]);
  assert.match(report.batches[0].sourceId, /^feishu:chat:oc_chat_1:/);
  assert.match(report.batchResults[0].sourceId, /^feishu:chat:oc_chat_1:/);
  assert.deepEqual(Object.keys(result.tasks[0]).sort(), [
    'archivedDate',
    'batchId',
    'channel',
    'chatIds',
    'failureCategory',
    'failureReason',
    'kind',
    'persistenceStatus',
    'sourceMessageIds',
    'taskId',
    'taskStatus',
  ].sort());
  assert.equal(result.tasks[0].channel, 'feishu');
  assert.equal(result.tasks[0].kind, 'image');
  assert.deepEqual(result.tasks[0].chatIds, ['oc_chat_1']);
  assert.deepEqual(result.tasks[0].sourceMessageIds, ['om_feishu_1']);
  assert.match(result.tasks[0].taskId, /^feishu:image:/);
  assert.equal(result.tasks[1].channel, 'feishu');
  assert.equal(result.tasks[1].kind, 'thought');
  assert.deepEqual(result.tasks[1].chatIds, ['oc_chat_1']);
  assert.deepEqual(result.tasks[1].sourceMessageIds, ['om_thought_1']);
  assert.equal(report.tasks[0].channel, 'feishu');
  assert.match(report.tasks[0].taskId, /^feishu:image:/);
  assert.deepEqual(report.tasks[0].chatIds, ['oc_chat_1']);
  assert.deepEqual(report.tasks[0].sourceMessageIds, ['om_feishu_1']);
});

test('buildFeishuSyncReport preserves image archive date confidence for summary gates', () => {
  const report = buildFeishuSyncReport({
    changed: true,
    fallbackUsed: false,
    updatesFetched: 1,
    lastProcessedUpdateId: null,
    readyBatches: 1,
    batchResults: [
      {
        kind: 'image',
        sourceChannel: 'feishu',
        batchId: 'feishu-date-confidence',
        status: 'ready',
        archivedDate: '2026-06-17',
        dateConfidence: 'uncertain',
        dateSources: [
          { messageId: 'om_1', detectedDate: '2026-06-17', source: 'image' },
          { messageId: 'om_2', detectedDate: '2026-06-17', source: 'sleep_bedtime' },
          { messageId: 'om_3', detectedDate: null, source: 'no_date' },
        ],
        warnings: ['detectedDate补全年份不确定，需程序确认'],
        messages: [
          { messageId: 101, sourceMessageId: 'om_1', chatId: 'oc_chat_1' },
        ],
      },
    ],
  });

  assert.equal(report.batches[0].dateConfidence, 'uncertain');
  assert.deepEqual(report.batches[0].dateSources.map((item) => item.source), ['image', 'sleep_bedtime', 'no_date']);
  assert.match(report.batches[0].taskId, /^feishu:image:/);
});

test('runFeishuSync preserves the recommended Feishu AI_CONCURRENCY limit', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-ai-concurrency-'));
  const observedConcurrency = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: {
      ...feishuSyncEnv(),
      AI_CONCURRENCY: '2',
    },
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuImageEvent({
            eventId: 'evt-concurrency-1',
            messageId: 'om_concurrency_1',
            chatId: 'oc_chat_1',
            imageKey: 'img_concurrency_1',
            createTime: '1781398800000',
          }),
        ],
      },
    },
    recognizeBatch: async (batch, env) => {
      observedConcurrency.push(env.aiConcurrency);
      return {
        recognitions: batch.messages.map((message) => ({
          messageId: message.messageId,
          sourceMessageId: message.sourceMessageId,
          imageType: 'workout',
          detectedDate: '2026-05-31',
          dateEvidence: 'image header: 2026-05-31',
          confidence: 0.98,
          warnings: [],
          records: {
            measurement: null,
            activities: [{ time: '19:13', type: '力量训练', detail: '总消耗 241 千卡' }],
            meals: [],
            totalCalories: null,
            details: [],
            dailyWorkoutSummary: null,
          },
        })),
        recognitionErrors: [],
      };
    },
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.deepEqual(observedConcurrency, [2]);
});

test('runFeishuSync queues Feishu thought database failures for pending replay', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-thought-pending-'));
  const queued = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: feishuSyncEnv(),
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-thought-pending-1',
            messageId: 'om_thought_pending_1',
            chatId: 'oc_chat_1',
            text: '/随想 今天练腿后髋部有点紧',
            createTime: '1781398800000',
          }),
        ],
      },
    },
    persistNormalizedBatch: async () => {
      throw new Error('database unavailable');
    },
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].persistenceStatus, 'pending_replay');
  assert.equal(result.batchResults[0].failureCategory, 'database');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].batch.kind, 'thought');
  assert.equal(queued[0].batch.sourceChannel, 'feishu');
  assert.equal(queued[0].batch.messages[0].sourceMessageId, 'om_thought_pending_1');
  assert.equal(queued[0].failureCategory, 'database');
  assert.match(queued[0].error, /database unavailable/);
});

test('runFeishuSync records Feishu image DB persist failures as a separate stage', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-image-persist-stage-'));
  const queued = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: feishuSyncEnv(),
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuImageEvent({
            eventId: 'evt-image-db-pending-1',
            messageId: 'om_image_db_pending_1',
            chatId: 'oc_chat_1',
            imageKey: 'img_db_pending_1',
            createTime: '1781398800000',
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
    persistNormalizedBatch: async () => {
      throw new Error('database unavailable');
    },
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  const report = buildFeishuSyncReport(result);
  const [batch] = report.batches;
  assert.equal(batch.kind, 'image');
  assert.equal(batch.persistenceStatus, 'pending_replay');
  assert.equal(batch.syncStages.ai_schema.status, 'succeeded');
  assert.equal(batch.syncStages.db_persist.status, 'failed');
  assert.equal(batch.syncStages.db_persist.failureCategory, 'database');
  assert.match(batch.syncStages.db_persist.failureReason, /database unavailable/);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].failureCategory, 'database');
});

test('runFeishuSync treats DB-rejected invalid image archive dates as manual intervention without pending replay', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-invalid-archive-date-'));
  const queued = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: feishuSyncEnv(),
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuImageEvent({
            eventId: 'evt-image-invalid-date-1',
            messageId: 'om_image_invalid_date_1',
            chatId: 'oc_chat_1',
            imageKey: 'img_invalid_date_1',
            createTime: '1781398800000',
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
    persistNormalizedBatch: async () => {
      throw new Error('invalid archivedDate: 2023-02-30');
    },
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  const report = buildFeishuSyncReport(result);
  const [batch] = report.batches;
  assert.equal(batch.persistenceStatus, 'manual_intervention');
  assert.equal(batch.failureCategory, 'user_input');
  assert.equal(batch.failureDisposition, 'manual_intervention');
  assert.equal(batch.syncStages.db_persist.failureCategory, 'user_input');
  assert.equal(queued.length, 0);
});

test('runFeishuSync exposes failed recognition AI call log status for Feishu images', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-image-ai-log-failure-'));
  const queued = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: feishuSyncEnv(),
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuImageEvent({
            eventId: 'evt-image-ai-failed-log-1',
            messageId: 'om_image_ai_failed_log_1',
            chatId: 'oc_chat_1',
            imageKey: 'img_ai_failed_log_1',
            createTime: '1781398800000',
          }),
        ],
      },
    },
    recognizeBatch: async () => ({
      recognitions: [],
      recognitionErrors: [
        {
          messageId: '2811537526481927',
          sourceMessageId: 'om_image_ai_failed_log_1',
          error: 'AI recognition failed with HTTP 502',
          failureCategory: 'ai_service',
          provider: 'openai-compatible',
          model: 'gpt-primary',
        },
      ],
    }),
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId, aiCallLogStatus: 'written' };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  const report = buildFeishuSyncReport(result);
  const [batch] = report.batches;

  assert.equal(batch.kind, 'image');
  assert.equal(batch.taskStatus, 'deferred');
  assert.equal(batch.failureCategory, 'ai_service');
  assert.equal(batch.recognitionPendingStatus, 'queued');
  assert.equal(batch.aiCallLogStatus, 'written');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].batch.sourceChannel, 'feishu');
  assert.equal(queued[0].batch.recognitionErrors[0].model, 'gpt-primary');
});

test('runFeishuSync consumes queued workflow dispatch payloads in webhook mode', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-workflow-dispatch-'));
  const dispatchPath = path.join(tempRoot, 'queued-dispatch-event.json');
  const persisted = [];
  await writeFile(
    dispatchPath,
    JSON.stringify({
      action: 'feishu_update_dev',
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-workflow-edit-1',
            messageId: 'om_workflow_edit_1',
            chatId: 'oc_chat_1',
            text: '/随想编 272 杂七杂八 workflow dispatch 正文',
            createTime: '1781398820000',
          }),
        ],
      },
    }),
    'utf8',
  );

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: {
      ...feishuSyncEnv(),
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: dispatchPath,
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
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].sourceChannel, 'feishu');
});

test('runFeishuSync consumes queued dispatch payloads when event name is unavailable', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-queued-dispatch-path-'));
  const dispatchPath = path.join(tempRoot, 'queued-dispatch-event.json');
  const persisted = [];
  await writeFile(
    dispatchPath,
    JSON.stringify({
      action: 'feishu_update_dev',
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-queued-edit-1',
            messageId: 'om_queued_edit_1',
            chatId: 'oc_chat_1',
            text: '/随想编 273 身体反馈 event path fallback',
            createTime: '1781398820000',
          }),
        ],
      },
    }),
    'utf8',
  );

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: {
      ...feishuSyncEnv(),
      GITHUB_EVENT_NAME: '',
      GITHUB_EVENT_PATH: dispatchPath,
    },
    persistNormalizedBatch: async ({ batch, sourceChannel }) => {
      persisted.push({ batch, sourceChannel });
      return { status: 'stored', archivedDate: batch.archivedDate ?? null };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persisted.length, 1);
});

test('runFeishuSync consumes inline queued dispatch payloads without event path', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-inline-dispatch-'));
  const persisted = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: {
      ...feishuSyncEnv(),
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: '',
      SYNC_DISPATCH_PAYLOAD: JSON.stringify({
        action: 'feishu_update_dev',
        client_payload: {
          feishu_updates: [
            createFeishuTextEvent({
              eventId: 'evt-inline-edit-1',
              messageId: 'om_inline_edit_1',
              chatId: 'oc_chat_1',
              text: '/随想编 274 杂七杂八 inline dispatch fallback',
              createTime: '1781398820000',
            }),
          ],
        },
      }),
    },
    persistNormalizedBatch: async ({ batch, sourceChannel }) => {
      persisted.push({ batch, sourceChannel });
      return { status: 'stored', archivedDate: batch.archivedDate ?? null };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persisted.length, 1);
});

test('runFeishuSync does not require Telegram placeholder env for Feishu payloads', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-no-telegram-env-'));
  const env = feishuSyncEnv();
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_ALLOWED_CHAT_IDS;
  delete env.TELEGRAM_SYNC_TRANSPORT;
  const persisted = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env,
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-no-telegram-env-1',
            messageId: 'om_no_telegram_env_1',
            chatId: 'oc_chat_1',
            text: '/随想 今天飞书同步不需要 Telegram 占位配置',
            createTime: '1781398820000',
          }),
        ],
      },
    },
    persistNormalizedBatch: async ({ batch, sourceChannel }) => {
      persisted.push({ batch, sourceChannel });
      return { status: 'stored', messageId: batch.thought.telegramMessageId };
    },
    sendFeishuMessage: async () => ({ ok: true }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].sourceChannel, 'feishu');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(result.batchResults[0].persistedThoughtMessageId, result.batchResults[0].thought.telegramMessageId);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].channel, 'feishu');
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted.map((entry) => entry.sourceChannel), ['feishu']);
});

test('runFeishuSync handles /analysis reply and AI call log through the shared pipeline', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-analysis-'));
  const sentMessages = [];
  const calls = [];
  const fakeClient = {
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

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: {
      ...feishuSyncEnv(),
      AI_MODEL: 'gpt-analysis-primary',
    },
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-analysis-1',
            messageId: 'om_analysis_1',
            chatId: 'oc_chat_1',
            text: '/analysis 今天怎么练',
            createTime: '1781398820000',
          }),
        ],
      },
    },
    aiProvider: {
      env: { model: 'gpt-analysis-primary' },
      async requestChatCompletion() {
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: '数据结论：飞书分析路径完成。',
                  },
                },
              ],
            };
          },
        };
      },
    },
    snapshot: buildSyntheticAnalysisSnapshot(),
    createClient() {
      return fakeClient;
    },
    sendFeishuMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  const aiLogCall = calls.find(([sql]) => /insert into ingest\.ai_call_log/i.test(sql));

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, '数据结论：飞书分析路径完成。');
  assert.equal(result.batchResults[0].kind, 'analysis');
  assert.equal(result.batchResults[0].analysisReplyStatus, 'sent');
  assert.equal(result.batchResults[0].analysisAttemptKind, 'primary');
  assert.equal(result.batchResults[0].analysisModel, 'gpt-analysis-primary');
  assert.equal(result.batchResults[0].analysisSnapshotSource, 'database');
  assert.ok(aiLogCall);
  assert.equal(aiLogCall[1][1], result.batchResults[0].batchId);
  assert.equal(aiLogCall[1][2], 'analysis');
  assert.equal(aiLogCall[1][4], 'gpt-analysis-primary');
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

test('runFeishuSync processes two Feishu thought edit messages from one buffered payload', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-sync-runner-edit-burst-'));
  const persisted = [];
  const sent = [];

  const result = await runFeishuSync({
    rootDir: tempRoot,
    env: {
      ...feishuSyncEnv(),
      FEISHU_SYNC_NOTIFY: 'true',
      FEISHU_SYNC_NOTIFY_STAGE: 'inline',
    },
    repositoryDispatchEvent: {
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-edit-burst-1',
            messageId: 'om_edit_burst_1',
            chatId: 'oc_chat_1',
            text: '/随想编 600 身体反馈 第一条连续编辑',
            createTime: '1781398820000',
          }),
          createFeishuTextEvent({
            eventId: 'evt-edit-burst-2',
            messageId: 'om_edit_burst_2',
            chatId: 'oc_chat_1',
            text: '/随想编 601 杂七杂八 第二条连续编辑',
            createTime: '1781398821000',
          }),
        ],
      },
    },
    persistNormalizedBatch: async ({ batch, sourceChannel }) => {
      persisted.push({ batch, sourceChannel });
      return {
        status: 'stored',
        thoughtModule: batch.thoughtEdit.thoughtModule,
        messageId: batch.thoughtEdit.targetMessageId,
      };
    },
    sendFeishuMessage: async (input) => {
      sent.push(input);
      return { ok: true };
    },
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 2);
  assert.equal(result.batchResults.length, 2);
  assert.deepEqual(result.batchResults.map((batch) => batch.kind), ['thought_edit', 'thought_edit']);
  assert.deepEqual(
    result.batchResults.map((batch) => batch.thoughtEdit.targetMessageId),
    [600, 601],
  );
  assert.deepEqual(
    result.batchResults.map((batch) => batch.thoughtEdit.thoughtModule),
    ['body_feedback', 'misc'],
  );
  assert.deepEqual(
    result.batchResults.map((batch) => batch.persistenceStatus),
    ['stored', 'stored'],
  );
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted.map((entry) => entry.sourceChannel), ['feishu', 'feishu']);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((message) => message.chatId), ['oc_chat_1', 'oc_chat_1']);
  assert.ok(sent.every((message) => /随想更新成功/.test(message.text)));
  assert.ok(sent.every((message) => /已入库/.test(message.text)));
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

test('buildFeishuSyncReport gates pending replay and manual intervention as business-incomplete states', () => {
  const report = buildFeishuSyncReport({
    changed: false,
    fallbackUsed: false,
    updatesFetched: 2,
    lastProcessedUpdateId: null,
    readyBatches: 0,
    batchResults: [
      {
        kind: 'thought',
        sourceChannel: 'feishu',
        batchId: 'feishu-db-pending',
        status: 'ready',
        persistenceStatus: 'pending_replay',
        failureCategory: 'database',
        failureReason: 'database unavailable',
        messages: [{ messageId: 201, sourceMessageId: 'om_pending', chatId: 'oc_chat_1' }],
      },
      {
        kind: 'thought',
        sourceChannel: 'feishu',
        batchId: 'feishu-manual',
        status: 'skipped',
        failureCategory: 'user_input',
        failureReason: '疑似编辑命令，请使用 /随想编 id 模块 内容',
        reason: '疑似编辑命令，请使用 /随想编 id 模块 内容',
        messages: [{ messageId: 202, sourceMessageId: 'om_manual', chatId: 'oc_chat_1' }],
      },
    ],
  });

  assert.deepEqual(
    report.batches.map((batch) => ({
      batchId: batch.batchId,
      taskStatus: batch.taskStatus,
      retryState: batch.retryState,
      failureDisposition: batch.failureDisposition,
      businessComplete: batch.failureDisposition === 'none' && batch.persistenceStatus !== 'pending_replay',
    })),
    [
      {
        batchId: 'feishu-db-pending',
        taskStatus: 'deferred',
        retryState: 'pending_replay',
        failureDisposition: 'auto_retry',
        businessComplete: false,
      },
      {
        batchId: 'feishu-manual',
        taskStatus: 'skipped',
        retryState: 'none',
        failureDisposition: 'manual_intervention',
        businessComplete: false,
      },
    ],
  );
  assert.ok(report.batches.every((batch) => batch.taskId.startsWith('feishu:')));
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

test('feishu action monitor reports queued workflow dispatch failures to the original Feishu chat', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-action-monitor-workflow-dispatch-'));
  const eventPath = path.join(tempRoot, 'queued-dispatch-event.json');
  const sentMessages = [];
  await writeFile(
    eventPath,
    JSON.stringify({
      action: 'feishu_update_dev',
      client_payload: {
        feishu_updates: [
          createFeishuImageEvent({
            eventId: 'evt-action-workflow-fail-1',
            messageId: 'om_action_workflow_fail_1',
            chatId: 'oc_chat_1',
            imageKey: 'img_action_workflow_fail_1',
            createTime: '1781398800000',
          }),
        ],
      },
    }),
    'utf8',
  );

  const result = await notifyFeishuActionFailure({
    env: {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_RUN_ID: '123460',
      STEP_SYNC_OUTCOME: 'failure',
    },
    sendFeishuMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureCategory, 'github_action');
  assert.deepEqual(sentMessages.map((message) => message.chatId), ['oc_chat_1']);
  assert.match(sentMessages[0].text, /GitHub Action 执行失败：Sync Feishu updates/);
});

test('feishu action monitor reports inline queued dispatch failures to the original Feishu chat', async () => {
  const sentMessages = [];

  const result = await notifyFeishuActionFailure({
    env: {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: '',
      SYNC_DISPATCH_PAYLOAD: JSON.stringify({
        action: 'feishu_update_dev',
        client_payload: {
          feishu_updates: [
            createFeishuImageEvent({
              eventId: 'evt-action-inline-fail-1',
              messageId: 'om_action_inline_fail_1',
              chatId: 'oc_chat_1',
              imageKey: 'img_action_inline_fail_1',
              createTime: '1781398800000',
            }),
          ],
        },
      }),
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_RUN_ID: '123462',
      STEP_SYNC_OUTCOME: 'failure',
    },
    sendFeishuMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureCategory, 'github_action');
  assert.deepEqual(sentMessages.map((message) => message.chatId), ['oc_chat_1']);
  assert.match(sentMessages[0].text, /GitHub Action 执行失败：Sync Feishu updates/);
});

test('feishu action monitor reports deploy wait failures as site refresh failures', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'feishu-action-monitor-deploy-'));
  const eventPath = path.join(tempRoot, 'event.json');
  const sentMessages = [];
  await writeFile(
    eventPath,
    JSON.stringify({
      client_payload: {
        feishu_updates: [
          createFeishuTextEvent({
            eventId: 'evt-action-deploy-fail-1',
            messageId: 'om_action_deploy_fail_1',
            chatId: 'oc_chat_1',
            text: '/随想编 1442054985160403 身体反馈 正式 2026 年 6 月 16 日 12:33:38',
            createTime: '1781398800000',
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
      GITHUB_RUN_ID: '123458',
      STEP_DEPLOY_OUTCOME: 'failure',
    },
    sendFeishuMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureStage, '站点部署/页面刷新');
  assert.match(sentMessages[0].text, /GitHub Action 执行失败：站点部署\/页面刷新/);
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

function buildSyntheticAnalysisSnapshot() {
  const daily = [
    {
      date: '2026-05-14',
      measurement: {
        archivedDate: '2026-05-14',
        weightKg: 73.5,
        bodyFatPct: 22.1,
        skeletalMuscleKg: 30.8,
      },
      workoutSummary: {
        trainingCalories: 420,
        workoutDurationMinutes: 55,
        cyclingDistanceKm: 0,
        countsByType: {
          力量训练: 1,
        },
      },
      nutrition: {
        totalCalories: 1580,
      },
    },
  ];

  return {
    source: 'database',
    daily,
    latest: {
      daily: daily[0],
      measurement: daily[0].measurement,
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
