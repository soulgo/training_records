import {
  buildTrainingDay,
  emptyNutrition,
  emptySleep,
  normalizeActivityTime,
  normalizeActivityType,
  parseDurationSeconds,
} from '../../domain/training/training-domain.mjs';
import {
  insertCoreActivities,
  insertCoreMeals,
  insertCoreMeasurements,
  insertCoreSleep,
} from './core-row-writer.mjs';

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

export async function persistTelegramImageBatchIncremental(client, batch, processedAt) {
  const day = buildTelegramImageBatchDay(batch);
  if (!day) {
    return;
  }

  const processedAtIso = processedAt.toISOString();
  const options = {
    batchId: batch.batchId,
    processedAt,
    sourceChannel: 'telegram',
  };

  await ensureCoreTrainingDayStub(client, day.date, batch.batchId, processedAtIso);
  await insertCoreMeasurements(client, [day], options, processedAtIso);
  await insertCoreActivities(client, [day], options, processedAtIso);
  await insertCoreMeals(client, [day], options, processedAtIso);
  await insertCoreSleep(client, [day], options, processedAtIso);

  await refreshCoreTrainingDaySummary(client, batch, processedAtIso);
}

async function ensureCoreTrainingDayStub(client, archivedDate, batchId, processedAtIso) {
  await client.query(
    `
      insert into core.training_day (
        archived_date,
        source_batch_id,
        source_channel,
        updated_at
      )
      values ($1, $2, $3, $4)
      on conflict (archived_date) do update set
        source_batch_id = excluded.source_batch_id,
        source_channel = excluded.source_channel,
        updated_at = excluded.updated_at
    `,
    [archivedDate, batchId, 'telegram', processedAtIso],
  );
}

function buildTelegramImageBatchDay(batch) {
  const archivedDate = normalizeDateKey(batch.archivedDate);
  if (!archivedDate) {
    return null;
  }

  return buildTrainingDay({
    date: archivedDate,
    measurements: batch.measurement ? [{ archivedDate, ...batch.measurement }] : [],
    activities: (batch.activities ?? []).map((activity) => normalizeBatchActivity(activity)),
    nutrition: hasNutritionPayload(batch.nutrition)
      ? {
          meals: batch.nutrition.meals ?? [],
          totalCalories: batch.nutrition.totalCalories ?? null,
          details: batch.nutrition.details ?? [],
        }
      : emptyNutrition(),
    sleep: normalizeBatchSleep(batch.sleep),
    workoutDailySummary: batch.workoutDailySummary ?? null,
  });
}

function normalizeBatchSleep(sleep) {
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

async function refreshCoreTrainingDaySummary(client, batch, processedAtIso) {
  const archivedDate = normalizeDateKey(batch.archivedDate);
  const summary = await readIncrementalCoreDaySummary(client, archivedDate);
  const hasBatchWorkoutSummary = batch.workoutDailySummary && Object.keys(batch.workoutDailySummary).length > 0;
  const hasBatchNutrition = hasNutritionPayload(batch.nutrition);

  await client.query(
    `
      insert into core.training_day (
        archived_date,
        source_batch_id,
        source_channel,
        total_activities,
        total_duration_seconds,
        training_calories,
        workout_duration_minutes,
        active_hours,
        cycling_distance_km,
        intake_calories,
        nutrition_details_json,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
      on conflict (archived_date) do update set
        source_batch_id = excluded.source_batch_id,
        source_channel = excluded.source_channel,
        total_activities = excluded.total_activities,
        total_duration_seconds = excluded.total_duration_seconds,
        training_calories = excluded.training_calories,
        workout_duration_minutes = excluded.workout_duration_minutes,
        active_hours = excluded.active_hours,
        cycling_distance_km = excluded.cycling_distance_km,
        intake_calories = excluded.intake_calories,
        nutrition_details_json = excluded.nutrition_details_json,
        updated_at = excluded.updated_at
    `,
    [
      archivedDate,
      batch.batchId,
      'telegram',
      summary.totalActivities,
      summary.totalDurationSeconds,
      hasBatchWorkoutSummary
        ? batch.workoutDailySummary.activityCaloriesKcal ?? summary.trainingCalories
        : summary.trainingCalories,
      hasBatchWorkoutSummary
        ? batch.workoutDailySummary.workoutDurationMinutes ?? summary.workoutDurationMinutes
        : summary.workoutDurationMinutes,
      hasBatchWorkoutSummary
        ? batch.workoutDailySummary.activeHours ?? summary.activeHours
        : summary.activeHours,
      summary.cyclingDistanceKm,
      hasBatchNutrition
        ? batch.nutrition.totalCalories ?? summary.intakeCalories
        : summary.intakeCalories,
      JSON.stringify(hasBatchNutrition && (batch.nutrition.details?.length ?? 0) > 0
        ? batch.nutrition.details
        : summary.nutritionDetails),
      processedAtIso,
    ],
  );
}

async function readIncrementalCoreDaySummary(client, archivedDate) {
  const activityResult = await client.query(
    `
      select
        count(*)::integer as total_activities,
        coalesce(sum(duration_seconds), 0)::integer as total_duration_seconds,
        coalesce(sum(calories), 0)::numeric as training_calories,
        coalesce(sum(distance_km), 0)::numeric as cycling_distance_km
      from core.activity
      where archived_date = $1
    `,
    [archivedDate],
  );
  const mealResult = await client.query(
    `
      select coalesce(sum(calories), 0)::integer as intake_calories
      from core.meal
      where archived_date = $1
    `,
    [archivedDate],
  );
  const dayResult = await client.query(
    `
      select
        workout_duration_minutes,
        active_hours,
        intake_calories,
        nutrition_details_json
      from core.training_day
      where archived_date = $1
    `,
    [archivedDate],
  );
  const activity = activityResult.rows[0] ?? {};
  const meal = mealResult.rows[0] ?? {};
  const existingDay = dayResult.rows[0] ?? {};
  const mealCalories = normalizeNumber(meal.intake_calories, null);

  return {
    totalActivities: normalizeNumber(activity.total_activities, 0),
    totalDurationSeconds: normalizeNumber(activity.total_duration_seconds, 0),
    trainingCalories: normalizeNumber(activity.training_calories, 0),
    workoutDurationMinutes: normalizeNumber(existingDay.workout_duration_minutes, null),
    activeHours: normalizeNumber(existingDay.active_hours, null),
    cyclingDistanceKm: normalizeNumber(activity.cycling_distance_km, 0),
    intakeCalories: mealCalories && mealCalories > 0
      ? mealCalories
      : normalizeNumber(existingDay.intake_calories, null),
    nutritionDetails: Array.isArray(existingDay.nutrition_details_json)
      ? existingDay.nutrition_details_json
      : [],
  };
}

function normalizeBatchActivity(activity) {
  const detail = activity.detail?.trim() ?? '';
  const durationText = activity.durationText ?? detail.match(/\d+分\d+秒|\d{2}:\d{2}:\d{2}/)?.[0] ?? null;

  return {
    time: normalizeActivityTime(activity.time),
    type: normalizeActivityType(activity.type),
    rawType: activity.rawType ?? activity.type,
    detail,
    durationText,
    durationSeconds: durationText ? parseDurationSeconds(durationText) : 0,
    calories: extractNumber(detail, /(?:总)?消耗\s*(\d+(?:\.\d+)?)\s*千卡/),
    heartRate: extractNumber(detail, /(?:平均(?:心率)?|记录值|心率)\s*(\d+)\s*次\/分钟/),
    distanceKm: extractNumber(detail, /(\d+(?:\.\d+)?)\s*公里/),
    avgSpeedKmh: extractNumber(detail, /(?:均速|平均速度)\s*(\d+(?:\.\d+)?)\s*公里\/小时/),
  };
}

function pickSleepHealthFields(sleep) {
  return Object.fromEntries(SLEEP_HEALTH_FIELDS.map((field) => [field, sleep?.[field] ?? null]));
}

function hasNutritionPayload(nutrition) {
  if (!nutrition) {
    return false;
  }
  return (
    (nutrition?.meals?.length ?? 0) > 0 ||
    (nutrition.totalCalories !== null && nutrition.totalCalories !== undefined) ||
    (nutrition?.details?.length ?? 0) > 0
  );
}

function hasSleepPayload(sleep) {
  return Boolean(sleep && [
    sleep.records?.length,
    sleep.totalSleepMinutes,
    sleep.nightSleepMinutes,
    sleep.napMinutes,
    sleep.bedtime,
    sleep.wakeTime,
    sleep.sleepStartTime,
    sleep.sleepEndTime,
    sleep.deepSleepMinutes,
    sleep.lightSleepMinutes,
    sleep.remSleepMinutes,
    sleep.awakeMinutes,
    sleep.sleepStageText,
    sleep.sleepStageDetail,
    ...SLEEP_HEALTH_FIELDS.map((field) => sleep[field]),
  ].some((value) => value !== null && value !== undefined && value !== '' && value !== 0));
}

function normalizeNumber(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeDateKey(value) {
  if (value instanceof Date) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }

  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : String(value ?? '');
}

function extractNumber(value, regex) {
  const match = value?.match(regex);
  return match ? Number(match[1]) : null;
}
