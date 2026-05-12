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
        JSON.stringify(options.parsed),
        dailyCount,
        latestArchivedDate,
        options.parsed.generatedAt,
        updatedAtIso,
        updatedAtIso,
      ],
    );

    for (const day of options.parsed.daily) {
      await upsertTrainingDay({
        client,
        sourceHash,
        day,
        updatedAtIso,
      });

      for (const measurement of resolveMeasurements(day)) {
        await upsertTrainingMeasurement({
          client,
          sourceHash,
          archivedDate: day.date,
          measurement,
          updatedAtIso,
        });
      }

      for (const activity of day.activities ?? []) {
        await upsertTrainingActivity({
          client,
          sourceHash,
          archivedDate: day.date,
          activity,
          updatedAtIso,
        });
      }

      for (const meal of day.nutrition?.meals ?? []) {
        await upsertTrainingMeal({
          client,
          sourceHash,
          archivedDate: day.date,
          meal,
          updatedAtIso,
        });
      }
    }

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
        options.runStartedAt.toISOString(),
        options.runFinishedAt.toISOString(),
        dailyCount,
        latestArchivedDate,
        true,
        'success',
      ],
    );

    await client.query('COMMIT');
    transactionStarted = false;

    return {
      status: 'synced',
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

async function upsertTrainingDay({ client, sourceHash, day, updatedAtIso }) {
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
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      day.date,
      sourceHash,
      day.workoutSummary?.totalActivities ?? 0,
      day.workoutSummary?.totalDurationSeconds ?? 0,
      day.workoutSummary?.trainingCalories ?? null,
      day.workoutSummary?.workoutDurationMinutes ?? null,
      day.workoutSummary?.activeHours ?? null,
      day.workoutSummary?.cyclingDistanceKm ?? null,
      day.nutrition?.totalCalories ?? null,
      resolveMeasurements(day).length,
      day.nutrition?.meals?.length ?? 0,
      updatedAtIso,
    ],
  );
}

async function upsertTrainingActivity({ client, sourceHash, archivedDate, activity, updatedAtIso }) {
  const activityHash = createHash('md5')
    .update(
      [
        archivedDate,
        activity.time ?? '',
        activity.type ?? '',
        activity.detail ?? '',
        activity.durationSeconds ?? '',
      ].join('|'),
      'utf8',
    )
    .digest('hex');

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
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
      activityHash,
      archivedDate,
      sourceHash,
      activity.time ?? null,
      activity.type ?? '未知活动',
      activity.rawType ?? null,
      activity.detail ?? null,
      activity.calories ?? null,
      activity.heartRate ?? null,
      activity.distanceKm ?? null,
      activity.avgSpeedKmh ?? null,
      activity.durationText ?? null,
      activity.durationSeconds ?? null,
      updatedAtIso,
    ],
  );
}

async function upsertTrainingMeasurement({
  client,
  sourceHash,
  archivedDate,
  measurement,
  updatedAtIso,
}) {
  const measurementHash = createHash('md5')
    .update(
      [
        archivedDate,
        measurement.measuredAt ?? '',
        measurement.weightKg ?? '',
        measurement.bodyFatPct ?? '',
      ].join('|'),
      'utf8',
    )
    .digest('hex');

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
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
      measurementHash,
      archivedDate,
      sourceHash,
      measurement.measuredAt ?? null,
      measurement.weightKg ?? null,
      measurement.bmi ?? null,
      measurement.bodyFatPct ?? null,
      measurement.skeletalMuscleKg ?? null,
      measurement.bodyWaterPct ?? null,
      measurement.proteinPct ?? null,
      measurement.boneMassKg ?? null,
      measurement.visceralFatLevel ?? null,
      measurement.basalMetabolismKcal ?? null,
      measurement.bodyAge ?? null,
      measurement.bodyScore ?? null,
      measurement.bodyType ?? null,
      measurement.fatFreeMassKg ?? null,
      updatedAtIso,
    ],
  );
}

async function upsertTrainingMeal({ client, sourceHash, archivedDate, meal, updatedAtIso }) {
  const mealHash = createHash('md5')
    .update([archivedDate, meal.name ?? '', meal.calories ?? ''].join('|'), 'utf8')
    .digest('hex');

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
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (meal_hash) do update set
        source_hash = excluded.source_hash,
        meal_name = excluded.meal_name,
        calories = excluded.calories,
        recommended_min = excluded.recommended_min,
        recommended_max = excluded.recommended_max,
        updated_at = excluded.updated_at
    `,
    [
      mealHash,
      archivedDate,
      sourceHash,
      meal.name ?? '未命名餐次',
      meal.calories ?? null,
      meal.recommendedMin ?? null,
      meal.recommendedMax ?? null,
      updatedAtIso,
    ],
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
