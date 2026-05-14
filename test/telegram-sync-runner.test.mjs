import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildTelegramSyncReport,
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
        dateEvidence: 'caption',
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
        dateEvidence: 'caption',
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
        dateEvidence: 'caption',
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
        dateEvidence: 'caption',
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
              dateEvidence: 'caption',
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
        batchId: 'album-1',
        status: 'ready',
        archivedDate: '2026-04-06',
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
        dateEvidence: 'caption',
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
