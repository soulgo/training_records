import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';

const { Client } = pg;

export function resolveTrainingArchiveRuntimeContext(options = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const runtimeEnv = env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local';
  const actorName =
    runtimeEnv === 'github-actions' ? env.GITHUB_ACTOR ?? null : resolveLocalActorName();
  const explicitTrigger = argv.find((arg) => arg.startsWith('--trigger='))?.slice('--trigger='.length);
  const triggerName =
    explicitTrigger ??
    (runtimeEnv === 'github-actions' ? 'github-actions-build' : 'local-build-data');

  return {
    triggerName,
    runtimeEnv,
    actorName,
  };
}

export function resolveTrainingArchiveConfig(env = process.env) {
  const enabled = String(env.TRAINING_DB_ENABLED ?? 'false').toLowerCase() === 'true';

  return {
    enabled,
    url: env.TRAINING_DB_URL?.trim() || '',
    timeoutMs: parsePositiveInteger(env.TRAINING_DB_TIMEOUT_MS, 3000),
    appName: env.TRAINING_DB_APP_NAME?.trim() || 'training-records-dashboard',
    logPath: env.TRAINING_DB_LOG_PATH?.trim() || 'runtime/training-db-sync.ndjson',
  };
}

export async function persistTrainingArchive(options) {
  const config = resolveTrainingArchiveConfig(options.env);
  if (!config.enabled) {
    return {
      status: 'skipped',
      reason: 'disabled',
    };
  }
  if (!config.url) {
    return {
      status: 'skipped',
      reason: 'missing_url',
    };
  }

  const runtimeContext =
    options.runtimeContext ?? resolveTrainingArchiveRuntimeContext({ env: options.env });
  const runId = randomUUID();
  const sourceHash = createHash('sha256').update(options.markdownRaw, 'utf8').digest('hex');
  const dailyCount = options.parsed.daily.length;
  const latestArchivedDate =
    options.parsed.latest?.daily?.date ?? options.parsed.daily.at(-1)?.date ?? null;
  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));

  const client = createClient(config);
  let transactionStarted = false;
  const updatedAtIso = options.runFinishedAt.toISOString();

  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const existingSnapshot = await readExistingSnapshotSourceHash(client, sourceHash);
    const snapshotUnchanged = existingSnapshot === sourceHash;

    if (snapshotUnchanged) {
      await updateTrainingParseSnapshotLastSeen(client, {
        sourceHash,
        updatedAtIso,
      });
    } else {
      await upsertTrainingParseSnapshot(client, {
        sourceHash,
        parsed: options.parsed,
        dailyCount,
        latestArchivedDate,
        updatedAtIso,
      });
      await upsertTrainingDays(client, buildTrainingDayRows({
        days: options.parsed.daily,
        sourceHash,
        updatedAtIso,
      }));
      await upsertTrainingMeasurements(client, buildTrainingMeasurementRows({
        days: options.parsed.daily,
        sourceHash,
        updatedAtIso,
      }));
      await upsertTrainingActivities(client, buildTrainingActivityRows({
        days: options.parsed.daily,
        sourceHash,
        updatedAtIso,
      }));
      await upsertTrainingMeals(client, buildTrainingMealRows({
        days: options.parsed.daily,
        sourceHash,
        updatedAtIso,
      }));
      await upsertTrainingSleeps(client, buildTrainingSleepRows({
        days: options.parsed.daily,
        sourceHash,
        updatedAtIso,
      }));
    }

    await insertTrainingParseRun(client, {
      runId,
      sourceHash,
      runtimeContext,
      runStartedAt: options.runStartedAt,
      runFinishedAt: options.runFinishedAt,
      dailyCount,
      latestArchivedDate,
    });

    await client.query('COMMIT');
    transactionStarted = false;

    return {
      status: snapshotUnchanged ? 'unchanged' : 'synced',
      runId,
      sourceHash,
      dailyCount,
      latestArchivedDate,
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    await client.end();
  }
}

export async function appendTrainingArchiveFailureLog(options) {
  const config = resolveTrainingArchiveConfig(options.env);
  const rootDir = options.rootDir ?? process.cwd();
  const logPath = path.join(rootDir, config.logPath);

  await mkdir(path.dirname(logPath), { recursive: true });

  const latestArchivedDate =
    options.parsed?.latest?.daily?.date ?? options.parsed?.daily?.at(-1)?.date ?? null;
  const payload = {
    loggedAt: new Date().toISOString(),
    triggerName: options.runtimeContext?.triggerName ?? null,
    runtimeEnv: options.runtimeContext?.runtimeEnv ?? null,
    actorName: options.runtimeContext?.actorName ?? null,
    runStartedAt: options.runStartedAt?.toISOString?.() ?? null,
    runFinishedAt: options.runFinishedAt?.toISOString?.() ?? null,
    dailyCount: options.parsed?.daily?.length ?? null,
    latestArchivedDate,
    error: options.error instanceof Error ? options.error.message : String(options.error),
  };

  await appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readExistingSnapshotSourceHash(client, sourceHash) {
  const result = await client.query(
    `
      select source_hash
      from archive.training_parse_snapshot
      where source_hash = $1
      limit 1
    `,
    [sourceHash],
  );
  return result?.rows?.[0]?.source_hash ?? null;
}

async function updateTrainingParseSnapshotLastSeen(client, { sourceHash, updatedAtIso }) {
  await client.query(
    `
      update archive.training_parse_snapshot
      set last_seen_at = $2
      where source_hash = $1
    `,
    [sourceHash, updatedAtIso],
  );
}

async function upsertTrainingParseSnapshot(client, {
  sourceHash,
  parsed,
  dailyCount,
  latestArchivedDate,
  updatedAtIso,
}) {
  await client.query(
    `
      insert into archive.training_parse_snapshot (
        source_hash,
        payload_version,
        payload_json,
        daily_count,
        latest_archived_date,
        parsed_generated_at,
        first_seen_at,
        last_seen_at
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
      JSON.stringify(parsed),
      dailyCount,
      latestArchivedDate,
      parsed.generatedAt,
      updatedAtIso,
      updatedAtIso,
    ],
  );
}

async function insertTrainingParseRun(client, {
  runId,
  sourceHash,
  runtimeContext,
  runStartedAt,
  runFinishedAt,
  dailyCount,
  latestArchivedDate,
}) {
  await client.query(
    `
      insert into archive.training_parse_run (
        run_id,
        source_hash,
        trigger_name,
        actor_name,
        runtime_env,
        run_started_at,
        run_finished_at,
        daily_count,
        latest_archived_date,
        main_output_written,
        db_sync_status
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      runId,
      sourceHash,
      runtimeContext.triggerName,
      runtimeContext.actorName,
      runtimeContext.runtimeEnv,
      runStartedAt.toISOString(),
      runFinishedAt.toISOString(),
      dailyCount,
      latestArchivedDate,
      true,
      'success',
    ],
  );
}

async function upsertTrainingDays(client, rows) {
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `
      insert into archive.training_day (
        archived_date,
        source_hash,
        total_activities,
        total_duration_seconds,
        training_calories,
        workout_duration_minutes,
        active_hours,
        cycling_distance_km,
        intake_calories,
        measurement_count,
        meal_count,
        updated_at
      )
      select *
      from unnest(
        $1::date[],
        $2::text[],
        $3::integer[],
        $4::integer[],
        $5::integer[],
        $6::integer[],
        $7::integer[],
        $8::numeric[],
        $9::integer[],
        $10::integer[],
        $11::integer[],
        $12::timestamptz[]
      )
      on conflict (archived_date) do update set
        source_hash = excluded.source_hash,
        total_activities = excluded.total_activities,
        total_duration_seconds = excluded.total_duration_seconds,
        training_calories = excluded.training_calories,
        workout_duration_minutes = excluded.workout_duration_minutes,
        active_hours = excluded.active_hours,
        cycling_distance_km = excluded.cycling_distance_km,
        intake_calories = excluded.intake_calories,
        measurement_count = excluded.measurement_count,
        meal_count = excluded.meal_count,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceHash),
      rows.map((row) => row.totalActivities),
      rows.map((row) => row.totalDurationSeconds),
      rows.map((row) => row.trainingCalories),
      rows.map((row) => row.workoutDurationMinutes),
      rows.map((row) => row.activeHours),
      rows.map((row) => row.cyclingDistanceKm),
      rows.map((row) => row.intakeCalories),
      rows.map((row) => row.measurementCount),
      rows.map((row) => row.mealCount),
      rows.map((row) => row.updatedAt),
    ],
  );
}

async function upsertTrainingActivities(client, rows) {
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `
      insert into archive.training_activity (
        activity_hash,
        archived_date,
        source_hash,
        activity_time,
        activity_type,
        raw_type,
        detail,
        calories,
        heart_rate,
        distance_km,
        avg_speed_kmh,
        duration_text,
        duration_seconds,
        updated_at
      )
      select *
      from unnest(
        $1::text[],
        $2::date[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::text[],
        $7::text[],
        $8::integer[],
        $9::integer[],
        $10::numeric[],
        $11::numeric[],
        $12::text[],
        $13::integer[],
        $14::timestamptz[]
      )
      on conflict (activity_hash) do update set
        source_hash = excluded.source_hash,
        activity_time = excluded.activity_time,
        activity_type = excluded.activity_type,
        raw_type = excluded.raw_type,
        detail = excluded.detail,
        calories = excluded.calories,
        heart_rate = excluded.heart_rate,
        distance_km = excluded.distance_km,
        avg_speed_kmh = excluded.avg_speed_kmh,
        duration_text = excluded.duration_text,
        duration_seconds = excluded.duration_seconds,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.activityHash),
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceHash),
      rows.map((row) => row.activityTime),
      rows.map((row) => row.activityType),
      rows.map((row) => row.rawType),
      rows.map((row) => row.detail),
      rows.map((row) => row.calories),
      rows.map((row) => row.heartRate),
      rows.map((row) => row.distanceKm),
      rows.map((row) => row.avgSpeedKmh),
      rows.map((row) => row.durationText),
      rows.map((row) => row.durationSeconds),
      rows.map((row) => row.updatedAt),
    ],
  );
}

async function upsertTrainingMeasurements(client, rows) {
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `
      insert into archive.training_measurement (
        measurement_hash,
        archived_date,
        source_hash,
        measured_at,
        weight_kg,
        bmi,
        body_fat_pct,
        skeletal_muscle_kg,
        body_water_pct,
        protein_pct,
        bone_mass_kg,
        visceral_fat_level,
        basal_metabolism_kcal,
        body_age,
        body_score,
        body_type,
        fat_free_mass_kg,
        updated_at
      )
      select *
      from unnest(
        $1::text[],
        $2::date[],
        $3::text[],
        $4::text[],
        $5::numeric[],
        $6::numeric[],
        $7::numeric[],
        $8::numeric[],
        $9::numeric[],
        $10::numeric[],
        $11::numeric[],
        $12::numeric[],
        $13::integer[],
        $14::integer[],
        $15::integer[],
        $16::text[],
        $17::numeric[],
        $18::timestamptz[]
      )
      on conflict (measurement_hash) do update set
        source_hash = excluded.source_hash,
        measured_at = excluded.measured_at,
        weight_kg = excluded.weight_kg,
        bmi = excluded.bmi,
        body_fat_pct = excluded.body_fat_pct,
        skeletal_muscle_kg = excluded.skeletal_muscle_kg,
        body_water_pct = excluded.body_water_pct,
        protein_pct = excluded.protein_pct,
        bone_mass_kg = excluded.bone_mass_kg,
        visceral_fat_level = excluded.visceral_fat_level,
        basal_metabolism_kcal = excluded.basal_metabolism_kcal,
        body_age = excluded.body_age,
        body_score = excluded.body_score,
        body_type = excluded.body_type,
        fat_free_mass_kg = excluded.fat_free_mass_kg,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.measurementHash),
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceHash),
      rows.map((row) => row.measuredAt),
      rows.map((row) => row.weightKg),
      rows.map((row) => row.bmi),
      rows.map((row) => row.bodyFatPct),
      rows.map((row) => row.skeletalMuscleKg),
      rows.map((row) => row.bodyWaterPct),
      rows.map((row) => row.proteinPct),
      rows.map((row) => row.boneMassKg),
      rows.map((row) => row.visceralFatLevel),
      rows.map((row) => row.basalMetabolismKcal),
      rows.map((row) => row.bodyAge),
      rows.map((row) => row.bodyScore),
      rows.map((row) => row.bodyType),
      rows.map((row) => row.fatFreeMassKg),
      rows.map((row) => row.updatedAt),
    ],
  );
}

async function upsertTrainingMeals(client, rows) {
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `
      insert into archive.training_meal (
        meal_hash,
        archived_date,
        source_hash,
        meal_name,
        calories,
        recommended_min,
        recommended_max,
        updated_at
      )
      select *
      from unnest(
        $1::text[],
        $2::date[],
        $3::text[],
        $4::text[],
        $5::integer[],
        $6::integer[],
        $7::integer[],
        $8::timestamptz[]
      )
      on conflict (meal_hash) do update set
        source_hash = excluded.source_hash,
        meal_name = excluded.meal_name,
        calories = excluded.calories,
        recommended_min = excluded.recommended_min,
        recommended_max = excluded.recommended_max,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.mealHash),
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceHash),
      rows.map((row) => row.mealName),
      rows.map((row) => row.calories),
      rows.map((row) => row.recommendedMin),
      rows.map((row) => row.recommendedMax),
      rows.map((row) => row.updatedAt),
    ],
  );
}

async function upsertTrainingSleeps(client, rows) {
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `
      insert into archive.training_sleep (
        sleep_hash,
        archived_date,
        source_hash,
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
        suggestion_text,
        updated_at
      )
      select *
      from unnest(
        $1::text[],
        $2::date[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::text[],
        $7::integer[],
        $8::integer[],
        $9::integer[],
        $10::integer[],
        $11::integer[],
        $12::integer[],
        $13::integer[],
        $14::text[],
        $15::text[],
        $16::integer[],
        $17::integer[],
        $18::numeric[],
        $19::numeric[],
        $20::numeric[],
        $21::integer[],
        $22::integer[],
        $23::integer[],
        $24::integer[],
        $25::integer[],
        $26::numeric[],
        $27::numeric[],
        $28::text[],
        $29::text[],
        $30::timestamptz[]
      )
      on conflict (sleep_hash) do update set
        source_hash = excluded.source_hash,
        sleep_type = excluded.sleep_type,
        bedtime = excluded.bedtime,
        wake_time = excluded.wake_time,
        night_sleep_minutes = excluded.night_sleep_minutes,
        total_sleep_minutes = excluded.total_sleep_minutes,
        nap_minutes = excluded.nap_minutes,
        deep_sleep_minutes = excluded.deep_sleep_minutes,
        light_sleep_minutes = excluded.light_sleep_minutes,
        rem_sleep_minutes = excluded.rem_sleep_minutes,
        awake_minutes = excluded.awake_minutes,
        sleep_stage_text = excluded.sleep_stage_text,
        sleep_stage_detail = excluded.sleep_stage_detail,
        sleep_score = excluded.sleep_score,
        sleep_score_percentile = excluded.sleep_score_percentile,
        deep_sleep_ratio_pct = excluded.deep_sleep_ratio_pct,
        light_sleep_ratio_pct = excluded.light_sleep_ratio_pct,
        rem_sleep_ratio_pct = excluded.rem_sleep_ratio_pct,
        deep_sleep_continuity_score = excluded.deep_sleep_continuity_score,
        wake_count = excluded.wake_count,
        breathing_quality_score = excluded.breathing_quality_score,
        average_heart_rate_bpm = excluded.average_heart_rate_bpm,
        hrv_ms = excluded.hrv_ms,
        average_spo2_pct = excluded.average_spo2_pct,
        average_respiratory_rate = excluded.average_respiratory_rate,
        analysis_text = excluded.analysis_text,
        suggestion_text = excluded.suggestion_text,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.sleepHash),
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceHash),
      rows.map((row) => row.sleepType),
      rows.map((row) => row.bedtime),
      rows.map((row) => row.wakeTime),
      rows.map((row) => row.nightSleepMinutes),
      rows.map((row) => row.totalSleepMinutes),
      rows.map((row) => row.napMinutes),
      rows.map((row) => row.deepSleepMinutes),
      rows.map((row) => row.lightSleepMinutes),
      rows.map((row) => row.remSleepMinutes),
      rows.map((row) => row.awakeMinutes),
      rows.map((row) => row.sleepStageText),
      rows.map((row) => row.sleepStageDetail),
      rows.map((row) => row.sleepScore),
      rows.map((row) => row.sleepScorePercentile),
      rows.map((row) => row.deepSleepRatioPct),
      rows.map((row) => row.lightSleepRatioPct),
      rows.map((row) => row.remSleepRatioPct),
      rows.map((row) => row.deepSleepContinuityScore),
      rows.map((row) => row.wakeCount),
      rows.map((row) => row.breathingQualityScore),
      rows.map((row) => row.averageHeartRateBpm),
      rows.map((row) => row.hrvMs),
      rows.map((row) => row.averageSpo2Pct),
      rows.map((row) => row.averageRespiratoryRate),
      rows.map((row) => row.analysisText),
      rows.map((row) => row.suggestionText),
      rows.map((row) => row.updatedAt),
    ],
  );
}

function buildTrainingDayRows({ days, sourceHash, updatedAtIso }) {
  return days.map((day) => ({
    archivedDate: day.date,
    sourceHash,
    totalActivities: day.workoutSummary?.totalActivities ?? 0,
    totalDurationSeconds: day.workoutSummary?.totalDurationSeconds ?? 0,
    trainingCalories: day.workoutSummary?.trainingCalories ?? null,
    workoutDurationMinutes: day.workoutSummary?.workoutDurationMinutes ?? null,
    activeHours: day.workoutSummary?.activeHours ?? null,
    cyclingDistanceKm: day.workoutSummary?.cyclingDistanceKm ?? null,
    intakeCalories: day.nutrition?.totalCalories ?? null,
    measurementCount: resolveMeasurements(day).length,
    mealCount: day.nutrition?.meals?.length ?? 0,
    updatedAt: updatedAtIso,
  }));
}

function buildTrainingMeasurementRows({ days, sourceHash, updatedAtIso }) {
  return days.flatMap((day) =>
    resolveMeasurements(day).map((measurement) => ({
      measurementHash: createHash('md5')
        .update(
          [
            day.date,
            measurement.measuredAt ?? '',
            measurement.weightKg ?? '',
            measurement.bodyFatPct ?? '',
          ].join('|'),
          'utf8',
        )
        .digest('hex'),
      archivedDate: day.date,
      sourceHash,
      measuredAt: measurement.measuredAt ?? null,
      weightKg: measurement.weightKg ?? null,
      bmi: measurement.bmi ?? null,
      bodyFatPct: measurement.bodyFatPct ?? null,
      skeletalMuscleKg: measurement.skeletalMuscleKg ?? null,
      bodyWaterPct: measurement.bodyWaterPct ?? null,
      proteinPct: measurement.proteinPct ?? null,
      boneMassKg: measurement.boneMassKg ?? null,
      visceralFatLevel: measurement.visceralFatLevel ?? null,
      basalMetabolismKcal: measurement.basalMetabolismKcal ?? null,
      bodyAge: measurement.bodyAge ?? null,
      bodyScore: measurement.bodyScore ?? null,
      bodyType: measurement.bodyType ?? null,
      fatFreeMassKg: measurement.fatFreeMassKg ?? null,
      updatedAt: updatedAtIso,
    })),
  );
}

function buildTrainingActivityRows({ days, sourceHash, updatedAtIso }) {
  return days.flatMap((day) =>
    (day.activities ?? []).map((activity) => ({
      activityHash: createHash('md5')
        .update(
          [
            day.date,
            activity.time ?? '',
            activity.type ?? '',
            activity.detail ?? '',
            activity.durationSeconds ?? '',
          ].join('|'),
          'utf8',
        )
        .digest('hex'),
      archivedDate: day.date,
      sourceHash,
      activityTime: activity.time ?? null,
      activityType: activity.type ?? '未知活动',
      rawType: activity.rawType ?? null,
      detail: activity.detail ?? null,
      calories: activity.calories ?? null,
      heartRate: activity.heartRate ?? null,
      distanceKm: activity.distanceKm ?? null,
      avgSpeedKmh: activity.avgSpeedKmh ?? null,
      durationText: activity.durationText ?? null,
      durationSeconds: activity.durationSeconds ?? null,
      updatedAt: updatedAtIso,
    })),
  );
}

function buildTrainingMealRows({ days, sourceHash, updatedAtIso }) {
  return days.flatMap((day) =>
    (day.nutrition?.meals ?? []).map((meal) => ({
      mealHash: createHash('md5')
        .update([day.date, meal.name ?? '', meal.calories ?? ''].join('|'), 'utf8')
        .digest('hex'),
      archivedDate: day.date,
      sourceHash,
      mealName: meal.name ?? '未命名餐次',
      calories: meal.calories ?? null,
      recommendedMin: meal.recommendedMin ?? null,
      recommendedMax: meal.recommendedMax ?? null,
      updatedAt: updatedAtIso,
    })),
  );
}

function buildTrainingSleepRows({ days, sourceHash, updatedAtIso }) {
  return days.flatMap((day) =>
    (day.sleep ?? []).map((sleep) => {
      const sleepType = sleep.sleepType ?? '夜间睡眠';
      const bedtime = sleep.bedtime ?? sleep.sleepStartTime ?? null;
      const wakeTime = sleep.wakeTime ?? sleep.sleepEndTime ?? null;
      return {
        sleepHash: createHash('md5')
          .update(
            [
              day.date,
              sleepType,
              bedtime ?? '',
              wakeTime ?? '',
              sleep.totalSleepMinutes ?? '',
            ].join('|'),
            'utf8',
          )
          .digest('hex'),
        archivedDate: day.date,
        sourceHash,
        sleepType,
        bedtime,
        wakeTime,
        nightSleepMinutes: sleep.nightSleepMinutes ?? null,
        totalSleepMinutes: sleep.totalSleepMinutes ?? null,
        napMinutes: sleep.napMinutes ?? null,
        deepSleepMinutes: sleep.deepSleepMinutes ?? null,
        lightSleepMinutes: sleep.lightSleepMinutes ?? null,
        remSleepMinutes: sleep.remSleepMinutes ?? null,
        awakeMinutes: sleep.awakeMinutes ?? null,
        sleepStageText: sleep.sleepStageText ?? null,
        sleepStageDetail: sleep.sleepStageDetail ? JSON.stringify(sleep.sleepStageDetail) : null,
        sleepScore: sleep.sleepScore ?? null,
        sleepScorePercentile: sleep.sleepScorePercentile ?? null,
        deepSleepRatioPct: sleep.deepSleepRatioPct ?? null,
        lightSleepRatioPct: sleep.lightSleepRatioPct ?? null,
        remSleepRatioPct: sleep.remSleepRatioPct ?? null,
        deepSleepContinuityScore: sleep.deepSleepContinuityScore ?? null,
        wakeCount: sleep.wakeCount ?? null,
        breathingQualityScore: sleep.breathingQualityScore ?? null,
        averageHeartRateBpm: sleep.averageHeartRateBpm ?? null,
        hrvMs: sleep.hrvMs ?? null,
        averageSpo2Pct: sleep.averageSpo2Pct ?? null,
        averageRespiratoryRate: sleep.averageRespiratoryRate ?? null,
        analysisText: sleep.analysisText ?? null,
        suggestionText: sleep.suggestionText ?? null,
        updatedAt: updatedAtIso,
      };
    }),
  );
}

function resolveMeasurements(day) {
  if (Array.isArray(day.measurements) && day.measurements.length > 0) {
    return day.measurements;
  }

  if (day.measurement) {
    return [day.measurement];
  }

  return [];
}

function resolveLocalActorName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? null;
  }
}
