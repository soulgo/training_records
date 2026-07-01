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

export function applyRecognitionSemanticWarnings(payload) {
  if (!isPlainObject(payload)) {
    return payload;
  }

  const warnings = new Set(Array.isArray(payload.warnings) ? payload.warnings : []);
  addMeasurementWarnings(payload.records?.measurement, warnings);
  addSleepWarnings(payload.records?.sleep, warnings);

  return {
    ...payload,
    warnings: [...warnings],
  };
}

function addMeasurementWarnings(measurement, warnings) {
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
  }
}

function addSleepWarnings(sleep, warnings) {
  if (!isPlainObject(sleep)) {
    return;
  }

  for (const [field, [min, max]] of Object.entries(SLEEP_RANGES)) {
    if (isOutsideRange(sleep[field], min, max)) {
      warnings.add(`semantic:sleep.${field} outside supported range`);
    }
  }

  const total = sleep.totalSleepMinutes;
  const night = sleep.nightSleepMinutes;
  const nap = sleep.napMinutes;
  if (isFiniteNumber(total) && (isFiniteNumber(night) || isFiniteNumber(nap))) {
    const componentTotal = (isFiniteNumber(night) ? night : 0) + (isFiniteNumber(nap) ? nap : 0);
    if (Math.abs(total - componentTotal) > 30) {
      warnings.add('semantic:sleep.totalSleepMinutes conflicts with component sleep minutes');
    }
  }

  const stageTotal = ['deepSleepMinutes', 'lightSleepMinutes', 'remSleepMinutes']
    .map((field) => sleep[field])
    .filter(isFiniteNumber)
    .reduce((sum, value) => sum + value, 0);
  if (isFiniteNumber(total) && stageTotal > total + 30) {
    warnings.add('semantic:sleep.stageMinutes exceed totalSleepMinutes');
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
