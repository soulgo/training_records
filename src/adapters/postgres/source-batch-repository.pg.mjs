import { createHash } from 'node:crypto';

import { normalizeAiUsage } from '../../core/ai/schema-validator.mjs';

export class PostgresSourceBatchRepository {
  constructor(client) {
    if (!client?.query) {
      throw new Error('PostgresSourceBatchRepository requires a pg client-like object');
    }
    this.client = client;
  }

  async upsertBatch(batch, payloadHash, processedAt) {
    const sourceChannel = normalizeSourceChannel(batch.sourceChannel);
    return this.client.query(
      `
        insert into ingest.source_batch (
          source_channel,
          batch_id,
          kind,
          status,
          archived_date,
          reason,
          confidence,
          warnings_json,
          issues_json,
          payload_hash,
          payload_json,
          processed_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13)
        on conflict (source_channel, batch_id) do update set
          kind = excluded.kind,
          status = excluded.status,
          archived_date = excluded.archived_date,
          reason = excluded.reason,
          confidence = excluded.confidence,
          warnings_json = excluded.warnings_json,
          issues_json = excluded.issues_json,
          payload_hash = excluded.payload_hash,
          payload_json = excluded.payload_json,
          processed_at = excluded.processed_at,
          updated_at = excluded.updated_at
        where ingest.source_batch.payload_hash <> excluded.payload_hash
      `,
      [
        sourceChannel,
        batch.batchId,
        batch.kind ?? 'image',
        batch.status,
        batch.archivedDate ?? null,
        batch.reason ?? null,
        batch.confidence ?? null,
        JSON.stringify(batch.warnings ?? []),
        JSON.stringify(batch.issues ?? []),
        payloadHash,
        JSON.stringify(batch),
        processedAt.toISOString(),
        processedAt.toISOString(),
      ],
    );
  }

  async upsertMessages(batch, processedAt) {
    for (const message of batch.messages ?? []) {
      const identity = resolveMessageIdentity(batch, message);
      await this.client.query(
        `
          insert into ingest.source_message (
            source_channel,
            source_chat_id,
            source_message_id,
            batch_id,
            source_event_id,
            legacy_message_id,
            legacy_update_id,
            media_group_id,
            sent_at,
            caption,
            message_text,
            payload_json,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
          on conflict (source_channel, source_chat_id, source_message_id) do update set
            batch_id = excluded.batch_id,
            source_event_id = excluded.source_event_id,
            legacy_message_id = excluded.legacy_message_id,
            legacy_update_id = excluded.legacy_update_id,
            media_group_id = excluded.media_group_id,
            sent_at = excluded.sent_at,
            caption = excluded.caption,
            message_text = excluded.message_text,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `,
        [
          identity.sourceChannel,
          identity.sourceChatId,
          identity.sourceMessageId,
          batch.batchId,
          normalizeSourceId(message.sourceEventId ?? message.eventId),
          normalizeBigIntValue(message.messageId),
          normalizeBigIntValue(message.updateId),
          message.mediaGroupId ?? null,
          toTimestamp(message),
          message.caption ?? '',
          message.text ?? '',
          JSON.stringify(message),
          processedAt.toISOString(),
        ],
      );
    }
  }

  async upsertAssets(batch, processedAt) {
    for (const message of batch.messages ?? []) {
      const identity = resolveMessageIdentity(batch, message);
      for (const [index, asset] of (message.photos ?? []).entries()) {
        const sourceAssetId = normalizeSourceId(
          asset.sourceAssetId ?? asset.fileUniqueId ?? asset.imageKey ?? asset.fileId,
        ) ?? `${identity.sourceMessageId}:${index}`;
        await this.client.query(
          `
            insert into ingest.source_asset (
              source_channel,
              source_chat_id,
              source_message_id,
              source_asset_id,
              asset_order,
              kind,
              mime_type,
              width,
              height,
              size_bytes,
              payload_json,
              created_at,
              updated_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
            on conflict (source_channel, source_chat_id, source_message_id, source_asset_id) do update set
              asset_order = excluded.asset_order,
              kind = excluded.kind,
              mime_type = excluded.mime_type,
              width = excluded.width,
              height = excluded.height,
              size_bytes = excluded.size_bytes,
              payload_json = excluded.payload_json,
              updated_at = excluded.updated_at
          `,
          [
            identity.sourceChannel,
            identity.sourceChatId,
            identity.sourceMessageId,
            sourceAssetId,
            index,
            asset.kind ?? (asset.mimeType === 'text/markdown' ? 'document' : 'image'),
            asset.mimeType ?? null,
            normalizePositiveInteger(asset.width),
            normalizePositiveInteger(asset.height),
            normalizeNonNegativeInteger(asset.sizeBytes ?? asset.fileSize),
            JSON.stringify(asset),
            processedAt.toISOString(),
            processedAt.toISOString(),
          ],
        );
      }
    }
  }

  async upsertRecognitions(batch, processedAt) {
    for (const recognition of batch.recognitions ?? []) {
      const sourceMessage = findBatchMessage(batch, recognition);
      const identity = resolveRecognitionIdentity(batch, recognition, sourceMessage);
      const normalized = recognition.normalizedRecognition ?? null;
      const runtime = normalized?.runtime ?? {};
      const evidence = normalized?.evidence ?? {};
      const recognitionId = buildRecognitionId({
        identity,
        cacheKey: runtime.cacheKey ?? recognition.cacheKey,
        pipelineVersion: runtime.pipelineVersion,
        schemaVersion: runtime.schemaVersion ?? recognition.schemaVersion,
        model: runtime.model ?? recognition.model,
      });
      await this.client.query(
        `
          insert into ingest.recognition_run (
            recognition_id,
            source_channel,
            source_chat_id,
            source_message_id,
            batch_id,
            cache_key,
            status,
            source_app,
            data_type,
            fields_json,
            confidence,
            warnings_json,
            ocr_json,
            image_metadata_json,
            pipeline_version,
            schema_name,
            schema_version,
            provider,
            model,
            prompt_version,
            raw_result_json,
            created_at,
            updated_at
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb,
            $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23
          )
          on conflict (recognition_id) do update set
            batch_id = excluded.batch_id,
            cache_key = excluded.cache_key,
            status = excluded.status,
            source_app = excluded.source_app,
            data_type = excluded.data_type,
            fields_json = excluded.fields_json,
            confidence = excluded.confidence,
            warnings_json = excluded.warnings_json,
            ocr_json = excluded.ocr_json,
            image_metadata_json = excluded.image_metadata_json,
            pipeline_version = excluded.pipeline_version,
            schema_name = excluded.schema_name,
            schema_version = excluded.schema_version,
            provider = excluded.provider,
            model = excluded.model,
            prompt_version = excluded.prompt_version,
            raw_result_json = excluded.raw_result_json,
            updated_at = excluded.updated_at
        `,
        [
          recognitionId,
          identity.sourceChannel,
          identity.sourceChatId,
          identity.sourceMessageId,
          batch.batchId,
          runtime.cacheKey ?? recognition.cacheKey ?? null,
          normalized?.dataType === 'unknown' ? 'unmapped' : 'succeeded',
          normalized?.sourceApp ?? recognition.detectedApp ?? null,
          normalized?.dataType ?? recognition.imageType ?? 'unknown',
          JSON.stringify(normalized?.fields ?? recognition.records ?? {}),
          normalized?.confidence ?? recognition.confidence ?? null,
          JSON.stringify(normalized?.warnings ?? recognition.warnings ?? []),
          stringifyNullableJson(evidence.ocr),
          stringifyNullableJson(evidence.image),
          runtime.pipelineVersion ?? 'legacy',
          runtime.schemaName ?? recognition.schemaName ?? null,
          runtime.schemaVersion ?? recognition.schemaVersion ?? null,
          runtime.provider ?? recognition.provider ?? null,
          runtime.model ?? recognition.model ?? null,
          runtime.promptVersion ?? recognition.promptVersion ?? null,
          JSON.stringify(recognition),
          processedAt.toISOString(),
          processedAt.toISOString(),
        ],
      );
    }
  }

  async upsertRecognitionAiCallLogs(batch, processedAt) {
    for (const recognition of batch.recognitions ?? []) {
      const sourceMessage = findBatchMessage(batch, recognition);
      const log = buildRecognitionAiCallLog({ batch, recognition, sourceMessage, processedAt });
      if (!log) {
        continue;
      }
      await this.client.query(
        `
          insert into ingest.ai_call_log (
            ai_call_id, task_id, scene, provider, model, prompt_version, idempotency_key,
            status, latency_ms, failure_category, failure_reason, created_at, updated_at,
            prompt_tokens, completion_tokens, total_tokens, cost_usd
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
          log.aiCallId, log.taskId, log.scene, log.provider, log.model, log.promptVersion,
          log.idempotencyKey, log.status, log.latencyMs, log.failureCategory, log.failureReason,
          log.createdAt, log.updatedAt, log.promptTokens, log.completionTokens, log.totalTokens,
          log.costUsd,
        ],
      );
    }
  }

  async getLastProcessedTelegramUpdateId() {
    return getLastProcessedTelegramUpdateId(this.client);
  }
}

export async function getLastProcessedTelegramUpdateId(client) {
  const result = await client.query(`
    select coalesce(max(legacy_update_id), 0) as last_processed_update_id
    from ingest.source_message
    where source_channel = 'telegram'
  `);
  return Number(result.rows[0]?.last_processed_update_id ?? 0);
}

function resolveMessageIdentity(batch, message) {
  return {
    sourceChannel: normalizeSourceChannel(message.sourceChannel ?? batch.sourceChannel),
    sourceChatId: normalizeSourceId(message.sourceChatId ?? message.chatId) ?? 'unknown-chat',
    sourceMessageId: normalizeSourceId(message.sourceMessageId ?? message.messageId) ?? 'unknown-message',
  };
}

function resolveRecognitionIdentity(batch, recognition, sourceMessage) {
  return {
    sourceChannel: normalizeSourceChannel(
      recognition.sourceChannel ?? sourceMessage?.sourceChannel ?? batch.sourceChannel,
    ),
    sourceChatId: normalizeSourceId(
      recognition.sourceChatId ?? sourceMessage?.sourceChatId ?? sourceMessage?.chatId,
    ) ?? 'unknown-chat',
    sourceMessageId: normalizeSourceId(
      recognition.sourceMessageId ?? sourceMessage?.sourceMessageId ?? recognition.messageId,
    ) ?? 'unknown-message',
  };
}

function findBatchMessage(batch, recognition) {
  const sourceMessageId = normalizeSourceId(recognition.sourceMessageId);
  return (batch.messages ?? []).find((message) =>
    (sourceMessageId && normalizeSourceId(message.sourceMessageId) === sourceMessageId)
      || message.messageId === recognition.messageId
  ) ?? null;
}

function buildRecognitionId({ identity, cacheKey, pipelineVersion, schemaVersion, model }) {
  const digest = createHash('sha256').update(JSON.stringify({
    ...identity,
    cacheKey: cacheKey ?? null,
    pipelineVersion: pipelineVersion ?? null,
    schemaVersion: schemaVersion ?? null,
    model: model ?? null,
  })).digest('hex');
  return `recognition:${digest}`;
}

function toTimestamp(message) {
  const dateUnix = Number(message.dateUnix);
  if (Number.isFinite(dateUnix) && dateUnix > 0) {
    return new Date(dateUnix * 1000).toISOString();
  }
  const createTimeMs = Number(message.createTimeMs);
  return Number.isFinite(createTimeMs) && createTimeMs > 0
    ? new Date(createTimeMs).toISOString()
    : null;
}

function stringifyNullableJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function normalizeSourceChannel(value) {
  return normalizeSourceId(value) ?? 'telegram';
}

function normalizeSourceId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function normalizeBigIntValue(value) {
  const text = normalizeSourceId(value);
  return text && /^-?\d+$/.test(text) ? text : null;
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function buildRecognitionAiCallLog({ batch, recognition, sourceMessage, processedAt }) {
  const model = normalizeSourceId(recognition.model);
  if (!model) {
    return null;
  }
  const identity = resolveRecognitionIdentity(batch, recognition, sourceMessage);
  const taskId = normalizeSourceId(batch.batchId)
    ?? [identity.sourceChannel, identity.sourceChatId, identity.sourceMessageId].join(':');
  const idempotencyKey = normalizeSourceId(recognition.aiIdempotencyKey ?? recognition.idempotencyKey);
  const usage = normalizeAiUsage(recognition.aiUsage ?? recognition.usage);
  const occurredAt = processedAt.toISOString();
  const aiCallId = `ai-call:recognition:${createHash('sha256').update(JSON.stringify({
    scene: 'recognition',
    taskId,
    messageId: identity.sourceMessageId,
    idempotencyKey,
    model,
  })).digest('hex')}`;
  return {
    aiCallId,
    taskId,
    scene: 'recognition',
    provider: normalizeSourceId(recognition.provider ?? recognition.providerName) ?? 'openai-compatible',
    model,
    promptVersion: normalizeSourceId(recognition.promptVersion),
    idempotencyKey,
    status: 'succeeded',
    latencyMs: normalizeNonNegativeInteger(recognition.aiLatencyMs ?? recognition.latencyMs),
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
