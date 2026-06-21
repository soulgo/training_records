import { createHash } from 'node:crypto';

import { normalizeAiUsage } from '../../core/ai/schema-validator.mjs';

export class PostgresTelegramBatchRepository {
  constructor(client) {
    if (!client?.query) {
      throw new Error('PostgresTelegramBatchRepository requires a pg client-like object');
    }
    this.client = client;
  }

  async upsertBatch(batch, payloadHash, processedAt) {
    return this.client.query(
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
        where ingest.telegram_batch.payload_hash <> excluded.payload_hash
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

  async upsertMessages(batch, processedAt) {
    for (const message of batch.messages ?? []) {
      const sourceChannel = normalizeSourceChannel(message.sourceChannel ?? batch.sourceChannel);
      const sourceChatId = normalizeSourceId(message.sourceChatId ?? message.chatId ?? 'legacy-chat');
      const sourceMessageId = normalizeSourceId(message.sourceMessageId ?? message.messageId);
      await this.client.query(
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
            source_channel,
            source_chat_id,
            source_message_id,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14)
          on conflict (source_channel, source_chat_id, source_message_id) do update set
            message_id = excluded.message_id,
            batch_id = excluded.batch_id,
            update_id = excluded.update_id,
            media_group_id = excluded.media_group_id,
            chat_id = excluded.chat_id,
            caption = excluded.caption,
            text = excluded.text,
            date_unix = excluded.date_unix,
            photo_file_ids_json = excluded.photo_file_ids_json,
            photo_file_unique_ids_json = excluded.photo_file_unique_ids_json,
            source_channel = excluded.source_channel,
            source_chat_id = excluded.source_chat_id,
            source_message_id = excluded.source_message_id,
            updated_at = excluded.updated_at
        `,
        [
          message.messageId,
          batch.batchId,
          message.updateId,
          message.mediaGroupId ?? null,
          normalizeBigIntValue(message.chatId),
          message.caption ?? '',
          message.text ?? '',
          message.dateUnix ?? null,
          JSON.stringify((message.photos ?? []).map((photo) => photo.fileId)),
          JSON.stringify((message.photos ?? []).map((photo) => photo.fileUniqueId)),
          sourceChannel,
          sourceChatId,
          sourceMessageId,
          processedAt.toISOString(),
        ],
      );
    }
  }

  async upsertRecognitions(batch, processedAt) {
    for (const recognition of batch.recognitions ?? []) {
      const sourceMessage = findBatchMessage(batch, recognition.messageId);
      const sourceChannel = normalizeSourceChannel(recognition.sourceChannel ?? batch.sourceChannel);
      const sourceChatId = normalizeSourceId(
        recognition.sourceChatId ?? sourceMessage?.sourceChatId ?? sourceMessage?.chatId ?? 'legacy-chat',
      );
      const sourceMessageId = normalizeSourceId(recognition.sourceMessageId ?? recognition.messageId);
      await this.client.query(
        `
          insert into ingest.telegram_recognition (
            message_id,
            batch_id,
            recognition_json,
            source_channel,
            source_chat_id,
            source_message_id,
            updated_at
          )
          values ($1, $2, $3::jsonb, $4, $5, $6, $7)
          on conflict (source_channel, source_chat_id, source_message_id) do update set
            message_id = excluded.message_id,
            batch_id = excluded.batch_id,
            recognition_json = excluded.recognition_json,
            source_channel = excluded.source_channel,
            source_chat_id = excluded.source_chat_id,
            source_message_id = excluded.source_message_id,
            updated_at = excluded.updated_at
        `,
        [
          recognition.messageId,
          batch.batchId,
          JSON.stringify(recognition),
          sourceChannel,
          sourceChatId,
          sourceMessageId,
          processedAt.toISOString(),
        ],
      );
    }
  }

  async upsertRecognitionAiCallLogs(batch, processedAt) {
    for (const recognition of batch.recognitions ?? []) {
      const sourceMessage = findBatchMessage(batch, recognition.messageId);
      const log = buildRecognitionAiCallLog({ batch, recognition, sourceMessage, processedAt });
      if (!log) {
        continue;
      }
      await this.client.query(
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
  }

  async getLastProcessedTelegramUpdateId() {
    const result = await this.client.query(`
      select coalesce(max(update_id), 0) as last_processed_update_id
      from ingest.telegram_message
    `);
    return Number(result.rows[0]?.last_processed_update_id ?? 0);
  }
}

export async function getLastProcessedTelegramUpdateId(client) {
  const result = await client.query(`
    select coalesce(max(update_id), 0) as last_processed_update_id
    from ingest.telegram_message
  `);
  return Number(result.rows[0]?.last_processed_update_id ?? 0);
}

function normalizeBigIntValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^-?\d+$/.test(trimmed) ? trimmed : null;
  }
  return null;
}

function normalizeSourceChannel(value) {
  const text = String(value ?? '').trim();
  return text || 'telegram';
}

function normalizeSourceId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function findBatchMessage(batch, messageId) {
  return (batch.messages ?? []).find((message) => message.messageId === messageId) ?? null;
}

function buildRecognitionAiCallLog({ batch, recognition, sourceMessage, processedAt }) {
  const model = normalizeText(recognition.model);
  if (!model) {
    return null;
  }

  const sourceChannel = normalizeSourceChannel(recognition.sourceChannel ?? batch.sourceChannel);
  const sourceChatId = normalizeSourceId(
    recognition.sourceChatId ?? sourceMessage?.sourceChatId ?? sourceMessage?.chatId ?? 'legacy-chat',
  );
  const sourceMessageId = normalizeSourceId(recognition.sourceMessageId ?? recognition.messageId);
  const taskId = normalizeText(batch.batchId) ??
    [sourceChannel, sourceChatId, sourceMessageId].map((part) => part ?? '').join(':');
  const idempotencyKey = normalizeText(recognition.aiIdempotencyKey ?? recognition.idempotencyKey);
  const promptVersion = normalizeText(recognition.promptVersion);
  const provider = normalizeText(recognition.provider ?? recognition.providerName) ?? 'openai-compatible';
  const occurredAt = processedAt.toISOString();
  const usage = normalizeAiUsage(recognition.aiUsage ?? recognition.usage);

  return {
    aiCallId: buildAiCallId({
      scene: 'recognition',
      taskId,
      messageId: normalizeText(sourceMessageId ?? recognition.messageId),
      idempotencyKey,
      model,
    }),
    taskId,
    scene: 'recognition',
    provider,
    model,
    promptVersion,
    idempotencyKey,
    status: 'succeeded',
    latencyMs: normalizeInteger(recognition.aiLatencyMs ?? recognition.latencyMs),
    failureCategory: null,
    failureReason: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
  };
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
