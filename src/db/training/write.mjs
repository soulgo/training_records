import { createHash } from 'node:crypto';

import pg from 'pg';
import { parseTrainingRecord } from '../../domain/training/training-parser.mjs';
import {
  buildTrainingDay,
  emptyNutrition,
  emptySleep,
  normalizeActivityTime,
  normalizeActivityType,
  parseDurationSeconds,
} from '../../domain/training/training-domain.mjs';
import { resolveTrainingCoreConfig } from './config.mjs';
import {
  readArchiveTrainingSnapshotFromDatabaseClient,
  readTrainingSnapshotFromDatabaseClient,
} from './read.mjs';
import {
  getThoughtModuleTags,
  isThoughtBatchKind,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
} from '../../../tools/lib/thought-modules.mjs';
import {
  insertArchiveSleep,
  insertCoreActivities,
  insertCoreMeals,
  insertCoreMeasurements,
  insertCoreSleep,
} from './core-row-writer.mjs';
import { persistTelegramImageBatchIncremental } from './incremental-write.mjs';

const { Client } = pg;
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
      if (isTelegramImageBatch(batch)) {
        await persistTelegramImageBatchIncremental(client, batch, payloadHash, processedAt);
      } else {
        const existingDay = await readCoreDay(client, batch.archivedDate);
        const mergedDay = mergeBatchIntoDay(existingDay, batch);
        await replaceCoreDay(client, mergedDay, batch.batchId, processedAt, {
          sourceHash: payloadHash,
        });
      }
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
    return await persistTrainingSnapshotToCoreClient(client, {
      snapshot: options.snapshot,
      batchId: options.batchId,
      processedAt,
      sourceChannel: options.sourceChannel ?? 'markdown_import',
      skipIfUnchanged: options.skipIfUnchanged ?? false,
    });
  } catch (error) {
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
    return await backfillCoreFromLatestArchiveSnapshotClient(client, {
      processedAt,
      batchId: options.batchId,
      sourceChannel: options.sourceChannel ?? 'archive_backfill',
    });
  } catch (error) {
    throw error;
  } finally {
    await client.end();
  }
}

export async function backfillCoreSleepFromIngestBatches(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
      batchesBackfilled: 0,
      daysBackfilled: [],
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

  try {
    await client.connect();
    return await backfillCoreSleepFromIngestBatchesClient(client, {
      processedAt: options.processedAt,
      sourceChannel: options.sourceChannel ?? 'ingest_sleep_backfill',
    });
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
    skipIfUnchanged: options.skipIfUnchanged ?? true,
  });
}

export async function backfillCoreSleepFromIngestBatchesClient(client, options = {}) {
  const processedAt = options.processedAt ?? new Date();
  const ingestCandidateResult = await client.query(`
    select
      b.batch_id,
      b.batch_payload_json
    from ingest.telegram_batch b
    where b.status = 'ready'
      and b.archived_date is not null
      and b.batch_payload_json->'sleep' is not null
      and not exists (
        select 1
        from core.sleep s
        where s.archived_date = b.archived_date
      )
    order by b.processed_at asc, b.batch_id asc
  `);
  const archiveCandidateResult = await client.query(`
    select
      a.archived_date,
      jsonb_build_object(
        'status', 'ready',
        'archivedDate', a.archived_date,
        'sleep', jsonb_build_object(
          'records', jsonb_agg(
            jsonb_build_object(
              'sleepType', coalesce(a.sleep_type, '夜间睡眠'),
              'bedtime', a.bedtime,
              'wakeTime', a.wake_time,
              'nightSleepMinutes', a.night_sleep_minutes,
              'totalSleepMinutes', a.total_sleep_minutes,
              'napMinutes', a.nap_minutes,
              'deepSleepMinutes', a.deep_sleep_minutes,
              'lightSleepMinutes', a.light_sleep_minutes,
              'remSleepMinutes', a.rem_sleep_minutes,
              'awakeMinutes', a.awake_minutes,
              'sleepStageText', a.sleep_stage_text,
              'sleepStageDetail', a.sleep_stage_detail,
              'sleepScore', a.sleep_score,
              'sleepScorePercentile', a.sleep_score_percentile,
              'deepSleepRatioPct', a.deep_sleep_ratio_pct,
              'lightSleepRatioPct', a.light_sleep_ratio_pct,
              'remSleepRatioPct', a.rem_sleep_ratio_pct,
              'deepSleepContinuityScore', a.deep_sleep_continuity_score,
              'wakeCount', a.wake_count,
              'breathingQualityScore', a.breathing_quality_score,
              'averageHeartRateBpm', a.average_heart_rate_bpm,
              'hrvMs', a.hrv_ms,
              'averageSpo2Pct', a.average_spo2_pct,
              'averageRespiratoryRate', a.average_respiratory_rate,
              'analysisText', a.analysis_text,
              'suggestionText', a.suggestion_text
            )
            order by a.bedtime asc nulls last
          ),
          'totalSleepMinutes', max(a.total_sleep_minutes),
          'nightSleepMinutes', max(a.night_sleep_minutes),
          'napMinutes', max(a.nap_minutes),
          'sleepStartTime', max(a.bedtime),
          'sleepEndTime', max(a.wake_time),
          'deepSleepMinutes', max(a.deep_sleep_minutes),
          'lightSleepMinutes', max(a.light_sleep_minutes),
          'remSleepMinutes', max(a.rem_sleep_minutes),
          'awakeMinutes', max(a.awake_minutes),
          'sleepScore', max(a.sleep_score),
          'sleepScorePercentile', max(a.sleep_score_percentile),
          'deepSleepRatioPct', max(a.deep_sleep_ratio_pct),
          'lightSleepRatioPct', max(a.light_sleep_ratio_pct),
          'remSleepRatioPct', max(a.rem_sleep_ratio_pct),
          'deepSleepContinuityScore', max(a.deep_sleep_continuity_score),
          'wakeCount', max(a.wake_count),
          'breathingQualityScore', max(a.breathing_quality_score),
          'averageHeartRateBpm', max(a.average_heart_rate_bpm),
          'hrvMs', max(a.hrv_ms),
          'averageSpo2Pct', max(a.average_spo2_pct),
          'averageRespiratoryRate', max(a.average_respiratory_rate),
          'analysisText', max(a.analysis_text),
          'suggestionText', max(a.suggestion_text)
        )
      ) as batch_payload_json
    from archive.training_sleep a
    where not exists (
      select 1
      from core.sleep s
      where s.archived_date = a.archived_date
    )
    group by a.archived_date
    order by a.archived_date asc
  `);
  const candidates = [
    ...ingestCandidateResult.rows.map((row) => ({
      batchId: row.batch_id,
      batch: row.batch_payload_json,
    })),
    ...archiveCandidateResult.rows.map((row) => ({
      batchId: `archive-sleep-${row.archived_date}`,
      batch: row.batch_payload_json,
    })),
  ].filter(({ batch }) =>
    batch?.status === 'ready' &&
    batch?.archivedDate &&
    hasSleepPayload(batch.sleep),
  );

  if (candidates.length === 0) {
    return {
      status: 'unchanged',
      batchesBackfilled: 0,
      daysBackfilled: [],
    };
  }

  const daysBackfilled = new Set();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    for (const { batchId, batch } of candidates) {
      const existingDay = await readCoreDay(client, batch.archivedDate);
      const mergedDay = mergeBatchIntoDay(existingDay, batch);
      await replaceCoreDay(
        client,
        mergedDay,
        batch.batchId ?? batchId,
        processedAt,
        {
          sourceChannel: options.sourceChannel ?? 'ingest_sleep_backfill',
          writeArchiveSleep: false,
        },
      );
      daysBackfilled.add(batch.archivedDate);
    }
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

  return {
    status: 'stored',
    batchesBackfilled: candidates.length,
    daysBackfilled: [...daysBackfilled].sort(),
  };
}

export async function backfillCoreFromLatestArchiveSnapshotClient(client, options = {}) {
  const processedAt = options.processedAt ?? new Date();
  const missingTrainingDayResult = await client.query(`
    select a.archived_date
    from archive.training_day a
    left join core.training_day c on c.archived_date = a.archived_date
    where c.archived_date is null
    order by a.archived_date asc
  `);
  const missingSleepResult = await client.query(`
    select a.archived_date
    from archive.training_sleep a
    left join core.sleep c on c.archived_date = a.archived_date
    where c.archived_date is null
    group by a.archived_date
    order by a.archived_date asc
  `);

  const missingDates = [
    ...missingTrainingDayResult.rows,
    ...missingSleepResult.rows,
  ]
    .map((row) => normalizeDateKey(row.archived_date))
    .filter(Boolean);

  if (missingDates.length === 0) {
    const archiveDayResult = await client.query(`
      select archived_date
      from archive.training_day
      limit 1
    `);
    const archiveSleepResult = await client.query(`
      select archived_date
      from archive.training_sleep
      limit 1
    `);
    if (archiveDayResult.rows.length === 0 && archiveSleepResult.rows.length === 0) {
      return {
        status: 'skipped',
        reason: 'missing_archive_days',
        daysBackfilled: 0,
      };
    }
    return {
      status: 'unchanged',
      reason: 'no_missing_days',
      daysBackfilled: 0,
    };
  }

  const snapshot = await readArchiveTrainingSnapshotFromDatabaseClient(client, processedAt);
  const missingDateSet = new Set(missingDates);
  const missingDays = (snapshot.daily ?? []).filter((day) => day?.date && missingDateSet.has(day.date));
  if (missingDays.length === 0) {
    return {
      status: 'skipped',
      reason: 'missing_archive_days',
      daysBackfilled: 0,
    };
  }

  await replaceCoreDays(client, missingDays, {
    batchId: options.batchId,
    batchIdPrefix: 'archive-backfill',
    processedAt,
    sourceChannel: options.sourceChannel ?? 'archive_backfill',
  });

  return {
    status: 'stored',
    daysBackfilled: missingDays.length,
  };
}

export async function persistTrainingSnapshotToCoreClient(client, options) {
  const snapshot = options.snapshot ?? { daily: [] };
  const days = (snapshot.daily ?? []).map((day) => ({ ...day, date: day.date })).filter((day) => day.date);
  if (days.length === 0) {
    return {
      status: 'skipped',
      reason: 'missing_snapshot_days',
      days: 0,
    };
  }

  if (options.skipIfUnchanged) {
    const coreDays = await readCoreDays(client, days.map((day) => day.date));
    if (snapshotDaysEqual(days, coreDays)) {
      return {
        status: 'unchanged',
        reason: 'core_matches_markdown',
        days: days.length,
      };
    }
  }

  await replaceCoreDays(client, days, {
    batchId: options.batchId,
    batchIdPrefix: 'markdown-import',
    processedAt: options.processedAt ?? new Date(),
    sourceChannel: options.sourceChannel ?? 'markdown_import',
  });

  return {
    status: 'stored',
    days: days.length,
  };
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
  return persistThoughtToCore(client, thought);
}

export async function persistThoughtToCore(client, thought) {
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
  if (!dayResult.rows.length) {
    return null;
  }

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
      where archived_date = $1
      order by bedtime asc nulls last
    `,
    [archivedDate],
  );
  const dayRow = dayResult.rows[0];

  return buildTrainingDay({
    date: archivedDate,
    measurements: measurementResult.rows.map((measurement) => ({
      archivedDate,
      measuredAt: measurement.measured_at,
      bodyScore: measurement.body_score ?? null,
      weightKg: measurement.weight_kg ?? null,
      bmi: measurement.bmi ?? null,
      bodyFatPct: measurement.body_fat_pct ?? null,
      skeletalMuscleKg: measurement.skeletal_muscle_kg ?? null,
      visceralFatLevel: measurement.visceral_fat_level ?? null,
      basalMetabolismKcal: measurement.basal_metabolism_kcal ?? null,
      bodyWaterPct: measurement.body_water_pct ?? null,
      proteinPct: measurement.protein_pct ?? null,
      boneMassKg: measurement.bone_mass_kg ?? null,
      fatFreeMassKg: measurement.fat_free_mass_kg ?? null,
      bodyAge: measurement.body_age ?? null,
      bodyType: measurement.body_type ?? null,
    })),
    activities: activityResult.rows.map((activity) => ({
      time: activity.activity_time,
      type: normalizeActivityType(activity.activity_type),
      rawType: activity.raw_type ?? activity.activity_type,
      detail: activity.detail,
      durationText: activity.duration_text,
      durationSeconds: activity.duration_seconds ?? 0,
      calories: activity.calories ?? null,
      heartRate: activity.heart_rate ?? null,
      distanceKm: activity.distance_km ?? null,
      avgSpeedKmh: activity.avg_speed_kmh ?? null,
    })),
    nutrition: {
      meals: mealResult.rows.map((meal) => ({
        name: meal.meal_name,
        calories: meal.calories ?? null,
        recommendedMin: meal.recommended_min ?? null,
        recommendedMax: meal.recommended_max ?? null,
      })),
      totalCalories: dayRow.intake_calories ?? null,
      details: Array.isArray(dayRow.nutrition_details_json) ? dayRow.nutrition_details_json : [],
    },
    sleep: {
      records: sleepResult.rows.map((sleep) => ({
        sleepType: sleep.sleep_type ?? '夜间睡眠',
        bedtime: sleep.bedtime ?? null,
        wakeTime: sleep.wake_time ?? null,
        nightSleepMinutes: sleep.night_sleep_minutes ?? null,
        totalSleepMinutes: sleep.total_sleep_minutes ?? null,
        napMinutes: sleep.nap_minutes ?? null,
        deepSleepMinutes: sleep.deep_sleep_minutes ?? null,
        lightSleepMinutes: sleep.light_sleep_minutes ?? null,
        remSleepMinutes: sleep.rem_sleep_minutes ?? null,
        awakeMinutes: sleep.awake_minutes ?? null,
        sleepStageText: sleep.sleep_stage_text ?? null,
        sleepStageDetail: sleep.sleep_stage_detail ?? null,
        sleepScore: sleep.sleep_score ?? null,
        sleepScorePercentile: sleep.sleep_score_percentile ?? null,
        deepSleepRatioPct: sleep.deep_sleep_ratio_pct ?? null,
        lightSleepRatioPct: sleep.light_sleep_ratio_pct ?? null,
        remSleepRatioPct: sleep.rem_sleep_ratio_pct ?? null,
        deepSleepContinuityScore: sleep.deep_sleep_continuity_score ?? null,
        wakeCount: sleep.wake_count ?? null,
        breathingQualityScore: sleep.breathing_quality_score ?? null,
        averageHeartRateBpm: sleep.average_heart_rate_bpm ?? null,
        hrvMs: sleep.hrv_ms ?? null,
        averageSpo2Pct: sleep.average_spo2_pct ?? null,
        averageRespiratoryRate: sleep.average_respiratory_rate ?? null,
        analysisText: sleep.analysis_text ?? null,
        suggestionText: sleep.suggestion_text ?? null,
      })),
    },
    workoutDailySummary: {
      activityCaloriesKcal: dayRow.training_calories,
      workoutDurationMinutes: dayRow.workout_duration_minutes,
      activeHours: dayRow.active_hours,
    },
  });
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
  const nextSleep = hasSleepPayload(batch.sleep)
    ? {
        records: batch.sleep.records?.length
          ? batch.sleep.records
          : [{
              sleepType: batch.sleep.sleepType ?? '夜间睡眠',
              bedtime: batch.sleep.bedtime ?? batch.sleep.sleepStartTime ?? null,
              wakeTime: batch.sleep.wakeTime ?? batch.sleep.sleepEndTime ?? null,
              nightSleepMinutes: batch.sleep.nightSleepMinutes ?? null,
              totalSleepMinutes: batch.sleep.totalSleepMinutes ?? null,
              napMinutes: batch.sleep.napMinutes ?? null,
              deepSleepMinutes: batch.sleep.deepSleepMinutes ?? null,
              lightSleepMinutes: batch.sleep.lightSleepMinutes ?? null,
              remSleepMinutes: batch.sleep.remSleepMinutes ?? null,
              awakeMinutes: batch.sleep.awakeMinutes ?? null,
              sleepStageText: batch.sleep.sleepStageText ?? null,
              sleepStageDetail: batch.sleep.sleepStageDetail ?? null,
              ...pickSleepHealthFields(batch.sleep),
            }],
        totalSleepMinutes: batch.sleep.totalSleepMinutes ?? null,
        nightSleepMinutes: batch.sleep.nightSleepMinutes ?? null,
        napMinutes: batch.sleep.napMinutes ?? null,
        sleepStartTime: batch.sleep.bedtime ?? batch.sleep.sleepStartTime ?? null,
        sleepEndTime: batch.sleep.wakeTime ?? batch.sleep.sleepEndTime ?? null,
        deepSleepMinutes: batch.sleep.deepSleepMinutes ?? null,
        lightSleepMinutes: batch.sleep.lightSleepMinutes ?? null,
        remSleepMinutes: batch.sleep.remSleepMinutes ?? null,
        awakeMinutes: batch.sleep.awakeMinutes ?? null,
        ...pickSleepHealthFields(batch.sleep),
      }
    : existingSleepPayload(existing);

  return buildTrainingDay({
    date: batch.archivedDate,
    measurements: nextMeasurements,
    activities: nextActivities,
    nutrition: nextNutrition,
    sleep: nextSleep,
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
  options = {},
) {
  await writeCoreDays(client, [day], {
    batchId,
    processedAt,
    sourceChannel: options.sourceChannel ?? 'telegram',
    sourceHash: options.sourceHash ?? null,
    writeArchiveSleep: options.writeArchiveSleep,
  });
}

async function replaceCoreDays(client, days, options) {
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

async function writeCoreDays(client, days, options) {
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

  const dayRows = normalizedDays.map((day) => ({
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
    nutritionDetailsJson: JSON.stringify(day.nutrition?.details ?? []),
    updatedAt: processedAtIso,
  }));

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
      select *
      from unnest($1::date[],
        $2::text[],
        $3::text[],
        $4::integer[],
        $5::integer[],
        $6::numeric[],
        $7::integer[],
        $8::integer[],
        $9::numeric[],
        $10::integer[],
        $11::jsonb[],
        $12::timestamptz[]
      )
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
      dayRows.map((row) => row.archivedDate),
      dayRows.map((row) => row.sourceBatchId),
      dayRows.map((row) => row.sourceChannel),
      dayRows.map((row) => row.totalActivities),
      dayRows.map((row) => row.totalDurationSeconds),
      dayRows.map((row) => row.trainingCalories),
      dayRows.map((row) => row.workoutDurationMinutes),
      dayRows.map((row) => row.activeHours),
      dayRows.map((row) => row.cyclingDistanceKm),
      dayRows.map((row) => row.intakeCalories),
      dayRows.map((row) => row.nutritionDetailsJson),
      dayRows.map((row) => row.updatedAt),
    ],
  );

  await insertCoreMeasurements(client, normalizedDays, options, processedAtIso);
  await insertCoreActivities(client, normalizedDays, options, processedAtIso);
  await insertCoreMeals(client, normalizedDays, options, processedAtIso);
  await insertCoreSleep(client, normalizedDays, options, processedAtIso);
  if (sourceHash) {
    await insertArchiveSleep(client, normalizedDays, { ...options, sourceHash }, processedAtIso);
  }
}

async function upsertArchiveParseSnapshot(client, { sourceHash, days, processedAtIso }) {
  const payload = {
    generatedAt: processedAtIso,
    daily: days,
    latest: { daily: days.at(-1) ?? null },
  };
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
      JSON.stringify(payload),
      days.length,
      days.at(-1)?.date ?? null,
      processedAtIso,
      processedAtIso,
      processedAtIso,
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

function existingSleepPayload(existing) {
  const records = Array.isArray(existing.sleep)
    ? existing.sleep
    : existing.sleep?.records ?? existing.sleepSummary?.records ?? [];
  if (records.length > 0) {
    return {
      ...(existing.sleepSummary ?? emptySleep()),
      records,
    };
  }
  return existing.sleepSummary ?? existing.sleep ?? emptySleep();
}

function pickSleepHealthFields(sleep) {
  return Object.fromEntries(SLEEP_HEALTH_FIELDS.map((field) => [field, sleep?.[field] ?? null]));
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

async function readCoreDays(client, dates) {
  const normalizedDates = [...new Set(dates.map((date) => normalizeDateKey(date)).filter(Boolean))];
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

function snapshotDaysEqual(expectedDays, actualDays) {
  return stableStringify(expectedDays.map(normalizeDayForComparison).sort(compareDaysByDate)) ===
    stableStringify(actualDays.map(normalizeDayForComparison).sort(compareDaysByDate));
}

function normalizeDayForComparison(day) {
  const measurements = (Array.isArray(day.measurements) && day.measurements.length > 0
    ? day.measurements
    : day.measurement
      ? [day.measurement]
      : []
  ).map(normalizeMeasurementForComparison);
  const measurement = measurements.at(-1) ?? null;
  return {
    date: normalizeDateKey(day.date),
    measurement,
    measurements,
    activities: (day.activities ?? []).map(normalizeActivityForComparison),
    workoutSummary: {
      totalActivities: normalizeNumber(day.workoutSummary?.totalActivities, 0),
      totalDurationSeconds: normalizeNumber(day.workoutSummary?.totalDurationSeconds, 0),
      trainingCalories: normalizeNumber(day.workoutSummary?.trainingCalories, 0),
      workoutDurationMinutes: normalizeNumber(day.workoutSummary?.workoutDurationMinutes, null),
      activeHours: normalizeNumber(day.workoutSummary?.activeHours, null),
      cyclingDistanceKm: normalizeNumber(day.workoutSummary?.cyclingDistanceKm, 0),
    },
    nutrition: {
      meals: (day.nutrition?.meals ?? []).map(normalizeMealForComparison),
      totalCalories: normalizeNumber(day.nutrition?.totalCalories, null),
      details: day.nutrition?.details ?? [],
    },
  };
}

function normalizeMeasurementForComparison(measurement) {
  return {
    archivedDate: normalizeDateKey(measurement.archivedDate),
    measuredAt: measurement.measuredAt ?? null,
    bodyScore: normalizeNumber(measurement.bodyScore, null),
    weightKg: normalizeNumber(measurement.weightKg, null),
    bmi: normalizeNumber(measurement.bmi, null),
    bodyFatPct: normalizeNumber(measurement.bodyFatPct, null),
    skeletalMuscleKg: normalizeNumber(measurement.skeletalMuscleKg, null),
    visceralFatLevel: normalizeNumber(measurement.visceralFatLevel, null),
    basalMetabolismKcal: normalizeNumber(measurement.basalMetabolismKcal, null),
    bodyWaterPct: normalizeNumber(measurement.bodyWaterPct, null),
    proteinPct: normalizeNumber(measurement.proteinPct, null),
    boneMassKg: normalizeNumber(measurement.boneMassKg, null),
    fatFreeMassKg: normalizeNumber(measurement.fatFreeMassKg, null),
    bodyAge: normalizeNumber(measurement.bodyAge, null),
    bodyType: measurement.bodyType ?? null,
  };
}

function normalizeActivityForComparison(activity) {
  return {
    time: activity.time ?? null,
    type: activity.type ?? '未知活动',
    rawType: activity.rawType ?? activity.type ?? null,
    detail: activity.detail ?? null,
    calories: normalizeNumber(activity.calories, null),
    heartRate: normalizeNumber(activity.heartRate, null),
    distanceKm: normalizeNumber(activity.distanceKm, null),
    avgSpeedKmh: normalizeNumber(activity.avgSpeedKmh, null),
    durationText: activity.durationText ?? null,
    durationSeconds: normalizeNumber(activity.durationSeconds, null),
  };
}

function normalizeMealForComparison(meal) {
  return {
    name: meal.name ?? '未命名餐次',
    calories: normalizeNumber(meal.calories, null),
    recommendedMin: normalizeNumber(meal.recommendedMin, null),
    recommendedMax: normalizeNumber(meal.recommendedMax, null),
  };
}

function compareDaysByDate(left, right) {
  return left.date.localeCompare(right.date);
}

function stableStringify(value) {
  return JSON.stringify(value);
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

function isTelegramImageBatch(batch) {
  return (batch?.kind ?? 'image') === 'image';
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeBigIntValue(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
