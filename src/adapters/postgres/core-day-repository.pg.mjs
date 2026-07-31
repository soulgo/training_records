import { createHash } from 'node:crypto';

import { readTrainingSnapshotFromDatabaseClient } from './training-read-client.pg.mjs';
import {
  insertArchiveSleep,
  insertCoreActivities,
  insertCoreMeals,
  insertCoreMeasurements,
  insertCoreSleep,
} from './core-row-writer.pg.mjs';

export async function readCoreDay(client, archivedDate) {
  const records = await readCoreDays(client, [archivedDate]);
  return records[0] ?? null;
}

export async function readCoreDays(client, dates) {
  const normalizedDates = [...new Set((dates ?? []).map(normalizeDateKey).filter(Boolean))];
  if (normalizedDates.length === 0) {
    return [];
  }

  const dayResult = await client.query(
    `
      select
        archived_date,
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
        nutrition_details_json
      from core.training_day
      where archived_date = any($1::date[])
      order by archived_date asc
    `,
    [normalizedDates],
  );
  const measurementResult = await client.query(
    `
      select
        archived_date,
        measured_at,
        body_score,
        weight_kg,
        bmi,
        body_fat_pct,
        skeletal_muscle_kg,
        visceral_fat_level,
        basal_metabolism_kcal,
        body_water_pct,
        protein_pct,
        bone_mass_kg,
        fat_free_mass_kg,
        body_age,
        body_type
      from core.measurement
      where archived_date = any($1::date[])
      order by archived_date asc, measured_at asc nulls last
    `,
    [normalizedDates],
  );
  const activityResult = await client.query(
    `
      select
        archived_date,
        activity_time,
        activity_type,
        raw_type,
        detail,
        calories,
        heart_rate,
        distance_km,
        avg_speed_kmh,
        duration_text,
        duration_seconds
      from core.activity
      where archived_date = any($1::date[])
      order by archived_date asc, activity_time asc nulls last
    `,
    [normalizedDates],
  );
  const mealResult = await client.query(
    `
      select
        archived_date,
        meal_name,
        calories,
        recommended_min,
        recommended_max
      from core.meal
      where archived_date = any($1::date[])
      order by archived_date asc, meal_name asc
    `,
    [normalizedDates],
  );
  const sleepResult = await client.query(
    `
      select
        archived_date,
        sleep_type,
        bedtime,
        wake_time,
        night_sleep_minutes,
        total_sleep_minutes,
        nap_minutes,
        deep_sleep_minutes,
        light_sleep_minutes,
        rem_sleep_minutes,
        awake_minutes,
        sleep_stage_text,
        sleep_stage_detail,
        sleep_score,
        sleep_score_percentile,
        deep_sleep_ratio_pct,
        light_sleep_ratio_pct,
        rem_sleep_ratio_pct,
        deep_sleep_continuity_score,
        wake_count,
        breathing_quality_score,
        average_heart_rate_bpm,
        hrv_ms,
        average_spo2_pct,
        average_respiratory_rate,
        analysis_text,
        suggestion_text
      from core.sleep
      where archived_date = any($1::date[])
      order by archived_date asc, bedtime asc nulls last
    `,
    [normalizedDates],
  );

  const snapshot = await readTrainingSnapshotFromDatabaseClient(
    {
      async query(sql) {
        if (/from core\.training_day/i.test(sql)) {
          return dayResult;
        }
        if (/from core\.measurement/i.test(sql)) {
          return measurementResult;
        }
        if (/from core\.activity/i.test(sql)) {
          return activityResult;
        }
        if (/from core\.meal/i.test(sql)) {
          return mealResult;
        }
        if (/from core\.sleep/i.test(sql)) {
          return sleepResult;
        }
        if (/from core\.thought/i.test(sql)) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
    new Date(),
  );
  return snapshot.daily ?? [];
}

export async function replaceCoreDay(client, day, batchId, processedAt, options = {}) {
  await writeCoreDays(client, [day], {
    batchId,
    processedAt,
    sourceChannel: options.sourceChannel ?? 'telegram',
    sourceHash: options.sourceHash ?? null,
    writeArchiveSleep: options.writeArchiveSleep,
  });
}

export async function replaceCoreSleepForDay(client, day, batchId, processedAt, options = {}) {
  const archivedDate = normalizeDateKey(day?.date);
  if (!archivedDate) {
    return;
  }

  const normalizedDay = { ...day, date: archivedDate };
  const processedAtIso = (processedAt ?? new Date()).toISOString();
  const sourceChannel = options.sourceChannel ?? 'ingest_sleep_backfill';
  const sleepSummary = normalizedDay.sleepSummary ?? {};

  await client.query('delete from core.sleep where archived_date = $1', [archivedDate]);
  await insertCoreSleep(client, [normalizedDay], { batchId, sourceChannel }, processedAtIso);
  await client.query(
    `
      insert into core.training_day (
        archived_date,
        source_batch_id,
        source_channel,
        sleep_total_minutes,
        night_sleep_minutes,
        nap_minutes,
        sleep_start_time,
        sleep_end_time,
        deep_sleep_minutes,
        light_sleep_minutes,
        rem_sleep_minutes,
        awake_minutes,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      on conflict (archived_date) do update set
        source_batch_id = excluded.source_batch_id,
        source_channel = excluded.source_channel,
        sleep_total_minutes = excluded.sleep_total_minutes,
        night_sleep_minutes = excluded.night_sleep_minutes,
        nap_minutes = excluded.nap_minutes,
        sleep_start_time = excluded.sleep_start_time,
        sleep_end_time = excluded.sleep_end_time,
        deep_sleep_minutes = excluded.deep_sleep_minutes,
        light_sleep_minutes = excluded.light_sleep_minutes,
        rem_sleep_minutes = excluded.rem_sleep_minutes,
        awake_minutes = excluded.awake_minutes,
        updated_at = excluded.updated_at
    `,
    [
      archivedDate,
      batchId,
      sourceChannel,
      sleepSummary.totalSleepMinutes ?? null,
      sleepSummary.nightSleepMinutes ?? null,
      sleepSummary.napMinutes ?? null,
      sleepSummary.sleepStartTime ?? sleepSummary.bedtime ?? null,
      sleepSummary.sleepEndTime ?? sleepSummary.wakeTime ?? null,
      sleepSummary.deepSleepMinutes ?? null,
      sleepSummary.lightSleepMinutes ?? null,
      sleepSummary.remSleepMinutes ?? null,
      sleepSummary.awakeMinutes ?? null,
      processedAtIso,
    ],
  );
}

export async function replaceCoreDays(client, days, options) {
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await writeCoreDays(client, days, options);
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }
    throw error;
  }
}

export async function writeCoreDays(client, days, options) {
  const normalizedDays = days.map((day) => ({ ...day, date: normalizeDateKey(day.date) })).filter((day) => day.date);
  if (normalizedDays.length === 0) {
    return;
  }

  const dates = normalizedDays.map((day) => day.date);
  const processedAtIso = (options.processedAt ?? new Date()).toISOString();
  const sourceHash = options.writeArchiveSleep === false
    ? null
    : options.sourceHash ?? buildArchiveSourceHash(normalizedDays, options);
  if (sourceHash) {
    await upsertArchiveParseSnapshot(client, {
      sourceHash,
      days: normalizedDays,
      processedAtIso,
    });
  }

  await client.query(`delete from core.measurement where archived_date = any($1::date[])`, [dates]);
  await client.query(`delete from core.activity where archived_date = any($1::date[])`, [dates]);
  await client.query(`delete from core.meal where archived_date = any($1::date[])`, [dates]);
  await client.query(`delete from core.sleep where archived_date = any($1::date[])`, [dates]);
  await upsertCoreTrainingDays(client, normalizedDays, options, processedAtIso);
  await insertCoreMeasurements(client, normalizedDays, options, processedAtIso);
  await insertCoreActivities(client, normalizedDays, options, processedAtIso);
  await insertCoreMeals(client, normalizedDays, options, processedAtIso);
  await insertCoreSleep(client, normalizedDays, options, processedAtIso);
  if (sourceHash) {
    await insertArchiveSleep(client, normalizedDays, { ...options, sourceHash }, processedAtIso);
  }
}

export async function upsertArchiveParseSnapshot(client, { sourceHash, days, processedAtIso }) {
  const payload = {
    generatedAt: processedAtIso,
    daily: days,
    latest: { daily: days.at(-1) ?? null },
  };
  await client.query(
    `
      insert into archive.training_parse_snapshot (
        source_hash, payload_version, payload_json, daily_count,
        latest_archived_date, parsed_generated_at, first_seen_at, last_seen_at
      )
      values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
      on conflict (source_hash) do update set
        payload_version = excluded.payload_version,
        payload_json = excluded.payload_json,
        daily_count = excluded.daily_count,
        latest_archived_date = excluded.latest_archived_date,
        parsed_generated_at = excluded.parsed_generated_at,
        last_seen_at = excluded.last_seen_at
    `,
    [
      sourceHash,
      1,
      JSON.stringify(payload),
      days.length,
      days.at(-1)?.date ?? null,
      processedAtIso,
      processedAtIso,
      processedAtIso,
    ],
  );
}

async function upsertCoreTrainingDays(client, days, options, processedAtIso) {
  const rows = days.map((day) => ({
    archivedDate: day.date,
    sourceChannel: options.sourceChannel ?? 'telegram',
    sourceBatchId: options.batchId ?? `${options.batchIdPrefix ?? 'core-day'}-${day.date}`,
    totalActivities: day.workoutSummary?.totalActivities ?? 0,
    totalDurationSeconds: day.workoutSummary?.totalDurationSeconds ?? 0,
    trainingCalories: day.workoutSummary?.trainingCalories ?? 0,
    workoutDurationMinutes: day.workoutSummary?.workoutDurationMinutes ?? null,
    activeHours: day.workoutSummary?.activeHours ?? null,
    cyclingDistanceKm: day.workoutSummary?.cyclingDistanceKm ?? 0,
    intakeCalories: day.nutrition?.totalCalories ?? null,
    sleepTotalMinutes: day.sleepSummary?.totalSleepMinutes ?? null,
    nightSleepMinutes: day.sleepSummary?.nightSleepMinutes ?? null,
    napMinutes: day.sleepSummary?.napMinutes ?? null,
    sleepStartTime: day.sleepSummary?.sleepStartTime ?? day.sleepSummary?.bedtime ?? null,
    sleepEndTime: day.sleepSummary?.sleepEndTime ?? day.sleepSummary?.wakeTime ?? null,
    deepSleepMinutes: day.sleepSummary?.deepSleepMinutes ?? null,
    lightSleepMinutes: day.sleepSummary?.lightSleepMinutes ?? null,
    remSleepMinutes: day.sleepSummary?.remSleepMinutes ?? null,
    awakeMinutes: day.sleepSummary?.awakeMinutes ?? null,
    nutritionDetailsJson: JSON.stringify(day.nutrition?.details ?? []),
    updatedAt: processedAtIso,
  }));

  await client.query(
    `
      insert into core.training_day (
        archived_date, source_batch_id, source_channel, total_activities,
        total_duration_seconds, training_calories, workout_duration_minutes,
        active_hours, cycling_distance_km, intake_calories, sleep_total_minutes,
        night_sleep_minutes, nap_minutes, sleep_start_time, sleep_end_time,
        deep_sleep_minutes, light_sleep_minutes, rem_sleep_minutes, awake_minutes,
        nutrition_details_json, updated_at
      )
      select *
      from unnest($1::date[], $2::text[], $3::text[], $4::integer[], $5::integer[],
        $6::numeric[], $7::integer[], $8::integer[], $9::numeric[], $10::integer[],
        $11::integer[], $12::integer[], $13::integer[], $14::text[], $15::text[],
        $16::integer[], $17::integer[], $18::integer[], $19::integer[], $20::jsonb[],
        $21::timestamptz[])
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
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceBatchId),
      rows.map((row) => row.sourceChannel),
      rows.map((row) => row.totalActivities),
      rows.map((row) => row.totalDurationSeconds),
      rows.map((row) => row.trainingCalories),
      rows.map((row) => row.workoutDurationMinutes),
      rows.map((row) => row.activeHours),
      rows.map((row) => row.cyclingDistanceKm),
      rows.map((row) => row.intakeCalories),
      rows.map((row) => row.sleepTotalMinutes),
      rows.map((row) => row.nightSleepMinutes),
      rows.map((row) => row.napMinutes),
      rows.map((row) => row.sleepStartTime),
      rows.map((row) => row.sleepEndTime),
      rows.map((row) => row.deepSleepMinutes),
      rows.map((row) => row.lightSleepMinutes),
      rows.map((row) => row.remSleepMinutes),
      rows.map((row) => row.awakeMinutes),
      rows.map((row) => row.nutritionDetailsJson),
      rows.map((row) => row.updatedAt),
    ],
  );
}

function buildArchiveSourceHash(days, options) {
  if (!options.batchId) {
    return null;
  }
  return createHash('sha256')
    .update(JSON.stringify({
      sourceChannel: options.sourceChannel ?? 'telegram',
      batchId: options.batchId,
      days,
    }), 'utf8')
    .digest('hex');
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
