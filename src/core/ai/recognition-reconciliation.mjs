import { evaluateRecognitionCompleteness } from './recognition-completeness.mjs';

export const RECOGNITION_RECONCILIATION_TOLERANCES = Object.freeze({
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

const MEASUREMENT_FIELDS = [
  'measuredAt',
  'bodyScore',
  'weightKg',
  'bmi',
  'bodyFatPct',
  'skeletalMuscleKg',
  'visceralFatLevel',
  'basalMetabolismKcal',
  'bodyWaterPct',
  'proteinPct',
  'boneMassKg',
  'fatFreeMassKg',
  'bodyAge',
  'bodyType',
];

const ACTIVITY_FIELDS = [
  'time',
  'type',
  'detail',
  'durationSeconds',
  'calories',
  'heartRate',
  'distanceKm',
  'avgSpeedKmh',
];

const MEAL_FIELDS = ['name', 'calories', 'recommendedMin', 'recommendedMax'];
const DAILY_WORKOUT_SUMMARY_FIELDS = [
  'activityCaloriesKcal',
  'workoutDurationMinutes',
  'activeHours',
];
const SLEEP_FIELDS = [
  'sleepType',
  'bedtime',
  'wakeTime',
  'nightSleepMinutes',
  'totalSleepMinutes',
  'napMinutes',
  'deepSleepMinutes',
  'lightSleepMinutes',
  'remSleepMinutes',
  'awakeMinutes',
  'sleepStageText',
  'sleepStageDetail',
  'sleepScore',
  'sleepScorePercentile',
  'deepSleepRatioPct',
  'lightSleepRatioPct',
  'remSleepRatioPct',
  'deepSleepContinuityScore',
  'wakeCount',
  'breathingQualityScore',
  'averageHeartRateBpm',
  'hrvMs',
  'averageSpo2Pct',
  'averageRespiratoryRate',
  'analysisText',
  'suggestionText',
];

const KILOGRAM_FIELDS = new Set([
  'records.measurement.weightKg',
  'records.measurement.skeletalMuscleKg',
  'records.measurement.boneMassKg',
  'records.measurement.fatFreeMassKg',
]);

const NON_CRITICAL_NUMERIC_FIELDS = new Set([
  'records.meals[].recommendedMin',
  'records.meals[].recommendedMax',
  'records.sleep.deepSleepMinutes',
  'records.sleep.lightSleepMinutes',
  'records.sleep.remSleepMinutes',
  'records.sleep.awakeMinutes',
  'records.sleep.deepSleepRatioPct',
  'records.sleep.lightSleepRatioPct',
  'records.sleep.remSleepRatioPct',
]);

export function reconcileRecognitionResults({ primary, fallback } = {}) {
  const hasPrimary = isRecognition(primary);
  const hasFallback = isRecognition(fallback);
  if (!hasPrimary && !hasFallback) return emptyResult('incomplete', 'not_run');
  if (hasPrimary && !hasFallback) return primaryOnlyResult(primary);

  if (hasPrimary && primary.imageType !== fallback.imageType) {
    return {
      ...emptyResult('conflict', 'conflict'),
      conflictFields: ['imageType'],
    };
  }

  const tracker = createTracker();
  const base = cloneValue(hasPrimary ? primary : fallback);
  delete base.semanticGate;
  base.warnings = Array.isArray(base.warnings)
    ? base.warnings.filter((warning) => !String(warning).startsWith('semantic:'))
    : [];
  base.records = mergeRecords({
    primary: hasPrimary ? primary.records : null,
    fallback: fallback.records,
    tracker,
  });

  if (tracker.conflictFields.length > 0) {
    return tracker.result('conflict', null, 'conflict');
  }
  if (evaluateRecognitionCompleteness({ recognition: base }).status !== 'complete') {
    return tracker.result('incomplete', null, 'merged_incomplete');
  }
  if (!hasPrimary && tracker.filledFields.length === 0) {
    return tracker.result('incomplete', null, 'fallback_incomplete');
  }
  return tracker.result(
    tracker.filledFields.length > 0 ? 'fallback_completed' : 'primary',
    base,
    tracker.filledFields.length > 0 ? 'merged' : 'primary',
  );
}

function primaryOnlyResult(primary) {
  const tracker = createTracker();
  const value = cloneValue(primary);
  value.records = mergeRecords({ primary: primary.records, fallback: null, tracker });
  const status = evaluateRecognitionCompleteness({ recognition: value }).status === 'complete'
    ? 'primary'
    : 'incomplete';
  return tracker.result(
    status,
    status === 'primary' ? value : null,
    status === 'primary' ? 'primary' : 'primary_incomplete',
  );
}

function mergeRecords({ primary, fallback, tracker }) {
  const primaryRecords = isPlainObject(primary) ? primary : {};
  const fallbackRecords = isPlainObject(fallback) ? fallback : {};
  return {
    measurement: mergeNullableObject({
      primary: primaryRecords.measurement,
      fallback: fallbackRecords.measurement,
      fields: MEASUREMENT_FIELDS,
      path: 'records.measurement',
      tracker,
    }),
    activities: mergeKeyedRecords({
      primary: primaryRecords.activities,
      fallback: fallbackRecords.activities,
      fields: ACTIVITY_FIELDS,
      path: 'records.activities',
      keyOf: activityKey,
      tracker,
    }),
    meals: mergeKeyedRecords({
      primary: primaryRecords.meals,
      fallback: fallbackRecords.meals,
      fields: MEAL_FIELDS,
      path: 'records.meals',
      keyOf: mealKey,
      tracker,
    }),
    totalCalories: mergeValue({
      primary: primaryRecords.totalCalories,
      fallback: fallbackRecords.totalCalories,
      path: 'records.totalCalories',
      tracker,
    }),
    details: mergeValue({
      primary: primaryRecords.details,
      fallback: fallbackRecords.details,
      path: 'records.details',
      tracker,
    }),
    dailyWorkoutSummary: mergeNullableObject({
      primary: primaryRecords.dailyWorkoutSummary,
      fallback: fallbackRecords.dailyWorkoutSummary,
      fields: DAILY_WORKOUT_SUMMARY_FIELDS,
      path: 'records.dailyWorkoutSummary',
      tracker,
    }),
    sleep: mergeNullableObject({
      primary: primaryRecords.sleep,
      fallback: fallbackRecords.sleep,
      fields: SLEEP_FIELDS,
      path: 'records.sleep',
      tracker,
    }),
  };
}

function mergeNullableObject({ primary, fallback, fields, path, tracker }) {
  const hasPrimary = isPlainObject(primary);
  const hasFallback = isPlainObject(fallback);
  if (!hasPrimary && !hasFallback) return cloneValue(primary ?? fallback ?? null);

  const output = {};
  for (const field of fields) {
    if (!hasOwn(primary, field) && !hasOwn(fallback, field)) continue;
    output[field] = mergeValue({
      primary: hasPrimary ? primary[field] : undefined,
      fallback: hasFallback ? fallback[field] : undefined,
      path: `${path}.${field}`,
      tracker,
    });
  }
  return output;
}

function mergeKeyedRecords({ primary, fallback, fields, path, keyOf, tracker }) {
  const primaryItems = deduplicateRecords(primary, fields, keyOf);
  const fallbackItems = deduplicateRecords(fallback, fields, keyOf);
  const fallbackByKey = new Map();
  for (let index = 0; index < fallbackItems.length; index += 1) {
    const key = keyOf(fallbackItems[index]);
    if (key) fallbackByKey.set(key, index);
  }

  const usedFallbackIndexes = new Set();
  const pairs = primaryItems.map((item) => {
    const fallbackIndex = fallbackByKey.get(keyOf(item));
    if (fallbackIndex === undefined) return { primary: item, fallback: undefined };
    usedFallbackIndexes.add(fallbackIndex);
    return { primary: item, fallback: fallbackItems[fallbackIndex] };
  });
  for (let index = 0; index < fallbackItems.length; index += 1) {
    if (!usedFallbackIndexes.has(index)) {
      pairs.push({ primary: undefined, fallback: fallbackItems[index] });
    }
  }

  return pairs.map((pair, index) => mergeRecord({
    ...pair,
    fields,
    path: `${path}[${index}]`,
    tracker,
  }));
}

function mergeRecord({ primary, fallback, fields, path, tracker }) {
  const output = {};
  for (const field of fields) {
    if (!hasOwn(primary, field) && !hasOwn(fallback, field)) continue;
    output[field] = mergeValue({
      primary: primary?.[field],
      fallback: fallback?.[field],
      path: `${path}.${field}`,
      tracker,
    });
  }
  return output;
}

function mergeValue({ primary, fallback, path, tracker }) {
  const primaryEmpty = isEmpty(primary);
  const fallbackEmpty = isEmpty(fallback);
  if (!primaryEmpty && fallbackEmpty) {
    tracker.source(path, 'primary');
    return cloneValue(primary);
  }
  if (primaryEmpty && !fallbackEmpty) {
    tracker.filled(path);
    tracker.source(path, 'fallback');
    return cloneValue(fallback);
  }
  if (primaryEmpty && fallbackEmpty) {
    return primary === undefined && fallback === undefined
      ? undefined
      : cloneValue(primary ?? fallback ?? null);
  }
  if (valuesAgree(primary, fallback, path)) {
    tracker.agreed(path);
    tracker.source(path, 'reconciled');
    return cloneValue(primary);
  }
  if (isCriticalConflict(primary, fallback, path)) {
    tracker.conflict(path);
    return cloneValue(primary);
  }
  tracker.source(path, 'primary');
  return cloneValue(primary);
}

function valuesAgree(primary, fallback, path) {
  if (typeof primary === 'number' && typeof fallback === 'number') {
    if (!Number.isFinite(primary) || !Number.isFinite(fallback)) return Object.is(primary, fallback);
    const tolerance = toleranceFor(path);
    const difference = Math.abs(primary - fallback);
    return difference <= tolerance + Number.EPSILON * Math.max(1, Math.abs(primary), Math.abs(fallback));
  }
  if (typeof primary === 'string' && typeof fallback === 'string') {
    return normalizeText(primary) === normalizeText(fallback);
  }
  return normalizedJson(primary) === normalizedJson(fallback);
}

function isCriticalConflict(primary, fallback, path) {
  return typeof primary === 'number'
    && typeof fallback === 'number'
    && Number.isFinite(primary)
    && Number.isFinite(fallback)
    && !NON_CRITICAL_NUMERIC_FIELDS.has(normalizeIndexedPath(path));
}

function toleranceFor(path) {
  const normalizedPath = normalizeIndexedPath(path);
  if (KILOGRAM_FIELDS.has(normalizedPath)) {
    return RECOGNITION_RECONCILIATION_TOLERANCES.KILOGRAMS;
  }
  if (normalizedPath.endsWith('.durationSeconds')) {
    return RECOGNITION_RECONCILIATION_TOLERANCES.DURATION_SECONDS;
  }
  if (normalizedPath.endsWith('Minutes')) {
    return RECOGNITION_RECONCILIATION_TOLERANCES.DURATION_MINUTES;
  }
  if (normalizedPath.endsWith('.heartRate') || normalizedPath.endsWith('.averageHeartRateBpm')) {
    return RECOGNITION_RECONCILIATION_TOLERANCES.HEART_RATE_BPM;
  }
  if (normalizedPath.endsWith('.distanceKm')) {
    return RECOGNITION_RECONCILIATION_TOLERANCES.DISTANCE_KM;
  }
  if (normalizedPath.endsWith('.avgSpeedKmh')) {
    return RECOGNITION_RECONCILIATION_TOLERANCES.SPEED_KMH;
  }
  if (normalizedPath.endsWith('.sleepScore')) {
    return RECOGNITION_RECONCILIATION_TOLERANCES.SLEEP_SCORE;
  }
  if (normalizedPath.endsWith('Pct') || normalizedPath.endsWith('.bmi')) {
    return RECOGNITION_RECONCILIATION_TOLERANCES.RATIO_OR_PERCENTAGE;
  }
  if (normalizedPath.endsWith('.calories')
    || normalizedPath.endsWith('Calories')
    || normalizedPath.endsWith('Kcal')
    || normalizedPath.endsWith('.recommendedMin')
    || normalizedPath.endsWith('.recommendedMax')) {
    return RECOGNITION_RECONCILIATION_TOLERANCES.KCAL;
  }
  return 0;
}

function deduplicateRecords(value, fields, keyOf) {
  if (!Array.isArray(value)) return [];
  const output = [];
  const indexByKey = new Map();
  for (const rawItem of value) {
    if (!isPlainObject(rawItem)) continue;
    const item = pickFields(rawItem, fields);
    const key = keyOf(item);
    if (!key || !indexByKey.has(key)) {
      if (key) indexByKey.set(key, output.length);
      output.push(item);
      continue;
    }
    const existing = output[indexByKey.get(key)];
    for (const field of fields) {
      if (isEmpty(existing[field]) && !isEmpty(item[field])) {
        existing[field] = cloneValue(item[field]);
      }
    }
  }
  return output;
}

function pickFields(value, fields) {
  const output = {};
  for (const field of fields) {
    if (hasOwn(value, field)) output[field] = cloneValue(value[field]);
  }
  return output;
}

function activityKey(value) {
  const parts = [value?.time, value?.type, value?.detail].map(normalizeText);
  return parts.every(Boolean) ? parts.join('|') : '';
}

function mealKey(value) {
  return normalizeText(value?.name).replace(/\s+/g, '');
}

function createTracker() {
  const filledFields = [];
  const agreedFields = [];
  const conflictFields = [];
  const fieldSources = {};
  const seen = {
    filled: new Set(),
    agreed: new Set(),
    conflict: new Set(),
  };
  return {
    filledFields,
    agreedFields,
    conflictFields,
    fieldSources,
    filled(path) {
      addUnique(filledFields, seen.filled, path);
    },
    agreed(path) {
      addUnique(agreedFields, seen.agreed, path);
    },
    conflict(path) {
      addUnique(conflictFields, seen.conflict, path);
    },
    source(path, source) {
      fieldSources[path] = source;
    },
    result(status, value, finalSource) {
      return {
        status,
        value,
        filledFields,
        agreedFields,
        conflictFields,
        fieldSources,
        finalSource,
      };
    },
  };
}

function addUnique(target, seen, value) {
  if (seen.has(value)) return;
  seen.add(value);
  target.push(value);
}

function emptyResult(status, finalSource) {
  return {
    status,
    value: null,
    filledFields: [],
    agreedFields: [],
    conflictFields: [],
    fieldSources: {},
    finalSource,
  };
}

function normalizeIndexedPath(path) {
  return String(path).replace(/\[\d+\]/g, '[]');
}

function normalizedJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(normalizedJsonValue));
  if (isPlainObject(value)) return JSON.stringify(normalizedJsonValue(value));
  return JSON.stringify(value);
}

function normalizedJsonValue(value) {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizedJsonValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizedJsonValue(value[key])]));
  }
  return value;
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').toLowerCase()
    : '';
}

function isEmpty(value) {
  return value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
}

function hasOwn(value, field) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, field);
}

function isRecognition(value) {
  return isPlainObject(value) && typeof value.imageType === 'string' && isPlainObject(value.records);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}
