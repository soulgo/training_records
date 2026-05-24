import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  backfillCoreFromLatestArchiveSnapshot,
  exportTrainingMarkdown,
  getLastProcessedTelegramUpdateId,
  persistNormalizedBatch,
  readTrainingSnapshotFromDatabaseClient,
} from '../tools/training-db-core.mjs';

const normalizedBatch = {
  batchId: 'album-20260509',
  status: 'ready',
  archivedDate: '2026-05-09',
  measurement: {
    measuredAt: '2026-05-09 06:42',
    bodyScore: 74,
    weightKg: 72.85,
    bmi: 23.5,
    bodyFatPct: 22.8,
    skeletalMuscleKg: 30.45,
    visceralFatLevel: 8,
    basalMetabolismKcal: 1587,
    bodyWaterPct: 49.7,
    proteinPct: 23.3,
    boneMassKg: 2.955,
    fatFreeMassKg: 56.6,
    bodyAge: 32,
    bodyType: '肥胖型',
  },
  activities: [
    {
      time: '19:13',
      type: '力量训练',
      detail: '总消耗241千卡，时长00:27:50，平均心率129次/分钟',
    },
  ],
  workoutDailySummary: {
    activityCaloriesKcal: 643,
    workoutDurationMinutes: 78,
    activeHours: 12,
  },
  nutrition: {
    meals: [
      { name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 },
    ],
    totalCalories: 1593,
    details: ['晚餐 1065 千卡（建议范围 317-740 千卡）'],
  },
  warnings: [],
  issues: [],
  confidence: 0.97,
  updateIds: [901, 902],
  recognitions: [
    {
      messageId: 71,
      imageType: 'workout',
      detectedDate: '2026-05-09',
      confidence: 0.97,
    },
  ],
  messages: [
    {
      updateId: 901,
      messageId: 71,
      mediaGroupId: 'album-20260509',
      caption: '归档到 2026-05-09',
      text: '',
      chatId: 42,
      dateUnix: 1746748800,
      photos: [{ fileId: 'abc', fileUniqueId: 'u-abc' }],
    },
  ],
};

test('readTrainingSnapshotFromDatabaseClient normalizes archived dates before grouping rows', async () => {
  const client = {
    async query(sql) {
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: new Date('2026-05-22T00:00:00.000Z'),
              total_activities: 7,
              total_duration_seconds: 8888,
              training_calories: 1077,
              workout_duration_minutes: 148,
              active_hours: 14,
              cycling_distance_km: 11.74,
              intake_calories: 1385,
              nutrition_details_json: ['早餐 597千卡'],
            },
          ],
        };
      }
      if (/from core\.measurement/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: new Date('2026-05-22T00:00:00.000Z'),
              measured_at: '2026-05-22',
              body_score: 76,
              weight_kg: 73.7,
              bmi: 23.7,
              body_fat_pct: 22.8,
              skeletal_muscle_kg: 30.8,
              visceral_fat_level: 9,
              basal_metabolism_kcal: 1605,
              body_water_pct: 50,
              protein_pct: 23.1,
              bone_mass_kg: 2.975,
              fat_free_mass_kg: 56.9,
              body_age: 31,
              body_type: '肥胖型',
            },
          ],
        };
      }
      if (/from core\.activity/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: new Date('2026-05-22T00:00:00.000Z'),
              activity_time: '06:40',
              activity_type: 'mixed_cardio',
              raw_type: 'mixed_cardio',
              detail: '总消耗375千卡，时长00:40:01，平均心率145次/分钟',
              calories: 375,
              heart_rate: 145,
              distance_km: null,
              avg_speed_kmh: null,
              duration_text: '00:40:01',
              duration_seconds: 2401,
            },
          ],
        };
      }
      if (/from core\.meal/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: new Date('2026-05-22T00:00:00.000Z'),
              meal_name: '早餐',
              calories: 597,
              recommended_min: 512,
              recommended_max: 922,
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const snapshot = await readTrainingSnapshotFromDatabaseClient(
    client,
    new Date('2026-05-23T00:00:00.000Z'),
  );
  const day = snapshot.daily.find((entry) => entry.date === '2026-05-22');

  assert.ok(day);
  assert.equal(day.activities.length, 1);
  assert.equal(day.nutrition.meals.length, 1);
  assert.equal(day.measurement.weightKg, 73.7);
  assert.equal(snapshot.charts.weightKg[0].date, '2026-05-22');
});

test('persistNormalizedBatch writes ingest and core records in one transaction', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: normalizedBatch,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.equal(calls[0][0], 'connect');
  assert.equal(calls[1][0], 'BEGIN');
  assert.ok(calls.some(([sql]) => /insert into ingest\.telegram_batch/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into ingest\.telegram_message/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into core\.training_day/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into core\.measurement/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into core\.activity/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into core\.meal/i.test(sql)));
  assert.equal(calls.at(-2)[0], 'COMMIT');
  assert.equal(calls.at(-1)[0], 'end');
});

test('persistNormalizedBatch rolls back the transaction when a core write fails', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      if (/insert into core\.training_day/i.test(sql)) {
        throw new Error('core write failed');
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  await assert.rejects(
    persistNormalizedBatch({
      batch: normalizedBatch,
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      createClient() {
        return fakeClient;
      },
      processedAt: new Date('2026-05-13T00:00:00.000Z'),
    }),
    /core write failed/,
  );

  const statements = calls.map(([sql]) => sql);
  assert.equal(statements.includes('BEGIN'), true);
  assert.equal(statements.includes('ROLLBACK'), true);
  assert.equal(statements.includes('COMMIT'), false);
  assert.equal(calls.at(-1)[0], 'end');
  assert.ok(calls.some(([sql]) => /insert into ingest\.telegram_batch/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into core\.training_day/i.test(sql)));
});

test('persistNormalizedBatch returns unchanged and rolls back when payload hash matches', async () => {
  const calls = [];
  const expectedPayloadHash = createHash('sha256')
    .update(JSON.stringify(normalizedBatch), 'utf8')
    .digest('hex');
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [{ payload_hash: expectedPayloadHash }] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: normalizedBatch,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'unchanged');
  assert.equal(result.batchId, normalizedBatch.batchId);
  assert.equal(calls.some(([sql]) => /insert into ingest\.telegram_batch/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.training_day/i.test(sql)), false);
  assert.deepEqual(
    calls.map(([sql]) => sql),
    ['connect', 'BEGIN', calls[2][0], 'ROLLBACK', 'end'],
  );
});

test('persistNormalizedBatch mirrors thought create, edit, and delete batches into core.thought', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };
  const env = {
    TRAINING_DB_ENABLED: 'true',
    TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
  };
  const processedAt = new Date('2026-05-14T03:00:00.000Z');

  await persistNormalizedBatch({
    batch: {
      kind: 'thought',
      batchId: 'thought-501',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [901],
      recognitions: [],
      messages: [
        {
          updateId: 901,
          messageId: 501,
          mediaGroupId: null,
          chatId: 42,
          caption: '',
          text: '/thought 今天训练后臀部发力更明显',
          dateUnix: 1778725800,
          photos: [],
        },
      ],
      thought: {
        command: '/thought',
        body: '今天训练后臀部发力更明显',
        thoughtModule: 'misc',
        tags: ['训练', '随想', 'Telegram'],
        telegramMessageId: 501,
        telegramChatId: 42,
        messageDateUnix: 1778725800,
        storage: {
          markdownPath: 'source/_posts/2026-05-14-telegram-thought-501.md',
          photoPaths: ['/images/thoughts/2026/05/2026-05-14-telegram-thought-501-1.jpg'],
        },
      },
    },
    env,
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  await persistNormalizedBatch({
    batch: {
      kind: 'thought_edit',
      batchId: 'thought-edit-132',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [902],
      recognitions: [],
      messages: [
        {
          updateId: 902,
          messageId: 132,
          mediaGroupId: null,
          chatId: 42,
          caption: '/随想编 501 更新后的正文',
          text: '',
          dateUnix: 1778812200,
          photos: [],
        },
      ],
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: 501,
        body: '更新后的正文',
        thoughtModule: 'misc',
        tags: ['杂七杂八', '随想', 'Telegram'],
        replacePhotos: false,
        telegramChatId: 42,
        messageDateUnix: 1778812200,
        storage: {
          markdownPath: 'source/_posts/2026-05-14-telegram-thought-501.md',
          photoPaths: [],
        },
      },
    },
    env,
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  await persistNormalizedBatch({
    batch: {
      kind: 'thought_delete',
      batchId: 'thought-delete-801',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [903],
      recognitions: [],
      messages: [
        {
          updateId: 903,
          messageId: 801,
          mediaGroupId: null,
          chatId: 42,
          caption: '',
          text: '/随想删 501',
          dateUnix: 1778898600,
          photos: [],
        },
      ],
      thoughtDelete: {
        command: '/随想删',
        targetMessageId: 501,
        telegramChatId: 42,
        messageDateUnix: 1778898600,
        storage: {
          markdownPath: 'source/_posts/2026-05-14-telegram-thought-501.md',
          deletedPhotoPaths: ['/images/thoughts/2026/05/2026-05-14-telegram-thought-501-1.jpg'],
        },
      },
    },
    env,
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  await persistNormalizedBatch({
    batch: {
      kind: 'thought_move',
      batchId: 'thought-move-133',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [904],
      recognitions: [],
      messages: [
        {
          updateId: 904,
          messageId: 133,
          mediaGroupId: null,
          chatId: 42,
          caption: '',
          text: '/移动 501 杂七杂八',
          dateUnix: 1778985000,
          photos: [],
        },
      ],
      thoughtMove: {
        command: '/移动',
        targetMessageId: 501,
        thoughtModule: 'misc',
        tags: ['杂七杂八', '随想', 'Telegram'],
        telegramChatId: 42,
        messageDateUnix: 1778985000,
        storage: {
          markdownPath: 'source/_posts/2026-05-14-telegram-thought-501.md',
          photoPaths: [],
        },
      },
    },
    env,
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  const thoughtWrites = calls.filter(
    ([sql]) => typeof sql === 'string' && /insert into core\.thought/i.test(sql),
  );
  assert.equal(thoughtWrites.length, 4);
  assert.equal(thoughtWrites[0][1][0], 501);
  assert.equal(thoughtWrites[0][1][4], '今天训练后臀部发力更明显');
  assert.equal(thoughtWrites[0][1][5], 'misc');
  assert.equal(thoughtWrites[0][1][8], 'source/_posts/2026-05-14-telegram-thought-501.md');
  assert.deepEqual(JSON.parse(thoughtWrites[0][1][9]), [
    '/images/thoughts/2026/05/2026-05-14-telegram-thought-501-1.jpg',
  ]);
  assert.equal(thoughtWrites[1][1][4], '更新后的正文');
  assert.equal(thoughtWrites[1][1][5], 'misc');
  assert.equal(thoughtWrites[1][1][9], '[]');
  assert.match(thoughtWrites[2][0], /status = excluded\.status/i);
  assert.deepEqual(JSON.parse(thoughtWrites[2][1][8]), [
    '/images/thoughts/2026/05/2026-05-14-telegram-thought-501-1.jpg',
  ]);
  assert.equal(thoughtWrites[3][1][4], '');
  assert.equal(thoughtWrites[3][1][5], 'misc');
});

test('getLastProcessedTelegramUpdateId reads the max update id from ingest records', async () => {
  const fakeClient = {
    async connect() {},
    async end() {},
    async query(sql) {
      assert.match(sql, /max\(update_id\)/i);
      return {
        rows: [{ last_processed_update_id: 903 }],
      };
    },
  };

  const updateId = await getLastProcessedTelegramUpdateId({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
  });

  assert.equal(updateId, 903);
});

test('backfillCoreFromLatestArchiveSnapshot writes only archive dates missing from core', async () => {
  const calls = [];
  function createArchiveClient() {
    return {
      async connect() {
        calls.push(['connect']);
      },
      async query(sql, params) {
        calls.push([sql, params]);
        if (/from archive\.training_day/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-04-03',
                total_activities: 1,
                total_duration_seconds: 1920,
                training_calories: 459,
                workout_duration_minutes: 32,
                active_hours: 13,
                cycling_distance_km: 0,
                intake_calories: null,
              },
              {
                archived_date: '2026-04-13',
                total_activities: 1,
                total_duration_seconds: 3300,
                training_calories: 779,
                workout_duration_minutes: 55,
                active_hours: 14,
                cycling_distance_km: 0,
                intake_calories: null,
              },
            ],
          };
        }
        if (/from archive\.training_measurement/i.test(sql)) {
          return { rows: [] };
        }
        if (/from archive\.training_activity/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-04-03',
                activity_time: '20:18',
                activity_type: 'traditional_strength_training',
                raw_type: 'traditional_strength_training',
                detail: '总消耗459千卡，时长00:32:00',
                calories: 459,
                heart_rate: null,
                distance_km: null,
                avg_speed_kmh: null,
                duration_text: '00:32:00',
                duration_seconds: 1920,
              },
              {
                archived_date: '2026-04-13',
                activity_time: '20:12',
                activity_type: 'mixed_cardio',
                raw_type: 'mixed_cardio',
                detail: '总消耗779千卡，时长00:55:00',
                calories: 779,
                heart_rate: null,
                distance_km: null,
                avg_speed_kmh: null,
                duration_text: '00:55:00',
                duration_seconds: 3300,
              },
            ],
          };
        }
        if (/from archive\.training_meal/i.test(sql)) {
          return { rows: [] };
        }
        if (/select\s+archived_date\s+from core\.training_day/i.test(sql)) {
          return { rows: [{ archived_date: '2026-04-13' }] };
        }
        return { rows: [] };
      },
      async end() {
        calls.push(['end']);
      },
    };
  }

  const result = await backfillCoreFromLatestArchiveSnapshot({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return createArchiveClient();
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.equal(result.daysBackfilled, 1);

  const dayInserts = calls.filter(
    ([sql]) => typeof sql === 'string' && /insert into core\.training_day/i.test(sql),
  );
  assert.equal(dayInserts.length, 1);
  assert.equal(dayInserts[0][1][0], '2026-04-03');
  assert.equal(dayInserts[0][1][1], 'archive_backfill');
});

test('exportTrainingMarkdown renders a readable markdown view from the canonical snapshot', async () => {
  const markdown = exportTrainingMarkdown({
    generatedAt: '2026-05-13T00:00:00.000Z',
    latest: {
      measurement: normalizedBatch.measurement,
      daily: {
        date: normalizedBatch.archivedDate,
      },
    },
    daily: [
      {
        date: normalizedBatch.archivedDate,
        measurement: {
          archivedDate: normalizedBatch.archivedDate,
          ...normalizedBatch.measurement,
        },
        measurements: [
          {
            archivedDate: normalizedBatch.archivedDate,
            ...normalizedBatch.measurement,
          },
        ],
        activities: [
          {
            time: '19:13',
            type: '力量训练',
            rawType: '力量训练',
            detail: '总消耗241千卡，时长00:27:50，平均心率129次/分钟',
            durationText: '00:27:50',
            durationSeconds: 1670,
            calories: 241,
            distanceKm: null,
            avgSpeedKmh: null,
            heartRate: 129,
          },
        ],
        workoutSummary: {
          totalActivities: 1,
          totalDurationSeconds: 1670,
          trainingCalories: 643,
          workoutDurationMinutes: 78,
          activeHours: 12,
          cyclingDistanceKm: 0,
          countsByType: {
            力量训练: 1,
          },
        },
        nutrition: normalizedBatch.nutrition,
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
  });

  assert.match(markdown, /### 2026-05-09/);
  assert.match(markdown, /#### 当日体脂秤截图记录/);
  assert.match(markdown, /#### 当日运动截图记录/);
  assert.match(markdown, /#### 2026-05-09 饮食截图记录/);
  assert.match(markdown, /- 19:13 力量训练：总消耗241千卡/);
});
