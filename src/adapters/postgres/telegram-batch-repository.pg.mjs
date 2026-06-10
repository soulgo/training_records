export class PostgresTelegramBatchRepository {
  constructor(client) {
    if (!client?.query) {
      throw new Error('PostgresTelegramBatchRepository requires a pg client-like object');
    }
    this.client = client;
  }

  async upsertBatch(batch, payloadHash, processedAt) {
    await this.client.query(
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

  async upsertMessages(batch, processedAt) {
    for (const message of batch.messages ?? []) {
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

  async upsertRecognitions(batch, processedAt) {
    for (const recognition of batch.recognitions ?? []) {
      await this.client.query(
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

