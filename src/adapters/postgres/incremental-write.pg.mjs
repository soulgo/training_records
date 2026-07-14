import {
  TrainingRecord,
  emptyNutrition,
  hasNutritionPayload,
  normalizeBatchActivity,
  normalizeBatchSleep,
} from '../../core/entities/training-record.mjs';
import {
  insertCoreActivities,
  insertCoreMeals,
  insertCoreMeasurements,
  insertCoreSleep,
} from './core-row-writer.pg.mjs';

export async function persistSourceImageBatchIncremental(client, batch, processedAt, writeOptions = {}) {
  const day = buildSourceImageBatchDay(batch);
  if (!day) {
    return;
  }

  const processedAtIso = processedAt.toISOString();
  const sourceChannel = normalizeRequiredSourceChannel(writeOptions.sourceChannel ?? batch.sourceChannel);
  const rowOptions = {
    batchId: batch.batchId,
    processedAt,
    sourceChannel,
  };

  await ensureCoreTrainingDayStub(client, day.date, batch.batchId, processedAtIso, sourceChannel);
  await insertCoreMeasurements(client, [day], rowOptions, processedAtIso);
  await insertCoreActivities(client, [day], rowOptions, processedAtIso);
  await insertCoreMeals(client, [day], rowOptions, processedAtIso);
  await insertCoreSleep(client, [day], rowOptions, processedAtIso);

  await refreshCoreTrainingDaySummary(client, batch, processedAtIso, sourceChannel);
}

async function ensureCoreTrainingDayStub(client, archivedDate, batchId, processedAtIso, sourceChannel) {
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
    [archivedDate, batchId, sourceChannel, processedAtIso],
  );
}

function buildSourceImageBatchDay(batch) {
  const archivedDate = normalizeDateKey(batch.archivedDate);
  if (!archivedDate) {
    return null;
  }

  return TrainingRecord.fromRaw({
    date: archivedDate,
    measurements: batch.measurement ? [{ archivedDate, ...batch.measurement }] : [],
    activities: (batch.activities ?? []).map((activity) => normalizeBatchActivity(activity)),
    nutrition: hasNutritionPayload(batch.nutrition)
      ? {
          meals: (batch.nutrition.meals ?? []).map((meal) => ({
            ...meal,
            calories: meal.calories != null ? Math.round(Number(meal.calories)) : null,
            recommendedMin: meal.recommendedMin != null ? Math.round(Number(meal.recommendedMin)) : null,
            recommendedMax: meal.recommendedMax != null ? Math.round(Number(meal.recommendedMax)) : null,
          })),
          totalCalories: batch.nutrition.totalCalories != null ? Math.round(Number(batch.nutrition.totalCalories)) : null,
          details: batch.nutrition.details ?? [],
        }
      : emptyNutrition(),
    sleep: normalizeBatchSleep(batch.sleep),
    workoutDailySummary: batch.workoutDailySummary ?? null,
  });
}

async function refreshCoreTrainingDaySummary(client, batch, processedAtIso, sourceChannel) {
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
      sleep_summary as (
        select
          nullif(sum(coalesce(total_sleep_minutes, 0)), 0)::integer as sleep_total_minutes,
          nullif(sum(coalesce(night_sleep_minutes, 0)), 0)::integer as night_sleep_minutes,
          nullif(sum(coalesce(nap_minutes, 0)), 0)::integer as nap_minutes,
          min(bedtime) filter (where bedtime is not null) as sleep_start_time,
          max(wake_time) filter (where wake_time is not null) as sleep_end_time,
          nullif(sum(coalesce(deep_sleep_minutes, 0)), 0)::integer as deep_sleep_minutes,
          nullif(sum(coalesce(light_sleep_minutes, 0)), 0)::integer as light_sleep_minutes,
          nullif(sum(coalesce(rem_sleep_minutes, 0)), 0)::integer as rem_sleep_minutes,
          nullif(sum(coalesce(awake_minutes, 0)), 0)::integer as awake_minutes
        from core.sleep
        where archived_date = $1
      ),
      existing_day as (
        select
          workout_duration_minutes,
          active_hours,
          intake_calories,
          sleep_total_minutes,
          night_sleep_minutes,
          nap_minutes,
          sleep_start_time,
          sleep_end_time,
          deep_sleep_minutes,
          light_sleep_minutes,
          rem_sleep_minutes,
          awake_minutes,
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
          coalesce(s.sleep_total_minutes, e.sleep_total_minutes) as sleep_total_minutes,
          coalesce(s.night_sleep_minutes, e.night_sleep_minutes) as night_sleep_minutes,
          coalesce(s.nap_minutes, e.nap_minutes) as nap_minutes,
          coalesce(s.sleep_start_time, e.sleep_start_time) as sleep_start_time,
          coalesce(s.sleep_end_time, e.sleep_end_time) as sleep_end_time,
          coalesce(s.deep_sleep_minutes, e.deep_sleep_minutes) as deep_sleep_minutes,
          coalesce(s.light_sleep_minutes, e.light_sleep_minutes) as light_sleep_minutes,
          coalesce(s.rem_sleep_minutes, e.rem_sleep_minutes) as rem_sleep_minutes,
          coalesce(s.awake_minutes, e.awake_minutes) as awake_minutes,
          $9::timestamptz as updated_at
        from activity_summary a
        cross join meal_summary m
        cross join sleep_summary s
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
        sleep_total_minutes,
        night_sleep_minutes,
        nap_minutes,
        sleep_start_time,
        sleep_end_time,
        deep_sleep_minutes,
        light_sleep_minutes,
        rem_sleep_minutes,
        awake_minutes,
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
        sleep_total_minutes,
        night_sleep_minutes,
        nap_minutes,
        sleep_start_time,
        sleep_end_time,
        deep_sleep_minutes,
        light_sleep_minutes,
        rem_sleep_minutes,
        awake_minutes,
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
        sleep_total_minutes = excluded.sleep_total_minutes,
        night_sleep_minutes = excluded.night_sleep_minutes,
        nap_minutes = excluded.nap_minutes,
        sleep_start_time = excluded.sleep_start_time,
        sleep_end_time = excluded.sleep_end_time,
        deep_sleep_minutes = excluded.deep_sleep_minutes,
        light_sleep_minutes = excluded.light_sleep_minutes,
        rem_sleep_minutes = excluded.rem_sleep_minutes,
        awake_minutes = excluded.awake_minutes,
        nutrition_details_json = excluded.nutrition_details_json,
        updated_at = excluded.updated_at
    `,
    [
      archivedDate,
      batch.batchId,
      sourceChannel,
      batch.workoutDailySummary?.activityCaloriesKcal != null ? Math.round(Number(batch.workoutDailySummary.activityCaloriesKcal)) : null,
      batch.workoutDailySummary?.workoutDurationMinutes != null ? Math.round(Number(batch.workoutDailySummary.workoutDurationMinutes)) : null,
      batch.workoutDailySummary?.activeHours != null ? Math.round(Number(batch.workoutDailySummary.activeHours)) : null,
      hasBatchNutrition ? (batch.nutrition.totalCalories != null ? Math.round(Number(batch.nutrition.totalCalories)) : null) : null,
      JSON.stringify(hasBatchNutrition && (batch.nutrition.details?.length ?? 0) > 0
        ? batch.nutrition.details
        : []),
      processedAtIso,
      hasBatchWorkoutSummary,
      hasBatchNutrition,
    ],
  );
}

function normalizeDateKey(value) {
  if (value instanceof Date) {
    const dateKey = [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
    return assertValidDateKey(dateKey, value);
  }

  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return String(value ?? '');
  }
  return assertValidDateKey(`${match[1]}-${match[2]}-${match[3]}`, value);
}

function assertValidDateKey(dateKey, originalValue) {
  const match = String(dateKey ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`invalid archivedDate: ${String(originalValue ?? '')}`);
  }
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`invalid archivedDate: ${String(originalValue ?? '')}`);
  }
  return dateKey;
}

function normalizeRequiredSourceChannel(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error('persistSourceImageBatchIncremental: sourceChannel is required');
  }
  return text;
}
