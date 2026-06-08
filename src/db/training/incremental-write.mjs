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
  const hasBatchWorkoutSummary = Boolean(batch.workoutDailySummary && Object.keys(batch.workoutDailySummary).length > 0);
  const hasBatchNutrition = hasNutritionPayload(batch.nutrition);

  await client.query(
    `
      with activity_summary as (
        select
          count(*)::integer as total_activities,
          coalesce(sum(duration_seconds), 0)::integer as total_duration_seconds,
          coalesce(sum(calories), 0)::numeric as training_calories,
          coalesce(sum(distance_km), 0)::numeric as cycling_distance_km
        from core.activity
        where archived_date = $1
      ),
      meal_summary as (
        select coalesce(sum(calories), 0)::integer as intake_calories
        from core.meal
        where archived_date = $1
      ),
      existing_day as (
        select
          workout_duration_minutes,
          active_hours,
          intake_calories,
          nutrition_details_json
        from core.training_day
        where archived_date = $1
      ),
      summary_values as (
        select
          $1::date as archived_date,
          $2::text as source_batch_id,
          $3::text as source_channel,
          coalesce(a.total_activities, 0)::integer as total_activities,
          coalesce(a.total_duration_seconds, 0)::integer as total_duration_seconds,
          case when $10::boolean
            then coalesce($4::numeric, a.training_calories, 0)
            else coalesce(a.training_calories, 0)
          end as training_calories,
          case when $10::boolean
            then coalesce($5::integer, e.workout_duration_minutes)
            else e.workout_duration_minutes
          end as workout_duration_minutes,
          case when $10::boolean
            then coalesce($6::integer, e.active_hours)
            else e.active_hours
          end as active_hours,
          coalesce(a.cycling_distance_km, 0)::numeric as cycling_distance_km,
          case when $11::boolean
            then coalesce($7::integer, nullif(m.intake_calories, 0), e.intake_calories)
            else coalesce(nullif(m.intake_calories, 0), e.intake_calories)
          end as intake_calories,
          case when $11::boolean
            then coalesce($8::jsonb, e.nutrition_details_json, '[]'::jsonb)
            else coalesce(e.nutrition_details_json, '[]'::jsonb)
          end as nutrition_details_json,
          $9::timestamptz as updated_at
        from activity_summary a
        cross join meal_summary m
        left join existing_day e on true
      )
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
      select
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
      from summary_values
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
      batch.workoutDailySummary?.activityCaloriesKcal ?? null,
      batch.workoutDailySummary?.workoutDurationMinutes ?? null,
      batch.workoutDailySummary?.activeHours ?? null,
      hasBatchNutrition ? batch.nutrition.totalCalories ?? null : null,
      JSON.stringify(hasBatchNutrition && (batch.nutrition.details?.length ?? 0) > 0
        ? batch.nutrition.details
        : []),
      processedAtIso,
      hasBatchWorkoutSummary,
      hasBatchNutrition,
    ],
  );
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
