import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';
import { parseTrainingRecord } from '../../domain/training/training-parser.mjs';
import { mergeBatchIntoDay } from '../../core/services/training-merge-service.mjs';
import { resolveTrainingCoreConfig } from './config.mjs';
import { readArchiveTrainingSnapshotFromDatabaseClient } from './read.mjs';
import {
  isThoughtBatchKind,
} from '../../core/thought-modules.mjs';
import {
  persistThoughtToCore as persistThoughtToCoreViaRepository,
  PostgresSourceBatchRepository,
  PostgresThoughtRepository,
  readCoreDay,
  readCoreDays,
  replaceCoreDay,
  replaceCoreDays,
} from '../../adapters/postgres/index.mjs';
import { persistTelegramImageBatchIncremental } from '../../adapters/postgres/incremental-write.pg.mjs';

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
const DEFAULT_DB_SLOW_QUERY_MS = 1000;
const EMPTY_ROW_COUNTS = {
  ingestBatch: 0,
  ingestMessage: 0,
  ingestRecognition: 0,
  ingestExtractedRecord: 0,
  aiCallLog: 0,
  coreTrainingDay: 0,
  coreMeasurement: 0,
  coreActivity: 0,
  coreMeal: 0,
  coreSleep: 0,
  coreThought: 0,
};

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
  const sourceChannel = options.sourceChannel ?? batch.sourceChannel ?? 'telegram';
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
  const transactionId = createTransactionId();
  const rowCounts = { ...EMPTY_ROW_COUNTS };
  const slowQueries = [];
  const dbTimingsMs = { connect: 0, begin: 0, query: 0, commit: 0, aiCallLog: 0 };
  const startedAt = nowMs();
  const slowQueryThresholdMs = parseNonNegativeInteger(
    options.env?.TRAINING_DB_SLOW_QUERY_MS,
    DEFAULT_DB_SLOW_QUERY_MS,
  );
  const observedClient = createObservedClient(client, {
    rowCounts,
    slowQueries,
    thresholdMs: slowQueryThresholdMs,
    dbTimingsMs,
  });

  try {
    const connectStartedAt = nowMs();
    await client.connect();
    dbTimingsMs.connect = elapsedMs(connectStartedAt);
    const beginStartedAt = nowMs();
    await observedClient.query('BEGIN');
    dbTimingsMs.begin = elapsedMs(beginStartedAt);
    transactionStarted = true;

    const sourceBatchRepository = new PostgresSourceBatchRepository(observedClient);
    const batchUpsertResult = await sourceBatchRepository.upsertBatch(batch, payloadHash, processedAt);
    if (batchUpsertResult?.rowCount === 0) {
      await observedClient.query('ROLLBACK');
      transactionStarted = false;
      return withPersistenceSummary({
        status: 'unchanged',
        batchId: batch.batchId,
        reason: 'payload_hash_unchanged',
      }, {
        transactionId,
        sourceChannel,
        rowCounts,
        durationMs: elapsedMs(startedAt),
        slowQueries,
        dbTimingsMs,
        pendingStatus: null,
        rollbackStatus: 'not_needed',
      });
    }

    await sourceBatchRepository.upsertMessages(batch, processedAt);
    await sourceBatchRepository.upsertAssets(batch, processedAt);
    await sourceBatchRepository.upsertRecognitions(batch, processedAt);
    await sourceBatchRepository.upsertExtractedRecords(batch, processedAt);

    let thoughtMirrorResult = null;
    if (isThoughtBatchKind(batch.kind) && batch.status === 'ready') {
      thoughtMirrorResult = await new PostgresThoughtRepository(observedClient).persistMirror(batch, processedAt);
    } else if (isTelegramImageBatch(batch) && batch.status === 'ready' && batch.archivedDate) {
      await persistTelegramImageBatchIncremental(observedClient, batch, processedAt, { sourceChannel });
    } else if (batch.kind !== 'image' && batch.kind !== 'thought' && batch.status === 'ready' && batch.archivedDate) {
      const existingDay = await readCoreDay(observedClient, batch.archivedDate);
      const mergedDay = mergeBatchIntoDay(existingDay, batch);
      await replaceCoreDay(observedClient, mergedDay, batch.batchId, processedAt, {
        sourceHash: payloadHash,
        writeArchiveSleep: isTelegramImageBatch(batch) ? false : undefined,
      });
    }

    const commitStartedAt = nowMs();
    await observedClient.query('COMMIT');
    dbTimingsMs.commit = elapsedMs(commitStartedAt);
    transactionStarted = false;

    try {
      const aiCallLogStartedAt = nowMs();
      await sourceBatchRepository.upsertRecognitionAiCallLogs(batch, processedAt);
      dbTimingsMs.aiCallLog = elapsedMs(aiCallLogStartedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[training-db] failed to write recognition AI call log for ${batch.batchId}: ${message}\n`,
      );
    }

    if (thoughtMirrorResult?.status === 'not_found') {
      return withPersistenceSummary({
        status: 'not_found',
        batchId: batch.batchId,
        messageId: thoughtMirrorResult.messageId ?? null,
        archivedDate: batch.archivedDate ?? null,
      }, {
        transactionId,
        sourceChannel,
        rowCounts,
        durationMs: elapsedMs(startedAt),
        slowQueries,
        dbTimingsMs,
        pendingStatus: null,
        rollbackStatus: null,
      });
    }

    return withPersistenceSummary({
      status: 'stored',
      batchId: batch.batchId,
      ...(thoughtMirrorResult
        ? {
            messageId: thoughtMirrorResult.messageId ?? null,
            thoughtModule: thoughtMirrorResult.thoughtModule ?? null,
          }
        : {}),
      archivedDate: batch.archivedDate ?? null,
    }, {
      transactionId,
      sourceChannel,
      rowCounts,
      durationMs: elapsedMs(startedAt),
      slowQueries,
      dbTimingsMs,
      pendingStatus: null,
      rollbackStatus: null,
    });
  } catch (error) {
    let rollbackStatus = transactionStarted ? 'not_attempted' : 'not_started';
    if (transactionStarted) {
      try {
        await observedClient.query('ROLLBACK');
        rollbackStatus = 'succeeded';
      } catch (rollbackError) {
        rollbackStatus = 'failed';
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        process.stderr.write(
          `[training-db] rollback failed after persistNormalizedBatch error for ${batch.batchId}: ${message}\n`,
        );
      }
    }
    attachPersistenceResult(error, {
      status: 'failed',
      batchId: batch.batchId,
      transactionId,
      sourceChannel,
      rowCounts,
      durationMs: elapsedMs(startedAt),
      slowQueries,
      dbTimingsMs,
      pendingStatus: null,
      rollbackStatus,
    });
    throw error;
  } finally {
    await client.end();
  }
}

function createTransactionId() {
  return `dbtx_${randomBytes(8).toString('hex')}`;
}

function createObservedClient(client, { rowCounts, slowQueries, thresholdMs, dbTimingsMs }) {
  let queryOrdinal = 0;
  return {
    async query(sql, params) {
      queryOrdinal += 1;
      const startedAt = nowMs();
      try {
        const result = await client.query(sql, params);
        observeQuery({ sql, result, startedAt, rowCounts, slowQueries, thresholdMs, queryOrdinal, dbTimingsMs });
        return result;
      } catch (error) {
        observeQuery({ sql, result: null, startedAt, rowCounts, slowQueries, thresholdMs, queryOrdinal, dbTimingsMs });
        throw error;
      }
    },
  };
}

function observeQuery({ sql, result, startedAt, rowCounts, slowQueries, thresholdMs, queryOrdinal, dbTimingsMs }) {
  const durationMs = elapsedMs(startedAt);
  const target = classifyDatabaseQuery(sql);
  const normalizedSql = String(sql ?? '').trim().toUpperCase();
  if (!['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalizedSql)
      && target.operation !== 'persist.ai_call_log') {
    dbTimingsMs.query += durationMs;
  }
  if (target.rowCountKey && Number.isFinite(result?.rowCount)) {
    rowCounts[target.rowCountKey] = (rowCounts[target.rowCountKey] ?? 0) + Math.max(0, Math.round(result.rowCount));
  }
  if (durationMs >= thresholdMs) {
    slowQueries.push({
      queryOrdinal,
      operation: target.operation,
      table: target.table,
      durationMs,
      thresholdMs,
    });
  }
}

function classifyDatabaseQuery(sql) {
  const normalized = String(sql ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();
  if (/ingest\.source_batch/u.test(normalized)) {
    return { operation: 'persist.batch', table: 'ingest.source_batch', rowCountKey: 'ingestBatch' };
  }
  if (/ingest\.source_message/u.test(normalized)) {
    return { operation: 'persist.message', table: 'ingest.source_message', rowCountKey: 'ingestMessage' };
  }
  if (/ingest\.source_asset/u.test(normalized)) {
    return { operation: 'persist.asset', table: 'ingest.source_asset', rowCountKey: null };
  }
  if (/ingest\.recognition_run/u.test(normalized)) {
    return { operation: 'persist.recognition', table: 'ingest.recognition_run', rowCountKey: 'ingestRecognition' };
  }
  if (/ingest\.extracted_record/u.test(normalized)) {
    return { operation: 'persist.extracted_record', table: 'ingest.extracted_record', rowCountKey: 'ingestExtractedRecord' };
  }
  if (/ingest\.ai_call_log/u.test(normalized)) {
    return { operation: 'persist.ai_call_log', table: 'ingest.ai_call_log', rowCountKey: 'aiCallLog' };
  }
  if (/core\.training_day/u.test(normalized)) {
    return { operation: 'persist.core_training_day', table: 'core.training_day', rowCountKey: 'coreTrainingDay' };
  }
  if (/core\.measurement/u.test(normalized)) {
    return { operation: 'persist.core_measurement', table: 'core.measurement', rowCountKey: 'coreMeasurement' };
  }
  if (/core\.activity/u.test(normalized)) {
    return { operation: 'persist.core_activity', table: 'core.activity', rowCountKey: 'coreActivity' };
  }
  if (/core\.meal/u.test(normalized)) {
    return { operation: 'persist.core_meal', table: 'core.meal', rowCountKey: 'coreMeal' };
  }
  if (/core\.sleep/u.test(normalized)) {
    return { operation: 'persist.core_sleep', table: 'core.sleep', rowCountKey: 'coreSleep' };
  }
  if (/core\.thought/u.test(normalized)) {
    return { operation: 'persist.core_thought', table: 'core.thought', rowCountKey: 'coreThought' };
  }
  return { operation: 'database.query', table: 'unknown', rowCountKey: null };
}

function withPersistenceSummary(result, summary) {
  const persistenceResult = compactObject({
    status: result.status,
    batchId: result.batchId,
    archivedDate: result.archivedDate,
    reason: result.reason,
    transactionId: summary.transactionId,
    sourceChannel: summary.sourceChannel,
    rowCounts: { ...summary.rowCounts },
    durationMs: summary.durationMs,
    slowQueries: [...summary.slowQueries],
    dbTimingsMs: { ...summary.dbTimingsMs },
    pendingStatus: summary.pendingStatus,
    rollbackStatus: summary.rollbackStatus,
  });
  return {
    ...result,
    transactionId: summary.transactionId,
    sourceChannel: summary.sourceChannel,
    rowCounts: { ...summary.rowCounts },
    durationMs: summary.durationMs,
    slowQueries: [...summary.slowQueries],
    dbTimingsMs: { ...summary.dbTimingsMs },
    persistenceResult,
  };
}

function attachPersistenceResult(error, summary) {
  if (!error || typeof error !== 'object') {
    return;
  }
  Object.defineProperty(error, 'persistenceResult', {
    configurable: true,
    enumerable: false,
    value: {
      status: summary.status,
      batchId: summary.batchId,
      transactionId: summary.transactionId,
      sourceChannel: summary.sourceChannel,
      rowCounts: { ...summary.rowCounts },
      durationMs: summary.durationMs,
      slowQueries: [...summary.slowQueries],
      dbTimingsMs: { ...summary.dbTimingsMs },
      pendingStatus: summary.pendingStatus,
      rollbackStatus: summary.rollbackStatus,
    },
  });
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

function nowMs() {
  return Number(globalThis.performance?.now?.() ?? Date.now());
}

export async function persistTrainingSnapshotToCore(options) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
    };
  }

  if (!hasValidSnapshotDays(options.snapshot)) {
    return {
      status: 'skipped',
      reason: 'missing_snapshot_days',
      days: 0,
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
  const hasTargetArchivedDates = Object.hasOwn(options, 'targetArchivedDates');
  const targetArchivedDates = normalizeTargetArchivedDates(options.targetArchivedDates);
  if (hasTargetArchivedDates && targetArchivedDates.length === 0) {
    return {
      status: 'unchanged',
      batchesBackfilled: 0,
      daysBackfilled: [],
    };
  }
  const targetDateFilter = targetArchivedDates.length > 0 ? '      and b.archived_date = any($1::date[])\n' : '';
  const targetArchiveDateFilter = targetArchivedDates.length > 0 ? '      and a.archived_date = any($1::date[])\n' : '';
  const targetDateParams = targetArchivedDates.length > 0 ? [targetArchivedDates] : undefined;

  const ingestCandidateResult = await client.query(`
    select
      b.batch_id,
      b.payload_json as batch_payload_json
    from ingest.source_batch b
    where b.status = 'ready'
      and b.archived_date is not null
      and b.payload_json->'sleep' is not null
${targetDateFilter}
    order by b.processed_at asc, b.batch_id asc
  `, targetDateParams);
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
${targetArchiveDateFilter}
    group by a.archived_date
    order by a.archived_date asc
  `, targetDateParams);
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

function normalizeTargetArchivedDates(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map((value) => normalizeDateKey(value)).filter(isValidDateKey))].sort();
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
  const days = (snapshot.daily ?? [])
    .map((day) => ({ ...day, date: normalizeDateKey(day.date) }))
    .filter((day) => isValidDateKey(day.date));
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

export async function persistThoughtToCore(client, thought) {
  return persistThoughtToCoreViaRepository(client, thought);
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
    sleep: (day.sleep ?? [])
      .map(normalizeSleepForComparison)
      .sort(compareSleepForComparison),
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

function normalizeSleepForComparison(sleep) {
  return {
    sleepType: sleep.sleepType ?? '夜间睡眠',
    bedtime: sleep.bedtime ?? sleep.sleepStartTime ?? null,
    wakeTime: sleep.wakeTime ?? sleep.sleepEndTime ?? null,
    nightSleepMinutes: normalizeNumber(sleep.nightSleepMinutes, null),
    totalSleepMinutes: normalizeNumber(sleep.totalSleepMinutes, null),
    napMinutes: normalizeNumber(sleep.napMinutes, null),
    deepSleepMinutes: normalizeNumber(sleep.deepSleepMinutes, null),
    lightSleepMinutes: normalizeNumber(sleep.lightSleepMinutes, null),
    remSleepMinutes: normalizeNumber(sleep.remSleepMinutes, null),
    awakeMinutes: normalizeNumber(sleep.awakeMinutes, null),
    sleepStageText: sleep.sleepStageText ?? null,
    sleepStageDetail: normalizeSleepStageDetailForComparison(sleep.sleepStageDetail),
    ...Object.fromEntries(
      SLEEP_HEALTH_FIELDS.map((field) => [
        field,
        typeof sleep[field] === 'number' || sleep[field] === null || sleep[field] === undefined || sleep[field] === ''
          ? normalizeNumber(sleep[field], null)
          : sleep[field],
      ]),
    ),
  };
}

function compareSleepForComparison(left, right) {
  return [
    left.bedtime ?? '',
    left.wakeTime ?? '',
    left.sleepType ?? '',
    String(left.totalSleepMinutes ?? ''),
  ].join('|').localeCompare([
    right.bedtime ?? '',
    right.wakeTime ?? '',
    right.sleepType ?? '',
    String(right.totalSleepMinutes ?? ''),
  ].join('|'));
}

function normalizeSleepStageDetailForComparison(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || value === undefined || value === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
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

function isValidDateKey(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

function hasValidSnapshotDays(snapshot) {
  return (snapshot?.daily ?? []).some((day) => isValidDateKey(normalizeDateKey(day?.date)));
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
  if ((batch?.kind ?? 'image') !== 'image') {
    return false;
  }
  if (batch?.kind !== 'image') {
    return true;
  }
  return (batch?.messages ?? []).some((message) => (message?.photos ?? []).length > 0);
}

