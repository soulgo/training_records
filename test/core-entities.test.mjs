import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Activity,
  BodyMetric,
  HealthDaily,
  Meal,
  SleepRecord,
  ThoughtRecord,
  TrainingRecord,
  normalizeBatchActivity,
} from '../src/core/entities/index.mjs';
import {
  emptyNutrition,
  emptySleep,
  mergeBatchIntoDay,
} from '../src/core/services/training-merge-service.mjs';

test('TrainingRecord.fromRaw builds the daily read model summary', () => {
  const record = TrainingRecord.fromRaw({
    date: '2026-05-09',
    measurements: [{ archivedDate: '2026-05-09', weightKg: 73.5 }],
    activities: [
      {
        time: '20:00',
        type: '户外骑行',
        durationSeconds: 1800,
        calories: 240,
        distanceKm: 8.2,
      },
    ],
    nutrition: {
      meals: [{ name: '晚餐', calories: 800 }],
      totalCalories: 800,
      details: ['晚餐 800 千卡'],
    },
    sleep: {
      records: [{ totalSleepMinutes: 420, bedtime: '23:30', wakeTime: '06:30' }],
    },
  });

  assert.equal(record.date, '2026-05-09');
  assert.equal(record.measurement.weightKg, 73.5);
  assert.equal(record.workoutSummary.totalActivities, 1);
  assert.equal(record.workoutSummary.trainingCalories, 240);
  assert.equal(record.workoutSummary.cyclingDistanceKm, 8.2);
  assert.equal(record.sleepSummary.totalSleepMinutes, 420);
});

test('TrainingRecord.mergeWith applies a ready batch without mutating existing data', () => {
  const existing = TrainingRecord.fromRaw({
    date: '2026-05-09',
    measurements: [{ archivedDate: '2026-05-09', weightKg: 74 }],
    activities: [],
    nutrition: {
      meals: [{ name: '午餐', calories: 600 }],
      totalCalories: 600,
      details: ['午餐 600 千卡'],
    },
  });

  const merged = existing.mergeWith({
    batchId: 'batch-1',
    archivedDate: '2026-05-09',
    measurement: { weightKg: 73.5 },
    activities: [
      {
        time: '2026-05-09 21:10',
        type: 'outdoor_cycling',
        detail: '骑行 30分10秒，总消耗 250 千卡，8.5 公里',
      },
    ],
  });

  assert.equal(existing.measurement.weightKg, 74);
  assert.equal(merged.measurement.weightKg, 73.5);
  assert.equal(merged.activities[0].time, '21:10');
  assert.equal(merged.activities[0].type, '户外骑行');
  assert.equal(merged.activities[0].durationSeconds, 1810);
  assert.equal(merged.activities[0].calories, 250);
  assert.equal(merged.nutrition.totalCalories, 600);
});

test('normalizeBatchActivity extracts stable workout metrics from detail text', () => {
  assert.deepEqual(
    normalizeBatchActivity({
      time: '2026-05-09 19:30',
      type: 'traditional_strength_training',
      detail: '力量训练 00:45:30，总消耗 310 千卡，平均心率 128 次/分钟',
    }),
    {
      time: '19:30',
      type: '力量训练',
      rawType: 'traditional_strength_training',
      detail: '力量训练 00:45:30，总消耗 310 千卡，平均心率 128 次/分钟',
      durationText: '00:45:30',
      durationSeconds: 2730,
      calories: 310,
      heartRate: 128,
      distanceKm: null,
      avgSpeedKmh: null,
    },
  );
});

test('core entity constructors keep raw values explicit and lightweight', () => {
  assert.equal(BodyMetric.fromRaw({ weightKg: 73 }).weightKg, 73);
  assert.equal(Activity.fromRaw({ type: '骑行' }).type, '骑行');
  assert.equal(Meal.fromRaw({ name: '晚餐' }).name, '晚餐');
  assert.equal(SleepRecord.fromRaw({ totalSleepMinutes: 420 }).totalSleepMinutes, 420);
  assert.equal(HealthDaily.fromRaw({ date: '2026-05-09' }).date, '2026-05-09');
  assert.equal(ThoughtRecord.fromRaw({ telegramMessageId: 42 }).telegramMessageId, 42);
});

test('training merge service exposes domain factories and merge behavior', () => {
  const merged = mergeBatchIntoDay(null, {
    batchId: 'batch-merge',
    archivedDate: '2026-05-10',
    nutrition: {
      meals: [{ name: '早餐', calories: 420 }],
      totalCalories: 420,
      details: [],
    },
  });

  assert.deepEqual(emptyNutrition(), { meals: [], totalCalories: null, details: [] });
  assert.equal(emptySleep().records.length, 0);
  assert.equal(merged.date, '2026-05-10');
  assert.equal(merged.nutrition.totalCalories, 420);
});
