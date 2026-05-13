import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backfillCoreFromLatestArchiveSnapshot,
  exportTrainingMarkdown,
  getLastProcessedTelegramUpdateId,
  persistNormalizedBatch,
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
  const archiveSnapshot = {
    generatedAt: '2026-05-13T00:00:00.000Z',
    latest: {
      measurement: null,
      daily: { date: '2026-04-13' },
    },
    daily: [
      {
        date: '2026-04-03',
        measurement: null,
        measurements: [],
        activities: [],
        workoutSummary: {
          totalActivities: 0,
          totalDurationSeconds: 0,
          trainingCalories: 459,
          workoutDurationMinutes: 32,
          activeHours: 13,
          cyclingDistanceKm: 0,
          countsByType: {},
        },
        nutrition: {
          meals: [],
          totalCalories: null,
          details: [],
        },
      },
      {
        date: '2026-04-13',
        measurement: null,
        measurements: [],
        activities: [],
        workoutSummary: {
          totalActivities: 0,
          totalDurationSeconds: 0,
          trainingCalories: 779,
          workoutDurationMinutes: 55,
          activeHours: 14,
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
  };

  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from archive\.training_parse_snapshot/i.test(sql)) {
        return { rows: [{ payload_json: archiveSnapshot }] };
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

  const result = await backfillCoreFromLatestArchiveSnapshot({
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
