import pg from 'pg';

import {
  buildTrainingSnapshotFromDaily,
  normalizeActivityType,
  toNullableNumber,
} from './training-domain.mjs';
import { resolveTrainingCoreConfig } from './training-db-config.mjs';

const { Client } = pg;
const TRAINING_DAY_QUERY = `
  select
    archived_date,
    total_activities,
    total_duration_seconds,
    training_calories,
    workout_duration_minutes,
    active_hours,
    cycling_distance_km,
    intake_calories,
    nutrition_details_json
  from core.training_day
  order by archived_date asc
`;
const TRAINING_MEASUREMENT_QUERY = `
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
  order by archived_date asc, measured_at asc nulls last
`;
const TRAINING_ACTIVITY_QUERY = `
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
  order by archived_date asc, activity_time asc nulls last
`;
const TRAINING_MEAL_QUERY = `
  select
    archived_date,
    meal_name,
    calories,
    recommended_min,
    recommended_max
  from core.meal
  order by archived_date asc, meal_name asc
`;

export async function readTrainingSnapshotFromDatabase(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return buildTrainingSnapshotFromDaily([], options.now?.toISOString?.() ?? new Date().toISOString());
  }

  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));

  return readTrainingSnapshotFromDatabaseWithClients({
    createClient,
    config,
    now: options.now,
  });
}

export async function readArchiveTrainingSnapshotFromDatabase(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return buildTrainingSnapshotFromDaily([], options.now?.toISOString?.() ?? new Date().toISOString());
  }

  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));

  return readArchiveTrainingSnapshotFromDatabaseWithClients({
    createClient,
    config,
    now: options.now,
  });
}

export async function getLastProcessedTelegramUpdateId(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return 0;
  }

  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));

  const client = createClient(config);

  try {
    await client.connect();
    const result = await client.query(`
      select coalesce(max(update_id), 0) as last_processed_update_id
      from ingest.telegram_message
    `);
    return Number(result.rows[0]?.last_processed_update_id ?? 0);
  } finally {
    await client.end();
  }
}

export async function readTrainingSnapshotFromDatabaseClient(client, now) {
  const dayResult = await client.query(TRAINING_DAY_QUERY);
  const measurementResult = await client.query(TRAINING_MEASUREMENT_QUERY);
  const activityResult = await client.query(TRAINING_ACTIVITY_QUERY);
  const mealResult = await client.query(TRAINING_MEAL_QUERY);

  return buildTrainingSnapshotFromRows({
    dayRows: dayResult.rows,
    measurementRows: measurementResult.rows,
    activityRows: activityResult.rows,
    mealRows: mealResult.rows,
    now,
  });
}

async function readTrainingSnapshotFromDatabaseWithClients({ createClient, config, now }) {
  const clients = Array.from({ length: 4 }, () => createClient(config));

  try {
    await Promise.all(clients.map((client) => client.connect()));

    const [dayResult, measurementResult, activityResult, mealResult] = await Promise.all([
      clients[0].query(TRAINING_DAY_QUERY),
      clients[1].query(TRAINING_MEASUREMENT_QUERY),
      clients[2].query(TRAINING_ACTIVITY_QUERY),
      clients[3].query(TRAINING_MEAL_QUERY),
    ]);

    return buildTrainingSnapshotFromRows({
      dayRows: dayResult.rows,
      measurementRows: measurementResult.rows,
      activityRows: activityResult.rows,
      mealRows: mealResult.rows,
      now,
    });
  } finally {
    await Promise.allSettled(clients.map((client) => client.end?.()));
  }
}

export async function readArchiveTrainingSnapshotFromDatabaseClient(client, now) {
  const dayResult = await client.query(`
      select
        archived_date,
        total_activities,
        total_duration_seconds,
        training_calories,
        workout_duration_minutes,
        active_hours,
        cycling_distance_km,
        intake_calories
      from archive.training_day
      order by archived_date asc
    `);
  const measurementResult = await client.query(`
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
      from archive.training_measurement
      order by archived_date asc, measured_at asc nulls last
    `);
  const activityResult = await client.query(`
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
      from archive.training_activity
      order by archived_date asc, activity_time asc nulls last
    `);
  const mealResult = await client.query(`
      select
        archived_date,
        meal_name,
        calories,
        recommended_min,
        recommended_max
      from archive.training_meal
      order by archived_date asc, meal_name asc
    `);

  return buildTrainingSnapshotFromRows({
    dayRows: dayResult.rows,
    measurementRows: measurementResult.rows,
    activityRows: activityResult.rows,
    mealRows: mealResult.rows,
    now,
  });
}

async function readArchiveTrainingSnapshotFromDatabaseWithClients({ createClient, config, now }) {
  const clients = Array.from({ length: 4 }, () => createClient(config));

  try {
    await Promise.all(clients.map((client) => client.connect()));

    const [dayResult, measurementResult, activityResult, mealResult] = await Promise.all([
      clients[0].query(ARCHIVE_TRAINING_DAY_QUERY),
      clients[1].query(ARCHIVE_TRAINING_MEASUREMENT_QUERY),
      clients[2].query(ARCHIVE_TRAINING_ACTIVITY_QUERY),
      clients[3].query(ARCHIVE_TRAINING_MEAL_QUERY),
    ]);

    return buildTrainingSnapshotFromRows({
      dayRows: dayResult.rows,
      measurementRows: measurementResult.rows,
      activityRows: activityResult.rows,
      mealRows: mealResult.rows,
      now,
    });
  } finally {
    await Promise.allSettled(clients.map((client) => client.end?.()));
  }
}

function buildTrainingSnapshotFromRows({
  dayRows,
  measurementRows,
  activityRows,
  mealRows,
  now,
}) {
  const measurementsByDate = groupBy(measurementRows, 'archived_date');
  const activitiesByDate = groupBy(activityRows, 'archived_date');
  const mealsByDate = groupBy(mealRows, 'archived_date');

  const daily = dayRows.map((row) => {
    const archivedDate = row.archived_date;
    const measurements = (measurementsByDate.get(archivedDate) ?? []).map((measurement) => ({
      archivedDate,
      measuredAt: measurement.measured_at,
      bodyScore: toNullableNumber(measurement.body_score),
      weightKg: toNullableNumber(measurement.weight_kg),
      bmi: toNullableNumber(measurement.bmi),
      bodyFatPct: toNullableNumber(measurement.body_fat_pct),
      skeletalMuscleKg: toNullableNumber(measurement.skeletal_muscle_kg),
      visceralFatLevel: toNullableNumber(measurement.visceral_fat_level),
      basalMetabolismKcal: toNullableNumber(measurement.basal_metabolism_kcal),
      bodyWaterPct: toNullableNumber(measurement.body_water_pct),
      proteinPct: toNullableNumber(measurement.protein_pct),
      boneMassKg: toNullableNumber(measurement.bone_mass_kg),
      fatFreeMassKg: toNullableNumber(measurement.fat_free_mass_kg),
      bodyAge: toNullableNumber(measurement.body_age),
      bodyType: measurement.body_type ?? null,
    }));
    const activities = (activitiesByDate.get(archivedDate) ?? []).map((activity) => ({
      time: activity.activity_time,
      type: normalizeActivityType(activity.activity_type),
      rawType: activity.raw_type ?? activity.activity_type,
      detail: activity.detail,
      durationText: activity.duration_text,
      durationSeconds: toNullableNumber(activity.duration_seconds) ?? 0,
      calories: toNullableNumber(activity.calories),
      heartRate: toNullableNumber(activity.heart_rate),
      distanceKm: toNullableNumber(activity.distance_km),
      avgSpeedKmh: toNullableNumber(activity.avg_speed_kmh),
    }));
    const meals = (mealsByDate.get(archivedDate) ?? []).map((meal) => ({
      name: meal.meal_name,
      calories: toNullableNumber(meal.calories),
      recommendedMin: toNullableNumber(meal.recommended_min),
      recommendedMax: toNullableNumber(meal.recommended_max),
    }));

    return {
      date: archivedDate,
      measurement: measurements.at(-1) ?? null,
      measurements,
      activities,
      workoutSummary: {
        totalActivities: Number(row.total_activities ?? activities.length),
        totalDurationSeconds: Number(row.total_duration_seconds ?? 0),
        trainingCalories: toNullableNumber(row.training_calories) ?? 0,
        workoutDurationMinutes: toNullableNumber(row.workout_duration_minutes),
        activeHours: toNullableNumber(row.active_hours),
        cyclingDistanceKm: toNullableNumber(row.cycling_distance_km) ?? 0,
        countsByType: countActivitiesByType(activities),
      },
      nutrition: {
        meals,
        totalCalories: toNullableNumber(row.intake_calories),
        details: Array.isArray(row.nutrition_details_json) ? row.nutrition_details_json : [],
      },
    };
  });

  return buildTrainingSnapshotFromDaily(
    daily,
    now?.toISOString?.() ?? new Date().toISOString(),
  );
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = row[key];
    const items = map.get(value) ?? [];
    items.push(row);
    map.set(value, items);
  }
  return map;
}

function countActivitiesByType(activities) {
  const countsByType = {};
  for (const activity of activities ?? []) {
    countsByType[activity.type] = (countsByType[activity.type] ?? 0) + 1;
  }
  return countsByType;
}

const ARCHIVE_TRAINING_DAY_QUERY = `
  select
    archived_date,
    total_activities,
    total_duration_seconds,
    training_calories,
    workout_duration_minutes,
    active_hours,
    cycling_distance_km,
    intake_calories
  from archive.training_day
  order by archived_date asc
`;
const ARCHIVE_TRAINING_MEASUREMENT_QUERY = `
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
  from archive.training_measurement
  order by archived_date asc, measured_at asc nulls last
`;
const ARCHIVE_TRAINING_ACTIVITY_QUERY = `
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
  from archive.training_activity
  order by archived_date asc, activity_time asc nulls last
`;
const ARCHIVE_TRAINING_MEAL_QUERY = `
  select
    archived_date,
    meal_name,
    calories,
    recommended_min,
    recommended_max
  from archive.training_meal
  order by archived_date asc, meal_name asc
`;
