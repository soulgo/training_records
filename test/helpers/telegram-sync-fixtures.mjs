export async function importTelegramSyncLib() {
  try {
    return await import('../../src/adapters/telegram/sync-batch-logic.adapter.mjs');
  } catch {
    return null;
  }
}

export async function importTelegramCommandRegistry() {
  try {
    return await import('../../src/telegram/command-registry.mjs');
  } catch {
    return null;
  }
}

export function telegramUpdate(updateId, message = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: message.messageId ?? updateId,
      date: message.date ?? 1_746_748_800,
      chat: { id: message.chatId ?? 42 },
      ...message.telegram,
    },
  };
}

export function telegramDocumentPhoto({
  fileId = 'file-a',
  fileUniqueId = 'uniq-a',
  fileName = '训练记录 2026-05-09.jpg',
  mimeType = 'image/jpeg',
} = {}) {
  return {
    file_id: fileId,
    file_unique_id: fileUniqueId,
    file_name: fileName,
    mime_type: mimeType,
  };
}

export function telegramDocumentFile({
  fileId = 'file-a',
  fileUniqueId = 'uniq-a',
  fileName = '随想.md',
  mimeType = 'text/markdown',
  fileSize,
} = {}) {
  return {
    file_id: fileId,
    file_unique_id: fileUniqueId,
    file_name: fileName,
    mime_type: mimeType,
    ...(fileSize == null ? {} : { file_size: fileSize }),
  };
}

export function telegramPhoto({
  fileId = 'file-a',
  fileUniqueId = 'uniq-a',
  width,
  height,
  fileSize,
} = {}) {
  return {
    file_id: fileId,
    file_unique_id: fileUniqueId,
    ...(width == null ? {} : { width }),
    ...(height == null ? {} : { height }),
    ...(fileSize == null ? {} : { file_size: fileSize }),
  };
}
