import { createHash } from 'node:crypto';

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
  PostgresTelegramBatchRepository,
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

    const telegramBatchRepository = new PostgresTelegramBatchRepository(client);
    await telegramBatchRepository.upsertBatch(batch, payloadHash, processedAt);
    await telegramBatchRepository.upsertMessages(batch, processedAt);
    await telegramBatchRepository.upsertRecognitions(batch, processedAt);

    if (isThoughtBatchKind(batch.kind) && batch.status === 'ready') {
      await new PostgresThoughtRepository(client).persistMirror(batch, processedAt);
    } else if (isTelegramImageBatch(batch) && batch.status === 'ready' && batch.archivedDate) {
      await persistTelegramImageBatchIncremental(client, batch, processedAt);
    } else if (batch.kind !== 'thought' && batch.status === 'ready' && batch.archivedDate) {
      const existingDay = await readCoreDay(client, batch.archivedDate);
      const mergedDay = mergeBatchIntoDay(existingDay, batch);
      await replaceCoreDay(client, mergedDay, batch.batchId, processedAt, {
        sourceHash: payloadHash,
        writeArchiveSleep: isTelegramImageBatch(batch) ? false : undefined,
      });
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

