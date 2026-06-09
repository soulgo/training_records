import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildTelegramSyncReport,
  createRecognitionAiProvider,
  loadRecognitionSystemPrompt,
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
    env: telegramSyncEnv(),
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
    exportTrainingMarkdown: () => {
      throw new Error('should not export from database on fallback');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults[0].persistenceStatus, 'pending_replay');
  assert.equal(result.batchResults[0].persistenceError, 'database unavailable');
  await assert.rejects(readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /ENOENT/);
  assert.match(
    await readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'),
    /album-1/,
  );
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
  assert.equal(
    await readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'),
    '',
  );
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
  assert.equal(
    await readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'),
    '',
  );
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

  assert.deepEqual(report, {
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
        pendingReplay: false,
        sourceImageCount: 0,
        recognizedImageCount: 0,
        failedImageCount: 0,
        recognitionErrors: [],
        warnings: [],
        issues: [],
        reason: null,
        dateSources: [],
      },
    ],
  });
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

test('runTelegramSync replays pending fallback batches into the database before new updates', async () => {
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
    env: telegramSyncEnv(),
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'no_images');
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'no_images');
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'no_images');
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'thought_edit_database_only');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
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
  assert.match(
    await readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'),
    /thought-701/,
  );
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
    env: telegramSyncEnv(),
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

test('telegram action monitor ignores site deployment stages outside telegram sync', async () => {
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
      STEP_PAGES_DEPLOY_OUTCOME: 'failure',
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.notified, true);
  assert.equal(result.failureStage, 'Unknown workflow stage');
  assert.match(sentMessages[0].text, /GitHub Action 执行失败：Unknown workflow stage/);
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'no_images');
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
  assert.equal(savedResult.batchResults[0].thoughtWriteStatus, 'no_images');
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
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9904 };
    },
  });

  assert.equal(result.batchResults[0].persistenceStatus, 'pending_replay');
  assert.equal(result.batchResults[0].failureCategory, 'database');
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
      return { status: 'queued', batchId: entry.batch.batchId };
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
  assert.equal(queued.length, 1);
  assert.equal(queued[0].batch.batchId, 'single-383');
  assert.equal(queued[0].batch.messages[0].photos[0].fileId, 'file-food-383');
  assert.match(queued[0].error, /invalid JSON/);
  assert.equal(queued[0].nextRetryAt.toISOString(), now.toISOString());
  const report = buildTelegramSyncReport(result);
  assert.equal(report.batches[0].recognitionPendingStatus, 'queued');
  assert.equal(report.batches[0].recognitionPendingError, null);
  assert.equal(report.batches[0].pendingReplay, false);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /AI 识别失败（已识别 \d+\/\d+.*），已加入重试队列/);
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

test('runTelegramSync queues low-confidence visible-date images instead of reporting no reliable date', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-low-confidence-date-'));
  const queued = [];
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
          date: Math.floor(new Date('2026-06-08T05:46:33Z').getTime() / 1000),
          chat: { id: 42 },
          photo: [{ file_id: 'file-a', file_unique_id: 'uniq-a' }],
        },
      },
    ],
    recognizeBatch: async () => ({
      recognitions: [
        {
          messageId: 903,
          imageType: 'workout',
          detectedDate: '2026-06-06',
          dateEvidence: 'image shows 6月6日, year from telegram message',
          confidence: 0.62,
          warnings: ['date text is small'],
          records: {
            activities: [{ time: '19:13', type: '力量训练', detail: '总消耗241千卡' }],
          },
        },
      ],
      recognitionErrors: [],
    }),
    appendPendingRecognitionBatch: async (entry) => {
      queued.push(entry);
      return { status: 'queued', batchId: entry.batch.batchId };
    },
    sendTelegramMessage: async (message) => {
      sentMessages.push(message);
      return { message_id: 9903 };
    },
  });

  const batch = result.batchResults[0];
  assert.equal(batch.status, 'skipped');
  assert.equal(batch.failureCategory, 'ai_service');
  assert.equal(batch.recognitionPendingStatus, 'queued');
  assert.match(batch.reason, /image date detected below confidence threshold: 2026-06-06/);
  assert.doesNotMatch(batch.reason, /no reliable image or filename date/);
  assert.equal(batch.dateSources[0].detectedDate, '2026-06-06');
  assert.equal(queued.length, 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /AI 识别失败/);
  assert.match(sentMessages[0].text, /已加入重试队列/);
  assert.doesNotMatch(sentMessages[0].text, /no reliable image or filename date/);
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
