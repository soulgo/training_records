import { createHash } from 'node:crypto';

import pg from 'pg';

import { normalizeAiUsage } from '../../core/ai/schema-validator.mjs';
import { resolveTrainingCoreConfig, resolveTrainingReadonlyConfig } from './config.mjs';

const { Client } = pg;
const DEFAULT_RETRY_DELAY_MINUTES = 10;
const DEFAULT_RETRY_LIMIT = 25;
const DEFAULT_CLAIM_MINUTES = 10;

export async function readPendingRecognitionBatches(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return [];
  }

  const client = createTrainingClient(config, options.createClient);
  const limit = normalizeLimit(options.limit);
  const retryLimit = normalizeRetryLimit(options.retryLimit);
  const sourceChannel = normalizeSourceChannel(options.sourceChannel);
  const now = options.now ?? new Date();
  const claimUntil = options.claimUntil ?? new Date(now.getTime() + normalizeClaimMinutes(options.claimMinutes) * 60 * 1000);

  try {
    await client.connect();
    await client.query('BEGIN');
    const result = await client.query(
      `
        with abandoned as (
          update ingest.pending_task
          set status = 'abandoned',
              updated_at = $1
          where status = 'pending'
            and source_channel = $5
            and attempt_count > $4
          returning pending_id
        ),
        claimed as (
          select pending_id
          from ingest.pending_task
          where status = 'pending'
            and source_channel = $5
            and next_retry_at <= $1
          order by next_retry_at asc, pending_id asc
          limit $2
          for update skip locked
        )
        update ingest.pending_task pending
        set next_retry_at = $3,
            updated_at = $1
        from claimed
        where pending.pending_id = claimed.pending_id
        returning
          batch_id,
          kind,
          payload_json as batch_payload_json,
          failure_category,
          failure_reason,
          attempt_count,
          next_retry_at,
          last_failed_at
      `,
      [now.toISOString(), limit, claimUntil.toISOString(), retryLimit, sourceChannel],
    );
    await client.query('COMMIT');

    return result.rows.map((row) => ({
      batchId: row.batch_id,
      kind: row.kind,
      batch: row.batch_payload_json,
      failureCategory: row.failure_category,
      failureReason: row.failure_reason,
      attemptCount: Number(row.attempt_count ?? 0),
      nextRetryAt: row.next_retry_at ?? null,
      lastFailedAt: row.last_failed_at ?? null,
    }));
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original query error; rollback failure only affects cleanup.
    }
    throw error;
  } finally {
    await client.end();
  }
}

function normalizeSourceChannel(value) {
  const normalized = String(value ?? 'telegram').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/u.test(normalized)) {
    throw new Error('sourceChannel must be a lowercase channel key');
  }
  return normalized;
}

export async function readPendingRecognitionSummary(options = {}) {
  const config = resolveTrainingReadonlyConfig(options.env);
  if (!config.enabled || !config.url) {
    return [];
  }

  const client = createTrainingClient(config, options.createClient);
  const limit = normalizeLimit(options.limit);

  try {
    await client.connect();
    const result = await client.query(
      `
        select
          batch_id,
          kind,
          failure_category,
          failure_reason,
          attempt_count,
          next_retry_at,
          last_failed_at,
          created_at,
          updated_at
        from ingest.pending_task
        where status = 'pending'
        order by created_at asc, pending_id asc
        limit $1
      `,
      [limit],
    );

    return result.rows.map((row) => ({
      batchId: row.batch_id,
      kind: row.kind,
      failureCategory: row.failure_category,
      failureReason: row.failure_reason,
      attemptCount: Number(row.attempt_count ?? 0),
      nextRetryAt: row.next_retry_at ?? null,
      lastFailedAt: row.last_failed_at ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    }));
  } finally {
    await client.end();
  }
}

export async function appendPendingRecognitionBatch(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled) {
    return { status: 'skipped', reason: 'disabled' };
  }
  if (!config.url) {
    return { status: 'skipped', reason: 'missing_url' };
  }

  const batch = options.batch;
  if (!batch?.batchId) {
    throw new Error('batch.batchId is required for pending recognition queue');
  }

  const client = createTrainingClient(config, options.createClient);
  const now = options.now ?? new Date();
  const retryDelayMinutes = normalizeRetryDelayMinutes(options.retryDelayMinutes);
  const nextRetryAt = options.nextRetryAt ?? new Date(now.getTime() + retryDelayMinutes * 60 * 1000);
  const failureCategory = options.failureCategory ?? 'ai_service';
  const failureReason = options.error ?? options.failureReason ?? null;

  try {
    await client.connect();
    await client.query(
      `
        insert into ingest.pending_task (
          source_channel,
          batch_id,
          kind,
          status,
          payload_json,
          failure_category,
          failure_reason,
          attempt_count,
          next_retry_at,
          last_failed_at,
          resolved_at,
          created_at,
          updated_at
        )
        values (coalesce(nullif($3::jsonb->>'sourceChannel', ''), 'telegram'), $1, $2, 'pending', $3::jsonb, $4, $5, 0, $6, $7, null, $8, $9)
        on conflict (source_channel, batch_id) do update set
          kind = excluded.kind,
          status = 'pending',
          payload_json = excluded.payload_json,
          failure_category = excluded.failure_category,
          failure_reason = excluded.failure_reason,
          attempt_count = ingest.pending_task.attempt_count + 1,
          next_retry_at = excluded.next_retry_at,
          last_failed_at = excluded.last_failed_at,
          resolved_at = null,
          updated_at = excluded.updated_at
        where ingest.pending_task.status <> 'abandoned'
      `,
      [
        batch.batchId,
        batch.kind ?? 'image',
        JSON.stringify(batch),
        failureCategory,
        failureReason,
        nextRetryAt.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
      ],
    );
    const statusResult = await client.query(
      `
        select status
        from ingest.pending_task
        where batch_id = $1
          and source_channel = coalesce(nullif($2, ''), 'telegram')
      `,
      [batch.batchId, batch.sourceChannel ?? 'telegram'],
    );
    const aiCallLogResult = await writeFailedRecognitionAiCallLogsBestEffort(client, {
      batch,
      failureCategory,
      failureReason,
      occurredAt: now,
    });
    if (statusResult.rows[0]?.status === 'abandoned') {
      return { status: 'abandoned', batchId: batch.batchId, aiCallLogStatus: aiCallLogResult.status };
    }
    return { status: 'queued', batchId: batch.batchId, aiCallLogStatus: aiCallLogResult.status };
  } finally {
    await client.end();
  }
}

export async function writeStartedRecognitionAiCallLog(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled) {
    return { status: 'skipped', reason: 'disabled' };
  }
  if (!config.url) {
    return { status: 'skipped', reason: 'missing_url' };
  }

  const log = buildStartedRecognitionAiCallLog({
    event: options,
    occurredAt: options.occurredAt ?? options.now ?? new Date(),
  });
  if (!log) {
    return { status: 'skipped', reason: 'missing_model' };
  }

  const client = createTrainingClient(config, options.createClient);
  try {
    await client.connect();
    await insertAiCallLog(client, log);
    return { status: 'written', aiCallId: log.aiCallId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[training-db] failed to write started recognition AI call log for ${log.taskId ?? 'unknown'}: ${message}\n`,
    );
    return { status: 'failed', error: message, aiCallId: log.aiCallId };
  } finally {
    await client.end();
  }
}

export async function markPendingRecognitionResolved(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
    };
  }
  if (!options.batchId) {
    throw new Error('batchId is required to resolve pending recognition batch');
  }

  const client = createTrainingClient(config, options.createClient);
  const now = options.now ?? new Date();

  try {
    await client.connect();
    await client.query(
      `
        update ingest.pending_task
        set status = 'resolved',
            resolved_at = $2,
            updated_at = $2
        where batch_id = $1
          and ($3::text is null or source_channel = $3)
      `,
      [options.batchId, now.toISOString(), options.sourceChannel ?? null],
    );
    return { status: 'resolved', batchId: options.batchId };
  } finally {
    await client.end();
  }
}

export function shouldQueueRecognitionFailure(batch) {
  if (!batch) {
    return false;
  }
  if (batch.recognitionPendingStatus === 'queued') {
    return false;
  }

  if (batch.status === 'ready' && batch.failureCategory === 'database') {
    return true;
  }

  if (batch.kind !== 'image') {
    return false;
  }

  if (batch.status === 'ready' && hasPartialRecognitionFailure(batch)) {
    return true;
  }

  if (batch.status !== 'skipped') {
    return false;
  }
  if (batch.failureCategory !== 'ai_service') {
    return false;
  }
  return Array.isArray(batch.messages) && batch.messages.some((message) => (message.photos?.length ?? 0) > 0);
}

function hasPartialRecognitionFailure(batch) {
  if (!batch || batch.status !== 'ready') {
    return false;
  }
  if (batch.partialFailure === true) {
    return true;
  }
  if (batch.failedImageCount > 0) {
    return true;
  }
  if (batch.sourceImageCount > 0 && batch.recognizedImageCount < batch.sourceImageCount) {
    return true;
  }
  if (Array.isArray(batch.recognitionErrors) && batch.recognitionErrors.length > 0) {
    return true;
  }
  return (batch.issues ?? []).some((issue) => /missing recognition/i.test(String(issue)));
}

async function writeFailedRecognitionAiCallLogsBestEffort(client, { batch, failureCategory, failureReason, occurredAt }) {
  const logs = buildFailedRecognitionAiCallLogs({
    batch,
    failureCategory,
    failureReason,
    occurredAt,
  });
  if (logs.length === 0) {
    return { status: 'skipped' };
  }

  try {
    for (const log of logs) {
      await insertAiCallLog(client, log);
    }
    return { status: 'written', count: logs.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[training-db] failed to write failed recognition AI call log for ${batch.batchId}: ${message}\n`,
    );
    return { status: 'failed', error: message };
  }
}

function buildFailedRecognitionAiCallLogs({ batch, failureCategory, failureReason, occurredAt }) {
  return (batch.recognitionErrors ?? [])
    .map((recognitionError) => {
      const model = normalizeText(recognitionError.model ?? recognitionError.aiModel ?? batch.aiModel);
      if (!model) {
        return null;
      }
      const taskId = normalizeText(batch.batchId);
      const idempotencyKey = normalizeText(recognitionError.aiIdempotencyKey ?? recognitionError.idempotencyKey);
      const occurredAtIso = occurredAt.toISOString();
      const usage = normalizeAiUsage(recognitionError.aiUsage ?? recognitionError.usage);
      return {
        aiCallId: buildAiCallId({
          scene: 'recognition',
          taskId,
        messageId: normalizeText(recognitionError.sourceMessageId ?? recognitionError.messageId),
        idempotencyKey,
        model,
      }),
        taskId,
        scene: 'recognition',
        provider: normalizeText(recognitionError.provider ?? recognitionError.providerName) ?? 'openai-compatible',
        model,
        promptVersion: normalizeText(recognitionError.promptVersion),
        idempotencyKey,
        status: 'failed',
        latencyMs: normalizeInteger(recognitionError.aiLatencyMs ?? recognitionError.latencyMs),
        failureCategory: normalizeText(recognitionError.failureCategory ?? failureCategory) ?? 'ai_service',
        failureReason: normalizeText(recognitionError.error ?? recognitionError.failureReason ?? failureReason),
        createdAt: occurredAtIso,
        updatedAt: occurredAtIso,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd,
      };
    })
    .filter(Boolean);
}

function buildStartedRecognitionAiCallLog({ event, occurredAt }) {
  const model = normalizeText(event.model);
  if (!model) {
    return null;
  }
  const taskId = normalizeText(event.taskId) ??
    [
      normalizeText(event.sourceChannel) ?? 'telegram',
      normalizeText(event.sourceChatId),
      normalizeText(event.sourceMessageId ?? event.messageId),
    ]
      .map((part) => part ?? '')
      .join(':');
  const idempotencyKey = normalizeText(event.idempotencyKey);
  const occurredAtIso = occurredAt.toISOString();
  const usage = normalizeAiUsage(event.aiUsage ?? event.usage);
  return {
    aiCallId: buildAiCallId({
      scene: 'recognition',
      taskId,
      messageId: normalizeText(event.sourceMessageId ?? event.messageId),
      idempotencyKey,
      model,
    }),
    taskId,
    scene: 'recognition',
    provider: normalizeText(event.provider) ?? 'openai-compatible',
    model,
    promptVersion: normalizeText(event.promptVersion),
    idempotencyKey,
    status: 'started',
    latencyMs: null,
    failureCategory: null,
    failureReason: null,
    createdAt: occurredAtIso,
    updatedAt: occurredAtIso,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
  };
}

async function insertAiCallLog(client, log) {
  return client.query(
    `
      insert into ingest.ai_call_log (
        ai_call_id,
        task_id,
        scene,
        provider,
        model,
        prompt_version,
        idempotency_key,
        status,
        latency_ms,
        failure_category,
        failure_reason,
        created_at,
        updated_at,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cost_usd
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      on conflict (ai_call_id) do update set
        task_id = excluded.task_id,
        scene = excluded.scene,
        provider = excluded.provider,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        idempotency_key = excluded.idempotency_key,
        status = excluded.status,
        latency_ms = excluded.latency_ms,
        failure_category = excluded.failure_category,
        failure_reason = excluded.failure_reason,
        prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        total_tokens = excluded.total_tokens,
        cost_usd = excluded.cost_usd,
        updated_at = excluded.updated_at
    `,
    [
      log.aiCallId,
      log.taskId,
      log.scene,
      log.provider,
      log.model,
      log.promptVersion,
      log.idempotencyKey,
      log.status,
      log.latencyMs,
      log.failureCategory,
      log.failureReason,
      log.createdAt,
      log.updatedAt,
      log.promptTokens,
      log.completionTokens,
      log.totalTokens,
      log.costUsd,
    ],
  );
}

function buildAiCallId(parts) {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `ai-call:${parts.scene}:${digest}`;
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return Math.round(number);
}

export function normalizePendingRecognitionBatchEntry(entry) {
  const batch = entry?.batch ?? entry?.batch_payload_json ?? entry;
  if (!batch?.batchId) {
    return null;
  }
  return {
    batchId: entry.batchId ?? entry.batch_id ?? batch.batchId,
    batch,
    attemptCount: Number(entry.attemptCount ?? entry.attempt_count ?? 0),
    failureReason: entry.failureReason ?? entry.failure_reason ?? null,
  };
}

function createTrainingClient(config, createClient) {
  return createClient
    ? createClient(config)
    : new Client({
        connectionString: config.url,
        connectionTimeoutMillis: config.timeoutMs,
        application_name: config.appName,
      });
}

function normalizeLimit(value) {
  const number = Number(value ?? DEFAULT_RETRY_LIMIT);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_RETRY_LIMIT;
}

function normalizeRetryLimit(value) {
  const number = Number(value ?? DEFAULT_RETRY_LIMIT);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : DEFAULT_RETRY_LIMIT;
}

function normalizeRetryDelayMinutes(value) {
  const number = Number(value ?? DEFAULT_RETRY_DELAY_MINUTES);
  return Number.isFinite(number) && number >= 0 ? number : DEFAULT_RETRY_DELAY_MINUTES;
}

function normalizeClaimMinutes(value) {
  const number = Number(value ?? DEFAULT_CLAIM_MINUTES);
  return Number.isFinite(number) && number > 0 ? number : DEFAULT_CLAIM_MINUTES;
}
