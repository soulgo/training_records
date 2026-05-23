import { createHash } from 'node:crypto';

import pg from 'pg';
import { parseTrainingRecord } from './training-parser.mjs';
import {
  buildTrainingDay,
  emptyNutrition,
  normalizeActivityTime,
  normalizeActivityType,
  parseDurationSeconds,
} from './training-domain.mjs';
import { resolveTrainingCoreConfig } from './training-db-config.mjs';
import {
  readArchiveTrainingSnapshotFromDatabase,
  readTrainingSnapshotFromDatabaseClient,
} from './training-db-read.mjs';
import {
  getThoughtModuleTags,
  isThoughtBatchKind,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
} from './lib/thought-modules.mjs';

const { Client } = pg;

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

    if (isThoughtBatchKind(batch.kind) && batch.status === 'ready') {
      await persistThoughtMirror(client, batch, processedAt);
    } else if (batch.kind !== 'thought' && batch.status === 'ready' && batch.archivedDate) {
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
    const snapshot = await readArchiveTrainingSnapshotFromDatabase({
      env: options.env,
      createClient: options.createClient,
      now: processedAt,
    });
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

async function persistThoughtMirror(client, batch, processedAt) {
  if (getThoughtStorageWriteStatus(batch) === 'not_found') {
    return;
  }

  if (batch.kind === 'thought') {
    await upsertThoughtMirror(client, {
      messageId: batch.thought?.telegramMessageId,
      chatId: batch.thought?.telegramChatId,
      sourceBatchId: batch.batchId,
      command: batch.thought?.command ?? '/thought',
      body: batch.thought?.body ?? '',
      thoughtModule: normalizeThoughtModule(batch.thought?.thoughtModule),
      tags: batch.thought?.tags ?? getThoughtModuleTags(batch.thought?.thoughtModule),
      messageDateUnix: batch.thought?.messageDateUnix ?? null,
      markdownPath: batch.thought?.storage?.markdownPath ?? null,
      imageRefs: batch.thought?.storage?.photoPaths ?? [],
      status: 'active',
      processedAt,
    });
    return;
  }

  if (batch.kind === 'thought_edit') {
    await upsertThoughtMirror(client, {
      messageId: batch.thoughtEdit?.targetMessageId,
      chatId: batch.thoughtEdit?.telegramChatId,
      sourceBatchId: batch.batchId,
      command: batch.thoughtEdit?.command ?? '/thought',
      body: batch.thoughtEdit?.body ?? '',
      thoughtModule: normalizeThoughtModuleOrNull(batch.thoughtEdit?.thoughtModule),
      tags: batch.thoughtEdit?.tags ?? null,
      messageDateUnix: batch.thoughtEdit?.messageDateUnix ?? null,
      markdownPath: batch.thoughtEdit?.storage?.markdownPath ?? null,
      imageRefs: batch.thoughtEdit?.storage?.photoPaths ?? null,
      status: 'active',
      processedAt,
    });
    return;
  }

  if (batch.kind === 'thought_delete') {
    await markThoughtMirrorDeleted(client, {
      messageId: batch.thoughtDelete?.targetMessageId,
      chatId: batch.thoughtDelete?.telegramChatId,
      sourceBatchId: batch.batchId,
      command: batch.thoughtDelete?.command ?? '/随想删',
      thoughtModule: normalizeThoughtModuleOrNull(batch.thoughtDelete?.thoughtModule),
      tags: batch.thoughtDelete?.tags ?? null,
      messageDateUnix: batch.thoughtDelete?.messageDateUnix ?? null,
      markdownPath: batch.thoughtDelete?.storage?.markdownPath ?? null,
      deletedImageRefs: batch.thoughtDelete?.storage?.deletedPhotoPaths ?? [],
      processedAt,
    });
    return;
  }

  if (batch.kind === 'thought_move') {
    await upsertThoughtMirror(client, {
      messageId: batch.thoughtMove?.targetMessageId,
      chatId: batch.thoughtMove?.telegramChatId,
      sourceBatchId: batch.batchId,
      command: batch.thoughtMove?.command ?? '/移动',
      body: '',
      thoughtModule: normalizeThoughtModuleOrNull(batch.thoughtMove?.thoughtModule),
      tags: batch.thoughtMove?.tags ?? null,
      messageDateUnix: batch.thoughtMove?.messageDateUnix ?? null,
      markdownPath: batch.thoughtMove?.storage?.markdownPath ?? null,
      imageRefs: batch.thoughtMove?.storage?.photoPaths ?? null,
      status: 'active',
      processedAt,
    });
  }
}

function getThoughtStorageWriteStatus(batch) {
  if (batch.kind === 'thought') {
    return batch.thought?.storage?.writeStatus ?? null;
  }
  if (batch.kind === 'thought_edit') {
    return batch.thoughtEdit?.storage?.writeStatus ?? null;
  }
  if (batch.kind === 'thought_delete') {
    return batch.thoughtDelete?.storage?.writeStatus ?? null;
  }
  if (batch.kind === 'thought_move') {
    return batch.thoughtMove?.storage?.writeStatus ?? null;
  }
  return null;
}

async function upsertThoughtMirror(client, thought) {
  const messageId = normalizePositiveInteger(thought.messageId);
  if (!messageId) {
    return;
  }

  await client.query(
    `
      insert into core.thought (
        telegram_message_id,
        telegram_chat_id,
        source_batch_id,
        command,
        body,
        thought_module,
        tags_json,
        message_date_unix,
        markdown_path,
        image_refs_json,
        status,
        deleted_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, coalesce($10::jsonb, '[]'::jsonb), $11, null, $12)
      on conflict (telegram_message_id) do update set
        telegram_chat_id = coalesce(excluded.telegram_chat_id, core.thought.telegram_chat_id),
        source_batch_id = excluded.source_batch_id,
        command = excluded.command,
        body = excluded.body,
        thought_module = coalesce(excluded.thought_module, core.thought.thought_module),
        tags_json = excluded.tags_json,
        message_date_unix = coalesce(excluded.message_date_unix, core.thought.message_date_unix),
        markdown_path = coalesce(excluded.markdown_path, core.thought.markdown_path),
        image_refs_json = case
          when $10::jsonb is null then core.thought.image_refs_json
          else excluded.image_refs_json
        end,
        status = excluded.status,
        deleted_at = null,
        updated_at = excluded.updated_at
    `,
    [
      messageId,
      normalizeBigIntValue(thought.chatId),
      thought.sourceBatchId ?? null,
      thought.command ?? '/thought',
      String(thought.body ?? '').trim(),
      normalizeThoughtModuleOrNull(thought.thoughtModule) ?? 'workout',
      JSON.stringify(thought.tags ?? getThoughtModuleTags(thought.thoughtModule)),
      normalizeBigIntValue(thought.messageDateUnix),
      thought.markdownPath ?? null,
      Array.isArray(thought.imageRefs) ? JSON.stringify(thought.imageRefs) : null,
      thought.status ?? 'active',
      thought.processedAt.toISOString(),
    ],
  );
}

async function markThoughtMirrorDeleted(client, thought) {
  const messageId = normalizePositiveInteger(thought.messageId);
  if (!messageId) {
    return;
  }

  const imageRefs = Array.isArray(thought.deletedImageRefs)
    ? JSON.stringify(thought.deletedImageRefs)
    : JSON.stringify([]);
  await client.query(
    `
      insert into core.thought (
        telegram_message_id,
        telegram_chat_id,
        source_batch_id,
        command,
        body,
        thought_module,
        tags_json,
        message_date_unix,
        markdown_path,
        image_refs_json,
        status,
        deleted_at,
        updated_at
      )
      values ($1, $2, $3, $4, '', coalesce($5, 'workout'), coalesce($6::jsonb, '["训练","随想","Telegram"]'::jsonb), $7, $8, $9::jsonb, 'deleted', $10, $11)
      on conflict (telegram_message_id) do update set
        telegram_chat_id = coalesce(excluded.telegram_chat_id, core.thought.telegram_chat_id),
        source_batch_id = excluded.source_batch_id,
        command = excluded.command,
        thought_module = coalesce(excluded.thought_module, core.thought.thought_module),
        markdown_path = coalesce(excluded.markdown_path, core.thought.markdown_path),
        image_refs_json = excluded.image_refs_json,
        status = excluded.status,
        deleted_at = excluded.deleted_at,
        updated_at = excluded.updated_at
    `,
    [
      messageId,
      normalizeBigIntValue(thought.chatId),
      thought.sourceBatchId ?? null,
      thought.command ?? '/随想删',
      normalizeThoughtModuleOrNull(thought.thoughtModule),
      thought.tags ? JSON.stringify(thought.tags) : null,
      normalizeBigIntValue(thought.messageDateUnix),
      thought.markdownPath ?? null,
      imageRefs,
      thought.processedAt.toISOString(),
      thought.processedAt.toISOString(),
    ],
  );
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

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeBigIntValue(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
