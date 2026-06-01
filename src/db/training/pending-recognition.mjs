import pg from 'pg';

import { resolveTrainingCoreConfig } from './config.mjs';

const { Client } = pg;
const DEFAULT_RETRY_DELAY_MINUTES = 10;
const DEFAULT_RETRY_LIMIT = 25;

export async function readPendingRecognitionBatches(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return [];
  }

  const client = createTrainingClient(config, options.createClient);
  const limit = normalizeLimit(options.limit);
  const now = options.now ?? new Date();

  try {
    await client.connect();
    const result = await client.query(
      `
        select
          batch_id,
          kind,
          batch_payload_json,
          failure_category,
          failure_reason,
          attempt_count,
          next_retry_at,
          last_failed_at
        from ingest.telegram_pending_batch
        where status = 'pending'
          and next_retry_at <= $1
        order by next_retry_at asc, pending_id asc
        limit $2
      `,
      [now.toISOString(), limit],
    );

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
        insert into ingest.telegram_pending_batch (
          batch_id,
          kind,
          status,
          batch_payload_json,
          failure_category,
          failure_reason,
          attempt_count,
          next_retry_at,
          last_failed_at,
          resolved_at,
          created_at,
          updated_at
        )
        values ($1, $2, 'pending', $3::jsonb, $4, $5, 0, $6, $7, null, $8, $9)
        on conflict (batch_id) do update set
          kind = excluded.kind,
          status = 'pending',
          batch_payload_json = excluded.batch_payload_json,
          failure_category = excluded.failure_category,
          failure_reason = excluded.failure_reason,
          attempt_count = ingest.telegram_pending_batch.attempt_count + 1,
          next_retry_at = excluded.next_retry_at,
          last_failed_at = excluded.last_failed_at,
          resolved_at = null,
          updated_at = excluded.updated_at
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
    return { status: 'queued', batchId: batch.batchId };
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
        update ingest.telegram_pending_batch
        set status = 'resolved',
            resolved_at = $2,
            updated_at = $2
        where batch_id = $1
      `,
      [options.batchId, now.toISOString()],
    );
    return { status: 'resolved', batchId: options.batchId };
  } finally {
    await client.end();
  }
}

export function shouldQueueRecognitionFailure(batch) {
  if (!batch || batch.kind !== 'image') {
    return false;
  }
  if (batch.recognitionPendingStatus === 'queued') {
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

function normalizeRetryDelayMinutes(value) {
  const number = Number(value ?? DEFAULT_RETRY_DELAY_MINUTES);
  return Number.isFinite(number) && number >= 0 ? number : DEFAULT_RETRY_DELAY_MINUTES;
}
