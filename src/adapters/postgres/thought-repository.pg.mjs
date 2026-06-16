import {
  getThoughtModuleTags,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
} from '../../core/thought-modules.mjs';
import { ThoughtRepositoryPort } from '../../core/repositories/thought-repository.port.mjs';

export class PostgresThoughtRepository extends ThoughtRepositoryPort {
  constructor(client) {
    super();
    if (!client?.query) {
      throw new Error('PostgresThoughtRepository requires a pg client-like object');
    }
    this.client = client;
  }

  async findByTelegramMessageId(messageId) {
    const result = await this.client.query(
      `
        select *
        from core.thought
        where telegram_message_id = $1
      `,
      [normalizePositiveInteger(messageId)],
    );
    return result.rows[0] ?? null;
  }

  async save(thought) {
    return persistThoughtToCore(this.client, thought);
  }

  async persistMirror(batch, processedAt) {
    if (getThoughtStorageWriteStatus(batch) === 'not_found') {
      return;
    }

    if (batch.kind === 'thought') {
      const messageId = normalizePositiveInteger(batch.thought?.telegramMessageId);
      const thoughtModule = normalizeThoughtModule(batch.thought?.thoughtModule);
      const sourceChannel = batch.sourceChannel ?? 'telegram';
      await this.save({
        messageId,
        chatId: batch.thought?.telegramChatId,
        sourceBatchId: batch.batchId,
        sourceChannel,
        command: batch.thought?.command ?? '/thought',
        body: batch.thought?.body ?? '',
        thoughtModule,
        tags: batch.thought?.tags ?? getThoughtModuleTags(batch.thought?.thoughtModule, { sourceChannel }),
        messageDateUnix: batch.thought?.messageDateUnix ?? null,
        markdownPath: batch.thought?.storage?.markdownPath ?? null,
        imageRefs: batch.thought?.storage?.photoPaths ?? [],
        status: 'active',
        processedAt,
      });
      return { status: 'stored', messageId, thoughtModule };
    }

    if (batch.kind === 'thought_edit') {
      const targetMessageId = normalizePositiveInteger(batch.thoughtEdit?.targetMessageId);
      const existing = await this.findByTelegramMessageId(targetMessageId);
      if (!existing) {
        return { status: 'not_found', messageId: targetMessageId };
      }
      const thoughtModule =
        normalizeThoughtModuleOrNull(batch.thoughtEdit?.thoughtModule) ??
        normalizeThoughtModule(existing.thought_module);
      const sourceChannel = batch.sourceChannel ?? existing.source_channel ?? 'telegram';

      await this.save({
        messageId: targetMessageId,
        chatId: batch.thoughtEdit?.telegramChatId,
        sourceBatchId: batch.batchId,
        sourceChannel,
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
      return { status: 'stored', messageId: targetMessageId, thoughtModule };
    }

    if (batch.kind === 'thought_delete') {
      const targetMessageId = normalizePositiveInteger(batch.thoughtDelete?.targetMessageId);
      const existing = await this.findByTelegramMessageId(targetMessageId);
      if (!existing) {
        return { status: 'not_found', messageId: targetMessageId };
      }
      const thoughtModule =
        normalizeThoughtModuleOrNull(batch.thoughtDelete?.thoughtModule) ??
        normalizeThoughtModule(existing.thought_module);
      const sourceChannel = batch.sourceChannel ?? existing.source_channel ?? 'telegram';
      await this.markDeleted({
        messageId: targetMessageId,
        chatId: batch.thoughtDelete?.telegramChatId,
        sourceBatchId: batch.batchId,
        sourceChannel,
        command: batch.thoughtDelete?.command ?? '/随想删',
        thoughtModule: normalizeThoughtModuleOrNull(batch.thoughtDelete?.thoughtModule),
        tags: batch.thoughtDelete?.tags ?? null,
        messageDateUnix: batch.thoughtDelete?.messageDateUnix ?? null,
        markdownPath: batch.thoughtDelete?.storage?.markdownPath ?? null,
        deletedImageRefs: batch.thoughtDelete?.storage?.deletedPhotoPaths ?? [],
        processedAt,
      });
      return { status: 'stored', messageId: targetMessageId, thoughtModule };
    }

    if (batch.kind === 'thought_move') {
      const targetMessageId = normalizePositiveInteger(batch.thoughtMove?.targetMessageId);
      const existing = await this.findByTelegramMessageId(targetMessageId);
      if (!existing) {
        return { status: 'not_found', messageId: targetMessageId };
      }
      const thoughtModule =
        normalizeThoughtModuleOrNull(batch.thoughtMove?.thoughtModule) ??
        normalizeThoughtModule(existing.thought_module);
      const sourceChannel = batch.sourceChannel ?? existing.source_channel ?? 'telegram';

      await this.save({
        messageId: targetMessageId,
        chatId: batch.thoughtMove?.telegramChatId,
        sourceBatchId: batch.batchId,
        sourceChannel,
        command: batch.thoughtMove?.command ?? '/移动',
        body: null,
        thoughtModule: normalizeThoughtModuleOrNull(batch.thoughtMove?.thoughtModule),
        tags: batch.thoughtMove?.tags ?? null,
        messageDateUnix: batch.thoughtMove?.messageDateUnix ?? null,
        markdownPath: batch.thoughtMove?.storage?.markdownPath ?? null,
        imageRefs: batch.thoughtMove?.storage?.photoPaths ?? null,
        status: 'active',
        processedAt,
      });
      return { status: 'stored', messageId: targetMessageId, thoughtModule };
    }
  }

  async markDeleted(thought) {
    return markThoughtMirrorDeleted(this.client, thought);
  }

  async getMissingTargetResult(messageId) {
    if (!messageId) {
      return { status: 'not_found', messageId: null };
    }
    const existing = await this.findByTelegramMessageId(messageId);
    return existing ? null : { status: 'not_found', messageId };
  }
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
        source_channel,
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
      values ($1, $2, $3, $4, $5, coalesce($6, ''), coalesce($7, 'workout'), coalesce($8::jsonb, '["训练","随想","Telegram"]'::jsonb), $9, $10, coalesce($11::jsonb, '[]'::jsonb), $12, null, $13)
      on conflict (telegram_message_id) do update set
        telegram_chat_id = coalesce(excluded.telegram_chat_id, core.thought.telegram_chat_id),
        source_batch_id = excluded.source_batch_id,
        source_channel = coalesce(excluded.source_channel, core.thought.source_channel),
        command = excluded.command,
        body = coalesce($6, core.thought.body),
        thought_module = coalesce($7, core.thought.thought_module),
        tags_json = coalesce($8::jsonb, core.thought.tags_json),
        message_date_unix = coalesce(excluded.message_date_unix, core.thought.message_date_unix),
        markdown_path = coalesce(excluded.markdown_path, core.thought.markdown_path),
        image_refs_json = case
          when $11::jsonb is null then core.thought.image_refs_json
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
      normalizeSourceChannel(thought.sourceChannel),
      thought.command ?? '/thought',
      thought.body === null || thought.body === undefined
        ? null
        : String(thought.body).trim(),
      normalizeThoughtModuleOrNull(thought.thoughtModule),
      thought.tags ? JSON.stringify(thought.tags) : null,
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
        source_channel,
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
      values ($1, $2, $3, $4, $5, '', coalesce($6, 'workout'), coalesce($7::jsonb, '["训练","随想","Telegram"]'::jsonb), $8, $9, $10::jsonb, 'deleted', $11, $12)
      on conflict (telegram_message_id) do update set
        telegram_chat_id = coalesce(excluded.telegram_chat_id, core.thought.telegram_chat_id),
        source_batch_id = excluded.source_batch_id,
        source_channel = coalesce(excluded.source_channel, core.thought.source_channel),
        command = excluded.command,
        thought_module = coalesce($6, core.thought.thought_module),
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
      normalizeSourceChannel(thought.sourceChannel),
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

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeBigIntValue(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function normalizeSourceChannel(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
