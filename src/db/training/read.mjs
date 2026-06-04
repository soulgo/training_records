import pg from 'pg';

import {
  buildTrainingSnapshotFromDaily,
  normalizeActivityType,
  toNullableNumber,
} from '../../domain/training/training-domain.mjs';
import { resolveTrainingCoreConfig } from './config.mjs';

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
const BODY_FEEDBACK_QUERY = `
  select
    telegram_message_id,
    telegram_chat_id,
    body,
    message_date_unix,
    markdown_path,
    updated_at
  from core.thought
  where thought_module = 'body_feedback'
    and status = 'active'
  order by coalesce(message_date_unix, extract(epoch from updated_at)) asc,
    telegram_message_id asc
`;

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
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
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
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
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
  const bodyFeedbackResult = await client.query(BODY_FEEDBACK_QUERY);

  return buildTrainingSnapshotFromRows({
    dayRows: dayResult.rows,
    measurementRows: measurementResult.rows,
    activityRows: activityResult.rows,
    mealRows: mealResult.rows,
    sleepRows: [],
    bodyFeedbackRows: bodyFeedbackResult.rows,
    now,
  });
}

async function readTrainingSnapshotFromDatabaseWithClients({ createClient, config, now, dateFrom, dateTo }) {
  const clients = Array.from({ length: 5 }, () => createClient(config));

  try {
    await Promise.all(clients.map((client) => client.connect()));

    const [dayResult, measurementResult, activityResult, mealResult, bodyFeedbackResult] = await Promise.all([
      clients[0].query(TRAINING_DAY_QUERY),
      clients[1].query(TRAINING_MEASUREMENT_QUERY),
      clients[2].query(TRAINING_ACTIVITY_QUERY),
      clients[3].query(TRAINING_MEAL_QUERY),
      clients[4].query(BODY_FEEDBACK_QUERY),
    ]);

    return buildTrainingSnapshotFromRows({
      dayRows: dayResult.rows,
      measurementRows: measurementResult.rows,
      activityRows: activityResult.rows,
      mealRows: mealResult.rows,
      sleepRows: [],
      bodyFeedbackRows: bodyFeedbackResult.rows,
      now,
      dateFrom,
      dateTo,
    });
  } finally {
    await Promise.allSettled(clients.map((client) => client.end?.()));
  }
}

export async function readArchiveTrainingSnapshotFromDatabaseClient(client, now) {
  const dayResult = await client.query(ARCHIVE_TRAINING_DAY_QUERY);
  const measurementResult = await client.query(ARCHIVE_TRAINING_MEASUREMENT_QUERY);
  const activityResult = await client.query(ARCHIVE_TRAINING_ACTIVITY_QUERY);
  const mealResult = await client.query(ARCHIVE_TRAINING_MEAL_QUERY);

  return buildTrainingSnapshotFromRows({
    dayRows: dayResult.rows,
    measurementRows: measurementResult.rows,
    activityRows: activityResult.rows,
    mealRows: mealResult.rows,
    sleepRows: [],
    now,
  });
}

async function readArchiveTrainingSnapshotFromDatabaseWithClients({
  createClient,
  config,
  now,
  dateFrom,
  dateTo,
}) {
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
      sleepRows: [],
      now,
      dateFrom,
      dateTo,
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
  sleepRows = [],
  bodyFeedbackRows = [],
  now,
  dateFrom,
  dateTo,
}) {
  const filteredDayRows = filterRowsByDateWindow(dayRows, 'archived_date', dateFrom, dateTo);
  const filteredMeasurementRows = filterRowsByDateWindow(measurementRows, 'archived_date', dateFrom, dateTo);
  const filteredActivityRows = filterRowsByDateWindow(activityRows, 'archived_date', dateFrom, dateTo);
  const filteredMealRows = filterRowsByDateWindow(mealRows, 'archived_date', dateFrom, dateTo);
  const filteredSleepRows = filterRowsByDateWindow(sleepRows, 'archived_date', dateFrom, dateTo);
  const filteredBodyFeedbackRows = filterFeedbackRowsByDateWindow(bodyFeedbackRows, dateFrom, dateTo);
  const measurementsByDate = groupByDate(filteredMeasurementRows, 'archived_date');
  const activitiesByDate = groupByDate(filteredActivityRows, 'archived_date');
  const mealsByDate = groupByDate(filteredMealRows, 'archived_date');
  const sleepByDate = groupByDate(filteredSleepRows, 'archived_date');
  const sleepSummaryByDate = new Map(
    filteredDayRows.map((row) => [
      normalizeDateKey(row.archived_date),
      {
        sleepTotalMinutes: toNullableNumber(row.sleep_total_minutes),
        nightSleepMinutes: toNullableNumber(row.night_sleep_minutes),
        napMinutes: toNullableNumber(row.nap_minutes),
        sleepStartTime: row.sleep_start_time ?? null,
        sleepEndTime: row.sleep_end_time ?? null,
        deepSleepMinutes: toNullableNumber(row.deep_sleep_minutes),
        lightSleepMinutes: toNullableNumber(row.light_sleep_minutes),
        remSleepMinutes: toNullableNumber(row.rem_sleep_minutes),
        awakeMinutes: toNullableNumber(row.awake_minutes),
        sleepScore: toNullableNumber(row.sleep_score),
        deepSleepRatioPct: toNullableNumber(row.deep_sleep_ratio_pct),
        lightSleepRatioPct: toNullableNumber(row.light_sleep_ratio_pct),
        remSleepRatioPct: toNullableNumber(row.rem_sleep_ratio_pct),
      },
    ]),
  );

  const daily = filteredDayRows.map((row) => {
    const archivedDate = normalizeDateKey(row.archived_date);
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
    const sleep = summarizeSleepRecords([
      ...(sleepByDate.get(archivedDate) ?? []).map(normalizeSleepRow),
      ...extractSleepRecords(row),
      sleepSummaryByDate.get(archivedDate) ?? null,
    ]);

    return {
      date: archivedDate,
      measurement: measurements.at(-1) ?? null,
      measurements,
      activities,
      sleep: sleep.records,
      sleepSummary: sleep,
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

  return {
    ...buildTrainingSnapshotFromDaily(
      daily,
      now?.toISOString?.() ?? new Date().toISOString(),
    ),
    bodyFeedback: filteredBodyFeedbackRows.map(normalizeBodyFeedbackRow),
  };
}

function filterRowsByDateWindow(rows, key, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) {
    return rows;
  }

  return rows.filter((row) => {
    const archivedDate = normalizeDateKey(row[key]);
    if (dateFrom && archivedDate < dateFrom) {
      return false;
    }
    if (dateTo && archivedDate > dateTo) {
      return false;
    }
    return true;
  });
}

function groupByDate(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = normalizeDateKey(row[key]);
    const items = map.get(value) ?? [];
    items.push(row);
    map.set(value, items);
  }
  return map;
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

function countActivitiesByType(activities) {
  const countsByType = {};
  for (const activity of activities ?? []) {
    countsByType[activity.type] = (countsByType[activity.type] ?? 0) + 1;
  }
  return countsByType;
}

function extractSleepRecords(row) {
  const sleep = {
    sleepType: '夜间睡眠',
    bedtime: row.sleep_start_time ?? null,
    wakeTime: row.sleep_end_time ?? null,
    nightSleepMinutes: toNullableNumber(row.night_sleep_minutes),
    totalSleepMinutes: toNullableNumber(row.sleep_total_minutes),
    napMinutes: toNullableNumber(row.nap_minutes),
    deepSleepMinutes: toNullableNumber(row.deep_sleep_minutes),
    lightSleepMinutes: toNullableNumber(row.light_sleep_minutes),
    remSleepMinutes: toNullableNumber(row.rem_sleep_minutes),
    awakeMinutes: toNullableNumber(row.awake_minutes),
    sleepStageText: null,
    sleepStageDetail: null,
    sleepScore: toNullableNumber(row.sleep_score),
    deepSleepRatioPct: toNullableNumber(row.deep_sleep_ratio_pct),
    lightSleepRatioPct: toNullableNumber(row.light_sleep_ratio_pct),
    remSleepRatioPct: toNullableNumber(row.rem_sleep_ratio_pct),
  };
  return hasAnySleepValue(sleep) ? [sleep] : [];
}

function normalizeSleepRow(row) {
  return {
    sleepType: row.sleep_type ?? '夜间睡眠',
    bedtime: row.bedtime ?? null,
    wakeTime: row.wake_time ?? null,
    nightSleepMinutes: toNullableNumber(row.night_sleep_minutes),
    totalSleepMinutes: toNullableNumber(row.total_sleep_minutes),
    napMinutes: toNullableNumber(row.nap_minutes),
    deepSleepMinutes: toNullableNumber(row.deep_sleep_minutes),
    lightSleepMinutes: toNullableNumber(row.light_sleep_minutes),
    remSleepMinutes: toNullableNumber(row.rem_sleep_minutes),
    awakeMinutes: toNullableNumber(row.awake_minutes),
    sleepStageText: row.sleep_stage_text ?? null,
    sleepStageDetail: row.sleep_stage_detail ?? null,
    sleepScore: toNullableNumber(row.sleep_score),
    sleepScorePercentile: toNullableNumber(row.sleep_score_percentile),
    deepSleepRatioPct: toNullableNumber(row.deep_sleep_ratio_pct),
    lightSleepRatioPct: toNullableNumber(row.light_sleep_ratio_pct),
    remSleepRatioPct: toNullableNumber(row.rem_sleep_ratio_pct),
    deepSleepContinuityScore: toNullableNumber(row.deep_sleep_continuity_score),
    wakeCount: toNullableNumber(row.wake_count),
    breathingQualityScore: toNullableNumber(row.breathing_quality_score),
    averageHeartRateBpm: toNullableNumber(row.average_heart_rate_bpm),
    hrvMs: toNullableNumber(row.hrv_ms),
    averageSpo2Pct: toNullableNumber(row.average_spo2_pct),
    averageRespiratoryRate: toNullableNumber(row.average_respiratory_rate),
    analysisText: row.analysis_text ?? null,
    suggestionText: row.suggestion_text ?? null,
  };
}

function summarizeSleepRecords(records) {
  const filtered = (records ?? []).filter(hasAnySleepValue);
  if (filtered.length === 0) {
    return {
      records: [],
      totalSleepMinutes: null,
      nightSleepMinutes: null,
      napMinutes: null,
      sleepStartTime: null,
      sleepEndTime: null,
      deepSleepMinutes: null,
      lightSleepMinutes: null,
      remSleepMinutes: null,
      awakeMinutes: null,
      sleepScore: null,
      sleepScorePercentile: null,
      deepSleepRatioPct: null,
      lightSleepRatioPct: null,
      remSleepRatioPct: null,
      deepSleepContinuityScore: null,
      wakeCount: null,
      breathingQualityScore: null,
      averageHeartRateBpm: null,
      hrvMs: null,
      averageSpo2Pct: null,
      averageRespiratoryRate: null,
      analysisText: null,
      suggestionText: null,
    };
  }

  const latest = filtered.at(-1);
  return {
    records: filtered,
    totalSleepMinutes: latest.totalSleepMinutes ?? null,
    nightSleepMinutes: latest.nightSleepMinutes ?? null,
    napMinutes: latest.napMinutes ?? null,
    sleepStartTime: latest.bedtime ?? null,
    sleepEndTime: latest.wakeTime ?? null,
    deepSleepMinutes: latest.deepSleepMinutes ?? null,
    lightSleepMinutes: latest.lightSleepMinutes ?? null,
    remSleepMinutes: latest.remSleepMinutes ?? null,
    awakeMinutes: latest.awakeMinutes ?? null,
    sleepScore: latest.sleepScore ?? null,
    sleepScorePercentile: latest.sleepScorePercentile ?? null,
    deepSleepRatioPct: latest.deepSleepRatioPct ?? null,
    lightSleepRatioPct: latest.lightSleepRatioPct ?? null,
    remSleepRatioPct: latest.remSleepRatioPct ?? null,
    deepSleepContinuityScore: latest.deepSleepContinuityScore ?? null,
    wakeCount: latest.wakeCount ?? null,
    breathingQualityScore: latest.breathingQualityScore ?? null,
    averageHeartRateBpm: latest.averageHeartRateBpm ?? null,
    hrvMs: latest.hrvMs ?? null,
    averageSpo2Pct: latest.averageSpo2Pct ?? null,
    averageRespiratoryRate: latest.averageRespiratoryRate ?? null,
    analysisText: latest.analysisText ?? null,
    suggestionText: latest.suggestionText ?? null,
  };
}

function hasAnySleepValue(sleep) {
  return [
    sleep?.totalSleepMinutes,
    sleep?.nightSleepMinutes,
    sleep?.napMinutes,
    sleep?.bedtime,
    sleep?.wakeTime,
    sleep?.deepSleepMinutes,
    sleep?.lightSleepMinutes,
    sleep?.remSleepMinutes,
    sleep?.awakeMinutes,
    sleep?.sleepStageText,
    sleep?.sleepStageDetail,
    sleep?.sleepScore,
    sleep?.sleepScorePercentile,
    sleep?.deepSleepRatioPct,
    sleep?.lightSleepRatioPct,
    sleep?.remSleepRatioPct,
    sleep?.deepSleepContinuityScore,
    sleep?.wakeCount,
    sleep?.breathingQualityScore,
    sleep?.averageHeartRateBpm,
    sleep?.hrvMs,
    sleep?.averageSpo2Pct,
    sleep?.averageRespiratoryRate,
    sleep?.analysisText,
    sleep?.suggestionText,
  ].some((value) => value !== null && value !== undefined && value !== '');
}

function filterFeedbackRowsByDateWindow(rows, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) {
    return rows;
  }

  return rows.filter((row) => {
    const archivedDate = normalizeBodyFeedbackRow(row).date;
    if (dateFrom && archivedDate < dateFrom) {
      return false;
    }
    if (dateTo && archivedDate > dateTo) {
      return false;
    }
    return true;
  });
}

function normalizeBodyFeedbackRow(row) {
  const dateParts = normalizeBodyFeedbackDateParts(row.message_date_unix, row.updated_at);
  return {
    date: dateParts.date,
    time: dateParts.time,
    body: String(row.body ?? '').trim(),
    telegramMessageId: toNullableNumber(row.telegram_message_id),
    telegramChatId: toNullableNumber(row.telegram_chat_id),
    markdownPath: row.markdown_path ?? null,
    source: 'database',
  };
}

function normalizeBodyFeedbackDateParts(messageDateUnix, updatedAt) {
  const fromUnix = toNullableNumber(messageDateUnix);
  if (fromUnix !== null) {
    return formatDatePartsInShanghai(new Date(fromUnix * 1000));
  }

  const fallback = new Date(updatedAt ?? '');
  if (!Number.isNaN(fallback.getTime())) {
    return formatDatePartsInShanghai(fallback);
  }

  return {
    date: '',
    time: null,
  };
}

function formatDatePartsInShanghai(date) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
