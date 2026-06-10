import {
  buildTrainingDay,
  emptyNutrition,
  emptySleep,
  normalizeActivityTime,
  normalizeActivityType,
  parseDurationSeconds,
} from '../../domain/training/training-domain.mjs';

export { emptyNutrition, emptySleep };

const SLEEP_HEALTH_FIELDS = [
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

export class TrainingRecord {
  constructor(value = {}) {
    Object.assign(this, value);
  }

  static fromRaw(raw = {}) {
    if (!raw.date) {
      throw new Error('TrainingRecord.date is required');
    }
    return new TrainingRecord(buildTrainingDay(raw));
  }

  mergeWith(batch) {
    return TrainingRecord.merge(this, batch);
  }

  static merge(existingDay, batch) {
    if (!batch?.archivedDate) {
      throw new Error('batch.archivedDate is required');
    }

    const existing = existingDay ?? {
      date: batch.archivedDate,
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
      nutrition: emptyNutrition(),
    };

    return TrainingRecord.fromRaw({
      date: batch.archivedDate,
      measurements: batch.measurement
        ? [{ archivedDate: batch.archivedDate, ...batch.measurement }]
        : existing.measurements ?? [],
      activities: batch.activities?.length
        ? batch.activities.map((activity) => normalizeBatchActivity(activity))
        : existing.activities ?? [],
      nutrition: hasNutritionPayload(batch.nutrition)
        ? {
            meals: batch.nutrition.meals ?? [],
            totalCalories: batch.nutrition.totalCalories ?? null,
            details: batch.nutrition.details ?? [],
          }
        : existing.nutrition ?? emptyNutrition(),
      sleep: hasSleepPayload(batch.sleep)
        ? normalizeBatchSleep(batch.sleep)
        : existingSleepPayload(existing),
      workoutDailySummary:
        batch.workoutDailySummary ??
        (existing.workoutSummary
          ? {
              activityCaloriesKcal: existing.workoutSummary.trainingCalories,
              workoutDurationMinutes: existing.workoutSummary.workoutDurationMinutes,
              activeHours: existing.workoutSummary.activeHours,
            }
          : null),
    });
  }
}

export function normalizeBatchActivity(activity) {
  const detail = activity.detail?.trim() ?? '';
  const durationText = activity.durationText ?? detail.match(/\d+分\d+秒|\d{2}:\d{2}:\d{2}/)?.[0] ?? null;

  return {
    time: normalizeActivityTime(activity.time),
    type: normalizeActivityType(activity.type),
    rawType: activity.rawType ?? activity.type,
    detail,
    durationText,
    durationSeconds: durationText ? parseDurationSeconds(durationText) : 0,
    calories: (() => { const v = extractNumber(detail, /(?:总)?消耗\s*(\d+(?:\.\d+)?)\s*千卡/); return v != null ? Math.round(v) : null; })(),
    heartRate: extractNumber(detail, /(?:平均(?:心率)?|记录值|心率)\s*(\d+)\s*次\/分钟/),
    distanceKm: extractNumber(detail, /(\d+(?:\.\d+)?)\s*公里/),
    avgSpeedKmh: extractNumber(detail, /(?:均速|平均速度)\s*(\d+(?:\.\d+)?)\s*公里\/小时/),
  };
}

export function normalizeBatchSleep(sleep) {
  if (!hasSleepPayload(sleep)) {
    return emptySleep();
  }

  const records = sleep.records?.length
    ? sleep.records
    : [{
        sleepType: sleep.sleepType ?? '夜间睡眠',
        bedtime: sleep.bedtime ?? sleep.sleepStartTime ?? null,
        wakeTime: sleep.wakeTime ?? sleep.sleepEndTime ?? null,
        nightSleepMinutes: sleep.nightSleepMinutes ?? null,
        totalSleepMinutes: sleep.totalSleepMinutes ?? null,
        napMinutes: sleep.napMinutes ?? null,
        deepSleepMinutes: sleep.deepSleepMinutes ?? null,
        lightSleepMinutes: sleep.lightSleepMinutes ?? null,
        remSleepMinutes: sleep.remSleepMinutes ?? null,
        awakeMinutes: sleep.awakeMinutes ?? null,
        sleepStageText: sleep.sleepStageText ?? null,
        sleepStageDetail: sleep.sleepStageDetail ?? null,
        ...pickSleepHealthFields(sleep),
      }];

  return {
    records,
    totalSleepMinutes: sleep.totalSleepMinutes ?? null,
    nightSleepMinutes: sleep.nightSleepMinutes ?? null,
    napMinutes: sleep.napMinutes ?? null,
    sleepStartTime: sleep.bedtime ?? sleep.sleepStartTime ?? null,
    sleepEndTime: sleep.wakeTime ?? sleep.sleepEndTime ?? null,
    deepSleepMinutes: sleep.deepSleepMinutes ?? null,
    lightSleepMinutes: sleep.lightSleepMinutes ?? null,
    remSleepMinutes: sleep.remSleepMinutes ?? null,
    awakeMinutes: sleep.awakeMinutes ?? null,
    ...pickSleepHealthFields(sleep),
  };
}

export function hasNutritionPayload(nutrition) {
  return Boolean(
    nutrition &&
      ((nutrition.meals?.length ?? 0) > 0 ||
        nutrition.totalCalories !== null && nutrition.totalCalories !== undefined ||
        (nutrition.details?.length ?? 0) > 0),
  );
}

export function hasSleepPayload(sleep) {
  return Boolean(
    sleep &&
      ((sleep.records?.length ?? 0) > 0 ||
        sleep.totalSleepMinutes !== null && sleep.totalSleepMinutes !== undefined ||
        sleep.nightSleepMinutes !== null && sleep.nightSleepMinutes !== undefined ||
        sleep.napMinutes !== null && sleep.napMinutes !== undefined ||
        sleep.bedtime ||
        sleep.wakeTime ||
        sleep.sleepStartTime ||
        sleep.sleepEndTime ||
        SLEEP_HEALTH_FIELDS.some((field) => sleep[field] !== null && sleep[field] !== undefined)),
  );
}

export function existingSleepPayload(existing) {
  const records = Array.isArray(existing.sleep)
    ? existing.sleep
    : existing.sleep?.records ?? existing.sleepSummary?.records ?? [];
  if (records.length > 0) {
    return {
      ...(existing.sleepSummary ?? emptySleep()),
      records,
    };
  }
  return existing.sleepSummary ?? existing.sleep ?? emptySleep();
}

function pickSleepHealthFields(sleep) {
  return Object.fromEntries(SLEEP_HEALTH_FIELDS.map((field) => [field, sleep?.[field] ?? null]));
}

function extractNumber(value, regex) {
  const match = value?.match(regex);
  return match ? Number(match[1]) : null;
}
