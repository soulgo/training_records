import { createHash } from 'node:crypto';

import pg from 'pg';

import {
  buildTrainingDay,
  buildTrainingSnapshotFromDaily,
  emptyNutrition,
  normalizeActivityTime,
  normalizeActivityType,
  parseDurationSeconds,
  toNullableNumber,
} from './training-domain.mjs';
import { parseTrainingRecord } from './training-parser.mjs';

const { Client } = pg;

export function resolveTrainingCoreConfig(env = process.env) {
  const enabled = String(env.TRAINING_DB_ENABLED ?? 'false').toLowerCase() === 'true';

  return {
    enabled,
    url: env.TRAINING_DB_URL?.trim() || '',
    timeoutMs: parsePositiveInteger(env.TRAINING_DB_TIMEOUT_MS, 3000),
    appName: env.TRAINING_DB_APP_NAME?.trim() || 'training-records-dashboard',
  };
}

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

  const client = createClient(config);

  try {
    await client.connect();
    return await readTrainingSnapshotFromDatabaseClient(client, options.now);
  } finally {
    await client.end();
  }
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

export async function persistNormalizedBatch(options) {
  const config = resolveTrainingCoreConfig(options.env);
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

  const batch = options.batch;
  const payloadHash = createHash('sha256').update(JSON.stringify(batch), 'utf8').digest('hex');
  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));
  const client = createClient(config);
  const processedAt = options.processedAt ?? new Date();
  let transactionStarted = false;

  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const existingBatchResult = await client.query(
      `
        select payload_hash
        from ingest.telegram_batch
        where batch_id = $1
      `,
      [batch.batchId],
    );
    const existingPayloadHash = existingBatchResult.rows[0]?.payload_hash ?? null;
    if (existingPayloadHash === payloadHash) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return {
        status: 'unchanged',
        batchId: batch.batchId,
      };
    }

    await upsertIngestBatch(client, batch, payloadHash, processedAt);
    await upsertIngestMessages(client, batch, processedAt);
    await upsertIngestRecognitions(client, batch, processedAt);

    if (batch.kind !== 'thought' && batch.status === 'ready' && batch.archivedDate) {
      const existingDay = await readCoreDay(client, batch.archivedDate);
      const mergedDay = mergeBatchIntoDay(existingDay, batch);
      await replaceCoreDay(client, mergedDay, batch.batchId, processedAt);
    }

    await client.query('COMMIT');
    transactionStarted = false;

    return {
      status: 'stored',
      batchId: batch.batchId,
      archivedDate: batch.archivedDate ?? null,
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

export async function persistTrainingSnapshotToCore(options) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
    };
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
  const processedAt = options.processedAt ?? new Date();

  try {
    await client.connect();
    await client.query('BEGIN');

    for (const day of options.snapshot.daily ?? []) {
      await replaceCoreDay(
        client,
        {
          ...day,
          date: day.date,
        },
        options.batchId ?? `markdown-import-${day.date}`,
        processedAt,
        options.sourceChannel ?? 'markdown_import',
      );
    }

    await client.query('COMMIT');
    return {
      status: 'stored',
      days: options.snapshot.daily?.length ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

export async function backfillCoreFromLatestArchiveSnapshot(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
      daysBackfilled: 0,
    };
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
  const processedAt = options.processedAt ?? new Date();

  try {
    await client.connect();
    const snapshot = await readArchiveTrainingSnapshotFromDatabaseClient(client, processedAt);
    if ((snapshot.daily?.length ?? 0) === 0) {
      return {
        status: 'skipped',
        reason: 'missing_archive_days',
        daysBackfilled: 0,
      };
    }

    const coreDayResult = await client.query(`
      select archived_date
      from core.training_day
    `);
    const existingDates = new Set(
      coreDayResult.rows.map((row) => String(row.archived_date)).filter(Boolean),
    );
    const missingDays = (snapshot.daily ?? []).filter((day) => day?.date && !existingDates.has(day.date));

    if (missingDays.length === 0) {
      return {
        status: 'unchanged',
        reason: 'no_missing_days',
        daysBackfilled: 0,
      };
    }

    await client.query('BEGIN');

    for (const day of missingDays) {
      await replaceCoreDay(
        client,
        {
          ...day,
          date: day.date,
        },
        options.batchId ?? `archive-backfill-${day.date}`,
        processedAt,
        options.sourceChannel ?? 'archive_backfill',
      );
    }

    await client.query('COMMIT');

    return {
      status: 'stored',
      daysBackfilled: missingDays.length,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

export async function importTrainingMarkdownToDatabase(options) {
  const snapshot = parseTrainingRecord(options.markdown);
  return persistTrainingSnapshotToCore({
    snapshot,
    env: options.env,
    createClient: options.createClient,
    processedAt: options.processedAt,
    sourceChannel: 'markdown_import',
  });
}

export function exportTrainingMarkdown(snapshot) {
  const lines = ['# 训练记录', ''];

  for (const day of snapshot.daily ?? []) {
    lines.push(`### ${day.date}`);
    lines.push('');

    if (day.measurement) {
      lines.push('#### 当日体脂秤截图记录');
      lines.push('');
      lines.push(`- 测量时间：${day.measurement.measuredAt ?? day.date}`);
      appendMetric(lines, '身体得分', day.measurement.bodyScore, '分');
      appendMetric(lines, '体重', day.measurement.weightKg, ' kg');
      appendMetric(lines, 'BMI', day.measurement.bmi);
      appendMetric(lines, '体脂率', day.measurement.bodyFatPct, '%');
      appendMetric(lines, '骨骼肌量', day.measurement.skeletalMuscleKg, ' kg');
      appendMetric(lines, '内脏脂肪等级', day.measurement.visceralFatLevel);
      appendMetric(lines, '基础代谢率', day.measurement.basalMetabolismKcal, ' kcal/日');
      appendMetric(lines, '水分率', day.measurement.bodyWaterPct, '%');
      appendMetric(lines, '蛋白质', day.measurement.proteinPct, '%');
      appendMetric(lines, '骨盐量', day.measurement.boneMassKg, ' kg');
      appendMetric(lines, '去脂体重', day.measurement.fatFreeMassKg, ' kg');
      appendMetric(lines, '身体年龄', day.measurement.bodyAge, '岁');
      if (day.measurement.bodyType) {
        lines.push(`- 身体类型：${day.measurement.bodyType}`);
      }
      lines.push('');
    }

    if ((day.activities?.length ?? 0) > 0 || day.workoutSummary) {
      lines.push('#### 当日运动截图记录');
      lines.push('');
      if (
        day.workoutSummary?.trainingCalories !== null ||
        day.workoutSummary?.workoutDurationMinutes !== null ||
        day.workoutSummary?.activeHours !== null
      ) {
        lines.push('##### 当日活动总览');
        lines.push('');
        appendMetric(lines, '活动热量', day.workoutSummary.trainingCalories, '千卡');
        appendMetric(lines, '锻炼时长', day.workoutSummary.workoutDurationMinutes, '分钟');
        appendMetric(lines, '活动小时数', day.workoutSummary.activeHours, '小时');
        lines.push('');
      }

      if ((day.activities?.length ?? 0) > 0) {
        lines.push('##### 活动明细');
        lines.push('');
        for (const activity of day.activities) {
          lines.push(`- ${activity.time} ${activity.type}：${activity.detail}`);
        }
        lines.push('');
      }
    }

    if ((day.nutrition?.meals?.length ?? 0) > 0 || day.nutrition?.totalCalories !== null) {
      lines.push(`#### ${day.date} 饮食截图记录`);
      lines.push('');
      lines.push('##### 餐次汇总');
      lines.push('');
      for (const meal of day.nutrition.meals ?? []) {
        lines.push(
          `- ${meal.name}：${meal.calories}千卡，建议范围${meal.recommendedMin}–${meal.recommendedMax}千卡`,
        );
      }
      if (day.nutrition.totalCalories !== null) {
        lines.push(`- 当日截图内已记录总热量：${day.nutrition.totalCalories}千卡`);
      }

      if ((day.nutrition.details?.length ?? 0) > 0) {
        lines.push('');
        lines.push('##### 餐次明细');
        lines.push('');
        for (const detail of day.nutrition.details) {
          lines.push(`- ${detail}`);
        }
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

async function readTrainingSnapshotFromDatabaseClient(client, now) {
  const dayResult = await client.query(`
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
      from core.measurement
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
      from core.activity
      order by archived_date asc, activity_time asc nulls last
    `);
  const mealResult = await client.query(`
      select
        archived_date,
        meal_name,
        calories,
        recommended_min,
        recommended_max
      from core.meal
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

async function readArchiveTrainingSnapshotFromDatabaseClient(client, now) {
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

async function upsertIngestBatch(client, batch, payloadHash, processedAt) {
  await client.query(
    `
      insert into ingest.telegram_batch (
        batch_id,
        status,
        archived_date,
        reason,
        confidence,
        warnings_json,
        issues_json,
        update_ids_json,
        payload_hash,
        batch_payload_json,
        processed_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, $12)
      on conflict (batch_id) do update set
        status = excluded.status,
        archived_date = excluded.archived_date,
        reason = excluded.reason,
        confidence = excluded.confidence,
        warnings_json = excluded.warnings_json,
        issues_json = excluded.issues_json,
        update_ids_json = excluded.update_ids_json,
        payload_hash = excluded.payload_hash,
        batch_payload_json = excluded.batch_payload_json,
        processed_at = excluded.processed_at,
        updated_at = excluded.updated_at
    `,
    [
      batch.batchId,
      batch.status,
      batch.archivedDate ?? null,
      batch.reason ?? null,
      batch.confidence ?? null,
      JSON.stringify(batch.warnings ?? []),
      JSON.stringify(batch.issues ?? []),
      JSON.stringify(batch.updateIds ?? []),
      payloadHash,
      JSON.stringify(batch),
      processedAt.toISOString(),
      processedAt.toISOString(),
    ],
  );
}

async function upsertIngestMessages(client, batch, processedAt) {
  for (const message of batch.messages ?? []) {
    await client.query(
      `
        insert into ingest.telegram_message (
          message_id,
          batch_id,
          update_id,
          media_group_id,
          chat_id,
          caption,
          text,
          date_unix,
          photo_file_ids_json,
          photo_file_unique_ids_json,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
        on conflict (message_id) do update set
          batch_id = excluded.batch_id,
          update_id = excluded.update_id,
          media_group_id = excluded.media_group_id,
          chat_id = excluded.chat_id,
          caption = excluded.caption,
          text = excluded.text,
          date_unix = excluded.date_unix,
          photo_file_ids_json = excluded.photo_file_ids_json,
          photo_file_unique_ids_json = excluded.photo_file_unique_ids_json,
          updated_at = excluded.updated_at
      `,
      [
        message.messageId,
        batch.batchId,
        message.updateId,
        message.mediaGroupId ?? null,
        message.chatId ?? null,
        message.caption ?? '',
        message.text ?? '',
        message.dateUnix ?? null,
        JSON.stringify((message.photos ?? []).map((photo) => photo.fileId)),
        JSON.stringify((message.photos ?? []).map((photo) => photo.fileUniqueId)),
        processedAt.toISOString(),
      ],
    );
  }
}

async function upsertIngestRecognitions(client, batch, processedAt) {
  for (const recognition of batch.recognitions ?? []) {
    await client.query(
      `
        insert into ingest.telegram_recognition (
          message_id,
          batch_id,
          recognition_json,
          updated_at
        )
        values ($1, $2, $3::jsonb, $4)
        on conflict (message_id) do update set
          batch_id = excluded.batch_id,
          recognition_json = excluded.recognition_json,
          updated_at = excluded.updated_at
      `,
      [
        recognition.messageId,
        batch.batchId,
        JSON.stringify(recognition),
        processedAt.toISOString(),
      ],
    );
  }
}

async function readCoreDay(client, archivedDate) {
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
        nutrition_details_json
      from core.training_day
      where archived_date = $1
    `,
    [archivedDate],
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
      where archived_date = $1
      order by measured_at asc nulls last
    `,
    [archivedDate],
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
      where archived_date = $1
      order by activity_time asc nulls last
    `,
    [archivedDate],
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
      where archived_date = $1
      order by meal_name asc
    `,
    [archivedDate],
  );

  if (!dayResult.rows.length) {
    return null;
  }

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
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
    new Date(),
  );

  return snapshot.daily[0] ?? null;
}

function mergeBatchIntoDay(existingDay, batch) {
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

  const nextMeasurements = batch.measurement
    ? [{ archivedDate: batch.archivedDate, ...batch.measurement }]
    : existing.measurements ?? [];
  const nextActivities = batch.activities?.length
    ? batch.activities.map((activity) => normalizeBatchActivity(activity))
    : existing.activities ?? [];
  const nextNutrition = hasNutritionPayload(batch.nutrition)
    ? {
        meals: batch.nutrition.meals ?? [],
        totalCalories: batch.nutrition.totalCalories ?? null,
        details: batch.nutrition.details ?? [],
      }
    : existing.nutrition ?? emptyNutrition();

  return buildTrainingDay({
    date: batch.archivedDate,
    measurements: nextMeasurements,
    activities: nextActivities,
    nutrition: nextNutrition,
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

async function replaceCoreDay(
  client,
  day,
  batchId,
  processedAt,
  sourceChannel = 'telegram',
) {
  await client.query(`delete from core.measurement where archived_date = $1`, [day.date]);
  await client.query(`delete from core.activity where archived_date = $1`, [day.date]);
  await client.query(`delete from core.meal where archived_date = $1`, [day.date]);
  await client.query(`delete from core.training_day where archived_date = $1`, [day.date]);

  await client.query(
    `
      insert into core.training_day (
        archived_date,
        source_channel,
        source_batch_id,
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
        source_channel = excluded.source_channel,
        source_batch_id = excluded.source_batch_id,
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
      day.date,
      sourceChannel,
      batchId,
      day.workoutSummary.totalActivities,
      day.workoutSummary.totalDurationSeconds,
      day.workoutSummary.trainingCalories,
      day.workoutSummary.workoutDurationMinutes,
      day.workoutSummary.activeHours,
      day.workoutSummary.cyclingDistanceKm,
      day.nutrition.totalCalories,
      JSON.stringify(day.nutrition.details ?? []),
      processedAt.toISOString(),
    ],
  );

  if (day.measurement) {
    const measurementKey = createHash('md5')
      .update([day.date, day.measurement.measuredAt ?? '', day.measurement.weightKg ?? ''].join('|'))
      .digest('hex');
    await client.query(
      `
        insert into core.measurement (
          measurement_key,
          archived_date,
          source_channel,
          source_batch_id,
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
          body_type,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      `,
      [
        measurementKey,
        day.date,
        sourceChannel,
        batchId,
        day.measurement.measuredAt ?? null,
        day.measurement.bodyScore ?? null,
        day.measurement.weightKg ?? null,
        day.measurement.bmi ?? null,
        day.measurement.bodyFatPct ?? null,
        day.measurement.skeletalMuscleKg ?? null,
        day.measurement.visceralFatLevel ?? null,
        day.measurement.basalMetabolismKcal ?? null,
        day.measurement.bodyWaterPct ?? null,
        day.measurement.proteinPct ?? null,
        day.measurement.boneMassKg ?? null,
        day.measurement.fatFreeMassKg ?? null,
        day.measurement.bodyAge ?? null,
        day.measurement.bodyType ?? null,
        processedAt.toISOString(),
      ],
    );
  }

  for (const activity of day.activities ?? []) {
    const activityKey = createHash('md5')
      .update([day.date, activity.time ?? '', activity.type ?? '', activity.detail ?? ''].join('|'))
      .digest('hex');
    await client.query(
      `
        insert into core.activity (
          activity_key,
          archived_date,
          source_channel,
          source_batch_id,
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
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `,
      [
        activityKey,
        day.date,
        sourceChannel,
        batchId,
        activity.time ?? null,
        activity.type ?? '未知活动',
        activity.rawType ?? activity.type ?? null,
        activity.detail ?? null,
        activity.calories ?? null,
        activity.heartRate ?? null,
        activity.distanceKm ?? null,
        activity.avgSpeedKmh ?? null,
        activity.durationText ?? null,
        activity.durationSeconds ?? null,
        processedAt.toISOString(),
      ],
    );
  }

  for (const meal of day.nutrition.meals ?? []) {
    const mealKey = createHash('md5')
      .update([day.date, meal.name ?? '', meal.calories ?? ''].join('|'))
      .digest('hex');
    await client.query(
      `
        insert into core.meal (
          meal_key,
          archived_date,
          source_channel,
          source_batch_id,
          meal_name,
          calories,
          recommended_min,
          recommended_max,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        mealKey,
        day.date,
        sourceChannel,
        batchId,
        meal.name ?? '未命名餐次',
        meal.calories ?? null,
        meal.recommendedMin ?? null,
        meal.recommendedMax ?? null,
        processedAt.toISOString(),
      ],
    );
  }
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

function extractNumber(value, regex) {
  const match = value?.match(regex);
  return match ? Number(match[1]) : null;
}

function hasNutritionPayload(nutrition) {
  return (
    (nutrition?.meals?.length ?? 0) > 0 ||
    nutrition?.totalCalories !== null ||
    (nutrition?.details?.length ?? 0) > 0
  );
}

function countActivitiesByType(activities) {
  const countsByType = {};
  for (const activity of activities ?? []) {
    countsByType[activity.type] = (countsByType[activity.type] ?? 0) + 1;
  }
  return countsByType;
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

function appendMetric(lines, label, value, suffix = '') {
  if (value === null || value === undefined || value === '') {
    return;
  }
  lines.push(`- ${label}：${value}${suffix}`);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
