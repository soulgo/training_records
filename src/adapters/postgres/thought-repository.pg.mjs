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

  async findBySourceIdentity(identity = {}) {
    const sourceChannel = normalizeSourceChannel(identity.sourceChannel ?? 'telegram');
    const sourceChatId = normalizeSourceId(identity.sourceChatId);
    const sourceMessageId = normalizeSourceId(identity.sourceMessageId);
    if (!sourceChatId || !sourceMessageId) {
      return null;
    }

    const result = await this.client.query(
      `
        select *
        from core.thought
        where source_channel = $1
          and source_chat_id = $2
          and source_message_id = $3
      `,
      [sourceChannel, sourceChatId, sourceMessageId],
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
      const sourceMessage = resolveThoughtSourceMessage(batch, batch.thought?.sourceMessageId ?? messageId);
      await this.save({
        messageId,
        chatId: batch.thought?.telegramChatId,
        sourceChatId: batch.thought?.sourceChatId ?? sourceMessage?.sourceChatId ?? sourceMessage?.chatId,
        sourceMessageId: batch.thought?.sourceMessageId ?? sourceMessage?.sourceMessageId ?? messageId,
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
      const sourceMessage = resolveThoughtSourceMessage(batch);
      const targetIdentity = buildTargetSourceIdentity({
        batch,
        targetMessageId,
        targetSourceMessageId: batch.thoughtEdit?.targetSourceMessageId,
        sourceChatId: batch.thoughtEdit?.sourceChatId ?? sourceMessage?.sourceChatId ?? sourceMessage?.chatId,
      });
      const existing = await this.findBySourceIdentity(targetIdentity) ?? await this.findByTelegramMessageId(targetMessageId);
      if (!existing) {
        return { status: 'not_found', messageId: targetMessageId };
      }
      const thoughtModule =
        normalizeThoughtModuleOrNull(batch.thoughtEdit?.thoughtModule) ??
        normalizeThoughtModule(existing.thought_module);
      const { sourceChannel, sourceChatId, sourceMessageId } = resolveExistingThoughtWriteIdentity({
        batch,
        existing,
        sourceMessage,
        targetMessageId,
        targetSourceMessageId: batch.thoughtEdit?.targetSourceMessageId,
        commandSourceChatId: batch.thoughtEdit?.sourceChatId,
        telegramChatId: batch.thoughtEdit?.telegramChatId,
      });

      await this.save({
        messageId: targetMessageId,
        chatId: batch.thoughtEdit?.telegramChatId,
        sourceChatId,
        sourceMessageId,
        sourceBatchId: batch.batchId,
        sourceChannel,
        command: batch.thoughtEdit?.command ?? '/thought',
        body: batch.thoughtEdit?.body ?? null,
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
      const sourceMessage = resolveThoughtSourceMessage(batch);
      const targetIdentity = buildTargetSourceIdentity({
        batch,
        targetMessageId,
        targetSourceMessageId: batch.thoughtDelete?.targetSourceMessageId,
        sourceChatId: batch.thoughtDelete?.sourceChatId ?? sourceMessage?.sourceChatId ?? sourceMessage?.chatId,
      });
      const existing = await this.findBySourceIdentity(targetIdentity) ?? await this.findByTelegramMessageId(targetMessageId);
      if (!existing) {
        return { status: 'not_found', messageId: targetMessageId };
      }
      const thoughtModule =
        normalizeThoughtModuleOrNull(batch.thoughtDelete?.thoughtModule) ??
        normalizeThoughtModule(existing.thought_module);
      const { sourceChannel, sourceChatId, sourceMessageId } = resolveExistingThoughtWriteIdentity({
        batch,
        existing,
        sourceMessage,
        targetMessageId,
        targetSourceMessageId: batch.thoughtDelete?.targetSourceMessageId,
        commandSourceChatId: batch.thoughtDelete?.sourceChatId,
        telegramChatId: batch.thoughtDelete?.telegramChatId,
      });
      await this.markDeleted({
        messageId: targetMessageId,
        chatId: batch.thoughtDelete?.telegramChatId,
        sourceChatId,
        sourceMessageId,
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
      const sourceMessage = resolveThoughtSourceMessage(batch);
      const targetIdentity = buildTargetSourceIdentity({
        batch,
        targetMessageId,
        targetSourceMessageId: batch.thoughtMove?.targetSourceMessageId,
        sourceChatId: batch.thoughtMove?.sourceChatId ?? sourceMessage?.sourceChatId ?? sourceMessage?.chatId,
      });
      const existing = await this.findBySourceIdentity(targetIdentity) ?? await this.findByTelegramMessageId(targetMessageId);
      if (!existing) {
        return { status: 'not_found', messageId: targetMessageId };
      }
      const thoughtModule =
        normalizeThoughtModuleOrNull(batch.thoughtMove?.thoughtModule) ??
        normalizeThoughtModule(existing.thought_module);
      const { sourceChannel, sourceChatId, sourceMessageId } = resolveExistingThoughtWriteIdentity({
        batch,
        existing,
        sourceMessage,
        targetMessageId,
        targetSourceMessageId: batch.thoughtMove?.targetSourceMessageId,
        commandSourceChatId: batch.thoughtMove?.sourceChatId,
        telegramChatId: batch.thoughtMove?.telegramChatId,
      });

      await this.save({
        messageId: targetMessageId,
        chatId: batch.thoughtMove?.telegramChatId,
        sourceChatId,
        sourceMessageId,
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
        source_chat_id,
        source_message_id,
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
      values ($1, $2, $3, $4, $14, $15, $5, coalesce($6, ''), coalesce($7, 'workout'), coalesce($8::jsonb, '["训练","随想","Telegram"]'::jsonb), $9, $10, coalesce($11::jsonb, '[]'::jsonb), $12, null, $13)
      on conflict (source_channel, source_chat_id, source_message_id) do update set
        telegram_message_id = excluded.telegram_message_id,
        telegram_chat_id = coalesce(excluded.telegram_chat_id, core.thought.telegram_chat_id),
        source_batch_id = excluded.source_batch_id,
        source_channel = coalesce(excluded.source_channel, core.thought.source_channel),
        source_chat_id = coalesce(excluded.source_chat_id, core.thought.source_chat_id),
        source_message_id = coalesce(excluded.source_message_id, core.thought.source_message_id),
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
      normalizeSourceId(thought.sourceChatId ?? thought.chatId ?? 'legacy-chat'),
      normalizeSourceId(thought.sourceMessageId ?? messageId),
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
        source_chat_id,
        source_message_id,
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
      values ($1, $2, $3, $4, $13, $14, $5, '', coalesce($6, 'workout'), coalesce($7::jsonb, '["训练","随想","Telegram"]'::jsonb), $8, $9, $10::jsonb, 'deleted', $11, $12)
      on conflict (source_channel, source_chat_id, source_message_id) do update set
        telegram_message_id = excluded.telegram_message_id,
        telegram_chat_id = coalesce(excluded.telegram_chat_id, core.thought.telegram_chat_id),
        source_batch_id = excluded.source_batch_id,
        source_channel = coalesce(excluded.source_channel, core.thought.source_channel),
        source_chat_id = coalesce(excluded.source_chat_id, core.thought.source_chat_id),
        source_message_id = coalesce(excluded.source_message_id, core.thought.source_message_id),
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
      normalizeSourceId(thought.sourceChatId ?? thought.chatId ?? 'legacy-chat'),
      normalizeSourceId(thought.sourceMessageId ?? messageId),
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
  const normalized = normalizeBigIntValue(value);
  if (normalized === null) {
    return null;
  }
  if (typeof normalized === 'number') {
    return normalized > 0 ? normalized : null;
  }
  if (normalized.startsWith('-') || normalized === '0') {
    return null;
  }
  return normalized;
}

function normalizeBigIntValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    return null;
  }
  const number = Number(text);
  return Number.isSafeInteger(number) && String(number) === text ? number : text;
}

function normalizeSourceChannel(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeSourceId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function resolveThoughtSourceMessage(batch, sourceMessageId = null) {
  const messages = batch.messages ?? [];
  if (sourceMessageId !== null && sourceMessageId !== undefined) {
    const sourceMessageText = String(sourceMessageId);
    const match = messages.find((message) =>
      String(message.sourceMessageId ?? message.messageId ?? '') === sourceMessageText
    );
    if (match) {
      return match;
    }
  }
  return messages[0] ?? null;
}

function buildTargetSourceIdentity({
  batch,
  targetMessageId,
  targetSourceMessageId = null,
  sourceChatId = null,
}) {
  return {
    sourceChannel: batch.sourceChannel ?? 'telegram',
    sourceChatId,
    sourceMessageId: targetSourceMessageId ?? targetMessageId,
  };
}

function resolveExistingThoughtWriteIdentity({
  batch,
  existing,
  sourceMessage,
  targetMessageId,
  targetSourceMessageId = null,
  commandSourceChatId = null,
  telegramChatId = null,
}) {
  return {
    sourceChannel: existing.source_channel ?? batch.sourceChannel ?? 'telegram',
    sourceChatId:
      existing.source_chat_id ??
      commandSourceChatId ??
      sourceMessage?.sourceChatId ??
      sourceMessage?.chatId ??
      telegramChatId,
    sourceMessageId: existing.source_message_id ?? targetSourceMessageId ?? targetMessageId,
  };
}
