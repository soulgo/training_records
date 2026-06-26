import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildTelegramSyncReport,
  createImageStorage,
  createRecognitionAiProvider,
  loadRecognitionSystemPrompt,
  runMessageSync,
  runTelegramSync,
  shouldPersistTelegramArtifacts,
} from '../tools/telegram-sync.mjs';
import {
  recognizeBatch,
  resolveRecognitionImageInputMode,
} from '../tools/telegram-sync-image-processing.mjs';
import { notifyTelegramActionFailure } from '../tools/telegram-action-monitor.mjs';
import { buildRecognitionCacheKey, isRecognitionCacheEnabled } from '../src/ai/recognition-service.mjs';
import { emptyTrainingCharts, telegramSyncEnv } from './helpers/telegram-sync-runner-fixtures.mjs';

test('telegram sync entrypoint exits cleanly in webhook mode without queued work', () => {
  const stdout = execFileSync(process.execPath, ['tools/telegram-sync.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'false',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_TRANSPORT: 'webhook',
    },
  });

  const report = JSON.parse(stdout);
  assert.equal(report.changed, false);
  assert.equal(report.updatesFetched, 0);
});

test('telegram sync entrypoint ignores empty repository dispatch payloads in webhook mode', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-empty-dispatch-'));
  const dispatchPath = path.join(tempRoot, 'dispatch-event.json');
  await writeFile(dispatchPath, JSON.stringify({ client_payload: {} }), 'utf8');

  const stdout = execFileSync(process.execPath, ['tools/telegram-sync.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'false',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_TRANSPORT: 'webhook',
      GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_EVENT_PATH: dispatchPath,
    },
  });

  const report = JSON.parse(stdout);
  assert.equal(report.changed, false);
  assert.equal(report.updatesFetched, 0);
});

test('telegram sync entrypoint consumes queued workflow dispatch payloads in webhook mode', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-workflow-dispatch-'));
  const dispatchPath = path.join(tempRoot, 'queued-dispatch-event.json');
  await writeFile(
    dispatchPath,
    JSON.stringify({
      action: 'telegram_update_dev',
      client_payload: {
        telegram_updates: [
          {
            update_id: 902,
            message: {
              message_id: 126,
              date: 1781665850,
              chat: { id: 42 },
              text: '/随想编 126 杂七杂八 测试 workflow dispatch',
            },
          },
        ],
      },
    }),
    'utf8',
  );

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv({
      TELEGRAM_SYNC_TRANSPORT: 'webhook',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: dispatchPath,
    }),
    getLastProcessedUpdateId: async () => 900,
    readPendingRecognitionBatches: async () => [],
    persistNormalizedBatch: async ({ batch }) => ({
      status: 'stored',
      messageId: batch.thoughtEdit.targetMessageId,
      thoughtModule: batch.thoughtEdit.thoughtModule,
    }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 1);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
});

test('telegram sync entrypoint consumes queued dispatch payloads when event name is unavailable', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-queued-dispatch-path-'));
  const dispatchPath = path.join(tempRoot, 'queued-dispatch-event.json');
  await writeFile(
    dispatchPath,
    JSON.stringify({
      action: 'telegram_update_dev',
      client_payload: {
        telegram_updates: [
          {
            update_id: 904,
            message: {
              message_id: 128,
              date: 1781665850,
              chat: { id: 42 },
              text: '/随想编 128 身体反馈 event path fallback',
            },
          },
        ],
      },
    }),
    'utf8',
  );

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv({
      TELEGRAM_SYNC_TRANSPORT: 'webhook',
      GITHUB_EVENT_NAME: '',
      GITHUB_EVENT_PATH: dispatchPath,
    }),
    getLastProcessedUpdateId: async () => 900,
    readPendingRecognitionBatches: async () => [],
    persistNormalizedBatch: async ({ batch }) => ({
      status: 'stored',
      messageId: batch.thoughtEdit.targetMessageId,
      thoughtModule: batch.thoughtEdit.thoughtModule,
    }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
});

test('telegram sync entrypoint consumes inline queued dispatch payloads without event path', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-inline-dispatch-'));

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv({
      TELEGRAM_SYNC_TRANSPORT: 'webhook',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: '',
      SYNC_DISPATCH_PAYLOAD: JSON.stringify({
        action: 'telegram_update_dev',
        client_payload: {
          telegram_updates: [
            {
              update_id: 906,
              message: {
                message_id: 130,
                date: 1781665850,
                chat: { id: 42 },
                text: '/随想编 130 杂七杂八 inline dispatch fallback',
              },
            },
          ],
        },
      }),
    }),
    getLastProcessedUpdateId: async () => 900,
    readPendingRecognitionBatches: async () => [],
    persistNormalizedBatch: async ({ batch }) => ({
      status: 'stored',
      messageId: batch.thoughtEdit.targetMessageId,
      thoughtModule: batch.thoughtEdit.thoughtModule,
    }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
});

test('runMessageSync keeps Telegram behavior while exposing task results', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'message-sync-telegram-'));
  const persisted = [];

  const result = await runMessageSync({
    adapter: { channel: 'telegram' },
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 71,
          date: 1746748800,
          chat: { id: 42 },
          text: '/随想 今天训练后恢复不错',
        },
      },
    ],
    persistNormalizedBatch: async ({ batch, sourceChannel }) => {
      persisted.push({ batch, sourceChannel });
      return { status: 'stored', messageId: batch.thought.telegramMessageId };
    },
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.tasks.length, 1);
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
  assert.deepEqual(result.tasks[0], {
    taskId: `telegram:thought:${result.batchResults[0].batchId}`,
    channel: 'telegram',
    kind: 'thought',
    batchId: result.batchResults[0].batchId,
    taskStatus: 'ready',
    persistenceStatus: 'stored',
    failureCategory: null,
    failureReason: null,
    archivedDate: null,
    chatIds: [42],
    sourceMessageIds: [71],
  });
  assert.deepEqual(persisted.map((entry) => entry.sourceChannel), ['telegram']);
});

test('runMessageSync clamps oversized AI_CONCURRENCY before image recognition', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'message-sync-ai-concurrency-'));
  const observedConcurrency = [];

  const result = await runMessageSync({
    adapter: { channel: 'telegram' },
    rootDir: tempRoot,
    env: telegramSyncEnv({
      AI_CONCURRENCY: '50',
    }),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 71,
          date: Math.floor(new Date('2026-05-31T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-71', file_unique_id: 'uniq-71' }],
        },
      },
    ],
    recognizeBatch: async (batch, env) => {
      observedConcurrency.push(env.aiConcurrency);
      return {
        recognitions: batch.messages.map((message) => ({
          messageId: message.messageId,
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
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.deepEqual(observedConcurrency, [5]);
});

test('runMessageSync respects AI_CONCURRENCY_MAX when clamping image recognition', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'message-sync-ai-concurrency-max-'));
  const observedConcurrency = [];

  const result = await runMessageSync({
    adapter: { channel: 'telegram' },
    rootDir: tempRoot,
    env: telegramSyncEnv({
      AI_CONCURRENCY: '50',
      AI_CONCURRENCY_MAX: '2',
    }),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 72,
          date: Math.floor(new Date('2026-05-31T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-72', file_unique_id: 'uniq-72' }],
        },
      },
    ],
    recognizeBatch: async (batch, env) => {
      observedConcurrency.push(env.aiConcurrency);
      return {
        recognitions: batch.messages.map((message) => ({
          messageId: message.messageId,
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
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.deepEqual(observedConcurrency, [2]);
});

test('does not persist telegram artifacts when no updates were fetched and nothing changed', () => {
  assert.equal(
    shouldPersistTelegramArtifacts({
      updatesFetched: 0,
      changed: false,
      previousLastProcessedUpdateId: 520905382,
      nextLastProcessedUpdateId: 520905382,
    }),
    false,
  );
});

test('persists telegram artifacts when new updates advance the processed offset', () => {
  assert.equal(
    shouldPersistTelegramArtifacts({
      updatesFetched: 1,
      changed: false,
      previousLastProcessedUpdateId: 520905382,
      nextLastProcessedUpdateId: 520905383,
    }),
    true,
  );
});

test('loadRecognitionSystemPrompt reads the versioned Telegram image prompt', async () => {
  const prompt = await loadRecognitionSystemPrompt();

  assert.match(prompt, /只能输出符合 schema 的 JSON/);
  assert.match(prompt, /detectedDate.*只来自截图画面内可见的可靠日期/);
  assert.match(prompt, /系统相册、文件详情或分享预览页/);
  assert.match(prompt, /不要从 caption\/text 或图片文件名推断/);
  assert.match(prompt, /records\.dailyWorkoutSummary/);
  assert.match(prompt, /kg = 斤 \* 0\.5/);
  assert.match(prompt, /2026年5月22日星期五/);
  assert.match(prompt, /活动总览这类页面顶部的大号日期/);
});

test('loadRecognitionSystemPrompt can be overridden for prompt experiments', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-recognition-prompt-'));
  const promptPath = path.join(tempRoot, 'prompt.md');
  await writeFile(promptPath, 'custom prompt', 'utf8');

  assert.equal(
    await loadRecognitionSystemPrompt({
      TELEGRAM_RECOGNITION_PROMPT_PATH: promptPath,
    }),
    'custom prompt',
  );
});

test('recognition cache key changes with prompt schema and model versions', () => {
  assert.equal(
    buildRecognitionCacheKey({
      fileUniqueId: 'uniq-a',
      promptVersion: '2026-05-24',
      schemaVersion: 'v1',
      model: 'gpt-test',
    }),
    'telegram:file_unique_id:uniq-a:prompt:2026-05-24:schema:v1:model:gpt-test',
  );
  assert.equal(buildRecognitionCacheKey({ fileUniqueId: 'uniq-a' }), null);
  assert.equal(isRecognitionCacheEnabled({ TELEGRAM_RECOGNITION_CACHE_ENABLED: 'true' }), true);
  assert.equal(isRecognitionCacheEnabled({ TELEGRAM_RECOGNITION_CACHE_ENABLED: '' }), false);
});

test('recognition image input mode defaults to auto with inline retry and accepts explicit modes', () => {
  assert.equal(resolveRecognitionImageInputMode({}), 'auto');
  assert.equal(resolveRecognitionImageInputMode({ TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE: 'inline' }), 'inline');
  assert.equal(resolveRecognitionImageInputMode({ TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE: 'url' }), 'url');
  assert.equal(resolveRecognitionImageInputMode({ TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE: 'AUTO' }), 'auto');
  assert.equal(resolveRecognitionImageInputMode({ TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE: 'invalid' }), 'auto');
});

test('createRecognitionAiProvider overrides only the image recognition model when configured', () => {
  const defaultProvider = {
    name: 'test-provider',
    env: { model: 'gpt-default' },
    async requestChatCompletion() {
      throw new Error('not used');
    },
  };

  assert.equal(createRecognitionAiProvider({}, defaultProvider), defaultProvider);

  const recognitionProvider = createRecognitionAiProvider(
    {
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-default',
      TELEGRAM_RECOGNITION_MODEL: 'gpt-vision-fast',
    },
    defaultProvider,
  );

  assert.notEqual(recognitionProvider, defaultProvider);
  assert.equal(recognitionProvider.env.model, 'gpt-vision-fast');
});

test('createRecognitionAiProvider applies recognition scene model and timeout overrides', () => {
  const defaultProvider = {
    name: 'test-provider',
    env: { model: 'gpt-default', timeoutMs: 45000 },
    async requestChatCompletion() {
      throw new Error('not used');
    },
  };

  const recognitionProvider = createRecognitionAiProvider(
    {
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-default',
      AI_TIMEOUT_MS: '45000',
      AI_RECOGNITION_MODEL: 'gpt-recognition',
      AI_RECOGNITION_TIMEOUT_MS: '17000',
    },
    defaultProvider,
  );

  assert.notEqual(recognitionProvider, defaultProvider);
  assert.equal(recognitionProvider.env.model, 'gpt-recognition');
  assert.equal(recognitionProvider.env.timeoutMs, 17000);
});

test('createRecognitionAiProvider ignores new scene overrides when scheduler is disabled', () => {
  const defaultProvider = {
    name: 'test-provider',
    env: { model: 'gpt-default', timeoutMs: 45000 },
    async requestChatCompletion() {
      throw new Error('not used');
    },
  };

  const recognitionProvider = createRecognitionAiProvider(
    {
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-default',
      AI_TIMEOUT_MS: '45000',
      AI_SCHEDULER_ENABLED: 'false',
      AI_RECOGNITION_MODEL: 'gpt-recognition',
      AI_RECOGNITION_TIMEOUT_MS: '17000',
    },
    defaultProvider,
  );

  assert.equal(recognitionProvider, defaultProvider);
});

test('createRecognitionAiProvider attaches a configured fallback provider for image recognition', () => {
  const defaultProvider = {
    name: 'test-provider',
    env: { model: 'gpt-default' },
    async requestChatCompletion() {
      throw new Error('not used');
    },
  };

  const recognitionProvider = createRecognitionAiProvider(
    {
      AI_API_KEY: 'primary-key',
      AI_BASE_URL: 'https://primary.example.com/v1',
      AI_MODEL: 'gpt-default',
      TELEGRAM_RECOGNITION_MODEL: 'gpt-vision-fast',
      TELEGRAM_RECOGNITION_FALLBACK_API_KEY: 'fallback-key',
      TELEGRAM_RECOGNITION_FALLBACK_BASE_URL: 'https://fallback.example.com/v1/',
      TELEGRAM_RECOGNITION_FALLBACK_MODEL: 'gpt-vision-backup',
      TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS: '15000',
    },
    defaultProvider,
  );

  assert.equal(recognitionProvider.env.model, 'gpt-vision-fast');
  assert.equal(recognitionProvider.fallbackProvider.env.baseUrl, 'https://fallback.example.com/v1');
  assert.equal(recognitionProvider.fallbackProvider.env.model, 'gpt-vision-backup');
  assert.equal(recognitionProvider.fallbackProvider.env.timeoutMs, 15000);
});

test('createRecognitionAiProvider lets recognition scene fallback timeout override legacy fallback timeout', () => {
  const defaultProvider = {
    name: 'test-provider',
    env: { model: 'gpt-default' },
    async requestChatCompletion() {
      throw new Error('not used');
    },
  };

  const recognitionProvider = createRecognitionAiProvider(
    {
      AI_API_KEY: 'primary-key',
      AI_BASE_URL: 'https://primary.example.com/v1',
      AI_MODEL: 'gpt-default',
      TELEGRAM_RECOGNITION_FALLBACK_API_KEY: 'fallback-key',
      TELEGRAM_RECOGNITION_FALLBACK_BASE_URL: 'https://fallback.example.com/v1/',
      TELEGRAM_RECOGNITION_FALLBACK_MODEL: 'gpt-vision-backup',
      TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS: '15000',
      AI_RECOGNITION_FALLBACK_TIMEOUT_MS: '12000',
    },
    defaultProvider,
  );

  assert.equal(recognitionProvider.fallbackProvider.env.timeoutMs, 12000);
});

test('recognizeBatch sends inline Telegram image data when inline mode is configured', async () => {
  const requestedImageUrls = [];
  const downloadedFileIds = [];

  const result = await recognizeBatch(
    {
      batchId: 'single-inline',
      messages: [
        {
          messageId: 701,
          updateId: 901,
          mediaGroupId: null,
          caption: '归档到 2026-05-31',
          text: '',
          chatId: 42,
          dateUnix: Math.floor(new Date('2026-05-31T02:30:00Z').getTime() / 1000),
          photos: [{ fileId: 'file-inline', fileUniqueId: 'uniq-inline', source: 'photo' }],
        },
      ],
    },
    {
      botToken: 'token',
      aiConcurrency: 1,
    },
    {
      rawEnv: {
        TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE: 'inline',
      },
      fetchTelegramFileById: async (fileId) => {
        downloadedFileIds.push(fileId);
        return {
          filePath: 'photos/file-inline.jpg',
          contentType: 'image/jpeg',
          data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        };
      },
      aiProvider: {
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
      },
    },
  );

  assert.deepEqual(downloadedFileIds, ['file-inline']);
  assert.equal(requestedImageUrls.length, 1);
  assert.match(requestedImageUrls[0], /^data:image\/jpeg;base64,/);
  assert.equal(result.recognitions.length, 1);
  assert.equal(result.recognitions[0].model, 'gpt-vision-fast');
  assert.equal(result.recognitionErrors.length, 0);
});

test('runTelegramSync persists ready image batches to the database without writing markdown', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-runner-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      ...telegramSyncEnv(),
      TELEGRAM_SYNC_REPLAY_LEGACY_NDJSON_PENDING: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 71,
          media_group_id: 'album-1',
          date: 1746748800,
          chat: { id: 42 },
          caption: '归档到 2026-05-09',
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 71,
        imageType: 'nutrition',
        detectedDate: '2026-05-09',
        dateEvidence: 'image header',
        confidence: 0.96,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 }],
          totalCalories: 1593,
          details: ['晚餐 1065 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for stored image batches');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for stored image batches');
    },
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.changed, true);
  assert.equal(persistedBatches.length, 1);
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches[0].archivedDate, '2026-05-09');
  assert.equal(persistedBatches[0].nutrition.meals[0].name, '晚餐');
  await assert.rejects(readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /ENOENT/);
});

test('runTelegramSync leaves existing markdown untouched after storing an image batch', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-stale-db-snapshot-'));

  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(
      path.join(tempRoot, '训练记录.md'),
      '# 训练记录\n\n### 2026-05-09\n\n#### 当日运动截图记录\n\n##### 当日活动总览\n\n- 活动热量：643千卡\n',
      'utf8',
    ),
  );

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      ...telegramSyncEnv(),
      TELEGRAM_SYNC_REPLAY_LEGACY_NDJSON_PENDING: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 76,
          date: 1775433600,
          chat: { id: 42 },
          caption: '归档到 2026-04-06',
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 76,
        imageType: 'workout',
        detectedDate: '2026-04-06',
        dateEvidence: 'image header',
        confidence: 0.97,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [],
          totalCalories: null,
          details: [],
          dailyWorkoutSummary: {
            activityCaloriesKcal: 402,
            workoutDurationMinutes: 30,
            activeHours: 16,
          },
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for stored image batches');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for stored image batches');
    },
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(
    await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'),
    '# 训练记录\n\n### 2026-05-09\n\n#### 当日运动截图记录\n\n##### 当日活动总览\n\n- 活动热量：643千卡\n',
  );
});

test('runTelegramSync stores image batches even when markdown contains stale data', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-incomplete-db-snapshot-'));

  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(
      path.join(tempRoot, '训练记录.md'),
      '# 训练记录\n\n### 2026-05-14\n\n#### 2026-05-14 饮食截图记录\n\n##### 餐次汇总\n\n- 午餐：420千卡，建议范围620–1033千卡\n',
      'utf8',
    ),
  );

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 94,
          date: 1775433600,
          chat: { id: 42 },
          caption: '归档到 2026-05-14',
          photo: [{ file_id: 'file-d', file_unique_id: 'uniq-d' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 94,
        imageType: 'nutrition',
        detectedDate: '2026-05-14',
        dateEvidence: 'image header',
        confidence: 0.97,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 329, recommendedMin: 310, recommendedMax: 723 }],
          totalCalories: 857,
          details: ['晚餐 329 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for stored image batches');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for stored image batches');
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(
    await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'),
    '# 训练记录\n\n### 2026-05-14\n\n#### 2026-05-14 饮食截图记录\n\n##### 餐次汇总\n\n- 午餐：420千卡，建议范围620–1033千卡\n',
  );
});

test('runTelegramSync stores sleep image batches without writing markdown', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-sleep-markdown-'));

  await writeFile(
    path.join(tempRoot, '训练记录.md'),
    '# 训练记录\n',
    'utf8',
  );

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 125,
          date: 1775433600,
          chat: { id: 42 },
          caption: '归档到 2026-05-30',
          photo: [{ file_id: 'file-sleep', file_unique_id: 'uniq-sleep' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 125,
        imageType: 'sleep',
        detectedDate: '2026-05-30',
        dateEvidence: 'image header',
        confidence: 0.97,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [],
          totalCalories: null,
          details: [],
          dailyWorkoutSummary: null,
          sleep: {
            records: [
              {
                sleepType: '夜间睡眠',
                bedtime: '22:56',
                wakeTime: '07:21',
                totalSleepMinutes: 505,
                nightSleepMinutes: 505,
              },
            ],
            totalSleepMinutes: 505,
            nightSleepMinutes: 505,
            sleepStartTime: '22:56',
            sleepEndTime: '07:21',
          },
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for stored image batches');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for stored image batches');
    },
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), '# 训练记录\n');
});

test('runTelegramSync runs sleep backfill for a fresh stored sleep image by default', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-sleep-backfill-'));
  await writeFile(path.join(tempRoot, '训练记录.md'), '# 训练记录\n', 'utf8');
  const backfillCalls = [];
  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 126,
          date: 1775433600,
          chat: { id: 42 },
          caption: '归档到 2026-05-30',
          photo: [{ file_id: 'file-sleep', file_unique_id: 'uniq-sleep' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 126,
        imageType: 'sleep',
        detectedDate: '2026-05-30',
        dateEvidence: 'image header',
        confidence: 0.97,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [],
          totalCalories: null,
          details: [],
          dailyWorkoutSummary: null,
          sleep: {
            totalSleepMinutes: 505,
            nightSleepMinutes: 505,
            bedtime: '22:56',
            wakeTime: '07:21',
          },
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    backfillCoreSleepFromIngestBatches: async (input) => {
      backfillCalls.push(input);
      return { status: 'synced' };
    },
  });

  assert.equal(result.changed, true);
  assert.equal(backfillCalls.length, 1);
  assert.equal(backfillCalls[0].sourceChannel, 'telegram_sync');
  assert.equal(Object.hasOwn(result.timingsMs, 'sleepBackfill'), true);
});

test('runTelegramSync does not run sleep backfill for a fresh stored non-sleep image by default', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-nutrition-no-sleep-backfill-'));
  await writeFile(path.join(tempRoot, '训练记录.md'), '# 训练记录\n', 'utf8');

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 128,
          date: 1775433600,
          chat: { id: 42 },
          caption: '归档到 2026-05-30',
          photo: [{ file_id: 'file-food', file_unique_id: 'uniq-food' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 128,
        imageType: 'nutrition',
        detectedDate: '2026-05-30',
        dateEvidence: 'image header',
        confidence: 0.97,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 329, recommendedMin: 310, recommendedMax: 723 }],
          totalCalories: 329,
          details: ['晚餐 329 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    backfillCoreSleepFromIngestBatches: async () => {
      throw new Error('sleep backfill should not run for non-sleep images by default');
    },
  });

  assert.equal(result.changed, true);
  assert.equal(Object.hasOwn(result.timingsMs, 'sleepBackfill'), false);
});

test('runTelegramSync can explicitly run sleep backfill for a fresh stored image', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-sleep-explicit-backfill-'));
  await writeFile(path.join(tempRoot, '训练记录.md'), '# 训练记录\n', 'utf8');
  const backfillCalls = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv({
      TELEGRAM_SYNC_RUN_SLEEP_BACKFILL: 'true',
    }),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 127,
          date: 1775433600,
          chat: { id: 42 },
          caption: '归档到 2026-05-30',
          photo: [{ file_id: 'file-sleep', file_unique_id: 'uniq-sleep' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 127,
        imageType: 'sleep',
        detectedDate: '2026-05-30',
        dateEvidence: 'image header',
        confidence: 0.97,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [],
          totalCalories: null,
          details: [],
          dailyWorkoutSummary: null,
          sleep: {
            totalSleepMinutes: 505,
            nightSleepMinutes: 505,
            bedtime: '22:56',
            wakeTime: '07:21',
          },
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    backfillCoreSleepFromIngestBatches: async (input) => {
      backfillCalls.push(input);
      return { status: 'synced' };
    },
  });

  assert.equal(result.changed, true);
  assert.equal(backfillCalls.length, 1);
  assert.equal(backfillCalls[0].sourceChannel, 'telegram_sync');
  assert.equal(Object.hasOwn(result.timingsMs, 'sleepBackfill'), true);
});

test('runTelegramSync runs sleep backfill when pending recognition replay stores sleep data', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-pending-sleep-backfill-'));
  await writeFile(path.join(tempRoot, '训练记录.md'), '# 训练记录\n', 'utf8');
  const backfillCalls = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv({
      GITHUB_EVENT_NAME: 'repository_dispatch',
    }),
    repositoryDispatchEvent: { client_payload: {} },
    getLastProcessedUpdateId: async () => 900,
    readPendingRecognitionBatches: async () => [
      {
        batchId: 'pending-sleep',
        batch: {
          kind: 'image',
          batchId: 'pending-sleep',
          messages: [
            {
              messageId: 129,
              updateId: 901,
              dateUnix: 1775433600,
              chatId: 42,
              caption: '归档到 2026-05-30',
              photos: [{ fileId: 'file-sleep', fileUniqueId: 'uniq-sleep' }],
            },
          ],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 129,
        imageType: 'sleep',
        detectedDate: '2026-05-30',
        dateEvidence: 'image header',
        confidence: 0.97,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [],
          totalCalories: null,
          details: [],
          dailyWorkoutSummary: null,
          sleep: {
            totalSleepMinutes: 505,
            nightSleepMinutes: 505,
            bedtime: '22:56',
            wakeTime: '07:21',
          },
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    markPendingRecognitionResolved: async ({ batchId }) => ({ status: 'resolved', batchId }),
    appendPendingRecognitionBatch: async () => ({ status: 'queued' }),
    backfillCoreSleepFromIngestBatches: async (input) => {
      backfillCalls.push(input);
      return { status: 'synced' };
    },
  });

  assert.equal(result.changed, true);
  assert.equal(backfillCalls.length, 1);
  assert.equal(backfillCalls[0].sourceChannel, 'telegram_sync');
  assert.equal(Object.hasOwn(result.timingsMs, 'sleepBackfill'), true);
});

test('runTelegramSync does not run sleep backfill when pending recognition replay stores non-sleep data', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-pending-nonsleep-backfill-'));
  await writeFile(path.join(tempRoot, '训练记录.md'), '# 训练记录\n', 'utf8');

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv({
      GITHUB_EVENT_NAME: 'repository_dispatch',
    }),
    repositoryDispatchEvent: { client_payload: {} },
    getLastProcessedUpdateId: async () => 900,
    readPendingRecognitionBatches: async () => [
      {
        batchId: 'pending-food',
        batch: {
          kind: 'image',
          batchId: 'pending-food',
          messages: [
            {
              messageId: 130,
              updateId: 901,
              dateUnix: 1775433600,
              chatId: 42,
              caption: '归档到 2026-05-30',
              photos: [{ fileId: 'file-food', fileUniqueId: 'uniq-food' }],
            },
          ],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 130,
        imageType: 'nutrition',
        detectedDate: '2026-05-30',
        dateEvidence: 'image header',
        confidence: 0.97,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 329, recommendedMin: 310, recommendedMax: 723 }],
          totalCalories: 329,
          details: ['晚餐 329 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    markPendingRecognitionResolved: async ({ batchId }) => ({ status: 'resolved', batchId }),
    appendPendingRecognitionBatch: async () => ({ status: 'queued' }),
    backfillCoreSleepFromIngestBatches: async () => {
      throw new Error('sleep backfill should not run for non-sleep pending replay');
    },
  });

  assert.equal(result.changed, true);
  assert.equal(Object.hasOwn(result.timingsMs, 'sleepBackfill'), false);
});

test('runTelegramSync queues database replay when image persistence fails', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-fallback-'));
  const queuedPersistenceFailures = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 71,
          media_group_id: 'album-1',
          date: 1746748800,
          chat: { id: 42 },
          caption: '归档到 2026-05-09',
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 71,
        imageType: 'nutrition',
        detectedDate: '2026-05-09',
        dateEvidence: 'image header',
        confidence: 0.96,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 }],
          totalCalories: 1593,
          details: ['晚餐 1065 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async () => {
      throw new Error('database unavailable');
    },
    appendPendingRecognitionBatch: async (entry) => {
      queuedPersistenceFailures.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
    exportTrainingMarkdown: () => {
      throw new Error('should not export from database on fallback');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults[0].persistenceStatus, 'pending_replay');
  assert.equal(result.batchResults[0].persistenceError, 'database unavailable');
  assert.equal(queuedPersistenceFailures.length, 1);
  assert.equal(queuedPersistenceFailures[0].batch.batchId, 'album-1');
  assert.equal(queuedPersistenceFailures[0].batch.archivedDate, '2026-05-09');
  assert.equal(queuedPersistenceFailures[0].failureCategory, 'database');
  await assert.rejects(readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'), /ENOENT/);
});

test('runTelegramSync treats DB-rejected invalid image archive dates as manual intervention without pending replay', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-invalid-archive-date-'));
  const queuedPersistenceFailures = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 71,
          media_group_id: 'album-invalid-date',
          date: 1746748800,
          chat: { id: 42 },
          caption: '归档到 2026-05-09',
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 71,
        imageType: 'nutrition',
        detectedDate: '2026-05-09',
        dateEvidence: 'image header',
        confidence: 0.96,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 }],
          totalCalories: 1593,
          details: ['晚餐 1065 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async () => {
      throw new Error('invalid archivedDate: 2023-02-30');
    },
    appendPendingRecognitionBatch: async (entry) => {
      queuedPersistenceFailures.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
  });

  const report = buildTelegramSyncReport(result);
  const [batch] = report.batches;
  assert.equal(batch.persistenceStatus, 'manual_intervention');
  assert.equal(batch.failureCategory, 'user_input');
  assert.equal(batch.failureDisposition, 'manual_intervention');
  assert.equal(batch.retryState, 'none');
  assert.equal(queuedPersistenceFailures.length, 0);
});

test('runTelegramSync replays a ready batch from pending after database recovery', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-db-recovery-'));
  const pendingRows = [];
  const persistedBatchIds = [];
  const resolved = [];

  const firstRun = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 71,
          media_group_id: 'album-1',
          date: 1746748800,
          chat: { id: 42 },
          caption: '归档到 2026-05-09',
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 71,
        imageType: 'nutrition',
        detectedDate: '2026-05-09',
        dateEvidence: 'image header',
        confidence: 0.96,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 }],
          totalCalories: 1593,
          details: ['晚餐 1065 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async () => {
      throw new Error('database unavailable');
    },
    appendPendingRecognitionBatch: async (entry) => {
      pendingRows.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
  });

  assert.equal(firstRun.batchResults[0].persistenceStatus, 'pending_replay');
  assert.equal(firstRun.batchResults[0].failureCategory, 'database');
  assert.equal(pendingRows.length, 1);
  assert.equal(pendingRows[0].batch.batchId, 'album-1');
  assert.equal(pendingRows[0].batch.nutrition.totalCalories, 1593);

  const secondRun = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 901,
    fetchTelegramUpdates: async () => [],
    readPendingRecognitionBatches: async () =>
      pendingRows.map((entry) => ({
        batchId: entry.batch.batchId,
        batch: entry.batch,
        failureCategory: entry.failureCategory,
        failureReason: entry.error,
      })),
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatchIds.push(batch.batchId);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    markPendingRecognitionResolved: async ({ batchId }) => {
      resolved.push(batchId);
      return { status: 'resolved', batchId };
    },
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-09T00:00:00.000Z',
      latest: { measurement: null, daily: { date: '2026-05-09' } },
      daily: [],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-09\n',
  });

  assert.deepEqual(persistedBatchIds, ['album-1']);
  assert.deepEqual(resolved, ['album-1']);
  assert.equal(secondRun.batchResults[0].pendingReplay, true);
  assert.equal(secondRun.batchResults[0].persistenceStatus, 'stored');
  assert.equal(secondRun.batchResults[0].recognitionPendingStatus, 'resolved');
  assert.equal(buildTelegramSyncReport(secondRun).batches[0].retryState, 'resolved');
});

test('runTelegramSync skips undated batches without persisting fallback or markdown writes', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-skip-undated-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 81,
          media_group_id: 'album-no-date',
          date: 1775433600,
          chat: { id: 42 },
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
      {
        update_id: 902,
        message: {
          message_id: 82,
          media_group_id: 'album-no-date',
          date: 1775433601,
          chat: { id: 42 },
          photo: [{ file_id: 'file-b', file_unique_id: 'uniq-b' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 81,
        imageType: 'nutrition',
        detectedDate: null,
        dateEvidence: 'no visible date',
        confidence: 0.96,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
          totalCalories: 465,
          details: ['晚餐 465 千卡'],
          dailyWorkoutSummary: null,
        },
      },
      {
        messageId: 82,
        imageType: 'measurement',
        detectedDate: null,
        dateEvidence: 'no visible date',
        confidence: 0.97,
        warnings: [],
        records: {
          measurement: {
            measuredAt: null,
            bodyScore: 73,
            weightKg: 73.65,
            bmi: 23.7,
            bodyFatPct: 24.1,
            skeletalMuscleKg: 30.7,
            visceralFatLevel: 9,
            basalMetabolismKcal: 1601,
            bodyWaterPct: 48.6,
            proteinPct: 23.3,
            boneMassKg: 2.965,
            fatFreeMassKg: 55.9,
            bodyAge: 32,
            bodyType: '肥胖型',
          },
          activities: [],
          meals: [],
          totalCalories: null,
          details: [],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch.batchId);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for skipped batches');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for skipped batches');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(persistedBatches, []);
  assert.equal(result.batchResults[0].status, 'skipped');
  await assert.rejects(readFile(path.join(tempRoot, '训练记录.md'), 'utf8'));
  await assert.rejects(readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'), /ENOENT/);
});

test('runTelegramSync skips conflicting-date batches and continues processing ready batches', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-skip-conflicting-'));
  const persistedBatches = [];
  const queuedRecognitionBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 91,
          media_group_id: 'album-conflict',
          date: 1775433600,
          chat: { id: 42 },
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
      {
        update_id: 902,
        message: {
          message_id: 92,
          media_group_id: 'album-conflict',
          date: 1775433601,
          chat: { id: 42 },
          photo: [{ file_id: 'file-b', file_unique_id: 'uniq-b' }],
        },
      },
      {
        update_id: 903,
        message: {
          message_id: 93,
          media_group_id: 'album-ready',
          date: 1775433602,
          chat: { id: 42 },
          caption: '归档到 2026-05-14',
          photo: [{ file_id: 'file-c', file_unique_id: 'uniq-c' }],
        },
      },
    ],
    recognizeBatch: async (batch) =>
      batch.batchId === 'album-conflict'
        ? [
            {
              messageId: 91,
              imageType: 'nutrition',
              detectedDate: '2026-05-13',
              dateEvidence: 'ocr',
              confidence: 0.96,
              warnings: [],
              records: {
                measurement: null,
                activities: [],
                meals: [{ name: '午餐', calories: 396, recommendedMin: 618, recommendedMax: 1030 }],
                totalCalories: 396,
                details: ['午餐 396 千卡'],
                dailyWorkoutSummary: null,
              },
            },
            {
              messageId: 92,
              imageType: 'measurement',
              detectedDate: '2026-05-14',
              dateEvidence: 'ocr',
              confidence: 0.97,
              warnings: [],
              records: {
                measurement: {
                  measuredAt: '2026-05-14 06:23',
                  bodyScore: 73,
                  weightKg: 73.65,
                  bmi: 23.7,
                  bodyFatPct: 24.1,
                  skeletalMuscleKg: 30.7,
                  visceralFatLevel: 9,
                  basalMetabolismKcal: 1601,
                  bodyWaterPct: 48.6,
                  proteinPct: 23.3,
                  boneMassKg: 2.965,
                  fatFreeMassKg: 55.9,
                  bodyAge: 32,
                  bodyType: '肥胖型',
                },
                activities: [],
                meals: [],
                totalCalories: null,
                details: [],
                dailyWorkoutSummary: null,
              },
            },
          ]
        : [
            {
              messageId: 93,
              imageType: 'nutrition',
              detectedDate: '2026-05-14',
              dateEvidence: 'image header',
              confidence: 0.98,
              warnings: [],
              records: {
                measurement: null,
                activities: [],
                meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
                totalCalories: 465,
                details: ['晚餐 465 千卡'],
                dailyWorkoutSummary: null,
              },
            },
          ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch.batchId);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    appendPendingRecognitionBatch: async (entry) => {
      queuedRecognitionBatches.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-14T00:00:00.000Z',
      latest: {
        measurement: null,
        daily: { date: '2026-05-14' },
      },
      daily: [
        {
          date: '2026-05-14',
          measurement: null,
          measurements: [],
          activities: [],
          workoutSummary: {
            totalActivities: 0,
            totalDurationSeconds: 0,
            trainingCalories: 0,
            workoutDurationMinutes: null,
            activeHours: null,
            cyclingDistanceKm: 0,
            countsByType: {},
          },
          nutrition: {
            meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
            totalCalories: 465,
            details: ['晚餐 465 千卡'],
          },
        },
      ],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-14\n',
  });

  assert.equal(result.changed, true);
  assert.deepEqual(persistedBatches, ['album-ready']);
  assert.deepEqual(queuedRecognitionBatches, []);
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[0].failureCategory, 'user_input');
  assert.match(result.batchResults[0].failureReason, /conflicting detected dates/);
  assert.equal(result.batchResults[1].status, 'ready');
  await assert.rejects(readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'), /ENOENT/);
});

test('buildTelegramSyncReport exposes pending replay and archived date details for logs', () => {
  const report = buildTelegramSyncReport({
    changed: true,
    fallbackUsed: false,
    updatesFetched: 1,
    lastProcessedUpdateId: 520905402,
    readyBatches: 1,
    batchResults: [
      {
        batchId: 'album-1',
        status: 'ready',
        archivedDate: '2026-04-06',
        persistenceStatus: 'pending_replay',
        persistenceError: 'database unavailable',
        warnings: [],
        issues: [],
      },
    ],
  });

  assert.deepEqual(
    {
      changed: report.changed,
      fallbackUsed: report.fallbackUsed,
      updatesFetched: report.updatesFetched,
      lastProcessedUpdateId: report.lastProcessedUpdateId,
      readyBatches: report.readyBatches,
      batches: report.batches,
    },
    {
    changed: true,
    fallbackUsed: false,
    updatesFetched: 1,
    lastProcessedUpdateId: 520905402,
    readyBatches: 1,
    batches: [
      {
        kind: 'image',
        batchId: 'album-1',
        taskId: 'telegram:image:album-1',
        sourceType: 'telegram_update',
        sourceId: 'telegram:batch:album-1',
        taskStatus: 'deferred',
        retryState: 'pending_replay',
        retryCount: 0,
        chatIds: [],
        messageIds: [],
        updateIds: [],
        status: 'ready',
        partialFailure: false,
        archivedDate: '2026-04-06',
        postPath: null,
        thoughtWriteStatus: null,
        persistenceStatus: 'pending_replay',
        persistenceError: 'database unavailable',
        failureCategory: null,
        failureReason: null,
        failureDisposition: 'auto_retry',
        recognitionPendingStatus: null,
        recognitionPendingError: null,
        aiCallLogStatus: null,
        pendingReplay: false,
        sourceImageCount: 0,
        recognizedImageCount: 0,
        failedImageCount: 0,
        recognitionAttemptKinds: [],
        recognitionErrors: [],
        syncStages: {},
        warnings: [],
        issues: [],
        reason: null,
        dateSources: [],
        dateConfidence: null,
        dateStages: {},
        imageUploadStats: null,
      },
    ],
    },
  );
  assert.deepEqual(report.batchResults, report.batches);
  assert.deepEqual(report.tasks, [
    {
      taskId: 'telegram:image:album-1',
      channel: 'telegram',
      kind: 'image',
      batchId: 'album-1',
      taskStatus: 'deferred',
      persistenceStatus: 'pending_replay',
      failureCategory: null,
      failureReason: null,
      archivedDate: '2026-04-06',
      chatIds: [],
      sourceMessageIds: [],
    },
  ]);
});

test('buildTelegramSyncReport marks abandoned pending batches for manual handling', () => {
  const report = buildTelegramSyncReport({
    changed: false,
    fallbackUsed: false,
    updatesFetched: 0,
    lastProcessedUpdateId: 520905402,
    readyBatches: 0,
    batchResults: [
      {
        kind: 'image',
        batchId: 'single-abandoned',
        status: 'failed',
        persistenceStatus: 'abandoned',
        failureCategory: 'ai_service',
        failureReason: 'pending retry limit exceeded',
        retryCount: 26,
        messages: [{ chatId: 42, messageId: 482, updateId: 982 }],
      },
    ],
  });

  assert.equal(report.batches[0].taskStatus, 'failed');
  assert.equal(report.batches[0].retryState, 'abandoned');
  assert.equal(report.batches[0].failureDisposition, 'manual_intervention');
  assert.equal(report.tasks[0].persistenceStatus, 'abandoned');
  assert.equal(report.tasks[0].failureCategory, 'ai_service');
  assert.equal(report.tasks[0].failureReason, 'pending retry limit exceeded');
});

test('buildTelegramSyncReport includes optional sync stage timings', () => {
  const report = buildTelegramSyncReport({
    changed: true,
    fallbackUsed: false,
    updatesFetched: 1,
    lastProcessedUpdateId: 520905500,
    readyBatches: 1,
    timingsMs: {
      resolveUpdates: 1.4,
      recognition: 1234.6,
      persist: 22,
      total: 1300.2,
      skippedNegative: -1,
      skippedText: 'slow',
    },
    batchResults: [],
  });

  assert.deepEqual(report.timingsMs, {
    resolveUpdates: 1,
    recognition: 1235,
    persist: 22,
    total: 1300,
  });
});

test('buildTelegramSyncReport preserves image archive date confidence for summary gates', () => {
  const report = buildTelegramSyncReport({
    changed: true,
    fallbackUsed: false,
    updatesFetched: 1,
    lastProcessedUpdateId: 960,
    readyBatches: 1,
    batchResults: [
      {
        kind: 'image',
        batchId: 'album-date-confidence',
        status: 'ready',
        archivedDate: '2026-06-17',
        dateConfidence: 'uncertain',
        dateSources: [
          { messageId: 601, detectedDate: '2026-06-17', source: 'image' },
          { messageId: 602, detectedDate: '2026-06-17', source: 'sleep_bedtime' },
          { messageId: 603, detectedDate: null, source: 'no_date' },
        ],
        dateStages: {
          date_parse: { status: 'succeeded', resultDate: '2026-06-17' },
          filename_fallback: { status: 'skipped', resultDate: null },
          sleep_bedtime_shift: { status: 'succeeded', resultDate: '2026-06-17' },
          date_confidence_gate: { status: 'manual_intervention', result: 'uncertain' },
        },
        warnings: ['detectedDate补全年份不确定，需程序确认'],
      },
    ],
  });

  assert.equal(report.batches[0].dateConfidence, 'uncertain');
  assert.deepEqual(report.batches[0].dateSources.map((item) => item.source), ['image', 'sleep_bedtime', 'no_date']);
  assert.equal(report.batches[0].dateStages.date_confidence_gate.result, 'uncertain');
  assert.equal(report.batches[0].dateStages.sleep_bedtime_shift.status, 'succeeded');
  assert.equal(report.batchResults[0].dateConfidence, 'uncertain');
});

test('buildTelegramSyncReport omits timings when unavailable for compatibility', () => {
  const report = buildTelegramSyncReport({
    changed: false,
    fallbackUsed: false,
    updatesFetched: 0,
    lastProcessedUpdateId: 520905501,
    readyBatches: 0,
    batchResults: [],
  });

  assert.equal(Object.hasOwn(report, 'timingsMs'), false);
});

test('buildTelegramSyncReport exposes normalized task status and identifiers for audit', () => {
  const report = buildTelegramSyncReport({
    changed: true,
    fallbackUsed: false,
    updatesFetched: 1,
    lastProcessedUpdateId: 930,
    readyBatches: 1,
    batchResults: [
      {
        kind: 'image',
        batchId: 'album-audit',
        status: 'ready',
        persistenceStatus: 'stored',
        recognitionPendingStatus: 'resolved',
        pendingReplay: true,
        messages: [
          { messageId: 501, updateId: 931, mediaGroupId: 'album-audit', chatId: 42 },
          { messageId: 502, updateId: 932, mediaGroupId: 'album-audit', chatId: 42 },
        ],
        sourceImageCount: 2,
        recognizedImageCount: 2,
        failedImageCount: 0,
        archivedDate: '2026-05-31',
      },
    ],
  });

  assert.equal(report.batches[0].taskId, 'telegram:image:album-audit');
  assert.equal(report.batches[0].sourceType, 'pending_replay');
  assert.equal(report.batches[0].sourceId, 'telegram:chat:42:media_group:album-audit');
  assert.equal(report.batches[0].taskStatus, 'resolved');
  assert.equal(report.batches[0].retryState, 'resolved');
  assert.equal(report.batches[0].retryCount, 1);
  assert.deepEqual(report.batches[0].messageIds, [501, 502]);
  assert.deepEqual(report.batches[0].updateIds, [931, 932]);
  assert.equal(report.batchResults.length, 1);
  assert.deepEqual(report.tasks, [
    {
      taskId: 'telegram:image:album-audit',
      channel: 'telegram',
      kind: 'image',
      batchId: 'album-audit',
      taskStatus: 'resolved',
      persistenceStatus: 'stored',
      failureCategory: null,
      failureReason: null,
      archivedDate: '2026-05-31',
      chatIds: [42],
      sourceMessageIds: [501, 502],
    },
  ]);
});

test('buildTelegramSyncReport keeps partial failure visible when failed images are queued', () => {
  const report = buildTelegramSyncReport({
    changed: true,
    fallbackUsed: false,
    updatesFetched: 1,
    lastProcessedUpdateId: 940,
    readyBatches: 1,
    batchResults: [
      {
        kind: 'image',
        batchId: 'album-partial-audit',
        status: 'ready',
        persistenceStatus: 'stored',
        partialFailure: true,
        recognitionPendingStatus: 'queued',
        sourceImageCount: 2,
        recognizedImageCount: 1,
        failedImageCount: 1,
      },
    ],
  });

  assert.equal(report.batches[0].taskStatus, 'partialFailure');
  assert.equal(report.batches[0].retryState, 'queued');
});

test('buildTelegramSyncReport exposes failure disposition for retry and manual handling', () => {
  const report = buildTelegramSyncReport({
    changed: false,
    fallbackUsed: false,
    updatesFetched: 3,
    lastProcessedUpdateId: 950,
    readyBatches: 0,
    batchResults: [
      {
        kind: 'image',
        batchId: 'ai-retry',
        status: 'skipped',
        failureCategory: 'ai_service',
        recognitionPendingStatus: 'queued',
      },
      {
        kind: 'image',
        batchId: 'date-conflict',
        status: 'skipped',
        failureCategory: 'user_input',
        failureReason: 'conflicting detected dates',
      },
      {
        kind: 'image',
        batchId: 'ignored',
        status: 'ignored',
        reason: 'unauthorized chat',
      },
    ],
  });

  assert.equal(report.batches[0].failureDisposition, 'auto_retry');
  assert.equal(report.batches[1].failureDisposition, 'manual_intervention');
  assert.equal(report.batches[2].failureDisposition, 'skip');
});

test('buildTelegramSyncReport classifies AI aborts and fallback failures as auto retry', () => {
  const report = buildTelegramSyncReport({
    changed: false,
    fallbackUsed: true,
    updatesFetched: 2,
    lastProcessedUpdateId: 960,
    readyBatches: 0,
    batchResults: [
      {
        kind: 'image',
        batchId: 'ai-abort',
        status: 'skipped',
        failureReason: 'AbortError: The operation was aborted',
      },
      {
        kind: 'image',
        batchId: 'fallback-failed',
        status: 'skipped',
        failureReason: 'fallback provider failed after primary AI timed out',
      },
    ],
  });

  assert.equal(report.batches[0].failureCategory, 'ai_service');
  assert.equal(report.batches[0].failureDisposition, 'auto_retry');
  assert.equal(report.batches[1].failureCategory, 'ai_service');
  assert.equal(report.batches[1].failureDisposition, 'auto_retry');
});

test('buildTelegramSyncReport exposes the canonical sync task statuses', () => {
  const report = buildTelegramSyncReport({
    changed: false,
    previousLastProcessedUpdateId: 1,
    nextLastProcessedUpdateId: 1,
    updatesFetched: 0,
    batchResults: [
      { batchId: 'queued' },
      { batchId: 'processing', status: 'processing' },
      { batchId: 'ready', status: 'ready' },
      { batchId: 'stored', status: 'ready', persistenceStatus: 'stored' },
      { batchId: 'skipped', status: 'skipped' },
      { batchId: 'deferred', status: 'ready', recognitionPendingStatus: 'queued' },
      { batchId: 'partial', status: 'ready', partialFailure: true },
      { batchId: 'resolved', status: 'ready', recognitionPendingStatus: 'resolved' },
      { batchId: 'failed', status: 'failed' },
    ],
  });

  assert.deepEqual(
    report.batches.map((batch) => batch.taskStatus),
    [
      'queued',
      'processing',
      'ready',
      'stored',
      'skipped',
      'deferred',
      'partialFailure',
      'resolved',
      'failed',
    ],
  );
});

test('runTelegramSync skips runtime NDJSON pending by default after DB-only pending is enabled', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-replay-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  await import('node:fs/promises').then(({ mkdir, writeFile }) =>
    mkdir(runtimeDir, { recursive: true }).then(() =>
      writeFile(
        path.join(runtimeDir, 'telegram-sync-pending.ndjson'),
        `${JSON.stringify({
          batch: {
            batchId: 'pending-batch',
            status: 'ready',
            archivedDate: '2026-05-08',
            measurement: null,
            activities: [],
            workoutDailySummary: null,
            nutrition: {
              meals: [{ name: '晚餐', calories: 800, recommendedMin: 300, recommendedMax: 700 }],
              totalCalories: 800,
              details: ['旧待同步晚餐 800 千卡'],
            },
            warnings: [],
            issues: [],
            confidence: 0.9,
            updateIds: [899],
            recognitions: [],
            messages: [],
          },
          failedAt: '2026-05-13T00:00:00.000Z',
        })}\n`,
        'utf8',
      ),
    ),
  );

  const persistedBatchIds = [];
  const backfillCalls = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatchIds.push(batch.batchId);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run when legacy NDJSON pending is skipped');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run when legacy NDJSON pending is skipped');
    },
    backfillCoreSleepFromIngestBatches: async () => {
      throw new Error('sleep backfill should not run when legacy NDJSON pending is skipped');
    },
  });

  assert.equal(result.changed, false);
  assert.deepEqual(persistedBatchIds, []);
  assert.equal(
    await readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'),
    `${JSON.stringify({
      batch: {
        batchId: 'pending-batch',
        status: 'ready',
        archivedDate: '2026-05-08',
        measurement: null,
        activities: [],
        workoutDailySummary: null,
        nutrition: {
          meals: [{ name: '晚餐', calories: 800, recommendedMin: 300, recommendedMax: 700 }],
          totalCalories: 800,
          details: ['旧待同步晚餐 800 千卡'],
        },
        warnings: [],
        issues: [],
        confidence: 0.9,
        updateIds: [899],
        recognitions: [],
        messages: [],
      },
      failedAt: '2026-05-13T00:00:00.000Z',
    })}\n`,
  );
});

test('runTelegramSync can explicitly replay legacy runtime NDJSON pending batches', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-replay-legacy-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  const originalPendingContent = `${JSON.stringify({
    batch: {
      batchId: 'pending-batch',
      status: 'ready',
      archivedDate: '2026-05-08',
      measurement: null,
      activities: [],
      workoutDailySummary: null,
      nutrition: {
        meals: [{ name: '晚餐', calories: 800, recommendedMin: 300, recommendedMax: 700 }],
        totalCalories: 800,
        details: ['旧待同步晚餐 800 千卡'],
      },
      warnings: [],
      issues: [],
      confidence: 0.9,
      updateIds: [899],
      recognitions: [],
      messages: [],
    },
    failedAt: '2026-05-13T00:00:00.000Z',
  })}\n`;
  await import('node:fs/promises').then(({ mkdir, writeFile }) =>
    mkdir(runtimeDir, { recursive: true }).then(() =>
      writeFile(
        path.join(runtimeDir, 'telegram-sync-pending.ndjson'),
        originalPendingContent,
        'utf8',
      ),
    ),
  );

  const persistedBatchIds = [];
  const backfillCalls = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    now: new Date('2026-05-14T08:09:10.011Z'),
    env: {
      ...telegramSyncEnv(),
      TELEGRAM_SYNC_REPLAY_LEGACY_NDJSON_PENDING: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatchIds.push(batch.batchId);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-13T00:00:00.000Z',
      latest: {
        measurement: null,
        daily: { date: '2026-05-08' },
      },
      daily: [
        {
          date: '2026-05-08',
          measurement: null,
          measurements: [],
          activities: [],
          workoutSummary: {
            totalActivities: 0,
            totalDurationSeconds: 0,
            trainingCalories: 0,
            workoutDurationMinutes: null,
            activeHours: null,
            cyclingDistanceKm: 0,
            countsByType: {},
          },
          nutrition: {
            meals: [{ name: '晚餐', calories: 800, recommendedMin: 300, recommendedMax: 700 }],
            totalCalories: 800,
            details: ['旧待同步晚餐 800 千卡'],
          },
        },
      ],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-08\n',
    backfillCoreSleepFromIngestBatches: async (input) => {
      backfillCalls.push(input);
      return { status: 'synced' };
    },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(persistedBatchIds, ['pending-batch']);
  assert.equal(backfillCalls.length, 0);
  assert.equal(
    await readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'),
    '',
  );
  const runtimeFiles = await readdir(runtimeDir);
  const backupFiles = runtimeFiles.filter((file) =>
    file.startsWith('telegram-sync-pending.ndjson.backup-')
  );
  assert.deepEqual(backupFiles, ['telegram-sync-pending.ndjson.backup-20260514T080910011Z']);
  assert.equal(
    await readFile(path.join(runtimeDir, backupFiles[0]), 'utf8'),
    originalPendingContent,
  );
});

test('runTelegramSync reads database pending queues before new updates without auto-consuming runtime NDJSON', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-dual-pending-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, 'telegram-sync-pending.ndjson'),
    `${JSON.stringify({
      batch: {
        kind: 'image',
        batchId: 'ndjson-pending',
        status: 'ready',
        archivedDate: '2026-05-08',
        measurement: null,
        activities: [],
        workoutDailySummary: null,
        nutrition: {
          meals: [{ name: '晚餐', calories: 800, recommendedMin: 300, recommendedMax: 700 }],
          totalCalories: 800,
          details: ['旧待同步晚餐 800 千卡'],
        },
        warnings: [],
        issues: [],
        confidence: 0.9,
        updateIds: [899],
        recognitions: [],
        messages: [],
      },
      failedAt: '2026-05-13T00:00:00.000Z',
    })}\n`,
    'utf8',
  );

  const persistedBatchIds = [];
  const resolved = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [],
    readPendingRecognitionBatches: async () => [
      {
        batchId: 'db-pending',
        batch: {
          kind: 'image',
          batchId: 'db-pending',
          messages: [
            {
              messageId: 383,
              updateId: 901,
              mediaGroupId: null,
              caption: '',
              text: '',
              chatId: 42,
              dateUnix: Math.floor(new Date('2026-05-31T03:00:00Z').getTime() / 1000),
              photos: [{ fileId: 'file-food-383', fileUniqueId: 'uniq-food-383', source: 'photo' }],
            },
          ],
        },
      },
    ],
    recognizeBatch: async () => ({
      recognitions: [
        {
          messageId: 383,
          imageType: 'nutrition',
          detectedDate: '2026-05-31',
          dateEvidence: 'image header',
          confidence: 0.97,
          warnings: [],
          records: {
            measurement: null,
            activities: [],
            meals: [{ name: '晚餐', calories: 868, recommendedMin: 310, recommendedMax: 723 }],
            totalCalories: 868,
            details: ['晚餐 868 千卡'],
            dailyWorkoutSummary: null,
          },
        },
      ],
      recognitionErrors: [],
    }),
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatchIds.push(batch.batchId);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    markPendingRecognitionResolved: async ({ batchId }) => {
      resolved.push(batchId);
      return { status: 'resolved', batchId };
    },
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
  });

  assert.equal(result.updatesFetched, 0);
  assert.deepEqual(persistedBatchIds, ['db-pending']);
  assert.deepEqual(resolved, ['db-pending']);
  assert.deepEqual(
    result.batchResults.map((batch) => [batch.batchId, batch.persistenceStatus, batch.pendingReplay ?? false]),
    [
      ['db-pending', 'stored', true],
    ],
  );
  assert.match(
    await readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'),
    /ndjson-pending/,
  );
});

test('runTelegramSync processes updates from repository dispatch payload without polling Telegram', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-dispatch-'));
  let fetchCalled = false;
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_EVENT_PATH: path.join(tempRoot, 'dispatch-event.json'),
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => {
      fetchCalled = true;
      return [];
    },
    repositoryDispatchEvent: {
      client_payload: {
        telegram_update: {
          update_id: 901,
          message: {
            message_id: 71,
            media_group_id: 'album-dispatch',
            date: 1746748800,
            chat: { id: 42 },
            caption: '归档到 2026-05-09',
            photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
          },
        },
      },
    },
    recognizeBatch: async () => [
      {
        messageId: 71,
        imageType: 'nutrition',
        detectedDate: '2026-05-09',
        dateEvidence: 'image header',
        confidence: 0.96,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 }],
          totalCalories: 1593,
          details: ['晚餐 1065 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-13T00:00:00.000Z',
      latest: {
        measurement: null,
        daily: { date: '2026-05-09' },
      },
      daily: [
        {
          date: '2026-05-09',
          measurement: null,
          measurements: [],
          activities: [],
          workoutSummary: {
            totalActivities: 0,
            totalDurationSeconds: 0,
            trainingCalories: 0,
            workoutDurationMinutes: null,
            activeHours: null,
            cyclingDistanceKm: 0,
            countsByType: {},
          },
          nutrition: {
            meals: [{ name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 }],
            totalCalories: 1593,
            details: ['晚餐 1065 千卡'],
          },
        },
      ],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-09\n',
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.changed, true);
  assert.equal(result.updatesFetched, 1);
  assert.equal(result.lastProcessedUpdateId, 901);
  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].archivedDate, '2026-05-09');
  await assert.rejects(readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /ENOENT/);
});

test('runTelegramSync processes repository dispatch updates when database offset read times out', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-dispatch-db-timeout-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_EVENT_PATH: path.join(tempRoot, 'dispatch-event.json'),
    },
    getLastProcessedUpdateId: async () => {
      throw new Error('timeout expired');
    },
    repositoryDispatchEvent: {
      client_payload: {
        telegram_update: {
          update_id: 901,
          message: {
            message_id: 71,
            media_group_id: 'album-dispatch-timeout',
            date: 1746748800,
            chat: { id: 42 },
            caption: '归档到 2026-05-09',
            photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
          },
        },
      },
    },
    recognizeBatch: async () => [
      {
        messageId: 71,
        imageType: 'nutrition',
        detectedDate: '2026-05-09',
        dateEvidence: 'image header',
        confidence: 0.96,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 }],
          totalCalories: 1593,
          details: ['晚餐 1065 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-13T00:00:00.000Z',
      latest: {
        measurement: null,
        daily: { date: '2026-05-09' },
      },
      daily: [
        {
          date: '2026-05-09',
          measurement: null,
          measurements: [],
          activities: [],
          workoutSummary: {
            totalActivities: 0,
            totalDurationSeconds: 0,
            trainingCalories: 0,
            workoutDurationMinutes: null,
            activeHours: null,
            cyclingDistanceKm: 0,
            countsByType: {},
          },
          nutrition: {
            meals: [{ name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 }],
            totalCalories: 1593,
            details: ['晚餐 1065 千卡'],
          },
        },
      ],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-09\n',
  });

  assert.equal(result.changed, true);
  assert.equal(result.updatesFetched, 1);
  assert.equal(result.lastProcessedUpdateId, 901);
  assert.equal(persistedBatches.length, 1);
});

test('runTelegramSync uses document filename date when recognition has no image date', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-filename-date-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_EVENT_PATH: path.join(tempRoot, 'dispatch-event.json'),
    },
    getLastProcessedUpdateId: async () => 900,
    repositoryDispatchEvent: {
      client_payload: {
        telegram_update: {
          update_id: 901,
          message: {
            message_id: 81,
            date: Math.floor(new Date('2026-05-14T07:55:00Z').getTime() / 1000),
            chat: { id: 42 },
            document: {
              file_id: 'file-nutrition',
              file_unique_id: 'uniq-nutrition',
              file_name: '饮食记录 2026-05-12.jpg',
              mime_type: 'image/jpeg',
            },
          },
        },
      },
    },
    recognizeBatch: async () => [
      {
        messageId: 81,
        imageType: 'nutrition',
        detectedDate: null,
        dateEvidence: 'no reliable image date',
        confidence: 0.96,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
          totalCalories: 1465,
          details: ['晚餐 465 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-14T00:00:00.000Z',
      latest: {
        measurement: null,
        daily: { date: '2026-05-12' },
      },
      daily: [
        {
          date: '2026-05-12',
          measurement: null,
          measurements: [],
          activities: [],
          workoutSummary: {
            totalActivities: 0,
            totalDurationSeconds: 0,
            trainingCalories: 0,
            workoutDurationMinutes: null,
            activeHours: null,
            cyclingDistanceKm: 0,
            countsByType: {},
          },
          nutrition: {
            meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
            totalCalories: 1465,
            details: ['晚餐 465 千卡'],
          },
        },
      ],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-12\n',
  });

  assert.equal(result.changed, true);
  assert.equal(persistedBatches[0].archivedDate, '2026-05-12');
  assert.equal(persistedBatches[0].messages[0].photos[0].fileName, '饮食记录 2026-05-12.jpg');
  assert.equal(result.batchResults[0].status, 'ready');
});

test('runTelegramSync skips an undated single nutrition screenshot without a filename date', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-undated-same-day-'));
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(
      path.join(tempRoot, '训练记录.md'),
      '# 训练记录\n\n### 2026-05-14\n\n#### 当日运动截图记录\n\n##### 当日活动总览\n\n- 活动热量：545千卡\n- 锻炼时长：60分钟\n',
      'utf8',
    ),
  );
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_EVENT_PATH: path.join(tempRoot, 'dispatch-event.json'),
    },
    getLastProcessedUpdateId: async () => 900,
    repositoryDispatchEvent: {
      client_payload: {
        telegram_update: {
          update_id: 901,
          message: {
            message_id: 81,
            date: Math.floor(new Date('2026-05-14T07:55:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-nutrition', file_unique_id: 'uniq-nutrition' }],
          },
        },
      },
    },
    recognizeBatch: async () => [
      {
        messageId: 81,
        imageType: 'nutrition',
        detectedDate: null,
        dateEvidence: 'no reliable image date',
        confidence: 0.96,
        warnings: ['No reliable image date found.'],
        records: {
          measurement: null,
          activities: [],
          meals: [{ name: '晚餐', calories: 465, recommendedMin: 309, recommendedMax: 721 }],
          totalCalories: 1465,
          details: ['晚餐 465 千卡'],
          dailyWorkoutSummary: null,
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('database snapshot is empty or missing measurements');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(persistedBatches.length, 0);
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.match(result.batchResults[0].reason, /no reliable image or filename date/i);
  assert.match(result.batchResults[0].warnings.join('\n'), /photo 形式发送/);
  assert.equal(buildTelegramSyncReport(result).batches[0].failureDisposition, 'manual_intervention');
  assert.doesNotMatch(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /晚餐：465千卡/);
});

test('runTelegramSync skips polling when webhook mode is enabled without dispatch payload', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-webhook-mode-'));
  let fetchCalled = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_TRANSPORT: 'webhook',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => {
      fetchCalled = true;
      return [];
    },
    persistNormalizedBatch: async () => {
      throw new Error('persist should not be called when no updates exist');
    },
    exportTrainingMarkdown: () => {
      throw new Error('export should not be called when nothing changed');
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.changed, false);
  assert.equal(result.updatesFetched, 0);
  assert.equal(result.lastProcessedUpdateId, 900);
});

test('runTelegramSync stores a /thought telegram message in core without writing a post', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      ...telegramSyncEnv(),
      TELEGRAM_SYNC_REPLAY_LEGACY_NDJSON_PENDING: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 501,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/thought 今天训练后臀部发力更明显\n感觉动作路线更顺了',
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].kind, 'thought');
  assert.equal(persistedBatches[0].thought.thoughtModule, 'workout');
  assert.equal(persistedBatches[0].thought.storage.markdownPath, null);
  assert.deepEqual(persistedBatches[0].thought.storage.photoPaths, []);
  assert.match(persistedBatches[0].thought.body, /今天训练后臀部发力更明显/);
  assert.match(persistedBatches[0].thought.body, /感觉动作路线更顺了/);
  await assert.rejects(
    readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-501.md'), 'utf8'),
    /ENOENT/,
  );
});

test('runTelegramSync stores markdown document content as the thought body', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-md-'));
  const persistedBatches = [];
  const downloadedFileIds = [];
  let recognized = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 503,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想 这段 caption 正文应该被 Markdown 附件覆盖',
          document: {
            file_id: 'markdown-file-503',
            file_unique_id: 'markdown-uniq-503',
            file_name: '训练随想.md',
            mime_type: 'text/markdown',
            file_size: 128,
          },
        },
      },
    ],
    recognizeBatch: async () => {
      recognized = true;
      return [];
    },
    fetchTelegramFile: async (fileId) => {
      downloadedFileIds.push(fileId);
      return {
        filePath: 'documents/训练随想.md',
        contentType: 'text/markdown',
        data: Buffer.from('\uFEFF# Markdown 标题\n\n- 动作更稳\n', 'utf8'),
      };
    },
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
  });

  assert.equal(recognized, false);
  assert.deepEqual(downloadedFileIds, ['markdown-file-503']);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].thought.body, '# Markdown 标题\n\n- 动作更稳');
});

test('runTelegramSync accepts markdown thought attachments larger than 1MB up to the configured limit', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-md-5mb-'));
  const persistedBatches = [];
  const largeMarkdownBody = `# 大随想\n\n${'动作记录\n'.repeat(140_000)}`;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 508,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想',
          document: {
            file_id: 'markdown-file-508',
            file_unique_id: 'markdown-uniq-508',
            file_name: '大随想.md',
            mime_type: 'text/markdown',
            file_size: Buffer.byteLength(largeMarkdownBody, 'utf8'),
          },
        },
      },
    ],
    fetchTelegramFile: async () => ({
      filePath: 'documents/大随想.md',
      contentType: 'text/markdown',
      data: Buffer.from(largeMarkdownBody, 'utf8'),
    }),
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
  });

  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches.length, 1);
  assert.equal(Buffer.byteLength(persistedBatches[0].thought.body, 'utf8') > 1024 * 1024, true);
  assert.equal(persistedBatches[0].thought.body.startsWith('# 大随想'), true);
});

test('runTelegramSync allows module-only captions when a markdown document supplies the body', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-md-module-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 504,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想 身体反馈',
          document: {
            file_id: 'markdown-file-504',
            file_unique_id: 'markdown-uniq-504',
            file_name: '身体反馈.md',
            mime_type: 'text/plain',
            file_size: 64,
          },
        },
      },
    ],
    fetchTelegramFile: async () => ({
      filePath: 'documents/身体反馈.md',
      contentType: 'text/plain',
      data: Buffer.from('## 腰背反馈\n\n今天硬拉后右侧腰背有点刺痛', 'utf8'),
    }),
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
  });

  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches[0].thought.thoughtModule, 'body_feedback');
  assert.equal(persistedBatches[0].thought.body, '## 腰背反馈\n\n今天硬拉后右侧腰背有点刺痛');
});

test('runTelegramSync rejects empty markdown thought attachments before persistence', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-md-empty-'));
  let persisted = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 505,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想',
          document: {
            file_id: 'markdown-file-505',
            file_unique_id: 'markdown-uniq-505',
            file_name: '空随想.md',
            mime_type: 'text/markdown',
            file_size: 8,
          },
        },
      },
    ],
    fetchTelegramFile: async () => ({
      filePath: 'documents/空随想.md',
      contentType: 'text/markdown',
      data: Buffer.from(' \n\t', 'utf8'),
    }),
    persistNormalizedBatch: async () => {
      persisted = true;
      return { status: 'stored' };
    },
  });

  assert.equal(persisted, false);
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'failed');
  assert.match(result.batchResults[0].failureReason, /empty markdown attachment/i);
});

test('runTelegramSync rejects oversized markdown thought attachments before download', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-md-large-'));
  let downloaded = false;
  let persisted = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 506,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想',
          document: {
            file_id: 'markdown-file-506',
            file_unique_id: 'markdown-uniq-506',
            file_name: '过大的随想.md',
            mime_type: 'text/markdown',
            file_size: 5 * 1024 * 1024 + 1,
          },
        },
      },
    ],
    fetchTelegramFile: async () => {
      downloaded = true;
      return {
        filePath: 'documents/过大的随想.md',
        contentType: 'text/markdown',
        data: Buffer.from('# too large', 'utf8'),
      };
    },
    persistNormalizedBatch: async () => {
      persisted = true;
      return { status: 'stored' };
    },
  });

  assert.equal(downloaded, false);
  assert.equal(persisted, false);
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'failed');
  assert.match(result.batchResults[0].failureReason, /markdown attachment too large/i);
});

test('runTelegramSync reports markdown thought attachment download failures', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-md-download-'));
  let persisted = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 507,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想',
          document: {
            file_id: 'markdown-file-507',
            file_unique_id: 'markdown-uniq-507',
            file_name: '下载失败.md',
            mime_type: 'text/markdown',
            file_size: 64,
          },
        },
      },
    ],
    fetchTelegramFile: async () => {
      throw new Error('Telegram file download failed with HTTP 500');
    },
    persistNormalizedBatch: async () => {
      persisted = true;
      return { status: 'stored' };
    },
  });

  assert.equal(persisted, false);
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[0].failureCategory, 'telegram_api');
  assert.match(result.batchResults[0].failureReason, /Telegram file download failed/i);
});

test('runTelegramSync writes /随想 image artifacts and stores core thought metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-photo-'));
  const persistedBatches = [];
  const downloadedFileIds = [];
  let recognized = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 502,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想 今天深蹲动作轨迹更稳了',
          photo: [
            {
              file_id: 'photo-small',
              file_unique_id: 'photo-small-u',
              width: 320,
              height: 240,
              file_size: 1000,
            },
            {
              file_id: 'photo-large',
              file_unique_id: 'photo-large-u',
              width: 1280,
              height: 960,
              file_size: 9000,
            },
          ],
        },
      },
    ],
    recognizeBatch: async () => {
      recognized = true;
      return [];
    },
    fetchTelegramFile: async (fileId) => {
      downloadedFileIds.push(fileId);
      return {
        filePath: 'photos/file_502.jpg',
        contentType: 'image/jpeg',
        data: Buffer.from('fake image content'),
      };
    },
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  const imagePath = path.join(
    tempRoot,
    'source',
    'images',
    'thoughts',
    '2026',
    '05',
    '2026-05-14-telegram-thought-502-1.jpg',
  );

  assert.equal(result.changed, true);
  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].thought.command, '/随想');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'images_written');
  assert.equal(recognized, false);
  assert.deepEqual(downloadedFileIds, ['photo-large']);
  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].kind, 'thought');
  assert.equal(persistedBatches[0].thought.storage.markdownPath, null);
  assert.deepEqual(persistedBatches[0].thought.storage.photoPaths, [
    '/images/thoughts/2026/05/2026-05-14-telegram-thought-502-1.jpg',
  ]);
  assert.match(persistedBatches[0].thought.body, /今天深蹲动作轨迹更稳了/);
  assert.equal(await readFile(imagePath, 'utf8'), 'fake image content');
  await assert.rejects(readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-502.md'), 'utf8'), /ENOENT/);
});

test('runTelegramSync stores COS image URLs from injected image storage in core thought metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-cos-'));
  const persistedBatches = [];
  const uploadedItems = [];
  const cosUrl = 'https://training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com/dev/thoughts/2026/05/2026-05-14-telegram-thought-508-1.jpg';
  const imageStorage = {
    provider: 'tencent_cos',
    lastUploadStats: null,
    async upload(items) {
      uploadedItems.push(...items);
      this.lastUploadStats = {
        provider: 'tencent_cos',
        bucket: 'training-images-dev-1250000000',
        pathPrefix: 'dev',
        uploaded: 1,
        skipped: 0,
        failed: 0,
        totalUploadMs: 12,
        maxSingleUploadMs: 12,
        firstUrlHost: 'training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com',
      };
      return [cosUrl];
    },
  };

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    imageStorage,
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 508,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想 COS 图片落库',
          photo: [{ file_id: 'photo-cos', file_unique_id: 'photo-cos-u' }],
        },
      },
    ],
    recognizeBatch: async () => [],
    fetchTelegramFile: async () => ({
      filePath: 'photos/file_508.jpg',
      contentType: 'image/jpeg',
      data: Buffer.from('cos image content'),
    }),
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'images_written');
  assert.deepEqual(persistedBatches[0].thought.storage.photoPaths, [cosUrl]);
  assert.equal(uploadedItems.length, 1);
  assert.deepEqual(
    {
      extension: uploadedItems[0].extension,
      channelSlug: uploadedItems[0].channelSlug,
      sourceMessageId: uploadedItems[0].sourceMessageId,
      index: uploadedItems[0].index,
      date: uploadedItems[0].dateParts.date,
    },
    {
      extension: '.jpg',
      channelSlug: 'telegram',
      sourceMessageId: 508,
      index: 1,
      date: '2026-05-14',
    },
  );
  assert.deepEqual(persistedBatches[0].thought.storage.imageUploadStats, {
    provider: 'tencent_cos',
    bucket: 'training-images-dev-1250000000',
    pathPrefix: 'dev',
    uploaded: 1,
    skipped: 0,
    failed: 0,
    totalUploadMs: 12,
    maxSingleUploadMs: 12,
    firstUrlHost: 'training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com',
  });
  assert.equal(result.batchResults[0].thought.storage.imageUploadStats?.provider, 'tencent_cos');
});

test('runTelegramSync does not persist thought metadata when image storage upload fails', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-cos-fail-'));
  let persisted = false;

  await assert.rejects(
    runTelegramSync({
      rootDir: tempRoot,
      env: telegramSyncEnv(),
      imageStorage: {
        provider: 'tencent_cos',
        async upload() {
          throw new Error('COS PutObject failed: AccessDenied');
        },
      },
      getLastProcessedUpdateId: async () => 900,
      fetchTelegramUpdates: async () => [
        {
          update_id: 901,
          message: {
            message_id: 509,
            date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
            chat: { id: 42 },
            caption: '/随想 COS 上传失败',
            photo: [{ file_id: 'photo-cos-fail', file_unique_id: 'photo-cos-fail-u' }],
          },
        },
      ],
      recognizeBatch: async () => [],
      fetchTelegramFile: async () => ({
        filePath: 'photos/file_509.jpg',
        contentType: 'image/jpeg',
        data: Buffer.from('cos image content'),
      }),
      persistNormalizedBatch: async () => {
        persisted = true;
        return { status: 'stored' };
      },
    }),
    /COS PutObject failed: AccessDenied/,
  );

  assert.equal(persisted, false);
});

test('createImageStorage uploads thought images to COS with stable keys and returns public URLs', async () => {
  const calls = [];
  const storage = createImageStorage({
    env: {
      COS_ENABLED: 'true',
      COS_PROVIDER: 'tencent_cos',
      COS_SECRET_ID: 'secret-id',
      COS_SECRET_KEY: 'secret-key',
      COS_BUCKET: 'training-images-dev-1250000000',
      COS_REGION: 'ap-shanghai',
      COS_DOMAIN: 'https://training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com',
      COS_PATH_PREFIX: 'dev',
    },
    rootDir: process.cwd(),
    createCosClient() {
      return {
        headObject(input, callback) {
          calls.push(['headObject', input]);
          const error = new Error('not found');
          error.statusCode = 404;
          callback(error);
        },
        putObject(input, callback) {
          calls.push(['putObject', input]);
          callback(null, { ETag: '"etag"' });
        },
      };
    },
  });

  const urls = await storage.upload([
    {
      data: Buffer.from('image'),
      extension: '.jpg',
      channelSlug: 'telegram',
      dateParts: { date: '2026-05-14' },
      sourceMessageId: 508,
      index: 1,
    },
  ]);

  const key = 'dev/thoughts/2026/05/2026-05-14-telegram-thought-508-1.jpg';
  assert.equal(storage.provider, 'tencent_cos');
  assert.deepEqual(urls, [
    `https://training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com/${key}`,
  ]);
  assert.equal(calls[0][0], 'headObject');
  assert.equal(calls[0][1].Key, key);
  assert.equal(calls[1][0], 'putObject');
  assert.equal(calls[1][1].Key, key);
  assert.equal(calls[1][1].ContentType, 'image/jpeg');
  assert.deepEqual(
    {
      provider: storage.lastUploadStats.provider,
      bucket: storage.lastUploadStats.bucket,
      pathPrefix: storage.lastUploadStats.pathPrefix,
      uploaded: storage.lastUploadStats.uploaded,
      skipped: storage.lastUploadStats.skipped,
      failed: storage.lastUploadStats.failed,
      firstUrlHost: storage.lastUploadStats.firstUrlHost,
    },
    {
      provider: 'tencent_cos',
      bucket: 'training-images-dev-1250000000',
      pathPrefix: 'dev',
      uploaded: 1,
      skipped: 0,
      failed: 0,
      firstUrlHost: 'training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com',
    },
  );
});

test('createImageStorage records skipped uploads when COS HeadObject finds existing object', async () => {
  const calls = [];
  const storage = createImageStorage({
    env: {
      COS_ENABLED: 'true',
      COS_PROVIDER: 'tencent_cos',
      COS_SECRET_ID: 'secret-id',
      COS_SECRET_KEY: 'secret-key',
      COS_BUCKET: 'training-images-dev-1250000000',
      COS_REGION: 'ap-shanghai',
      COS_DOMAIN: 'https://training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com',
      COS_PATH_PREFIX: 'dev',
    },
    rootDir: process.cwd(),
    createCosClient() {
      return {
        headObject(input, callback) {
          calls.push(['headObject', input]);
          callback(null, { headers: { 'content-length': '1234' } });
        },
        putObject(input, callback) {
          calls.push(['putObject', input]);
          callback(null, { ETag: '"etag"' });
        },
      };
    },
  });

  const urls = await storage.upload([
    {
      data: Buffer.from('image'),
      extension: '.jpg',
      channelSlug: 'telegram',
      dateParts: { date: '2026-05-14' },
      sourceMessageId: 511,
      index: 1,
    },
  ]);

  const key = 'dev/thoughts/2026/05/2026-05-14-telegram-thought-511-1.jpg';
  assert.deepEqual(urls, [
    `https://training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com/${key}`,
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'headObject');
  assert.equal(storage.lastUploadStats.uploaded, 0);
  assert.equal(storage.lastUploadStats.skipped, 1);
  assert.equal(storage.lastUploadStats.failed, 0);
});

test('createImageStorage fails fast when COS_DOMAIN does not match the default COS domain format', () => {
  assert.throws(
    () => createImageStorage({
      env: {
        COS_ENABLED: 'true',
        COS_PROVIDER: 'tencent_cos',
        COS_SECRET_ID: 'secret-id',
        COS_SECRET_KEY: 'secret-key',
        COS_BUCKET: 'training-images-dev-1250000000',
        COS_REGION: 'ap-shanghai',
        COS_DOMAIN: 'https://img-dev.soulgo.chat',
        COS_PATH_PREFIX: 'dev',
      },
      rootDir: process.cwd(),
    }),
    /default COS domain format/,
  );
});

test('createImageStorage treats transient initial COS HeadObject failures as upload attempts', async () => {
  const calls = [];
  const storage = createImageStorage({
    env: {
      COS_ENABLED: 'true',
      COS_PROVIDER: 'tencent_cos',
      COS_SECRET_ID: 'secret-id',
      COS_SECRET_KEY: 'secret-key',
      COS_BUCKET: 'training-images-dev-1250000000',
      COS_REGION: 'ap-shanghai',
      COS_DOMAIN: 'https://training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com',
      COS_PATH_PREFIX: 'dev',
    },
    rootDir: process.cwd(),
    createCosClient() {
      return {
        headObject(input, callback) {
          calls.push(['headObject', input]);
          const error = new Error('socket timeout');
          error.code = 'ETIMEDOUT';
          callback(error);
        },
        putObject(input, callback) {
          calls.push(['putObject', input]);
          callback(null, { ETag: '"etag"' });
        },
      };
    },
  });

  await storage.upload([
    {
      data: Buffer.from('image'),
      extension: '.png',
      channelSlug: 'telegram',
      dateParts: { date: '2026-05-14' },
      sourceMessageId: 510,
      index: 1,
    },
  ]);

  assert.deepEqual(calls.map(([name]) => name), ['headObject', 'putObject']);
});

test('createImageStorage fails fast when COS is enabled without required configuration', () => {
  assert.throws(
    () => createImageStorage({
      env: {
        COS_ENABLED: 'true',
        COS_PROVIDER: 'tencent_cos',
        COS_SECRET_ID: 'secret-id',
      },
      rootDir: process.cwd(),
    }),
    /Missing required COS configuration: COS_SECRET_KEY/,
  );
});

test('runTelegramSync stores module-scoped /随想 metadata in core payload', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-misc-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 503,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想 杂七杂八 今天把零碎事情记一下',
          photo: [{ file_id: 'photo-misc', file_unique_id: 'photo-misc-u' }],
        },
      },
    ],
    recognizeBatch: async () => [],
    fetchTelegramFile: async () => ({
      filePath: 'misc/file_503.jpg',
      contentType: 'image/jpeg',
      data: Buffer.from('fake image content'),
    }),
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(result.batchResults[0].thought.thoughtModule, 'misc');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'images_written');
  assert.equal(persistedBatches[0].thought.thoughtModule, 'misc');
  assert.deepEqual(persistedBatches[0].thought.tags, ['杂七杂八', '随想', 'Telegram']);
  await assert.rejects(readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-503.md'), 'utf8'), /ENOENT/);
});

test('runTelegramSync stores body feedback /随想 metadata in core payload', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-body-feedback-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 504,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/随想 身体反馈 今天硬拉后右侧腰背有点刺痛',
        },
      },
    ],
    recognizeBatch: async () => {
      throw new Error('recognizeBatch should not run for thought-only sync');
    },
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(result.batchResults[0].thought.thoughtModule, 'body_feedback');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_database_only');
  assert.equal(persistedBatches[0].thought.thoughtModule, 'body_feedback');
  assert.deepEqual(persistedBatches[0].thought.tags, ['身体反馈', '随想', 'Telegram']);
  assert.match(persistedBatches[0].thought.body, /今天硬拉后右侧腰背有点刺痛/);
  await assert.rejects(readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-504.md'), 'utf8'), /ENOENT/);
});

test('runTelegramSync writes /thought album images as artifacts only', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-album-'));
  const downloadedFileIds = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 601,
          media_group_id: 'album-thought',
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/thought 训练姿态记录',
          photo: [{ file_id: 'album-photo-a', file_unique_id: 'album-photo-a-u' }],
        },
      },
      {
        update_id: 902,
        message: {
          message_id: 602,
          media_group_id: 'album-thought',
          date: Math.floor(new Date('2026-05-14T02:30:01Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'album-photo-b', file_unique_id: 'album-photo-b-u' }],
        },
      },
    ],
    fetchTelegramFile: async (fileId) => {
      downloadedFileIds.push(fileId);
      return {
        filePath: `${fileId}.png`,
        contentType: 'image/png',
        data: Buffer.from(fileId),
      };
    },
    persistNormalizedBatch: async () => ({ status: 'stored', archivedDate: null }),
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].batchId, 'thought-601');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'images_written');
  assert.deepEqual(downloadedFileIds, ['album-photo-a', 'album-photo-b']);
  assert.deepEqual(result.batchResults[0].thought.storage.photoPaths, [
    '/images/thoughts/2026/05/2026-05-14-telegram-thought-601-1.png',
    '/images/thoughts/2026/05/2026-05-14-telegram-thought-601-2.png',
  ]);
  assert.equal(
    await readFile(path.join(tempRoot, 'source', 'images', 'thoughts', '2026', '05', '2026-05-14-telegram-thought-601-1.png'), 'utf8'),
    'album-photo-a',
  );
  assert.equal(
    await readFile(path.join(tempRoot, 'source', 'images', 'thoughts', '2026', '05', '2026-05-14-telegram-thought-601-2.png'), 'utf8'),
    'album-photo-b',
  );
  await assert.rejects(readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-601.md'), 'utf8'), /ENOENT/);
});

test('runTelegramSync ignores existing markdown posts when storing new core thoughts', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-duplicate-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  await import('node:fs/promises').then(({ mkdir, writeFile }) =>
    mkdir(postsDir, { recursive: true }).then(() =>
      writeFile(
        path.join(postsDir, '2026-05-14-telegram-thought-501.md'),
        'original thought content\n',
        'utf8',
      ),
    ),
  );

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 501,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/thought 今天训练后臀部发力更明显',
        },
      },
    ],
    persistNormalizedBatch: async () => ({ status: 'stored', archivedDate: null }),
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_database_only');
  assert.equal(
    await readFile(path.join(postsDir, '2026-05-14-telegram-thought-501.md'), 'utf8'),
    'original thought content\n',
  );
});

test('runTelegramSync updates an existing telegram thought when the original message is edited', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-edit-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  await import('node:fs/promises').then(({ mkdir, writeFile }) =>
    mkdir(postsDir, { recursive: true }).then(() =>
      writeFile(
        path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
        `---
date: 2026-05-17 11:28:14
tags:
  - 训练
  - 随想
  - Telegram
thought_module: misc
telegram_message_id: 126
telegram_chat_id: 42
---

旧正文
`,
        'utf8',
      ),
    ),
  );

  const persistedBatches = [];
  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        edited_message: {
          message_id: 126,
          date: Math.floor(new Date('2026-05-17T03:40:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '今天骑行 40 公里，动作更顺',
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return {
        status: 'stored',
        archivedDate: batch.archivedDate,
        messageId: batch.thoughtEdit.targetMessageId,
        thoughtModule: 'misc',
      };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  const postContent = await readFile(
    path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
    'utf8',
  );

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_edit_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(result.batchResults[0].persistedThoughtModule, 'misc');
  assert.equal(persistedBatches[0].kind, 'thought_edit');
  assert.equal(persistedBatches[0].thoughtEdit.storage.markdownPath, null);
  assert.deepEqual(persistedBatches[0].thoughtEdit.storage.photoPaths, []);
  assert.equal(persistedBatches[0].thoughtEdit.thoughtModule, null);
  assert.equal(persistedBatches[0].thoughtEdit.tags, undefined);
  assert.match(persistedBatches[0].thoughtEdit.body, /今天骑行 40 公里，动作更顺/);
  assert.match(postContent, /thought_module: misc/);
  assert.match(postContent, /旧正文/);
});

test('runTelegramSync keeps scanning same-id thought posts until the chat id matches', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-chat-match-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  await mkdir(postsDir, { recursive: true });
  await writeFile(
    path.join(postsDir, '2026-05-16-telegram-thought-126.md'),
    `---
date: 2026-05-16 09:00:00
tags:
  - 训练
  - 随想
  - Telegram
thought_module: workout
telegram_message_id: 126
telegram_chat_id: 41
---

别的 chat 的旧正文
`,
    'utf8',
  );
  await writeFile(
    path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
    `---
date: 2026-05-17 11:28:14
tags:
  - 杂七杂八
  - 随想
  - Telegram
thought_module: misc
telegram_message_id: 126
telegram_chat_id: 42
---

目标旧正文
`,
    'utf8',
  );
  await writeFile(
    path.join(postsDir, '2026-05-17-regular-note.md'),
    `---
date: 2026-05-17 12:00:00
tags:
  - 训练
---

普通文章
`,
    'utf8',
  );

  const persistedBatches = [];
  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        edited_message: {
          message_id: 126,
          date: Math.floor(new Date('2026-05-17T03:40:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '正确 chat 的新正文',
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  const otherPostContent = await readFile(
    path.join(postsDir, '2026-05-16-telegram-thought-126.md'),
    'utf8',
  );
  const targetPostContent = await readFile(
    path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
    'utf8',
  );

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_edit_database_only');
  assert.equal(persistedBatches[0].thoughtEdit.storage.markdownPath, null);
  assert.match(persistedBatches[0].thoughtEdit.body, /正确 chat 的新正文/);
  assert.match(otherPostContent, /别的 chat 的旧正文/);
  assert.match(targetPostContent, /目标旧正文/);
});

test('runTelegramSync updates an existing telegram thought when a reply-based revision targets it', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-reply-edit-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  await import('node:fs/promises').then(({ mkdir, writeFile }) =>
    mkdir(postsDir, { recursive: true }).then(() =>
      writeFile(
        path.join(postsDir, '2026-05-18-telegram-thought-126.md'),
        `---
date: 2026-05-18 09:59:00
tags:
  - 杂七杂八
  - 随想
  - Telegram
thought_module: misc
telegram_message_id: 126
telegram_chat_id: 42
---

旧正文
`,
        'utf8',
      ),
    ),
  );

  const persistedBatches = [];
  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 131,
          date: Math.floor(new Date('2026-05-18T02:59:00Z').getTime() / 1000),
          chat: { id: 42 },
          reply_to_message: {
            message_id: 126,
          },
          text: '/随想 今天骑行 40 公里，温地公园是一个散步的好地方，\n高德地图骑行的公里数和华为手表骑行的公里数差别太大了，差了12公里多。',
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  const postContent = await readFile(
    path.join(postsDir, '2026-05-18-telegram-thought-126.md'),
    'utf8',
  );

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_edit_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches[0].kind, 'thought_edit');
  assert.equal(persistedBatches[0].thoughtEdit.thoughtModule, null);
  assert.equal(persistedBatches[0].thoughtEdit.tags, undefined);
  assert.match(persistedBatches[0].thoughtEdit.body, /高德地图骑行的公里数和华为手表骑行的公里数差别太大了/);
  assert.match(postContent, /thought_module: misc/);
  assert.match(postContent, /tags:\n  - 杂七杂八\n  - 随想\n  - Telegram/);
  assert.match(postContent, /旧正文/);
  await assert.rejects(
    readFile(path.join(postsDir, '2026-05-18-telegram-thought-131.md'), 'utf8'),
    /ENOENT/,
  );
});

test('runTelegramSync updates an existing telegram thought by explicit id and replaces photos', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-explicit-edit-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  const imageDir = path.join(tempRoot, 'source', 'images', 'thoughts', '2026', '05');
  await mkdir(postsDir, { recursive: true });
  await mkdir(imageDir, { recursive: true });
  await writeFile(
    path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
    `---
date: 2026-05-17 11:28:14
tags:
  - 训练
  - 随想
  - Telegram
telegram_message_id: 126
telegram_chat_id: 42
photos:
  - /images/thoughts/2026/05/2026-05-17-telegram-thought-126-1.jpg
---

旧正文
`,
    'utf8',
  );
  await writeFile(
    path.join(imageDir, '2026-05-17-telegram-thought-126-1.jpg'),
    'old image',
    'utf8',
  );

  const downloadedFileIds = [];
  const persistedBatches = [];
  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 132,
          date: Math.floor(new Date('2026-05-18T02:59:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想编 126 杂七杂八 今天骑行 40 公里，补充图片',
          photo: [{ file_id: 'new-photo', file_unique_id: 'new-photo-u' }],
        },
      },
    ],
    fetchTelegramFile: async (fileId) => {
      downloadedFileIds.push(fileId);
      return {
        filePath: `${fileId}.png`,
        contentType: 'image/png',
        data: Buffer.from('new image'),
      };
    },
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  const postContent = await readFile(
    path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
    'utf8',
  );

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'images_written');
  assert.equal(persistedBatches[0].thoughtEdit.replacePhotos, true);
  assert.equal(persistedBatches[0].thoughtEdit.thoughtModule, 'misc');
  assert.deepEqual(persistedBatches[0].thoughtEdit.tags, ['杂七杂八', '随想', 'Telegram']);
  assert.deepEqual(downloadedFileIds, ['new-photo']);
  assert.match(persistedBatches[0].thoughtEdit.body, /今天骑行 40 公里，补充图片/);
  assert.match(postContent, /旧正文/);
  assert.equal(await readFile(path.join(imageDir, '2026-05-17-telegram-thought-126-1.jpg'), 'utf8'), 'old image');
  assert.equal(
    await readFile(path.join(imageDir, '2026-05-18-telegram-thought-126-1.png'), 'utf8'),
    'new image',
  );
});

test('runTelegramSync uses markdown document content as an explicit thought edit body', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-edit-md-'));
  const persistedBatches = [];
  const downloadedFileIds = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 136,
          date: Math.floor(new Date('2026-05-18T02:59:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想编 126 这段 caption 正文应该被 Markdown 附件覆盖',
          document: {
            file_id: 'markdown-edit-file-136',
            file_unique_id: 'markdown-edit-uniq-136',
            file_name: '修订随想.md',
            mime_type: 'text/markdown',
            file_size: 128,
          },
        },
      },
    ],
    fetchTelegramFile: async (fileId) => {
      downloadedFileIds.push(fileId);
      return {
        filePath: 'documents/修订随想.md',
        contentType: 'text/markdown',
        data: Buffer.from('\uFEFF# 新标题\n\n修订正文', 'utf8'),
      };
    },
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.deepEqual(downloadedFileIds, ['markdown-edit-file-136']);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_edit_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].kind, 'thought_edit');
  assert.equal(persistedBatches[0].thoughtEdit.targetMessageId, 126);
  assert.equal(persistedBatches[0].thoughtEdit.body, '# 新标题\n\n修订正文');
  assert.equal(persistedBatches[0].thoughtEdit.storage.markdownPath, null);
});

test('runTelegramSync reports missing database thought edit targets without marking the batch stored', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-edit-missing-db-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 409656527232593,
          date: Math.floor(new Date('2026-06-15T09:15:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/随想编 501 杂七杂八 编辑并移动后的正文',
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'not_found', messageId: batch.thoughtEdit.targetMessageId };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].kind, 'thought_edit');
  assert.equal(persistedBatches[0].thoughtEdit.targetMessageId, 501);
  assert.equal(persistedBatches[0].thoughtEdit.thoughtModule, 'misc');
  assert.equal(persistedBatches[0].thoughtEdit.body, '编辑并移动后的正文');
  assert.equal(result.changed, false);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[0].persistenceStatus, 'not_found');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'not_found');
  assert.match(result.batchResults[0].reason, /target thought 501 not found/i);
});

test('runTelegramSync allows module-only explicit thought edit captions when markdown supplies the body', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-edit-md-module-'));
  const persistedBatches = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 137,
          date: Math.floor(new Date('2026-05-18T02:59:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想编 126 身体反馈',
          document: {
            file_id: 'markdown-edit-file-137',
            file_unique_id: 'markdown-edit-uniq-137',
            file_name: '身体反馈修订.md',
            mime_type: 'text/markdown',
            file_size: 128,
          },
        },
      },
    ],
    fetchTelegramFile: async () => ({
      filePath: 'documents/身体反馈修订.md',
      contentType: 'text/markdown',
      data: Buffer.from('## 腰背反馈\n\n今天右侧腰背恢复正常', 'utf8'),
    }),
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches[0].thoughtEdit.thoughtModule, 'body_feedback');
  assert.deepEqual(persistedBatches[0].thoughtEdit.tags, ['身体反馈', '随想', 'Telegram']);
  assert.equal(persistedBatches[0].thoughtEdit.body, '## 腰背反馈\n\n今天右侧腰背恢复正常');
});

test('runTelegramSync rejects empty markdown explicit thought edit attachments before persistence', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-edit-md-empty-'));
  let persisted = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 138,
          date: Math.floor(new Date('2026-05-18T02:59:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想编 126',
          document: {
            file_id: 'markdown-edit-file-138',
            file_unique_id: 'markdown-edit-uniq-138',
            file_name: '空修订.md',
            mime_type: 'text/markdown',
            file_size: 8,
          },
        },
      },
    ],
    fetchTelegramFile: async () => ({
      filePath: 'documents/空修订.md',
      contentType: 'text/markdown',
      data: Buffer.from(' \n\t', 'utf8'),
    }),
    persistNormalizedBatch: async () => {
      persisted = true;
      return { status: 'stored' };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(persisted, false);
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'failed');
  assert.match(result.batchResults[0].failureReason, /empty markdown attachment/i);
});

test('runTelegramSync rejects oversized markdown explicit thought edit attachments before download', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-edit-md-large-'));
  let downloaded = false;
  let persisted = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 139,
          date: Math.floor(new Date('2026-05-18T02:59:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想编 126',
          document: {
            file_id: 'markdown-edit-file-139',
            file_unique_id: 'markdown-edit-uniq-139',
            file_name: '过大修订.md',
            mime_type: 'text/markdown',
            file_size: 5 * 1024 * 1024 + 1,
          },
        },
      },
    ],
    fetchTelegramFile: async () => {
      downloaded = true;
      return {
        filePath: 'documents/过大修订.md',
        contentType: 'text/markdown',
        data: Buffer.from('# too large', 'utf8'),
      };
    },
    persistNormalizedBatch: async () => {
      persisted = true;
      return { status: 'stored' };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(downloaded, false);
  assert.equal(persisted, false);
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[0].kind, 'thought_edit');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'failed');
  assert.match(result.batchResults[0].failureReason, /markdown attachment too large/i);
});

test('runTelegramSync deletes a telegram thought and its photos when receiving a reply delete command', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-delete-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  const imageDir = path.join(tempRoot, 'source', 'images', 'thoughts', '2026', '05');
  await import('node:fs/promises').then(({ mkdir, writeFile }) =>
    Promise.all([
      mkdir(postsDir, { recursive: true }),
      mkdir(imageDir, { recursive: true }),
    ]).then(() =>
      Promise.all([
        writeFile(
          path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
          `---
date: 2026-05-17 11:28:14
tags:
  - 训练
  - 随想
  - Telegram
telegram_message_id: 126
telegram_chat_id: 42
photos:
  - /images/thoughts/2026/05/2026-05-17-telegram-thought-126-1.jpg
---

待删除正文
`,
          'utf8',
        ),
        writeFile(
          path.join(imageDir, '2026-05-17-telegram-thought-126-1.jpg'),
          'fake image',
          'utf8',
        ),
      ]),
    ),
  );

  const persistedBatches = [];
  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 801,
          date: Math.floor(new Date('2026-05-17T03:45:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/随想删',
          reply_to_message: {
            message_id: 126,
          },
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_delete');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_delete_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches[0].kind, 'thought_delete');
  assert.equal(persistedBatches[0].thoughtDelete.storage.markdownPath, null);
  assert.deepEqual(persistedBatches[0].thoughtDelete.storage.deletedPhotoPaths, []);
  assert.match(await readFile(path.join(postsDir, '2026-05-17-telegram-thought-126.md'), 'utf8'), /待删除正文/);
  assert.equal(await readFile(path.join(imageDir, '2026-05-17-telegram-thought-126-1.jpg'), 'utf8'), 'fake image');
});

test('runTelegramSync moves a telegram thought to another module by reply command', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-move-reply-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  await mkdir(postsDir, { recursive: true });
  await writeFile(
    path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
    `---
date: 2026-05-17 11:28:14
tags:
  - 训练
  - 随想
  - Telegram
thought_module: workout
telegram_message_id: 126
telegram_chat_id: 42
---

发错模块的正文
`,
    'utf8',
  );

  const persistedBatches = [];
  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 811,
          date: Math.floor(new Date('2026-05-17T03:45:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/移动 杂七杂八',
          reply_to_message: {
            message_id: 126,
          },
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  const postContent = await readFile(
    path.join(postsDir, '2026-05-17-telegram-thought-126.md'),
    'utf8',
  );

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought_move');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_move_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches[0].kind, 'thought_move');
  assert.equal(persistedBatches[0].thoughtMove.thoughtModule, 'misc');
  assert.equal(persistedBatches[0].thoughtMove.storage.markdownPath, null);
  assert.match(postContent, /thought_module: workout/);
  assert.match(postContent, /tags:\n  - 训练\n  - 随想\n  - Telegram/);
  assert.match(postContent, /发错模块的正文/);
});

test('runTelegramSync moves a telegram thought to another module by explicit id', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-move-id-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  await mkdir(postsDir, { recursive: true });
  await writeFile(
    path.join(postsDir, '2026-05-18-telegram-thought-127.md'),
    `---
date: 2026-05-18 11:28:14
tags:
  - 杂七杂八
  - 随想
  - Telegram
thought_module: misc
telegram_message_id: 127
telegram_chat_id: 42
---

应该回到锻炼随想的正文
`,
    'utf8',
  );

  const persistedBatches = [];
  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 812,
          date: Math.floor(new Date('2026-05-18T03:45:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/移动 127 锻炼',
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  const postContent = await readFile(
    path.join(postsDir, '2026-05-18-telegram-thought-127.md'),
    'utf8',
  );

  assert.equal(result.batchResults[0].kind, 'thought_move');
  assert.equal(persistedBatches[0].thoughtMove.thoughtModule, 'workout');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_move_database_only');
  assert.match(postContent, /thought_module: misc/);
  assert.match(postContent, /tags:\n  - 杂七杂八\n  - 随想\n  - Telegram/);
  assert.match(postContent, /应该回到锻炼随想的正文/);
});

test('runTelegramSync treats /随想 id module as a move instead of creating a new thought', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-legacy-move-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  await mkdir(postsDir, { recursive: true });
  await writeFile(
    path.join(postsDir, '2026-05-22-telegram-thought-175.md'),
    `---
date: 2026-05-22 09:47:53
tags:
  - 训练
  - 随想
  - Telegram
thought_module: workout
telegram_message_id: 175
telegram_chat_id: 42
---

利用欲望让自己努力，控制欲望让自己快乐
`,
    'utf8',
  );

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 176,
          date: Math.floor(new Date('2026-05-22T06:41:03Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/随想 175 杂七杂八',
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  const targetContent = await readFile(
    path.join(postsDir, '2026-05-22-telegram-thought-175.md'),
    'utf8',
  );

  assert.equal(result.batchResults[0].kind, 'thought_move');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_move_database_only');
  assert.match(targetContent, /thought_module: workout/);
  assert.match(targetContent, /tags:\n  - 训练\n  - 随想\n  - Telegram/);
  assert.match(targetContent, /利用欲望让自己努力/);
  await assert.rejects(
    readFile(path.join(postsDir, '2026-05-22-telegram-thought-176.md'), 'utf8'),
    /ENOENT/,
  );
});

test('runTelegramSync keeps thought posts when database persistence fails and queues replay', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-fallback-'));
  const queuedPersistenceFailures = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 701,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/thought 今晚训练结束后心率回落更快了',
        },
      },
    ],
    persistNormalizedBatch: async () => {
      throw new Error('database unavailable');
    },
    appendPendingRecognitionBatch: async (entry) => {
      queuedPersistenceFailures.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought-only sync');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought-only sync');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults[0].persistenceStatus, 'pending_replay');
  await assert.rejects(
    readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-701.md'), 'utf8'),
    /ENOENT/,
  );
  assert.equal(queuedPersistenceFailures.length, 1);
  assert.equal(queuedPersistenceFailures[0].batch.batchId, 'thought-701');
  assert.equal(queuedPersistenceFailures[0].failureCategory, 'database');
  await assert.rejects(readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'), /ENOENT/);
});

test('runTelegramSync replays pending thought batches without rewriting training markdown', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-replay-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  const originalMarkdown = '# 训练记录\n\n### 2026-05-08\n\n';

  await import('node:fs/promises').then(({ mkdir, writeFile }) =>
    Promise.all([
      mkdir(runtimeDir, { recursive: true }),
      writeFile(path.join(tempRoot, '训练记录.md'), originalMarkdown, 'utf8'),
    ]).then(() =>
      writeFile(
        path.join(runtimeDir, 'telegram-sync-pending.ndjson'),
        `${JSON.stringify({
          batch: {
            kind: 'thought',
            batchId: 'thought-801',
            status: 'ready',
            archivedDate: null,
            warnings: [],
            issues: [],
            confidence: 1,
            thought: {
              body: '恢复节奏更稳了',
              tags: ['训练', '随想', 'Telegram'],
              telegramMessageId: 801,
              telegramChatId: 42,
              messageDateUnix: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
            },
            updateIds: [899],
            recognitions: [],
            messages: [
              {
                kind: 'message',
                updateId: 899,
                messageId: 801,
                mediaGroupId: null,
                caption: '',
                text: '/thought 恢复节奏更稳了',
                chatId: 42,
                dateUnix: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
                photos: [],
              },
            ],
          },
          failedAt: '2026-05-13T00:00:00.000Z',
        })}\n`,
        'utf8',
      ),
    ),
  );

  const persistedBatchIds = [];
  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      ...telegramSyncEnv(),
      TELEGRAM_SYNC_REPLAY_LEGACY_NDJSON_PENDING: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [],
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatchIds.push(batch.batchId);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for thought replay only');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for thought replay only');
    },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(persistedBatchIds, ['thought-801']);
  assert.equal(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), originalMarkdown);
  assert.equal(
    await readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'),
    '',
  );
});

test('runTelegramSync replies to /analysis without image recognition or file writes', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-analysis-'));
  const sentMessages = [];
  let recognized = false;
  let persisted = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 9011,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/analysis 今天怎么练',
        },
      },
    ],
    recognizeBatch: async () => {
      recognized = true;
      return [];
    },
    persistNormalizedBatch: async () => {
      persisted = true;
      return { status: 'stored' };
    },
    generateTrainingAnalysisReply: async ({ question }) => {
      assert.equal(question, '今天怎么练');
      return '数据结论：最近训练稳定。\n下一步行动：今天做低强度有氧 30 分钟。';
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 10001 };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run through sync override');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for analysis command');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'analysis');
  assert.equal(result.batchResults[0].analysisReplyStatus, 'sent');
  assert.equal(result.batchResults[0].analysisReplyParts, 1);
  assert.equal(recognized, false);
  assert.equal(persisted, false);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0], {
    chatId: 42,
    text: '数据结论：最近训练稳定。\n下一步行动：今天做低强度有氧 30 分钟。',
    replyToMessageId: 9011,
  });

  await assert.rejects(readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-9011.md'), 'utf8'), /ENOENT/);
});

test('runTelegramSync keeps analysis reply text unchanged while reporting AI attempt metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-analysis-audit-'));
  const sentMessages = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 9015,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/analysis 今天怎么练',
        },
      },
    ],
    generateTrainingAnalysisReply: async () => ({
      status: 'ok',
      reply: '数据结论：最近训练稳定。',
      snapshotSource: 'database',
      aiAttemptKind: 'fallback',
      model: 'gpt-analysis-fallback',
    }),
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 10005 };
    },
  });

  const report = buildTelegramSyncReport(result);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, '数据结论：最近训练稳定。');
  assert.equal(result.batchResults[0].analysisReplyStatus, 'sent');
  assert.equal(result.batchResults[0].analysisAttemptKind, 'fallback');
  assert.equal(result.batchResults[0].analysisModel, 'gpt-analysis-fallback');
  assert.equal(result.batchResults[0].analysisSnapshotSource, 'database');
  assert.equal(report.batches[0].analysisAttemptKind, 'fallback');
  assert.equal(report.batches[0].analysisModel, 'gpt-analysis-fallback');
  assert.equal(report.batches[0].analysisSnapshotSource, 'database');
});

test('runTelegramSync default analysis path reports primary model metadata without changing reply text', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-analysis-default-audit-'));
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

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      ...telegramSyncEnv(),
      AI_MODEL: 'gpt-analysis-primary',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
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
                    content: '数据结论：默认分析路径完成。',
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
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 9016,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/analysis 今天怎么练',
        },
      },
    ],
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 10006 };
    },
  });

  assert.equal(sentMessages[0].text, '数据结论：默认分析路径完成。');
  assert.equal(result.batchResults[0].analysisAttemptKind, 'primary');
  assert.equal(result.batchResults[0].analysisModel, 'gpt-analysis-primary');
  assert.equal(result.batchResults[0].analysisSnapshotSource, 'database');

  const aiLogCall = calls.find(([sql]) => /insert into ingest\.ai_call_log/i.test(sql));
  assert.ok(aiLogCall);
  assert.equal(aiLogCall[1][1], 'analysis-9016');
  assert.equal(aiLogCall[1][2], 'analysis');
  assert.equal(aiLogCall[1][4], 'gpt-analysis-primary');
});

test('runTelegramSync replies with a short failure message when analysis generation fails', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-analysis-failure-'));
  const sentMessages = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 9012,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/分析 最近饮食怎么样',
        },
      },
    ],
    generateTrainingAnalysisReply: async () => {
      throw new Error('AI unavailable');
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 10002 };
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.batchResults[0].kind, 'analysis');
  assert.equal(result.batchResults[0].analysisReplyStatus, 'failed');
  assert.equal(result.batchResults[0].analysisReplyError, 'AI unavailable');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 42);
  assert.equal(sentMessages[0].replyToMessageId, 9012);
  assert.match(sentMessages[0].text, /训练分析暂时生成失败：AI unavailable/);
});

test('runTelegramSync ignores unauthorized /analysis commands without generating replies', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-analysis-unauthorized-'));
  let generated = false;
  let sent = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 9013,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 99 },
          text: '/analysis 今天怎么练',
        },
      },
    ],
    generateTrainingAnalysisReply: async () => {
      generated = true;
      return 'should not run';
    },
    sendTelegramMessage: async () => {
      sent = true;
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'analysis');
  assert.equal(result.batchResults[0].status, 'ignored');
  assert.equal(result.batchResults[0].reason, 'unauthorized chat');
  const report = buildTelegramSyncReport(result);
  assert.equal(report.batches[0].sourceId, 'telegram:chat:99:message:9013');
  assert.deepEqual(report.batches[0].messageIds, [9013]);
  assert.deepEqual(report.batches[0].updateIds, [901]);
  assert.equal(generated, false);
  assert.equal(sent, false);
});

test('telegram action monitor reports the failed workflow stage to the original telegram message', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-action-monitor-'));
  const eventPath = path.join(tempRoot, 'event.json');
  const sentMessages = [];
  await writeFile(
    eventPath,
    JSON.stringify({
      client_payload: {
        telegram_updates: [
          {
            update_id: 901,
            message: {
              message_id: 77,
              chat: { id: 42 },
            },
          },
        ],
      },
    }),
    'utf8',
  );

  const result = await notifyTelegramActionFailure({
    env: {
      GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_RUN_ID: '123456',
      TELEGRAM_BOT_TOKEN: 'token',
      STEP_SYNC_OUTCOME: 'failure',
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureCategory, 'github_action');
  assert.equal(result.failureStage, 'Sync Telegram updates');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 42);
  assert.equal(sentMessages[0].replyToMessageId, 77);
  assert.match(sentMessages[0].text, /GitHub Action 执行失败：Sync Telegram updates/);
  assert.match(sentMessages[0].text, /https:\/\/github\.com\/soulgo\/training_records\/actions\/runs\/123456/);
});

test('telegram action monitor reports queued workflow dispatch failures to the original telegram message', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-action-monitor-workflow-dispatch-'));
  const eventPath = path.join(tempRoot, 'queued-dispatch-event.json');
  const sentMessages = [];
  await writeFile(
    eventPath,
    JSON.stringify({
      action: 'telegram_update_dev',
      client_payload: {
        telegram_updates: [
          {
            update_id: 903,
            message: {
              message_id: 79,
              chat: { id: 42 },
            },
          },
        ],
      },
    }),
    'utf8',
  );

  const result = await notifyTelegramActionFailure({
    env: {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_RUN_ID: '123459',
      TELEGRAM_BOT_TOKEN: 'token',
      STEP_SYNC_OUTCOME: 'failure',
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureCategory, 'github_action');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 42);
  assert.equal(sentMessages[0].replyToMessageId, 79);
});

test('telegram action monitor reports inline queued dispatch failures to the original telegram message', async () => {
  const sentMessages = [];

  const result = await notifyTelegramActionFailure({
    env: {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: '',
      SYNC_DISPATCH_PAYLOAD: JSON.stringify({
        action: 'telegram_update_dev',
        client_payload: {
          telegram_updates: [
            {
              update_id: 905,
              message: {
                message_id: 81,
                chat: { id: 42 },
              },
            },
          ],
        },
      }),
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_RUN_ID: '123461',
      TELEGRAM_BOT_TOKEN: 'token',
      STEP_SYNC_OUTCOME: 'failure',
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureCategory, 'github_action');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 42);
  assert.equal(sentMessages[0].replyToMessageId, 81);
});

test('telegram action monitor reports deploy wait failures as site refresh failures', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-action-monitor-pages-'));
  const eventPath = path.join(tempRoot, 'event.json');
  const sentMessages = [];
  await writeFile(
    eventPath,
    JSON.stringify({
      client_payload: {
        telegram_updates: [
          {
            update_id: 902,
            message: {
              message_id: 78,
              chat: { id: 42 },
            },
          },
        ],
      },
    }),
    'utf8',
  );

  const result = await notifyTelegramActionFailure({
    env: {
      GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_RUN_ID: '123457',
      TELEGRAM_BOT_TOKEN: 'token',
      STEP_DEPLOY_OUTCOME: 'failure',
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureStage, '站点部署/页面刷新');
  assert.match(sentMessages[0].text, /GitHub Action 执行失败：站点部署\/页面刷新/);
});

test('runTelegramSync ignores removed /ai assistant commands without side effects', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-ai-agent-'));
  const sentMessages = [];
  let recognized = false;
  let persisted = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 9014,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/ai 搜一下右肩疼痛相关记录',
        },
      },
    ],
    recognizeBatch: async () => {
      recognized = true;
      return [];
    },
    persistNormalizedBatch: async () => {
      persisted = true;
      return { status: 'stored' };
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 10004 };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run through sync override');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for ai agent command');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults.length, 0);
  assert.equal(recognized, false);
  assert.equal(persisted, false);
  assert.equal(sentMessages.length, 0);

  await assert.rejects(readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-9014.md'), 'utf8'), /ENOENT/);
});

test('runTelegramSync ignores removed unauthorized /ai commands without replies', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-ai-agent-unauthorized-'));
  let sent = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 9015,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 99 },
          text: '/ai 同步状态正常吗',
        },
      },
    ],
    sendTelegramMessage: async () => {
      sent = true;
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.batchResults.length, 0);
  assert.equal(sent, false);
});

test('runTelegramSync replies to help commands without image recognition or persistence', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-help-'));
  const sentMessages = [];
  let recognized = false;
  let persisted = false;

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 9016,
          date: Math.floor(new Date('2026-05-14T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/帮助',
        },
      },
      {
        update_id: 902,
        message: {
          message_id: 9017,
          date: Math.floor(new Date('2026-05-14T02:31:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: 'help',
        },
      },
    ],
    recognizeBatch: async () => {
      recognized = true;
      return [];
    },
    persistNormalizedBatch: async () => {
      persisted = true;
      return { status: 'stored' };
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 10006 };
    },
    buildTrainingSnapshot: async () => {
      throw new Error('buildTrainingSnapshot should not run for help command');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run for help command');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults.length, 2);
  assert.deepEqual(result.batchResults.map((batch) => batch.kind), ['help', 'help']);
  assert.deepEqual(result.batchResults.map((batch) => batch.helpReplyStatus), ['sent', 'sent']);
  assert.equal(recognized, false);
  assert.equal(persisted, false);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].chatId, 42);
  assert.equal(sentMessages[0].replyToMessageId, 9016);
  assert.match(sentMessages[0].text, /\/随想 内容：记录锻炼随想/);
  assert.match(sentMessages[0].text, /\/移动 id 模块/);
  assert.match(sentMessages[0].text, /Markdown：用“文件”发送 \.md\/\.markdown/);
  assert.match(sentMessages[0].text, /Markdown 编辑：重新发送 \.md\/\.markdown/);
  assert.equal(sentMessages[1].replyToMessageId, 9017);

  await assert.rejects(readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-9016.md'), 'utf8'), /ENOENT/);
});

test('runTelegramSync retries transient AI recognition failures and continues syncing', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-recognition-retry-'));
  const persistedBatches = [];
  const originalFetch = globalThis.fetch;
  let aiAttempts = 0;

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);

    if (requestUrl.includes('/getFile?')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_path: 'photos/file_801.jpg',
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    if (requestUrl.includes('/chat/completions')) {
      aiAttempts += 1;
      if (aiAttempts === 1) {
        return new Response('upstream temporary failure', { status: 502 });
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  messageId: 801,
                  imageType: 'measurement',
                  detectedDate: '2026-05-18',
                  dateEvidence: 'image header',
                  confidence: 0.98,
                  warnings: [],
                  records: {
                    measurement: {
                      bodyScore: null,
                      weightKg: 72,
                      bmi: null,
                      bodyFatPct: 23.7,
                      skeletalMuscleKg: null,
                      visceralFatLevel: null,
                      basalMetabolismKcal: null,
                      bodyWaterPct: null,
                      proteinPct: null,
                      boneMassKg: null,
                      fatFreeMassKg: null,
                      bodyAge: null,
                      bodyType: null,
                      measuredAt: '2026-05-18',
                    },
                    activities: [],
                    meals: [],
                    totalCalories: null,
                    details: [],
                    dailyWorkoutSummary: null,
                  },
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    throw new Error(`Unexpected fetch call: ${requestUrl}`);
  };

  try {
    const result = await runTelegramSync({
      rootDir: tempRoot,
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        TELEGRAM_ALLOWED_CHAT_IDS: '42',
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      getLastProcessedUpdateId: async () => 900,
      fetchTelegramUpdates: async () => [
        {
          update_id: 901,
          message: {
            message_id: 801,
            date: Math.floor(new Date('2026-05-18T02:30:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
          },
        },
      ],
      persistNormalizedBatch: async ({ batch }) => {
        persistedBatches.push(batch);
        return { status: 'stored', archivedDate: batch.archivedDate };
      },
      buildTrainingSnapshot: async () => ({
        generatedAt: '2026-05-18T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-18' },
        },
        daily: [],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      }),
      exportTrainingMarkdown: () => '### 2026-05-18\n',
    });

    assert.equal(result.changed, true);
    assert.equal(result.batchResults[0].status, 'ready');
    assert.equal(result.batchResults[0].persistenceStatus, 'stored');
    assert.equal(aiAttempts, 2);
    assert.equal(persistedBatches.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runTelegramSync falls back to inline image data when AI rejects a Telegram file URL', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-inline-image-fallback-'));
  const persistedBatches = [];
  const originalFetch = globalThis.fetch;
  let remoteUrlAttempts = 0;
  let inlineUrlAttempts = 0;

  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);

    if (requestUrl.includes('/getFile?')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_path: 'photos/file_803.jpg',
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    if (requestUrl.includes('/file/bottoken/photos/file_803.jpg')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
        },
      });
    }

    if (requestUrl.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      const imagePart = body.messages?.[1]?.content?.find((part) => part.type === 'image_url');
      const imageUrl = imagePart?.image_url?.url ?? '';

      if (imageUrl === 'https://api.telegram.org/file/bottoken/photos/file_803.jpg') {
        remoteUrlAttempts += 1;
        return new Response(
          JSON.stringify({
            error: {
              message: 'remote image URL is not accessible',
            },
          }),
          {
            status: 400,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      if (imageUrl.startsWith('data:image/jpeg;base64,')) {
        inlineUrlAttempts += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    messageId: 803,
                    imageType: 'measurement',
                    detectedDate: '2026-05-18',
                    dateEvidence: 'image header',
                    confidence: 0.98,
                    warnings: [],
                    records: {
                      measurement: {
                        bodyScore: null,
                        weightKg: 72,
                        bmi: null,
                        bodyFatPct: 23.7,
                        skeletalMuscleKg: null,
                        visceralFatLevel: null,
                        basalMetabolismKcal: null,
                        bodyWaterPct: null,
                        proteinPct: null,
                        boneMassKg: null,
                        fatFreeMassKg: null,
                        bodyAge: null,
                        bodyType: null,
                        measuredAt: '2026-05-18',
                      },
                      activities: [],
                      meals: [],
                      totalCalories: null,
                      details: [],
                      dailyWorkoutSummary: null,
                    },
                  }),
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      throw new Error(`Unexpected image URL: ${imageUrl}`);
    }

    throw new Error(`Unexpected fetch call: ${requestUrl}`);
  };

  try {
    const result = await runTelegramSync({
      rootDir: tempRoot,
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        TELEGRAM_ALLOWED_CHAT_IDS: '42',
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      getLastProcessedUpdateId: async () => 900,
      fetchTelegramUpdates: async () => [
        {
          update_id: 901,
          message: {
            message_id: 803,
            date: Math.floor(new Date('2026-05-18T02:30:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-c', file_unique_id: 'uniq-c' }],
          },
        },
      ],
      persistNormalizedBatch: async ({ batch }) => {
        persistedBatches.push(batch);
        return { status: 'stored', archivedDate: batch.archivedDate };
      },
      buildTrainingSnapshot: async () => ({
        generatedAt: '2026-05-18T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-18' },
        },
        daily: [],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      }),
      exportTrainingMarkdown: () => '### 2026-05-18\n',
    });

    assert.equal(result.changed, true);
    assert.equal(result.batchResults[0].status, 'ready');
    assert.equal(remoteUrlAttempts, 1);
    assert.equal(inlineUrlAttempts, 1);
    assert.equal(persistedBatches.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runTelegramSync keeps inline image download failures visible in the summary', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-inline-download-failure-'));
  const originalFetch = globalThis.fetch;
  let remoteUrlAttempts = 0;

  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);

    if (requestUrl.includes('/getFile?')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_path: 'photos/file_804.jpg',
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    if (requestUrl.includes('/file/bottoken/photos/file_804.jpg')) {
      return new Response('not found', { status: 404 });
    }

    if (requestUrl.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      const imagePart = body.messages?.[1]?.content?.find((part) => part.type === 'image_url');
      const imageUrl = imagePart?.image_url?.url ?? '';
      if (imageUrl === 'https://api.telegram.org/file/bottoken/photos/file_804.jpg') {
        remoteUrlAttempts += 1;
        return new Response(
          JSON.stringify({
            error: {
              message: 'remote image URL is not accessible',
            },
          }),
          {
            status: 400,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }
      throw new Error(`Unexpected image URL: ${imageUrl}`);
    }

    throw new Error(`Unexpected fetch call: ${requestUrl}`);
  };

  try {
    const result = await runTelegramSync({
      rootDir: tempRoot,
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        TELEGRAM_ALLOWED_CHAT_IDS: '42',
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      getLastProcessedUpdateId: async () => 900,
      fetchTelegramUpdates: async () => [
        {
          update_id: 902,
          message: {
            message_id: 804,
            date: Math.floor(new Date('2026-05-18T02:30:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-download-fail', file_unique_id: 'uniq-download-fail' }],
          },
        },
      ],
      persistNormalizedBatch: async () => {
        throw new Error('should not persist when inline image download fails');
      },
      buildTrainingSnapshot: async () => ({
        generatedAt: '2026-05-18T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-18' },
        },
        daily: [],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      }),
      exportTrainingMarkdown: () => '### 2026-05-18\n',
    });

    const report = buildTelegramSyncReport(result);
    const [batch] = report.batches;
    assert.equal(remoteUrlAttempts, 1);
    assert.equal(batch.failureCategory, 'image_download');
    assert.equal(batch.failureDisposition, 'auto_retry');
    assert.equal(batch.recognitionErrors[0].failureCategory, 'image_download');
    assert.match(batch.recognitionErrors[0].error, /Telegram file download failed with HTTP 404/);
    assert.match(batch.recognitionErrors[0].error, /file-download-fail/);
    assert.doesNotMatch(batch.recognitionErrors[0].error, /bottoken|api\.telegram\.org/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runTelegramSync retries invalid JSON recognition with inline image data and stores 2026-05-31 nutrition', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-invalid-json-inline-retry-'));
  const persistedBatches = [];
  const originalFetch = globalThis.fetch;
  let foodRemoteAttempts = 0;
  let foodInlineAttempts = 0;

  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);

    if (requestUrl.includes('/getFile?')) {
      const fileId = new URL(requestUrl).searchParams.get('file_id');
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_path:
              fileId === 'file-food-380'
                ? 'photos/food_380.jpg'
                : 'photos/workout_379.jpg',
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    if (requestUrl.includes('/file/bottoken/photos/food_380.jpg')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
        },
      });
    }

    if (requestUrl.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      const imagePart = body.messages?.[1]?.content?.find((part) => part.type === 'image_url');
      const imageUrl = imagePart?.image_url?.url ?? '';

      if (imageUrl === 'https://api.telegram.org/file/bottoken/photos/workout_379.jpg') {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    messageId: 379,
                    imageType: 'workout',
                    detectedDate: '2026-05-31',
                    dateEvidence: 'image header',
                    confidence: 0.98,
                    warnings: [],
                    records: {
                      measurement: null,
                      activities: [],
                      meals: [],
                      totalCalories: null,
                      details: [],
                      dailyWorkoutSummary: {
                        activityCaloriesKcal: 874,
                        workoutDurationMinutes: 58,
                        activeHours: 15,
                      },
                    },
                  }),
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      if (imageUrl === 'https://api.telegram.org/file/bottoken/photos/food_380.jpg') {
        foodRemoteAttempts += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'telegram_training_image returned invalid JSON',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      if (imageUrl.startsWith('data:image/jpeg;base64,')) {
        foodInlineAttempts += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    messageId: 380,
                    imageType: 'nutrition',
                    detectedDate: null,
                    dateEvidence: 'same album as dated workout overview',
                    confidence: 0.96,
                    warnings: [],
                    records: {
                      measurement: null,
                      activities: [],
                      meals: [
                        { name: '午餐', calories: 754, recommendedMin: 620, recommendedMax: 1033 },
                        { name: '晚餐', calories: 114, recommendedMin: 310, recommendedMax: 723 },
                      ],
                      totalCalories: 868,
                      details: ['午餐 754 千卡', '晚餐 114 千卡'],
                      dailyWorkoutSummary: null,
                    },
                  }),
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      throw new Error(`Unexpected image URL: ${imageUrl}`);
    }

    throw new Error(`Unexpected fetch call: ${requestUrl}`);
  };

  try {
    const result = await runTelegramSync({
      rootDir: tempRoot,
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        TELEGRAM_ALLOWED_CHAT_IDS: '42',
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      getLastProcessedUpdateId: async () => 900,
      fetchTelegramUpdates: async () => [
        {
          update_id: 901,
          message: {
            message_id: 379,
            media_group_id: 'album-2026-05-31',
            date: Math.floor(new Date('2026-05-31T02:30:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-workout-379', file_unique_id: 'uniq-workout-379' }],
          },
        },
        {
          update_id: 902,
          message: {
            message_id: 380,
            media_group_id: 'album-2026-05-31',
            date: Math.floor(new Date('2026-05-31T02:31:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-food-380', file_unique_id: 'uniq-food-380' }],
          },
        },
      ],
      persistNormalizedBatch: async ({ batch }) => {
        persistedBatches.push(batch);
        return { status: 'stored', archivedDate: batch.archivedDate };
      },
      buildTrainingSnapshot: async () => ({
        generatedAt: '2026-05-31T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-31' },
        },
        daily: [
          {
            date: '2026-05-31',
            measurement: null,
            measurements: [],
            activities: [],
            workoutSummary: {
              totalActivities: 0,
              totalDurationSeconds: 0,
              trainingCalories: 874,
              workoutDurationMinutes: 58,
              activeHours: 15,
              cyclingDistanceKm: 0,
              countsByType: {},
            },
            nutrition: {
              meals: [
                { name: '午餐', calories: 754, recommendedMin: 620, recommendedMax: 1033 },
                { name: '晚餐', calories: 114, recommendedMin: 310, recommendedMax: 723 },
              ],
              totalCalories: 868,
              details: ['午餐 754 千卡', '晚餐 114 千卡'],
            },
          },
        ],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      }),
      exportTrainingMarkdown: () => '### 2026-05-31\n',
    });

    assert.equal(result.batchResults[0].status, 'ready');
    assert.equal(result.batchResults[0].persistenceStatus, 'stored');
    assert.equal(foodRemoteAttempts, 2);
    assert.equal(foodInlineAttempts, 1);
    assert.equal(persistedBatches.length, 1);
    assert.equal(persistedBatches[0].workoutDailySummary.activityCaloriesKcal, 874);
    assert.equal(persistedBatches[0].nutrition.totalCalories, 868);
    assert.deepEqual(
      persistedBatches[0].nutrition.meals.map((meal) => [meal.name, meal.calories]),
      [
        ['午餐', 754],
        ['晚餐', 114],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runTelegramSync retries recognition with json_object when json_schema response format is rejected', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-json-format-fallback-'));
  const persistedBatches = [];
  const originalFetch = globalThis.fetch;
  const responseFormats = [];

  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);

    if (requestUrl.includes('/getFile?')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_path: 'photos/file_804.jpg',
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    if (requestUrl.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      responseFormats.push(body.response_format?.type ?? null);

      if (body.response_format?.type === 'json_schema') {
        return new Response(
          JSON.stringify({
            error: {
              message: "Missing required parameter: 'response_format.json_schema.name'.",
            },
          }),
          {
            status: 400,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      if (body.response_format?.type === 'json_object') {
        const userText = (body.messages ?? [])
          .filter((message) => message.role === 'user')
          .flatMap((message) => message.content ?? [])
          .map((part) => part?.text ?? '')
          .join('\n');
        if (!/\bjson\b/.test(userText)) {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "Response input messages must contain the word 'json' in some form to use 'response_format' of type 'json_object'.",
              },
            }),
            {
              status: 400,
              headers: {
                'content-type': 'application/json',
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    imageType: 'workout',
                    detectedDate: '2026-05-18',
                    dateEvidence: 'image header: 2026-05-18',
                    confidence: 0.98,
                    warnings: [],
                    records: {
                      measurement: null,
                      activities: [],
                      meals: [],
                      totalCalories: null,
                      details: [],
                      dailyWorkoutSummary: {
                        activityCaloriesKcal: 402,
                        workoutDurationMinutes: 30,
                        activeHours: 16,
                      },
                    },
                  }),
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      throw new Error(`Unexpected response format: ${body.response_format?.type}`);
    }

    throw new Error(`Unexpected fetch call: ${requestUrl}`);
  };

  try {
    const result = await runTelegramSync({
      rootDir: tempRoot,
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        TELEGRAM_ALLOWED_CHAT_IDS: '42',
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      getLastProcessedUpdateId: async () => 900,
      fetchTelegramUpdates: async () => [
        {
          update_id: 901,
          message: {
            message_id: 804,
            date: Math.floor(new Date('2026-05-18T02:30:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-d', file_unique_id: 'uniq-d' }],
          },
        },
      ],
      persistNormalizedBatch: async ({ batch }) => {
        persistedBatches.push(batch);
        return { status: 'stored', archivedDate: batch.archivedDate };
      },
      buildTrainingSnapshot: async () => ({
        generatedAt: '2026-05-18T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-18' },
        },
        daily: [],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      }),
      exportTrainingMarkdown: () => '### 2026-05-18\n',
    });

    assert.deepEqual(responseFormats, ['json_schema', 'json_object']);
    assert.equal(result.batchResults[0].status, 'ready');
    assert.equal(result.batchResults[0].persistenceStatus, 'stored');
    assert.equal(persistedBatches.length, 1);
    assert.equal(persistedBatches[0].archivedDate, '2026-05-18');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runTelegramSync normalizes object recognition details before batch analysis', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-recognition-details-'));
  const persistedBatches = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);

    if (requestUrl.includes('/getFile?')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_path: 'photos/file_805.jpg',
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    if (requestUrl.includes('/chat/completions')) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  imageType: 'nutrition',
                  detectedDate: '2026-05-18',
                  dateEvidence: 'image header: 2026-05-18',
                  confidence: 0.96,
                  warnings: [],
                  records: {
                    measurement: null,
                    activities: [],
                    meals: [],
                    totalCalories: 465,
                    details: {
                      dinner: '晚餐 465 千卡',
                    },
                    dailyWorkoutSummary: null,
                  },
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    throw new Error(`Unexpected fetch call: ${requestUrl}`);
  };

  try {
    const result = await runTelegramSync({
      rootDir: tempRoot,
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        TELEGRAM_ALLOWED_CHAT_IDS: '42',
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      getLastProcessedUpdateId: async () => 900,
      fetchTelegramUpdates: async () => [
        {
          update_id: 901,
          message: {
            message_id: 805,
            date: Math.floor(new Date('2026-05-18T02:30:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-e', file_unique_id: 'uniq-e' }],
          },
        },
      ],
      persistNormalizedBatch: async ({ batch }) => {
        persistedBatches.push(batch);
        return { status: 'stored', archivedDate: batch.archivedDate };
      },
      buildTrainingSnapshot: async () => ({
        generatedAt: '2026-05-18T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-18' },
        },
        daily: [],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      }),
      exportTrainingMarkdown: () => '### 2026-05-18\n',
    });

    assert.equal(result.batchResults[0].status, 'ready');
    assert.equal(result.batchResults[0].persistenceStatus, 'stored');
    assert.equal(persistedBatches.length, 1);
    assert.deepEqual(persistedBatches[0].nutrition.details, ['晚餐 465 千卡']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runTelegramSync normalizes null recognition details without dropping workout activities', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-workout-details-'));
  const persistedBatches = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);

    if (requestUrl.includes('/getFile?')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_path: 'photos/file_806.jpg',
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    if (requestUrl.includes('/chat/completions')) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  imageType: 'workout',
                  detectedDate: '2026-05-24',
                  dateEvidence: 'image header: 5月24日',
                  confidence: 0.96,
                  warnings: [],
                  records: {
                    measurement: null,
                    activities: [
                      {
                        time: '10:46',
                        type: 'HIIT',
                        detail: '总消耗419千卡，时长00:47:28，平均心率140次/分钟',
                      },
                    ],
                    meals: [],
                    totalCalories: null,
                    details: null,
                    dailyWorkoutSummary: null,
                  },
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    throw new Error(`Unexpected fetch call: ${requestUrl}`);
  };

  try {
    const result = await runTelegramSync({
      rootDir: tempRoot,
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        TELEGRAM_ALLOWED_CHAT_IDS: '42',
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      getLastProcessedUpdateId: async () => 900,
      fetchTelegramUpdates: async () => [
        {
          update_id: 901,
          message: {
            message_id: 806,
            date: Math.floor(new Date('2026-05-24T02:46:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-f', file_unique_id: 'uniq-f' }],
          },
        },
      ],
      persistNormalizedBatch: async ({ batch }) => {
        persistedBatches.push(batch);
        return { status: 'stored', archivedDate: batch.archivedDate };
      },
      buildTrainingSnapshot: async () => ({
        generatedAt: '2026-05-24T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-24' },
        },
        daily: [],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      }),
      exportTrainingMarkdown: () => '### 2026-05-24\n',
    });

    assert.equal(result.batchResults[0].status, 'ready');
    assert.equal(result.batchResults[0].persistenceStatus, 'stored');
    assert.equal(persistedBatches.length, 1);
    assert.equal(persistedBatches[0].activities.length, 1);
    assert.equal(persistedBatches[0].activities[0].type, 'HIIT');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runTelegramSync skips malformed recognition responses after logging the recognition failure', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-recognition-errors-'));
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);

    if (requestUrl.includes('/getFile?')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_path: 'photos/file_802.jpg',
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    if (requestUrl.includes('/chat/completions')) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    throw new Error(`Unexpected fetch call: ${requestUrl}`);
  };

  try {
    const result = await runTelegramSync({
      rootDir: tempRoot,
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        TELEGRAM_ALLOWED_CHAT_IDS: '42',
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      getLastProcessedUpdateId: async () => 900,
      fetchTelegramUpdates: async () => [
        {
          update_id: 901,
          message: {
            message_id: 802,
            date: Math.floor(new Date('2026-05-18T02:30:00Z').getTime() / 1000),
            chat: { id: 42 },
            photo: [{ file_id: 'file-b', file_unique_id: 'uniq-b' }],
          },
        },
      ],
      persistNormalizedBatch: async () => ({ status: 'stored', archivedDate: '2026-05-18' }),
      buildTrainingSnapshot: async () => ({
        generatedAt: '2026-05-18T00:00:00.000Z',
        latest: { measurement: null, daily: { date: '2026-05-18' } },
        daily: [],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      }),
    });

    assert.equal(result.batchResults[0].status, 'skipped');
    assert.match(result.batchResults[0].reason, /missing recognition/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runTelegramSync sends Telegram result notification after storing an image batch', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notification-success-'));
  const sentMessages = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_NOTIFY: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 901,
          date: Math.floor(new Date('2026-05-22T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
    ],
    recognizeBatch: async () => [
      {
        messageId: 901,
        imageType: 'workout',
        detectedDate: '2026-05-22',
        dateEvidence: 'image header: 2026年5月22日星期五',
        confidence: 0.98,
        warnings: [],
        records: {
          measurement: null,
          activities: [],
          meals: [],
          totalCalories: null,
          details: [],
          dailyWorkoutSummary: {
            activityCaloriesKcal: 1077,
            workoutDurationMinutes: 148,
            activeHours: 14,
          },
        },
      },
    ],
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-22T00:00:00.000Z',
      latest: { measurement: null, daily: { date: '2026-05-22' } },
      daily: [],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-22\n',
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9901 };
    },
  });

  assert.equal(result.batchResults[0].status, 'ready');
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0], {
    chatId: 42,
    text: '解析成功（已识别 1/1），已入库 2026 年 5 月 22 日数据',
    replyToMessageId: 901,
  });
});

test('runTelegramSync sends Telegram result notification after writing a thought', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notification-thought-'));
  const sentMessages = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_NOTIFY: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 903,
          date: Math.floor(new Date('2026-05-22T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/随想 今天深蹲动作轨迹更稳了',
        },
      },
    ],
    persistNormalizedBatch: async () => ({ status: 'stored' }),
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9903 };
    },
  });

  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_database_only');
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0], {
    chatId: 42,
    text: '随想写入成功，已入库',
    replyToMessageId: 903,
  });
});

test('runTelegramSync defers Telegram success notification until the action finishes', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notification-deferred-'));
  const resultPath = path.join(tempRoot, 'runtime', 'telegram-sync-result.json');

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_NOTIFY: 'true',
      TELEGRAM_SYNC_NOTIFY_STAGE: 'after_action',
      TELEGRAM_SYNC_RESULT_PATH: resultPath,
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 906,
          date: Math.floor(new Date('2026-05-22T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/随想 动作轨迹更稳了',
        },
      },
    ],
    persistNormalizedBatch: async () => ({ status: 'stored' }),
  });

  assert.equal(result.batchResults[0].kind, 'thought');
  const savedResult = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(savedResult.batchResults[0].thoughtWriteStatus, 'thought_database_only');
  assert.equal(savedResult.batchResults[0].persistenceStatus, 'stored');

  const notifierMessages = [];
  const { notifyTelegramSyncResultFromFile } = await import('../tools/telegram-sync.mjs');
  const notifyResult = await notifyTelegramSyncResultFromFile({
    resultPath,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_SYNC_NOTIFY: 'true',
      TELEGRAM_SYNC_TRANSPORT: 'webhook',
    },
    sendMessage: async (message) => {
      notifierMessages.push(message);
      return { message_id: 9906 };
    },
  });

  assert.equal(notifyResult.notified, true);
  assert.equal(notifierMessages.length, 1);
  assert.deepEqual(notifierMessages[0], {
    chatId: 42,
    text: '随想写入成功，已入库',
    replyToMessageId: 906,
  });
});

test('runTelegramSync explains thought database fallback in Telegram notification', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notification-thought-db-'));
  const sentMessages = [];
  const queued = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_NOTIFY: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 904,
          date: Math.floor(new Date('2026-05-22T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          text: '/随想 今天训练后背阔发力更明显',
        },
      },
    ],
    persistNormalizedBatch: async () => {
      throw new Error('database unavailable');
    },
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId, aiCallLogStatus: 'written' };
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9904 };
    },
  });

  assert.equal(result.batchResults[0].persistenceStatus, 'pending_replay');
  assert.equal(result.batchResults[0].failureCategory, 'database');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].batch.kind, 'thought');
  assert.equal(queued[0].batch.batchId, 'thought-904');
  assert.equal(queued[0].failureCategory, 'database');
  assert.match(queued[0].error, /database unavailable/);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 42);
  assert.equal(sentMessages[0].replyToMessageId, 904);
  assert.match(sentMessages[0].text, /随想写入成功，已记录，数据库待补偿/);
  assert.match(sentMessages[0].text, /database unavailable/);
});

test('runTelegramSync preserves image recognition failure reason in report and notification', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notification-ai-failure-'));
  const sentMessages = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_NOTIFY: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 905,
          date: Math.floor(new Date('2026-05-22T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
    ],
    recognizeBatch: async () => {
      throw new Error('AI recognition failed with HTTP 429: rate limit');
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9905 };
    },
  });

  const report = buildTelegramSyncReport(result);
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[0].failureCategory, 'ai_service');
  assert.match(result.batchResults[0].failureReason, /HTTP 429/);
  assert.equal(report.batches[0].failureCategory, 'ai_service');
  assert.match(report.batches[0].recognitionErrors[0].error, /rate limit/);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /AI 服务失败/);
  assert.match(sentMessages[0].text, /HTTP 429/);
});

test('runTelegramSync queues image batches when AI recognition fails before any image can be stored', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-pending-recognition-failure-'));
  const queued = [];
  const sentMessages = [];
  const now = new Date('2026-05-31T03:05:00.000Z');

  const result = await runTelegramSync({
    rootDir: tempRoot,
    now,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_NOTIFY: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 383,
          date: Math.floor(new Date('2026-05-31T03:00:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-food-383', file_unique_id: 'uniq-food-383' }],
        },
      },
    ],
    recognizeBatch: async () => ({
      recognitions: [],
      recognitionErrors: [
        {
          messageId: 383,
          error: 'telegram_training_image returned invalid JSON',
          failureCategory: 'ai_service',
        },
      ],
    }),
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId, aiCallLogStatus: 'written' };
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9909 };
    },
  });

  const batch = result.batchResults[0];
  assert.equal(batch.status, 'skipped');
  assert.equal(batch.failureCategory, 'ai_service');
  assert.equal(batch.recognitionPendingStatus, 'queued');
  assert.equal(batch.aiCallLogStatus, 'written');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].batch.batchId, 'single-383');
  assert.equal(queued[0].batch.messages[0].photos[0].fileId, 'file-food-383');
  assert.match(queued[0].error, /invalid JSON/);
  assert.equal(queued[0].nextRetryAt.toISOString(), now.toISOString());
  const report = buildTelegramSyncReport(result);
  assert.equal(report.batches[0].recognitionPendingStatus, 'queued');
  assert.equal(report.batches[0].aiCallLogStatus, 'written');
  assert.equal(report.batches[0].recognitionPendingError, null);
  assert.equal(report.batches[0].pendingReplay, false);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /AI 识别失败（已识别 \d+\/\d+.*），已加入重试队列/);
});

test('runTelegramSync queues image batches when primary and fallback AI providers fail', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-primary-fallback-ai-failure-'));
  const queued = [];
  const providerCalls = [];
  const sentMessages = [];
  const now = new Date('2026-05-31T03:05:00.000Z');

  const result = await runTelegramSync({
    rootDir: tempRoot,
    now,
    env: telegramSyncEnv({
      TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE: 'inline',
      TELEGRAM_SYNC_NOTIFY: 'true',
    }),
    recognitionAiProvider: {
      env: { model: 'gpt-primary' },
      fallbackProvider: {
        env: { model: 'gpt-fallback' },
        async requestChatCompletion() {
          providerCalls.push('fallback');
          const error = new Error('fallback provider timed out');
          error.name = 'TimeoutError';
          throw error;
        },
      },
      async requestChatCompletion() {
        providerCalls.push('primary');
        throw new Error('AI recognition request failed with HTTP 502');
      },
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 383,
          date: Math.floor(new Date('2026-05-31T03:00:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-food-383', file_unique_id: 'uniq-food-383' }],
        },
      },
    ],
    fetchTelegramFile: async () => ({
      filePath: 'photos/file-food-383.jpg',
      contentType: 'image/jpeg',
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    }),
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId, aiCallLogStatus: 'written' };
    },
    persistNormalizedBatch: async () => {
      throw new Error('should not persist when both AI providers fail');
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9911 };
    },
  });

  assert.deepEqual(providerCalls, ['primary', 'fallback']);
  const batch = result.batchResults[0];
  assert.equal(batch.status, 'skipped');
  assert.equal(batch.failureCategory, 'ai_service');
  assert.equal(batch.recognitionPendingStatus, 'queued');
  assert.match(batch.failureReason, /fallback provider timed out/);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].batch.batchId, 'single-383');
  assert.equal(queued[0].batch.recognitionErrors[0].model, 'gpt-fallback');
  assert.equal(queued[0].batch.recognitionErrors[0].aiAttemptKind, 'fallback');
  assert.match(queued[0].batch.recognitionErrors[0].promptVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(
    queued[0].batch.recognitionErrors[0].aiIdempotencyKey,
    new RegExp(`^recognition:telegram_training_image:v2:${queued[0].batch.recognitionErrors[0].promptVersion}:gpt-primary:`),
  );
  assert.match(queued[0].error, /fallback provider timed out/);
  assert.equal(queued[0].nextRetryAt.toISOString(), now.toISOString());
  const report = buildTelegramSyncReport(result);
  assert.equal(report.batches[0].taskStatus, 'deferred');
  assert.equal(report.batches[0].aiCallLogStatus, 'written');
  assert.equal(report.batches[0].retryState, 'queued');
  assert.equal(report.batches[0].failureDisposition, 'auto_retry');
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /已加入重试队列/);
});

test('runTelegramSync replays pending recognition batches and marks them resolved after storage', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-replay-pending-recognition-'));
  const persistedBatches = [];
  const resolved = [];
  const backfillCalls = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [],
    readPendingRecognitionBatches: async () => [
      {
        batchId: 'single-383',
        batch: {
          kind: 'image',
          batchId: 'single-383',
          messages: [
            {
              messageId: 383,
              updateId: 901,
              mediaGroupId: null,
              caption: '',
              text: '',
              chatId: 42,
              dateUnix: Math.floor(new Date('2026-05-31T03:00:00Z').getTime() / 1000),
              photos: [{ fileId: 'file-food-383', fileUniqueId: 'uniq-food-383', source: 'photo' }],
            },
          ],
        },
      },
    ],
    recognizeBatch: async () => ({
      recognitions: [
        {
          messageId: 383,
          imageType: 'nutrition',
          detectedDate: '2026-05-31',
          dateEvidence: 'image header',
          confidence: 0.97,
          warnings: [],
          records: {
            measurement: null,
            activities: [],
            meals: [{ name: '晚餐', calories: 868, recommendedMin: 310, recommendedMax: 723 }],
            totalCalories: 868,
            details: ['晚餐 868 千卡'],
            dailyWorkoutSummary: null,
          },
        },
      ],
      recognitionErrors: [],
    }),
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    markPendingRecognitionResolved: async ({ batchId }) => {
      resolved.push(batchId);
      return { status: 'resolved', batchId };
    },
    backfillCoreSleepFromIngestBatches: async (input) => {
      backfillCalls.push(input);
      return { status: 'synced' };
    },
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-31T00:00:00.000Z',
      latest: { measurement: null, daily: { date: '2026-05-31' } },
      daily: [
        {
          date: '2026-05-31',
          measurement: null,
          measurements: [],
          activities: [],
          workoutSummary: {
            totalActivities: 0,
            totalDurationSeconds: 0,
            trainingCalories: 0,
            workoutDurationMinutes: null,
            activeHours: null,
            cyclingDistanceKm: 0,
            countsByType: {},
          },
          nutrition: {
            meals: [{ name: '晚餐', calories: 868, recommendedMin: 310, recommendedMax: 723 }],
            totalCalories: 868,
            details: ['晚餐 868 千卡'],
          },
        },
      ],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-31\n',
  });

  assert.equal(result.changed, true);
  assert.equal(result.batchResults[0].status, 'ready');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(result.batchResults[0].pendingReplay, true);
  assert.equal(buildTelegramSyncReport(result).batches[0].pendingReplay, true);
  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].nutrition.totalCalories, 868);
  assert.deepEqual(resolved, ['single-383']);
  assert.equal(backfillCalls.length, 0);
});

test('runTelegramSync uses the normalized runtime env for first-time and replayed image recognition', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-shared-recognition-env-'));
  const recognitionEnvArgs = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 902,
        message: {
          message_id: 384,
          date: Math.floor(new Date('2026-05-31T03:10:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-food-384', file_unique_id: 'uniq-food-384' }],
        },
      },
    ],
    readPendingRecognitionBatches: async () => [
      {
        batchId: 'single-383',
        batch: {
          kind: 'image',
          batchId: 'single-383',
          messages: [
            {
              messageId: 383,
              updateId: 901,
              mediaGroupId: null,
              caption: '',
              text: '',
              chatId: 42,
              dateUnix: Math.floor(new Date('2026-05-31T03:00:00Z').getTime() / 1000),
              photos: [{ fileId: 'file-food-383', fileUniqueId: 'uniq-food-383', source: 'photo' }],
            },
          ],
        },
      },
    ],
    recognizeBatch: async (batch, runtimeEnv) => {
      recognitionEnvArgs.push({ batchId: batch.batchId, runtimeEnv });
      return {
        recognitions: [
          {
            messageId: batch.messages[0].messageId,
            imageType: 'nutrition',
            detectedDate: '2026-05-31',
            dateEvidence: 'image header',
            confidence: 0.97,
            warnings: [],
            records: {
              measurement: null,
              activities: [],
              meals: [{ name: '晚餐', calories: 868, recommendedMin: 310, recommendedMax: 723 }],
              totalCalories: 868,
              details: ['晚餐 868 千卡'],
              dailyWorkoutSummary: null,
            },
          },
        ],
        recognitionErrors: [],
      };
    },
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    markPendingRecognitionResolved: async ({ batchId }) => ({ status: 'resolved', batchId }),
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-31T00:00:00.000Z',
      latest: { measurement: null, daily: { date: '2026-05-31' } },
      daily: [],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-31\n',
  });

  assert.equal(result.batchResults.length, 2);
  assert.deepEqual(
    recognitionEnvArgs.map((call) => call.batchId),
    ['single-383', 'single-384'],
  );
  for (const { runtimeEnv } of recognitionEnvArgs) {
    assert.equal(runtimeEnv.botToken, 'token');
    assert.equal(runtimeEnv.allowedChatIds.has(42), true);
  }
});

test('runTelegramSync keeps pending recognition batches queued when replay still fails', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-replay-pending-recognition-fails-'));
  const queued = [];
  const resolved = [];
  const now = new Date('2026-05-31T03:06:00.000Z');

  const result = await runTelegramSync({
    rootDir: tempRoot,
    now,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [],
    readPendingRecognitionBatches: async () => [
      {
        batchId: 'single-383',
        batch: {
          kind: 'image',
          batchId: 'single-383',
          messages: [
            {
              messageId: 383,
              updateId: 901,
              mediaGroupId: null,
              caption: '',
              text: '',
              chatId: 42,
              dateUnix: Math.floor(new Date('2026-05-31T03:00:00Z').getTime() / 1000),
              photos: [{ fileId: 'file-food-383', fileUniqueId: 'uniq-food-383', source: 'photo' }],
            },
          ],
        },
      },
    ],
    recognizeBatch: async () => {
      throw new Error('telegram_training_image returned invalid JSON');
    },
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
    markPendingRecognitionResolved: async ({ batchId }) => {
      resolved.push(batchId);
      return { status: 'resolved', batchId };
    },
  });

  const batch = result.batchResults[0];
  assert.equal(batch.status, 'skipped');
  assert.equal(batch.pendingReplay, true);
  assert.equal(batch.failureCategory, 'ai_service');
  assert.equal(batch.recognitionPendingStatus, 'queued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].batch.batchId, 'single-383');
  assert.match(queued[0].error, /invalid JSON/);
  assert.ok(queued[0].nextRetryAt > now);
  assert.deepEqual(resolved, []);
  const report = buildTelegramSyncReport(result);
  assert.equal(report.batches[0].pendingReplay, true);
  assert.equal(report.batches[0].recognitionPendingStatus, 'queued');
});

test('runTelegramSync marks ready image albums with failed photos as partial failures in reports and notifications', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notification-partial-ai-failure-'));
  const sentMessages = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_NOTIFY: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 379,
          media_group_id: 'album-2026-05-31',
          date: Math.floor(new Date('2026-05-31T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-workout-379', file_unique_id: 'uniq-workout-379' }],
        },
      },
      {
        update_id: 902,
        message: {
          message_id: 380,
          media_group_id: 'album-2026-05-31',
          date: Math.floor(new Date('2026-05-31T02:31:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-food-380', file_unique_id: 'uniq-food-380' }],
        },
      },
    ],
    recognizeBatch: async () => ({
      recognitions: [
        {
          messageId: 379,
          imageType: 'workout',
          detectedDate: '2026-05-31',
          dateEvidence: 'image header',
          confidence: 0.98,
          warnings: [],
          records: {
            measurement: null,
            activities: [],
            meals: [],
            totalCalories: null,
            details: [],
            dailyWorkoutSummary: {
              activityCaloriesKcal: 874,
              workoutDurationMinutes: 58,
              activeHours: 15,
            },
          },
        },
      ],
      recognitionErrors: [
        {
          messageId: 380,
          error: 'telegram_training_image returned invalid JSON',
          failureCategory: 'ai_service',
          summary: {
            contentType: 'application/json',
            parseStage: 'message_content_json',
            snippet: 'telegram_training_image returned invalid JSON',
          },
        },
      ],
    }),
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-31T00:00:00.000Z',
      latest: { measurement: null, daily: { date: '2026-05-31' } },
      daily: [],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-31\n',
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9908 };
    },
  });

  const batch = result.batchResults[0];
  const report = buildTelegramSyncReport(result);
  assert.equal(batch.status, 'ready');
  assert.equal(batch.persistenceStatus, 'stored');
  assert.equal(batch.partialFailure, true);
  assert.equal(batch.failureCategory, 'ai_service');
  assert.match(batch.failureReason, /invalid JSON/);
  assert.equal(report.batches[0].partialFailure, true);
  assert.equal(report.batches[0].recognitionErrors[0].messageId, 380);
  assert.equal(report.batches[0].recognitionErrors[0].summary.contentType, 'application/json');
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /部分解析失败/);
  assert.match(sentMessages[0].text, /380/);
  assert.doesNotMatch(sentMessages[0].text, /解析成功/);
});

test('runTelegramSync sends Telegram result notification when an image batch is skipped', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-notification-skipped-'));
  const sentMessages = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_NOTIFY: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 902,
          date: Math.floor(new Date('2026-05-22T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
    ],
    recognizeBatch: async () => [],
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9902 };
    },
  });

  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 42);
  assert.equal(sentMessages[0].replyToMessageId, 902);
  assert.match(sentMessages[0].text, /解析未入库/);
  assert.match(sentMessages[0].text, /no reliable image or filename date/);
});

test('runTelegramSync queues partial failure ready batches for pending recognition', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-partial-failure-pending-'));
  const queued = [];
  const sentMessages = [];
  const now = new Date('2026-05-31T03:05:00.000Z');

  const result = await runTelegramSync({
    rootDir: tempRoot,
    now,
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TELEGRAM_ALLOWED_CHAT_IDS: '42',
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TELEGRAM_SYNC_NOTIFY: 'true',
    },
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [
      {
        update_id: 901,
        message: {
          message_id: 391,
          media_group_id: 'album-partial-pending',
          date: Math.floor(new Date('2026-05-31T02:30:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-overview-391', file_unique_id: 'uniq-overview-391' }],
        },
      },
      {
        update_id: 902,
        message: {
          message_id: 392,
          media_group_id: 'album-partial-pending',
          date: Math.floor(new Date('2026-05-31T02:31:00Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-nutrition-392', file_unique_id: 'uniq-nutrition-392' }],
        },
      },
    ],
    recognizeBatch: async () => ({
      recognitions: [
        {
          messageId: 391,
          imageType: 'workout',
          detectedDate: '2026-05-31',
          dateEvidence: 'image header: 2026年5月31日',
          confidence: 0.98,
          warnings: [],
          records: {
            measurement: null,
            activities: [],
            meals: [],
            totalCalories: null,
            details: [],
            dailyWorkoutSummary: {
              activityCaloriesKcal: 804,
              workoutDurationMinutes: 71,
              activeHours: 15,
            },
          },
        },
      ],
      recognitionErrors: [
        {
          messageId: 392,
          error: 'telegram_training_image returned invalid JSON',
          failureCategory: 'ai_service',
        },
      ],
    }),
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
    persistNormalizedBatch: async ({ batch }) => ({ status: 'stored', archivedDate: batch.archivedDate }),
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-31T00:00:00.000Z',
      latest: { measurement: null, daily: { date: '2026-05-31' } },
      daily: [],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-31\n',
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9910 };
    },
  });

  const batch = result.batchResults[0];
  assert.equal(batch.status, 'ready');
  assert.equal(batch.partialFailure, true);
  assert.equal(batch.sourceImageCount, 2);
  assert.equal(batch.recognizedImageCount, 1);
  assert.equal(batch.failedImageCount, 1);
  assert.equal(batch.recognitionPendingStatus, 'queued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].batch.batchId, 'album-partial-pending');
  assert.equal(queued[0].batch.messages.length, 2);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /部分解析失败/);
  assert.match(sentMessages[0].text, /已识别 1\/2/);
  assert.match(sentMessages[0].text, /失败图片已加入重试队列/);
});

test('runTelegramSync report includes image counts for pending replay batches', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-replay-counts-'));
  const persistedBatches = [];
  const resolved = [];

  const result = await runTelegramSync({
    rootDir: tempRoot,
    env: telegramSyncEnv(),
    getLastProcessedUpdateId: async () => 900,
    fetchTelegramUpdates: async () => [],
    readPendingRecognitionBatches: async () => [
      {
        batchId: 'album-replay-counts',
        batch: {
          kind: 'image',
          batchId: 'album-replay-counts',
          messages: [
            {
              messageId: 401,
              updateId: 911,
              mediaGroupId: 'album-replay-counts',
              chatId: 42,
              dateUnix: Math.floor(new Date('2026-05-31T03:00:00Z').getTime() / 1000),
              photos: [{ fileId: 'f1', fileUniqueId: 'u1', source: 'photo' }],
            },
            {
              messageId: 402,
              updateId: 912,
              mediaGroupId: 'album-replay-counts',
              chatId: 42,
              dateUnix: Math.floor(new Date('2026-05-31T03:00:01Z').getTime() / 1000),
              photos: [{ fileId: 'f2', fileUniqueId: 'u2', source: 'photo' }],
            },
          ],
        },
      },
    ],
    recognizeBatch: async () => ({
      recognitions: [
        {
          messageId: 401,
          imageType: 'workout',
          detectedDate: '2026-05-31',
          dateEvidence: 'image header: 2026-05-31',
          confidence: 0.98,
          warnings: [],
          records: {
            activities: [{ time: '19:13', type: '力量训练', detail: '总消耗241千卡' }],
          },
        },
        {
          messageId: 402,
          imageType: 'nutrition',
          detectedDate: null,
          dateEvidence: 'no reliable image date',
          confidence: 0.96,
          warnings: [],
          records: {
            meals: [{ name: '晚餐', calories: 868, recommendedMin: 310, recommendedMax: 723 }],
            totalCalories: 868,
          },
        },
      ],
      recognitionErrors: [],
    }),
    persistNormalizedBatch: async ({ batch }) => {
      persistedBatches.push(batch);
      return { status: 'stored', archivedDate: batch.archivedDate };
    },
    markPendingRecognitionResolved: async ({ batchId }) => {
      resolved.push(batchId);
      return { status: 'resolved', batchId };
    },
    backfillCoreSleepFromIngestBatches: async () => ({ status: 'synced' }),
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-31T00:00:00.000Z',
      latest: { measurement: null, daily: { date: '2026-05-31' } },
      daily: [],
      charts: emptyTrainingCharts(),
    }),
    exportTrainingMarkdown: () => '### 2026-05-31\n',
  });

  const report = buildTelegramSyncReport(result);
  assert.equal(result.changed, true);
  assert.equal(result.batchResults[0].pendingReplay, true);
  assert.equal(result.batchResults[0].sourceImageCount, 2);
  assert.equal(result.batchResults[0].recognizedImageCount, 2);
  assert.equal(result.batchResults[0].failedImageCount, 0);
  assert.equal(report.batches[0].sourceImageCount, 2);
  assert.equal(report.batches[0].recognizedImageCount, 2);
  assert.equal(report.batches[0].failedImageCount, 0);
  assert.equal(report.batches[0].pendingReplay, true);
  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].sourceImageCount, 2);
  assert.equal(persistedBatches[0].recognizedImageCount, 2);
  assert.equal(persistedBatches[0].failedImageCount, 0);
  assert.deepEqual(resolved, ['album-replay-counts']);
});

test('buildTelegramSyncReport exposes recognition attempt kinds for audit summaries', () => {
  const report = buildTelegramSyncReport({
    changed: true,
    fallbackUsed: false,
    updatesFetched: 1,
    lastProcessedUpdateId: 901,
    readyBatches: 1,
    batchResults: [
      {
        kind: 'image',
        batchId: 'album-recognition-attempts',
        status: 'ready',
        archivedDate: '2026-06-08',
        persistenceStatus: 'stored',
        messages: [
          { chatId: 42, messageId: 701, updateId: 901, mediaGroupId: 'album-recognition-attempts' },
          { chatId: 42, messageId: 702, updateId: 902, mediaGroupId: 'album-recognition-attempts' },
        ],
        recognitions: [
          { messageId: 701, aiAttemptKind: 'normal' },
          { messageId: 702, aiAttemptKind: 'fallback' },
          { messageId: 703, aiAttemptKind: 'fallback' },
        ],
      },
    ],
  });

  assert.deepEqual(report.batches[0].recognitionAttemptKinds, ['normal', 'fallback']);
});

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
