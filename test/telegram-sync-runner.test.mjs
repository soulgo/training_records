import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildTelegramSyncReport,
  loadRecognitionSystemPrompt,
  runTelegramSync,
  shouldPersistTelegramArtifacts,
} from '../tools/telegram-sync.mjs';

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

test('runTelegramSync persists ready batches to the database and exports derived markdown', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-runner-'));
  const persistedBatches = [];
  const writtenMarkdown = [];

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
    exportTrainingMarkdown: (snapshot) => {
      writtenMarkdown.push(snapshot);
      return '### 2026-05-09\n';
    },
  });

  assert.equal(result.changed, true);
  assert.equal(persistedBatches.length, 1);
  assert.equal(writtenMarkdown.length, 1);
  assert.match(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /2026-05-09/);
});

test('runTelegramSync writes the ready batch back into markdown when the rebuilt database snapshot misses the new archived date', async () => {
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
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-05-13T00:00:00.000Z',
      latest: {
        measurement: {
          archivedDate: '2026-05-09',
          measuredAt: '2026-05-09 06:42',
          weightKg: 72.85,
        },
        daily: { date: '2026-05-09' },
      },
      daily: [
        {
          date: '2026-05-09',
          measurement: {
            archivedDate: '2026-05-09',
            measuredAt: '2026-05-09 06:42',
            weightKg: 72.85,
          },
          measurements: [
            {
              archivedDate: '2026-05-09',
              measuredAt: '2026-05-09 06:42',
              weightKg: 72.85,
            },
          ],
          activities: [],
          workoutSummary: {
            totalActivities: 0,
            totalDurationSeconds: 0,
            trainingCalories: 643,
            workoutDurationMinutes: 78,
            activeHours: 12,
            cyclingDistanceKm: 0,
            countsByType: {},
          },
          nutrition: {
            meals: [],
            totalCalories: null,
            details: [],
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
  });

  assert.equal(result.changed, true);
  assert.equal(result.fallbackUsed, false);
  assert.match(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /### 2026-04-06/);
  assert.match(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /活动热量：402千卡/);
});

test('runTelegramSync falls back to markdown rebuild when database snapshot lacks measurements after storing a batch', async () => {
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
      throw new Error('database snapshot is empty or missing measurements');
    },
    exportTrainingMarkdown: () => {
      throw new Error('exportTrainingMarkdown should not run when snapshot rebuild falls back to markdown');
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.fallbackUsed, false);
  assert.match(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /晚餐：329千卡/);
});

test('runTelegramSync falls back to markdown when database persistence fails', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-fallback-'));
  const fallbackMarkdown = [];

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
    onFallbackMarkdownWritten: (markdown) => {
      fallbackMarkdown.push(markdown);
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(fallbackMarkdown.length, 1);
  assert.equal(result.batchResults[0].persistenceStatus, 'fallback_markdown');
  assert.equal(result.batchResults[0].persistenceError, 'database unavailable');
  assert.match(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /晚餐：1065千卡/);
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
    exportTrainingMarkdown: () => '### 2026-05-14\n',
  });

  assert.equal(result.changed, true);
  assert.deepEqual(persistedBatches, ['album-ready']);
  assert.equal(result.batchResults[0].status, 'skipped');
  assert.equal(result.batchResults[1].status, 'ready');
  assert.match(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /2026-05-14/);
  assert.equal(
    await readFile(path.join(tempRoot, 'runtime', 'telegram-sync-pending.ndjson'), 'utf8'),
    '',
  );
});

test('buildTelegramSyncReport exposes fallback and archived date details for logs', () => {
  const report = buildTelegramSyncReport({
    changed: true,
    fallbackUsed: true,
    updatesFetched: 1,
    lastProcessedUpdateId: 520905402,
    readyBatches: 1,
    batchResults: [
      {
        batchId: 'album-1',
        status: 'ready',
        archivedDate: '2026-04-06',
        persistenceStatus: 'fallback_markdown',
        persistenceError: 'database unavailable',
        warnings: [],
        issues: [],
      },
    ],
  });

  assert.deepEqual(report, {
    changed: true,
    fallbackUsed: true,
    updatesFetched: 1,
    lastProcessedUpdateId: 520905402,
    readyBatches: 1,
    batches: [
      {
        kind: 'image',
        batchId: 'album-1',
        status: 'ready',
        archivedDate: '2026-04-06',
        postPath: null,
        thoughtWriteStatus: null,
        persistenceStatus: 'fallback_markdown',
        persistenceError: 'database unavailable',
        warnings: [],
        issues: [],
        reason: null,
      },
    ],
  });
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
    exportTrainingMarkdown: () => '### 2026-05-08\n',
  });

  assert.equal(result.changed, true);
  assert.deepEqual(persistedBatchIds, ['pending-batch']);
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
    exportTrainingMarkdown: () => '### 2026-05-09\n',
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.changed, true);
  assert.equal(result.updatesFetched, 1);
  assert.equal(result.lastProcessedUpdateId, 901);
  assert.equal(persistedBatches.length, 1);
  assert.match(await readFile(path.join(tempRoot, '训练记录.md'), 'utf8'), /2026-05-09/);
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

test('runTelegramSync writes a /thought telegram message into source/_posts and persists ingest only', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-'));
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

  const postPath = path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-501.md');
  const postContent = await readFile(postPath, 'utf8');

  assert.equal(result.changed, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'written');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].kind, 'thought');
  assert.equal(
    persistedBatches[0].thought.storage.markdownPath,
    'source/_posts/2026-05-14-telegram-thought-501.md',
  );
  assert.deepEqual(persistedBatches[0].thought.storage.photoPaths, []);
  assert.doesNotMatch(postContent, /^title:/m);
  assert.match(postContent, /date: 2026-05-14 10:30:00/);
  assert.match(postContent, /telegram_message_id: 501/);
  assert.match(postContent, /telegram_chat_id: 42/);
  assert.match(postContent, /今天训练后臀部发力更明显/);
  assert.match(postContent, /感觉动作路线更顺了/);
});

test('runTelegramSync writes a /随想 image caption into source/_posts with downloaded photos', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-photo-'));
  const persistedBatches = [];
  const downloadedFileIds = [];
  let recognized = false;

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

  const postPath = path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-502.md');
  const postContent = await readFile(postPath, 'utf8');
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
  assert.equal(recognized, false);
  assert.deepEqual(downloadedFileIds, ['photo-large']);
  assert.equal(persistedBatches.length, 1);
  assert.equal(persistedBatches[0].kind, 'thought');
  assert.equal(
    persistedBatches[0].thought.storage.markdownPath,
    'source/_posts/2026-05-14-telegram-thought-502.md',
  );
  assert.deepEqual(persistedBatches[0].thought.storage.photoPaths, [
    '/images/thoughts/2026/05/2026-05-14-telegram-thought-502-1.jpg',
  ]);
  assert.match(postContent, /photos:\n  - \/images\/thoughts\/2026\/05\/2026-05-14-telegram-thought-502-1\.jpg/);
  assert.match(postContent, /今天深蹲动作轨迹更稳了/);
  assert.equal(await readFile(imagePath, 'utf8'), 'fake image content');
});

test('runTelegramSync writes a /thought album caption as one thought post with all photos', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-album-'));
  const downloadedFileIds = [];

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

  const postContent = await readFile(
    path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-601.md'),
    'utf8',
  );

  assert.equal(result.batchResults.length, 1);
  assert.equal(result.batchResults[0].kind, 'thought');
  assert.equal(result.batchResults[0].batchId, 'thought-601');
  assert.deepEqual(downloadedFileIds, ['album-photo-a', 'album-photo-b']);
  assert.match(postContent, /\/images\/thoughts\/2026\/05\/2026-05-14-telegram-thought-601-1\.png/);
  assert.match(postContent, /\/images\/thoughts\/2026\/05\/2026-05-14-telegram-thought-601-2\.png/);
});

test('runTelegramSync treats an existing thought post as duplicate and does not overwrite it', async () => {
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'duplicate');
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'updated');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches[0].kind, 'thought_edit');
  assert.equal(
    persistedBatches[0].thoughtEdit.storage.markdownPath,
    'source/_posts/2026-05-17-telegram-thought-126.md',
  );
  assert.deepEqual(persistedBatches[0].thoughtEdit.storage.photoPaths, []);
  assert.match(postContent, /今天骑行 40 公里，动作更顺/);
  assert.doesNotMatch(postContent, /旧正文/);
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
  - 训练
  - 随想
  - Telegram
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'updated');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches[0].kind, 'thought_edit');
  assert.match(postContent, /高德地图骑行的公里数和华为手表骑行的公里数差别太大了/);
  assert.doesNotMatch(postContent, /旧正文/);
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
          message_id: 132,
          date: Math.floor(new Date('2026-05-18T02:59:00Z').getTime() / 1000),
          chat: { id: 42 },
          caption: '/随想编 126 今天骑行 40 公里，补充图片',
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'updated');
  assert.equal(persistedBatches[0].thoughtEdit.replacePhotos, true);
  assert.deepEqual(downloadedFileIds, ['new-photo']);
  assert.match(postContent, /今天骑行 40 公里，补充图片/);
  assert.match(postContent, /photos:\n  - \/images\/thoughts\/2026\/05\/2026-05-17-telegram-thought-126-1\.png/);
  await assert.rejects(
    readFile(path.join(imageDir, '2026-05-17-telegram-thought-126-1.jpg'), 'utf8'),
    /ENOENT/,
  );
  assert.equal(
    await readFile(path.join(imageDir, '2026-05-17-telegram-thought-126-1.png'), 'utf8'),
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
  assert.equal(result.batchResults[0].thoughtWriteStatus, 'deleted');
  assert.equal(result.batchResults[0].persistenceStatus, 'stored');
  assert.equal(persistedBatches[0].kind, 'thought_delete');
  assert.equal(
    persistedBatches[0].thoughtDelete.storage.markdownPath,
    'source/_posts/2026-05-17-telegram-thought-126.md',
  );
  assert.deepEqual(persistedBatches[0].thoughtDelete.storage.deletedPhotoPaths, [
    '/images/thoughts/2026/05/2026-05-17-telegram-thought-126-1.jpg',
  ]);
  await assert.rejects(
    readFile(path.join(postsDir, '2026-05-17-telegram-thought-126.md'), 'utf8'),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(path.join(imageDir, '2026-05-17-telegram-thought-126-1.jpg'), 'utf8'),
    /ENOENT/,
  );
});

test('runTelegramSync keeps thought posts when database persistence fails and queues replay', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-sync-thought-fallback-'));

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

  assert.equal(result.changed, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.batchResults[0].persistenceStatus, 'pending_replay');
  assert.match(
    await readFile(path.join(tempRoot, 'source', '_posts', '2026-05-14-telegram-thought-701.md'), 'utf8'),
    /今晚训练结束后心率回落更快了/,
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
  assert.equal(generated, false);
  assert.equal(sent, false);
});
