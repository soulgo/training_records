import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECOGNITION_RECONCILIATION_TOLERANCES,
  reconcileRecognitionResults,
} from '../src/core/ai/recognition-reconciliation.mjs';

const EMPTY_RECORDS = Object.freeze({
  measurement: null,
  activities: [],
  meals: [],
  totalCalories: null,
  details: [],
  dailyWorkoutSummary: null,
  sleep: null,
});

function recognition(imageType, records = {}) {
  return {
    imageType,
    detectedApp: 'test-app',
    detectedDate: '2026-07-16',
    dateEvidence: 'explicit',
    records: { ...EMPTY_RECORDS, ...records },
    confidence: 0.9,
    warnings: [],
  };
}

test('reconciliation tolerances are centralized and lock the documented v1 values', () => {
  assert.deepEqual(RECOGNITION_RECONCILIATION_TOLERANCES, {
    KILOGRAMS: 0.1,
    RATIO_OR_PERCENTAGE: 0.1,
    KCAL: 1,
    DURATION_MINUTES: 5,
    DURATION_SECONDS: 5,
    HEART_RATE_BPM: 2,
    DISTANCE_KM: 0.05,
    SPEED_KMH: 0.1,
    SLEEP_SCORE: 1,
  });
});

test('keeps a non-empty primary field when the fallback field is empty', () => {
  const primary = recognition('measurement', {
    measurement: { weightKg: 70 },
  });
  const fallback = recognition('measurement', {
    measurement: { weightKg: null },
  });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'primary');
  assert.equal(result.value.records.measurement.weightKg, 70);
  assert.deepEqual(result.filledFields, []);
  assert.equal(result.fieldSources['records.measurement.weightKg'], 'primary');
});

test('fills an empty primary field from a non-empty fallback field', () => {
  const primary = recognition('measurement', {
    measurement: { weightKg: null },
  });
  const fallback = recognition('measurement', {
    measurement: { weightKg: 70 },
  });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'fallback_completed');
  assert.equal(result.value.records.measurement.weightKg, 70);
  assert.deepEqual(result.filledFields, ['records.measurement.weightKg']);
  assert.equal(result.fieldSources['records.measurement.weightKg'], 'fallback');
});

test('keeps the primary value and records agreement when both values are equal', () => {
  const primary = recognition('nutrition', { totalCalories: 868 });
  const fallback = recognition('nutrition', { totalCalories: 868 });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'primary');
  assert.equal(result.value.records.totalCalories, 868);
  assert.deepEqual(result.agreedFields, ['records.totalCalories']);
  assert.equal(result.fieldSources['records.totalCalories'], 'reconciled');
});

test('keeps the primary numeric value when the difference is within tolerance', () => {
  const primary = recognition('measurement', {
    measurement: { weightKg: 70 },
  });
  const fallback = recognition('measurement', {
    measurement: { weightKg: 70.09 },
  });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'primary');
  assert.equal(result.value.records.measurement.weightKg, 70);
  assert.deepEqual(result.agreedFields, ['records.measurement.weightKg']);
  assert.deepEqual(result.conflictFields, []);
});

test('blocks a critical numeric conflict when the difference exceeds tolerance', () => {
  const primary = recognition('measurement', {
    measurement: { weightKg: 70 },
  });
  const fallback = recognition('measurement', {
    measurement: { weightKg: 70.2 },
  });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'conflict');
  assert.equal(result.value, null);
  assert.deepEqual(result.conflictFields, ['records.measurement.weightKg']);
});

test('does not turn non-critical explanatory text differences into core conflicts', () => {
  const primary = recognition('sleep', {
    sleep: { totalSleepMinutes: 480, analysisText: '睡眠良好' },
  });
  const fallback = recognition('sleep', {
    sleep: { totalSleepMinutes: 480, analysisText: '整体睡眠良好' },
  });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'primary');
  assert.equal(result.value.records.sleep.analysisText, '睡眠良好');
  assert.deepEqual(result.conflictFields, []);
  assert.equal(result.fieldSources['records.sleep.analysisText'], 'primary');
});

test('blocks reconciliation when primary and fallback image types differ', () => {
  const primary = recognition('measurement', {
    measurement: { weightKg: null },
  });
  const fallback = recognition('nutrition', { totalCalories: 868 });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'conflict');
  assert.equal(result.value, null);
  assert.deepEqual(result.conflictFields, ['imageType']);
  assert.deepEqual(result.filledFields, []);
});

test('merges activities by the stable time-type-detail key instead of array position', () => {
  const primary = recognition('workout', {
    activities: [
      {
        time: '07:30',
        type: '跑步',
        detail: '晨跑',
        durationSeconds: 1800,
        calories: null,
        heartRate: null,
        distanceKm: 5,
        avgSpeedKmh: null,
      },
      {
        time: '19:00',
        type: '力量训练',
        detail: '上肢',
        durationSeconds: 1200,
        calories: 180,
        heartRate: 120,
        distanceKm: null,
        avgSpeedKmh: null,
      },
    ],
  });
  const fallback = recognition('workout', {
    activities: [
      {
        time: '19:00',
        type: '力量训练',
        detail: '上肢',
        durationSeconds: 1200,
        calories: 180,
        heartRate: 120,
        distanceKm: null,
        avgSpeedKmh: null,
      },
      {
        time: '07:30',
        type: '跑步',
        detail: '晨跑',
        durationSeconds: 1802,
        calories: 240,
        heartRate: 135,
        distanceKm: 5.03,
        avgSpeedKmh: 10,
      },
    ],
  });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'fallback_completed');
  assert.equal(result.value.records.activities.length, 2);
  assert.equal(result.value.records.activities[0].type, '跑步');
  assert.equal(result.value.records.activities[0].calories, 240);
  assert.equal(result.value.records.activities[0].heartRate, 135);
  assert.equal(result.value.records.activities[1].type, '力量训练');
  assert.ok(result.filledFields.includes('records.activities[0].calories'));
  assert.ok(result.agreedFields.includes('records.activities[0].durationSeconds'));
  assert.equal(result.fieldSources['records.activities[0].heartRate'], 'fallback');
});

test('merges meals by normalized meal name and applies kcal tolerance', () => {
  const primary = recognition('nutrition', {
    meals: [
      { name: ' 晚餐 ', calories: 500, recommendedMin: null, recommendedMax: 700 },
    ],
  });
  const fallback = recognition('nutrition', {
    meals: [
      { name: '  晚   餐 ', calories: 500.5, recommendedMin: 400, recommendedMax: 700 },
    ],
  });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'fallback_completed');
  assert.equal(result.value.records.meals.length, 1);
  assert.equal(result.value.records.meals[0].name, ' 晚餐 ');
  assert.equal(result.value.records.meals[0].calories, 500);
  assert.equal(result.value.records.meals[0].recommendedMin, 400);
  assert.ok(result.agreedFields.includes('records.meals[0].calories'));
  assert.ok(result.filledFields.includes('records.meals[0].recommendedMin'));
});

test('returns primary when the primary result is complete and no fallback was needed', () => {
  const primary = recognition('measurement', {
    measurement: { weightKg: 70 },
  });

  const result = reconcileRecognitionResults({ primary, fallback: null });

  assert.equal(result.status, 'primary');
  assert.equal(result.value.records.measurement.weightKg, 70);
  assert.deepEqual(result.filledFields, []);
  assert.equal(result.fieldSources['records.measurement.weightKg'], 'primary');
});

test('returns incomplete when an incomplete primary result has no fallback', () => {
  const primary = recognition('measurement', {
    measurement: { weightKg: null },
  });

  const result = reconcileRecognitionResults({ primary, fallback: null });

  assert.deepEqual(result, {
    status: 'incomplete',
    value: null,
    filledFields: [],
    agreedFields: [],
    conflictFields: [],
    fieldSources: {},
    finalSource: 'primary_incomplete',
  });
});

test('returns incomplete when both results still miss the hard-required field', () => {
  const primary = recognition('measurement', {
    measurement: { weightKg: null, bodyFatPct: null },
  });
  const fallback = recognition('measurement', {
    measurement: { weightKg: null, bodyFatPct: 20 },
  });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'incomplete');
  assert.equal(result.value, null);
  assert.deepEqual(result.filledFields, ['records.measurement.bodyFatPct']);
  assert.deepEqual(result.conflictFields, []);
});

test('does not let a stale primary semantic review block a fallback relationship fix', () => {
  const primary = recognition('sleep', {
    sleep: {
      totalSleepMinutes: 480,
      nightSleepMinutes: null,
      napMinutes: 0,
    },
  });
  primary.semanticGate = {
    status: 'needs_review',
    decisions: [{ action: 'review', path: 'sleep.totalSleepMinutes' }],
  };
  primary.warnings = [
    'semantic:sleep.totalSleepMinutes conflicts with component sleep minutes',
    '保留的来源提示',
  ];
  const fallback = recognition('sleep', {
    sleep: {
      totalSleepMinutes: 480,
      nightSleepMinutes: 480,
      napMinutes: 0,
    },
  });

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.status, 'fallback_completed');
  assert.equal(result.value.records.sleep.nightSleepMinutes, 480);
  assert.equal(result.value.semanticGate, undefined);
  assert.deepEqual(result.value.warnings, ['保留的来源提示']);
});

test('does not mutate primary or fallback inputs', () => {
  const primary = recognition('measurement', {
    measurement: { weightKg: null, bodyFatPct: 20 },
  });
  const fallback = recognition('measurement', {
    measurement: { weightKg: 70, bodyFatPct: 20.05 },
  });
  const primaryBefore = structuredClone(primary);
  const fallbackBefore = structuredClone(fallback);
  deepFreeze(primary);
  deepFreeze(fallback);

  const result = reconcileRecognitionResults({ primary, fallback });

  assert.equal(result.value.records.measurement.weightKg, 70);
  assert.deepEqual(primary, primaryBefore);
  assert.deepEqual(fallback, fallbackBefore);
  assert.notEqual(result.value, primary);
  assert.notEqual(result.value.records, primary.records);
  assert.notEqual(result.value.records.measurement, primary.records.measurement);
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
