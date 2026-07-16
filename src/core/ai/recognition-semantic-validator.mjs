const MEASUREMENT_RANGES = {
  weightKg: [20, 300],
  bmi: [8, 80],
  bodyFatPct: [2, 75],
  bodyWaterPct: [20, 85],
  proteinPct: [5, 35],
  boneMassKg: [0.5, 8],
  basalMetabolismKcal: [500, 3500],
};

const SLEEP_RANGES = {
  totalSleepMinutes: [0, 24 * 60],
  nightSleepMinutes: [0, 16 * 60],
  napMinutes: [0, 8 * 60],
  deepSleepMinutes: [0, 10 * 60],
  lightSleepMinutes: [0, 14 * 60],
  remSleepMinutes: [0, 10 * 60],
  awakeMinutes: [0, 12 * 60],
  sleepScore: [0, 100],
  sleepScorePercentile: [0, 100],
  deepSleepRatioPct: [0, 100],
  lightSleepRatioPct: [0, 100],
  remSleepRatioPct: [0, 100],
  averageHeartRateBpm: [25, 220],
  averageSpo2Pct: [50, 100],
  averageRespiratoryRate: [4, 60],
};

const ACTIVITY_POSITIVE_FIELDS = [
  'durationSeconds',
  'calories',
  'heartRate',
  'distanceKm',
  'avgSpeedKmh',
];

const WORKOUT_SUMMARY_POSITIVE_FIELDS = [
  'activityCaloriesKcal',
  'workoutDurationMinutes',
  'activeHours',
];

export function applyRecognitionSemanticGate(payload) {
  if (!isPlainObject(payload)) {
    return payload;
  }

  const gated = structuredClone(payload);
  const warnings = new Set(Array.isArray(gated.warnings) ? gated.warnings : []);
  const decisions = [];
  sanitizeRanges(payload.records?.measurement, gated.records?.measurement, MEASUREMENT_RANGES, 'measurement', warnings, decisions);
  sanitizeRanges(payload.records?.sleep, gated.records?.sleep, SLEEP_RANGES, 'sleep', warnings, decisions);
  sanitizePositiveActivities(payload.records?.activities, gated.records?.activities, warnings, decisions);
  sanitizePositiveObjectFields(
    payload.records?.dailyWorkoutSummary,
    gated.records?.dailyWorkoutSummary,
    WORKOUT_SUMMARY_POSITIVE_FIELDS,
    'dailyWorkoutSummary',
    warnings,
    decisions,
  );
  sanitizePositiveNutrition(payload.records, gated.records, warnings, decisions);
  addMeasurementReviews(payload.records?.measurement, warnings, decisions);
  addSleepReviews(payload.records?.sleep, warnings, decisions);

  const result = {
    ...gated,
    warnings: [...warnings],
  };
  return decisions.length === 0 ? result : {
    ...result,
    semanticGate: {
      status: decisions.some((decision) => decision.action === 'review')
        ? 'needs_review'
        : decisions.some((decision) => decision.action === 'sanitize') ? 'sanitized' : 'accepted',
      decisions,
      rawResult: structuredClone(payload),
    },
  };
}

function sanitizePositiveActivities(original, target, warnings, decisions) {
  if (!Array.isArray(original) || !Array.isArray(target)) return;
  for (let index = 0; index < original.length; index += 1) {
    sanitizePositiveObjectFields(
      original[index],
      target[index],
      ACTIVITY_POSITIVE_FIELDS,
      `activities[${index}]`,
      warnings,
      decisions,
    );
  }
}

function sanitizePositiveNutrition(originalRecords, targetRecords, warnings, decisions) {
  if (!isPlainObject(originalRecords) || !isPlainObject(targetRecords)) return;
  if (isNonPositiveFiniteNumber(originalRecords.totalCalories)) {
    targetRecords.totalCalories = null;
    addPositiveSanitizeDecision('totalCalories', warnings, decisions);
  }
  if (!Array.isArray(originalRecords.meals) || !Array.isArray(targetRecords.meals)) return;
  targetRecords.meals = targetRecords.meals.filter((meal, index) => {
    if (!isNonPositiveFiniteNumber(originalRecords.meals[index]?.calories)) return true;
    addPositiveSanitizeDecision(`meals[${index}].calories`, warnings, decisions);
    return false;
  });
}

function sanitizePositiveObjectFields(original, target, fields, namespace, warnings, decisions) {
  if (!isPlainObject(original) || !isPlainObject(target)) return;
  for (const field of fields) {
    if (!isNonPositiveFiniteNumber(original[field])) continue;
    target[field] = null;
    addPositiveSanitizeDecision(`${namespace}.${field}`, warnings, decisions);
  }
}

function addPositiveSanitizeDecision(path, warnings, decisions) {
  warnings.add(`semantic:${path.replace(/\[\d+\]/gu, '[]')} must be positive`);
  decisions.push({ action: 'sanitize', path, reason: 'non_positive' });
}

function addMeasurementReviews(measurement, warnings, decisions) {
  if (!isPlainObject(measurement)) {
    return;
  }

  for (const [field, [min, max]] of Object.entries(MEASUREMENT_RANGES)) {
    if (isOutsideRange(measurement[field], min, max)) {
      warnings.add(`semantic:measurement.${field} outside supported range`);
    }
  }

  if (
    isFiniteNumber(measurement.fatFreeMassKg) &&
    isFiniteNumber(measurement.weightKg) &&
    measurement.fatFreeMassKg > measurement.weightKg
  ) {
    warnings.add('semantic:measurement.fatFreeMassKg exceeds weightKg');
    decisions.push({ action: 'review', path: 'measurement.fatFreeMassKg', reason: 'exceeds_weight' });
  }
}

function addSleepReviews(sleep, warnings, decisions) {
  if (!isPlainObject(sleep)) {
    return;
  }

  const total = sleep.totalSleepMinutes;
  const night = sleep.nightSleepMinutes;
  const nap = sleep.napMinutes;
  if (isFiniteNumber(total) && (isFiniteNumber(night) || isFiniteNumber(nap))) {
    const componentTotal = (isFiniteNumber(night) ? night : 0) + (isFiniteNumber(nap) ? nap : 0);
    if (Math.abs(total - componentTotal) > 30) {
      warnings.add('semantic:sleep.totalSleepMinutes conflicts with component sleep minutes');
      decisions.push({ action: 'review', path: 'sleep.totalSleepMinutes', reason: 'component_conflict' });
    }
  }

  const stageTotal = ['deepSleepMinutes', 'lightSleepMinutes', 'remSleepMinutes']
    .map((field) => sleep[field])
    .filter(isFiniteNumber)
    .reduce((sum, value) => sum + value, 0);
  if (isFiniteNumber(total) && stageTotal > total + 30) {
    warnings.add('semantic:sleep.stageMinutes exceed totalSleepMinutes');
    decisions.push({ action: 'review', path: 'sleep.stageMinutes', reason: 'exceeds_total' });
  }
}

function sanitizeRanges(original, target, ranges, namespace, warnings, decisions) {
  if (!isPlainObject(original) || !isPlainObject(target)) return;
  for (const [field, [min, max]] of Object.entries(ranges)) {
    if (!isOutsideRange(original[field], min, max)) continue;
    target[field] = null;
    warnings.add(`semantic:${namespace}.${field} outside supported range`);
    decisions.push({ action: 'sanitize', path: `${namespace}.${field}`, reason: 'outside_supported_range' });
  }
}

function isOutsideRange(value, min, max) {
  return isFiniteNumber(value) && (value < min || value > max);
}

function isNonPositiveFiniteNumber(value) {
  return isFiniteNumber(value) && value <= 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
