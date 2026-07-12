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

export function applyRecognitionSemanticGate(payload) {
  if (!isPlainObject(payload)) {
    return payload;
  }

  const gated = structuredClone(payload);
  const warnings = new Set(Array.isArray(gated.warnings) ? gated.warnings : []);
  const decisions = [];
  sanitizeRanges(payload.records?.measurement, gated.records?.measurement, MEASUREMENT_RANGES, 'measurement', warnings, decisions);
  sanitizeRanges(payload.records?.sleep, gated.records?.sleep, SLEEP_RANGES, 'sleep', warnings, decisions);
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

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
