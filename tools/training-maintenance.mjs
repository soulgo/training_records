import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { exportDerivedTrainingMarkdown as exportDerivedTrainingMarkdownDefault } from './export-training-markdown.mjs';
import { syncTrainingCore as syncTrainingCoreDefault } from './sync-training-core.mjs';
import {
  readPendingRecognitionSummary as readPendingBatchesDefault,
  resolveTrainingCoreConfig,
} from './training-db-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..');
const { Client } = pg;
const migrationPlan = ['sync committed archive, ingest repairs, and thoughts into core tables'];
const pendingDatabaseThresholds = {
  p2OldestAgeMinutes: 30,
  p1OldestAgeMinutes: 24 * 60,
  p1Count: 10,
  p1AttemptCount: 25,
};
const pendingDatabaseP1Reasons = new Set([
  'pending_count_gt_10',
  'pending_oldest_gt_24h',
  'pending_attempt_count_gte_25',
]);
const aiMonitoringWindowMinutes = 60;
const aiMonitoringThresholds = {
  fallbackRate: 0.3,
  schemaFailureCountPerHour: 2,
};

export async function runTrainingMaintenance(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const command = argv[0] ?? 'inspect';
  const flags = new Set(argv.slice(1));
  const rootDir = options.rootDir ?? defaultRootDir;
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const syncTrainingCore = options.syncTrainingCore ?? syncTrainingCoreDefault;
  const readPendingBatches = options.readPendingBatches ?? readPendingBatchesDefault;
  const readBatchAudit = options.readBatchAudit ?? readTrainingBatchAudit;
  const exportDerivedTrainingMarkdown =
    options.exportDerivedTrainingMarkdown ?? exportDerivedTrainingMarkdownDefault;

  let payload;
  if (command === 'inspect') {
    payload = await inspectMaintenanceState({
      rootDir,
      env,
      readPendingBatches,
      readBatchAudit,
      batchId: resolveValueFlag(argv.slice(1), '--batch-id'),
      createClient: options.createClient,
      now: options.now,
    });
  } else if (command === 'sync') {
    payload = await runSyncMaintenance({ rootDir, env, stderr, flags, syncTrainingCore });
  } else if (command === 'export') {
    payload = await runExportMaintenance({
      rootDir,
      env,
      stderr,
      target: argv[1],
      exportDerivedTrainingMarkdown,
    });
  } else if (command === 'migrate') {
    payload = await runMigrateMaintenance({
      rootDir,
      env,
      stderr,
      flags,
      syncTrainingCore,
    });
  } else {
    payload = {
      status: 'failed',
      mode: command,
      error: `unknown maintenance command: ${command}`,
      commands: ['inspect', 'sync', 'export', 'migrate'],
    };
  }

  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

async function inspectMaintenanceState({ rootDir, env, readPendingBatches, readBatchAudit, batchId, createClient, now }) {
  const runtimeDir = path.join(rootDir, 'runtime');
  const archiveFailures = await readNdjsonSummary(
    path.join(runtimeDir, 'training-archive-failures.ndjson'),
  );
  const pendingDatabase = await readPendingDatabaseSummary({
    env,
    readPendingBatches,
    createClient,
    now,
  });
  const aiMonitoring = await readAiMonitoringSummary({ env, createClient, now });
  const batchAudit = batchId
    ? await readBatchAuditSummary({ env, batchId, readBatchAudit, createClient })
    : null;

  const data = {
    pendingDatabaseCount: pendingDatabase.count,
    pendingDatabaseStatus: pendingDatabase.status,
    pendingDatabaseError: pendingDatabase.error,
    pendingDatabaseOldestAt: pendingDatabase.oldestAt,
    pendingDatabaseOldestAgeMinutes: pendingDatabase.oldestAgeMinutes,
    pendingDatabaseMaxAttemptCount: pendingDatabase.maxAttemptCount,
    pendingDatabaseAlertLevel: pendingDatabase.alertLevel,
    pendingDatabaseAlertReasons: pendingDatabase.alertReasons,
    pendingDatabaseThresholds: pendingDatabase.thresholds,
    aiMonitoringStatus: aiMonitoring.status,
    aiMonitoringError: aiMonitoring.error,
    aiMonitoringWindowMinutes: aiMonitoring.windowMinutes,
    aiMonitoringTotalCalls: aiMonitoring.totalCalls,
    aiMonitoringRecognitionCalls: aiMonitoring.recognitionCalls,
    aiMonitoringAnalysisCalls: aiMonitoring.analysisCalls,
    aiMonitoringFallbackCalls: aiMonitoring.fallbackCalls,
    aiMonitoringFallbackRate: aiMonitoring.fallbackRate,
    aiMonitoringSchemaFailureCount: aiMonitoring.schemaFailureCount,
    aiMonitoringFailedCalls: aiMonitoring.failedCalls,
    aiMonitoringAvgRecognitionLatencyMs: aiMonitoring.avgRecognitionLatencyMs,
    aiMonitoringMaxRecognitionLatencyMs: aiMonitoring.maxRecognitionLatencyMs,
    aiMonitoringTotalTokens: aiMonitoring.totalTokens,
    aiMonitoringTotalCostUsd: aiMonitoring.totalCostUsd,
    aiMonitoringSources: aiMonitoring.sources,
    aiMonitoringAlertReasons: aiMonitoring.alertReasons,
    aiMonitoringThresholds: aiMonitoring.thresholds,
    archiveFailureCount: archiveFailures.validCount,
    archiveFailureInvalidLines: archiveFailures.invalidLines,
    database: {
      enabled: normalizeBooleanFlag(env.TRAINING_DB_ENABLED),
      hasUrl: Boolean(String(env.TRAINING_DB_URL ?? '').trim()),
    },
  };
  if (batchAudit) {
    data.batchAudit = batchAudit;
  }

  return {
    status: 'ok',
    mode: 'inspect',
    readonly: true,
    data,
  };
}

async function readPendingDatabaseSummary({ env, readPendingBatches, createClient, now }) {
  try {
    const pending = await readPendingBatches({ env, limit: 1000, createClient });
    const metrics = summarizePendingDatabaseRows(pending, now ?? new Date());
    return {
      status: 'ok',
      count: pending.length,
      error: null,
      ...metrics,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      count: 0,
      error: error instanceof Error ? error.message : String(error),
      oldestAt: null,
      oldestAgeMinutes: null,
      maxAttemptCount: 0,
      alertLevel: 'none',
      alertReasons: [],
      thresholds: pendingDatabaseThresholds,
    };
  }
}

async function readAiMonitoringSummary({ env, createClient, now }) {
  const config = resolveTrainingCoreConfig(env);
  if (!config.enabled || !config.url) {
    return emptyAiMonitoringSummary({ status: 'ok' });
  }

  const client = createMaintenanceClient(config, createClient);
  const windowEnd = now ?? new Date();
  const windowStart = new Date(windowEnd.getTime() - aiMonitoringWindowMinutes * 60 * 1000);

  try {
    await client.connect();
    const [callLogResult, recognitionResult] = await Promise.all([
      client.query(
        `
          select
            count(*)::int as total_calls,
            count(*) filter (where scene = 'recognition')::int as recognition_calls,
            count(*) filter (where scene = 'analysis')::int as analysis_calls,
            count(*) filter (where status = 'failed')::int as failed_calls,
            count(*) filter (
              where coalesce(failure_category, '') = 'ai_service'
                and coalesce(failure_reason, '') ~* 'schema|invalid json|parse'
            )::int as schema_failure_count,
            round(avg(latency_ms) filter (where scene = 'recognition' and latency_ms is not null))::int
              as avg_recognition_latency_ms,
            max(latency_ms) filter (where scene = 'recognition')::int as max_recognition_latency_ms,
            coalesce(sum(total_tokens), 0)::int as total_tokens,
            coalesce(sum(cost_usd), 0)::numeric as total_cost_usd
          from ingest.ai_call_log
          where created_at >= $1
            and created_at <= $2
        `,
        [windowStart.toISOString(), windowEnd.toISOString()],
      ),
      client.query(
        `
          select
            count(*) filter (where recognition_json->>'aiAttemptKind' = 'fallback')::int
              as recognition_fallback_count,
            count(*) filter (where recognition_json ? 'aiAttemptKind')::int
              as recognition_total_count
          from ingest.telegram_recognition
          where updated_at >= $1
            and updated_at <= $2
        `,
        [windowStart.toISOString(), windowEnd.toISOString()],
      ),
    ]);

    return buildAiMonitoringSummary({
      callLogRow: callLogResult.rows[0] ?? {},
      recognitionRow: recognitionResult.rows[0] ?? {},
    });
  } catch (error) {
    return emptyAiMonitoringSummary({
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await client.end();
  }
}

function buildAiMonitoringSummary({ callLogRow, recognitionRow }) {
  const totalCalls = normalizeNonNegativeInteger(callLogRow.total_calls);
  const recognitionCalls = normalizeNonNegativeInteger(callLogRow.recognition_calls);
  const fallbackCalls = normalizeNonNegativeInteger(recognitionRow.recognition_fallback_count);
  const recognitionTotal = normalizeNonNegativeInteger(recognitionRow.recognition_total_count);
  const fallbackRate = recognitionTotal > 0 ? roundRatio(fallbackCalls / recognitionTotal) : 0;
  const schemaFailureCount = normalizeNonNegativeInteger(callLogRow.schema_failure_count);
  const alertReasons = [];

  if (fallbackRate > aiMonitoringThresholds.fallbackRate) {
    alertReasons.push('ai_fallback_rate_gt_30pct');
  }
  if (schemaFailureCount >= aiMonitoringThresholds.schemaFailureCountPerHour) {
    alertReasons.push('ai_schema_failure_gte_2_per_hour');
  }

  return {
    status: 'ok',
    error: null,
    windowMinutes: aiMonitoringWindowMinutes,
    totalCalls,
    recognitionCalls,
    analysisCalls: normalizeNonNegativeInteger(callLogRow.analysis_calls),
    fallbackCalls,
    fallbackRate,
    schemaFailureCount,
    failedCalls: normalizeNonNegativeInteger(callLogRow.failed_calls),
    avgRecognitionLatencyMs: normalizeNullableInteger(callLogRow.avg_recognition_latency_ms),
    maxRecognitionLatencyMs: normalizeNullableInteger(callLogRow.max_recognition_latency_ms),
    totalTokens: normalizeNonNegativeInteger(callLogRow.total_tokens),
    totalCostUsd: normalizeNullableNumber(callLogRow.total_cost_usd) ?? 0,
    sources: [
      'ingest.ai_call_log',
      'ingest.telegram_recognition.recognition_json.aiAttemptKind',
    ],
    alertReasons,
    thresholds: aiMonitoringThresholds,
  };
}

function emptyAiMonitoringSummary({ status, error = null }) {
  return {
    status,
    error,
    windowMinutes: aiMonitoringWindowMinutes,
    totalCalls: 0,
    recognitionCalls: 0,
    analysisCalls: 0,
    fallbackCalls: 0,
    fallbackRate: 0,
    schemaFailureCount: 0,
    failedCalls: 0,
    avgRecognitionLatencyMs: null,
    maxRecognitionLatencyMs: null,
    totalTokens: 0,
    totalCostUsd: 0,
    sources: [
      'ingest.ai_call_log',
      'ingest.telegram_recognition.recognition_json.aiAttemptKind',
    ],
    alertReasons: [],
    thresholds: aiMonitoringThresholds,
  };
}

function createMaintenanceClient(config, createClient) {
  return createClient
    ? createClient(config)
    : new Client({
        connectionString: config.url,
        connectionTimeoutMillis: config.timeoutMs,
        application_name: config.appName,
      });
}

function summarizePendingDatabaseRows(pending, now) {
  const nowTime = normalizeTime(now)?.getTime() ?? Date.now();
  let oldest = null;
  let maxAttemptCount = 0;

  for (const row of pending) {
    const timestamp = pickPendingTimestamp(row);
    if (timestamp && (!oldest || timestamp.getTime() < oldest.getTime())) {
      oldest = timestamp;
    }
    maxAttemptCount = Math.max(maxAttemptCount, normalizeNonNegativeInteger(row?.attemptCount ?? row?.attempt_count));
  }

  const oldestAgeMinutes = oldest
    ? Math.max(0, Math.floor((nowTime - oldest.getTime()) / 60000))
    : null;
  const alertReasons = [];

  if (pending.length > pendingDatabaseThresholds.p1Count) {
    alertReasons.push('pending_count_gt_10');
  }
  if (oldestAgeMinutes !== null && oldestAgeMinutes > pendingDatabaseThresholds.p1OldestAgeMinutes) {
    alertReasons.push('pending_oldest_gt_24h');
  }
  if (maxAttemptCount >= pendingDatabaseThresholds.p1AttemptCount) {
    alertReasons.push('pending_attempt_count_gte_25');
  }
  if (alertReasons.length === 0 && pending.length > 0 && oldestAgeMinutes > pendingDatabaseThresholds.p2OldestAgeMinutes) {
    alertReasons.push('pending_oldest_gt_30m');
  }

  return {
    oldestAt: oldest ? oldest.toISOString() : null,
    oldestAgeMinutes,
    maxAttemptCount,
    alertLevel: resolvePendingDatabaseAlertLevel(alertReasons),
    alertReasons,
    thresholds: pendingDatabaseThresholds,
  };
}

function resolvePendingDatabaseAlertLevel(alertReasons) {
  if (alertReasons.some((reason) => pendingDatabaseP1Reasons.has(reason))) {
    return 'P1';
  }
  return alertReasons.length > 0 ? 'P2' : 'none';
}

function pickPendingTimestamp(row) {
  return normalizeTime(row?.createdAt ?? row?.created_at) ??
    normalizeTime(row?.lastFailedAt ?? row?.last_failed_at) ??
    normalizeTime(row?.nextRetryAt ?? row?.next_retry_at) ??
    normalizeTime(row?.updatedAt ?? row?.updated_at);
}

function normalizeTime(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Math.floor(number);
}

function normalizeNullableInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return Math.round(number);
}

function normalizeNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function roundRatio(value) {
  return Math.round(value * 10000) / 10000;
}

async function readBatchAuditSummary({ env, batchId, readBatchAudit, createClient }) {
  try {
    return await readBatchAudit({ env, batchId, createClient });
  } catch (error) {
    return emptyBatchAudit(batchId, {
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readTrainingBatchAudit(options = {}) {
  const batchId = String(options.batchId ?? '').trim();
  if (!batchId) {
    return emptyBatchAudit(batchId, {
      status: 'skipped',
      reason: 'missing_batch_id',
    });
  }

  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return emptyBatchAudit(batchId, {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
    });
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
    return await readTrainingBatchAuditClient(client, { batchId });
  } finally {
    await client.end();
  }
}

export async function readTrainingBatchAuditClient(client, { batchId }) {
  const [batchResult, recognitionResult, coreResult] = await Promise.all([
    client.query(
      `
        select
          batch_id,
          status,
          archived_date::text as archived_date,
          reason,
          confidence,
          processed_at,
          batch_payload_json
        from ingest.telegram_batch
        where batch_id = $1
      `,
      [batchId],
    ),
    client.query(
      `
        select
          message_id::text as message_id,
          source_channel,
          source_chat_id,
          source_message_id,
          recognition_json,
          updated_at
        from ingest.telegram_recognition
        where batch_id = $1
        order by source_channel, source_chat_id, source_message_id
      `,
      [batchId],
    ),
    client.query(
      `
        select 'measurement' as target, archived_date::text as archived_date, count(*)::int as row_count
        from core.measurement
        where source_batch_id = $1
        group by archived_date
        union all
        select 'activity' as target, archived_date::text as archived_date, count(*)::int as row_count
        from core.activity
        where source_batch_id = $1
        group by archived_date
        union all
        select 'meal' as target, archived_date::text as archived_date, count(*)::int as row_count
        from core.meal
        where source_batch_id = $1
        group by archived_date
        union all
        select 'sleep' as target, archived_date::text as archived_date, count(*)::int as row_count
        from core.sleep
        where source_batch_id = $1
        group by archived_date
        union all
        select 'trainingDay' as target, archived_date::text as archived_date, count(*)::int as row_count
        from core.training_day
        where source_batch_id = $1
        group by archived_date
        order by target, archived_date
      `,
      [batchId],
    ),
  ]);

  const batchRow = batchResult.rows[0] ?? null;
  const recognitions = recognitionResult.rows.map((row) => ({
    messageId: row.message_id ?? null,
    sourceChannel: row.source_channel ?? null,
    sourceChatId: row.source_chat_id ?? null,
    sourceMessageId: row.source_message_id ?? null,
    recognitionJson: row.recognition_json ?? null,
    updatedAt: row.updated_at ?? null,
  }));
  const coreTargets = buildCoreTargets(coreResult.rows);
  const recoveryTargetDays = collectRecoveryTargetDays({
    batch: batchRow,
    recognitions,
    coreTargets,
  });

  return {
    status: 'ok',
    batchId,
    readonly: true,
    batch: batchRow
      ? {
          status: batchRow.status ?? null,
          archivedDate: normalizeDateString(batchRow.archived_date),
          reason: batchRow.reason ?? null,
          confidence: batchRow.confidence ?? null,
          processedAt: batchRow.processed_at ?? null,
        }
      : null,
    recognitions,
    coreTargets,
    recoveryTargetDays,
  };
}

function emptyBatchAudit(batchId, extra = {}) {
  return {
    status: extra.status ?? 'skipped',
    batchId,
    readonly: true,
    batch: null,
    recognitions: [],
    coreTargets: emptyCoreTargets(),
    recoveryTargetDays: [],
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  };
}

function buildCoreTargets(rows) {
  const targets = emptyCoreTargets();
  for (const row of rows) {
    const target = normalizeCoreTarget(row.target);
    if (!target) {
      continue;
    }
    targets[target].push({
      archivedDate: normalizeDateString(row.archived_date),
      rowCount: Number(row.row_count ?? 0),
    });
  }
  return targets;
}

function emptyCoreTargets() {
  return {
    measurement: [],
    activity: [],
    meal: [],
    sleep: [],
    trainingDay: [],
  };
}

function normalizeCoreTarget(value) {
  const target = String(value ?? '').trim();
  return Object.hasOwn(emptyCoreTargets(), target) ? target : null;
}

function collectRecoveryTargetDays({ batch, recognitions, coreTargets }) {
  const days = new Set();
  addDate(days, batch?.archived_date);
  for (const recognition of recognitions) {
    collectDatesFromJson(recognition.recognitionJson, days);
  }
  for (const rows of Object.values(coreTargets)) {
    for (const row of rows) {
      addDate(days, row.archivedDate);
    }
  }
  return [...days].sort();
}

function collectDatesFromJson(value, days, key = '') {
  if (typeof value === 'string') {
    if (isDateLikeField(key)) {
      addDate(days, value);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDatesFromJson(entry, days, key);
    }
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    collectDatesFromJson(childValue, days, childKey);
  }
}

function isDateLikeField(key) {
  return /(?:^|_)(?:archived|detected|image|meal|sleep|start|end)?date$/iu.test(key) ||
    /(?:measured|started|ended|created|updated)At$/u.test(key);
}

function addDate(days, value) {
  const date = normalizeDateString(value);
  if (date) {
    days.add(date);
  }
}

function normalizeDateString(value) {
  const match = String(value ?? '').match(/\b(\d{4}-\d{2}-\d{2})\b/u);
  return match?.[1] ?? null;
}

async function runSyncMaintenance({ rootDir, env, stderr, flags, syncTrainingCore }) {
  const phase = resolvePhaseFlag(flags);
  const dryRun = flags.has('--dry-run');
  const result = await syncTrainingCore({
    rootDir,
    env,
    stderr,
    stdout: { write() {} },
    phase,
    dryRun,
  });

  return {
    status: result.status,
    mode: 'sync',
    phase,
    readonly: dryRun,
    dryRun,
    result,
  };
}

async function runExportMaintenance({ rootDir, env, stderr, target, exportDerivedTrainingMarkdown }) {
  if (target !== 'markdown') {
    return {
      status: 'failed',
      mode: 'export',
      target: target ?? null,
      readonly: false,
      error: 'export requires target: markdown',
    };
  }

  const result = await exportDerivedTrainingMarkdown({
    rootDir,
    env,
    stderr,
  });

  return {
    status: 'stored',
    mode: 'export',
    target,
    readonly: false,
    result,
  };
}

async function runMigrateMaintenance({ rootDir, env, stderr, flags, syncTrainingCore }) {
  const dryRun = flags.has('--dry-run');
  const confirmed = flags.has('--confirm');

  if (dryRun) {
    return {
      status: 'planned',
      mode: 'migrate',
      readonly: true,
      dryRun: true,
      requiresConfirm: true,
      plan: migrationPlan,
    };
  }

  if (!confirmed) {
    return {
      status: 'blocked',
      mode: 'migrate',
      readonly: false,
      requiresConfirm: true,
      plan: migrationPlan,
      error: 'migrate requires --dry-run or --confirm',
    };
  }

  const result = await syncTrainingCore({
    rootDir,
    env,
    stderr,
    stdout: { write() {} },
    sourceChannel: 'maintenance_migrate',
  });

  return {
    status: result.status,
    mode: 'migrate',
    readonly: false,
    confirmed: true,
    plan: migrationPlan,
    result,
  };
}

async function readNdjsonSummary(filePath) {
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { validCount: 0, invalidLines: 0 };
    }
    throw error;
  }

  let validCount = 0;
  let invalidLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      JSON.parse(line);
      validCount += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { validCount, invalidLines };
}

function normalizeBooleanFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function resolvePhaseFlag(flags) {
  const values = [...flags];
  const equalsFlag = values.find((value) => value.startsWith('--phase='));
  if (equalsFlag) {
    return normalizeSyncPhase(equalsFlag.slice('--phase='.length));
  }

  const phaseIndex = values.indexOf('--phase');
  if (phaseIndex >= 0) {
    return normalizeSyncPhase(values[phaseIndex + 1]);
  }

  return 'safe';
}

function resolveValueFlag(values, flagName) {
  const equalsFlag = values.find((value) => value.startsWith(`${flagName}=`));
  if (equalsFlag) {
    return equalsFlag.slice(flagName.length + 1).trim() || null;
  }

  const flagIndex = values.indexOf(flagName);
  if (flagIndex >= 0) {
    return String(values[flagIndex + 1] ?? '').trim() || null;
  }

  return null;
}

function normalizeSyncPhase(value) {
  const phase = String(value ?? 'safe').trim();
  return ['safe', 'all', 'archive', 'ingest', 'markdown', 'thoughts'].includes(phase) ? phase : 'safe';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runTrainingMaintenance();
  if (result.status === 'failed') {
    process.exitCode = 1;
  } else if (result.status === 'blocked') {
    process.exitCode = 2;
  }
}
