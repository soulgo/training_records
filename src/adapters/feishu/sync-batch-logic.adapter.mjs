import { createHash } from 'node:crypto';

import { groupTelegramUpdates } from '../telegram/sync-batch-logic.adapter.mjs';

const DEFAULT_IMAGE_WINDOW_MS = 3_000;

export function normalizeFeishuMessage(event, options = {}) {
  const message = event?.event?.message ?? {};
  const header = event?.header ?? {};
  const content = parseFeishuContent(message.content);
  const sourceMessageId = normalizeText(message.message_id);
  const eventId = normalizeText(header.event_id);
  const chatId = normalizeText(message.chat_id);
  const createTimeMs = normalizeFeishuCreateTime(message.create_time ?? header.create_time);
  const messageType = normalizeText(message.message_type);
  const imageKey = normalizeText(content.image_key);
  const text = normalizeFeishuTextContent(content, messageType);
  const messageId = options.messageId ?? buildStableSafeInteger(`feishu:message:${sourceMessageId || eventId}`);
  const replySourceMessageId = normalizeText(message.parent_id) || normalizeText(message.root_id);
  const replyToMessageId = replySourceMessageId
    ? buildStableSafeInteger(`feishu:message:${replySourceMessageId}`)
    : null;

  return {
    sourceChannel: 'feishu',
    eventId,
    updateId: options.updateId ?? buildStableSafeInteger(`feishu:event:${eventId || sourceMessageId}`),
    messageId,
    replyToMessageId,
    replySourceMessageId,
    sourceMessageId,
    chatId,
    sourceChatId: chatId,
    senderId: normalizeText(event?.event?.sender?.sender_id?.open_id),
    messageType,
    imageKey,
    text,
    caption: normalizeText(content.caption),
    createTimeMs,
    dateUnix: createTimeMs ? Math.floor(createTimeMs / 1000) : null,
    rawEvent: event,
  };
}

export function groupFeishuUpdates(events, options = {}) {
  const imageWindowMs = Number.isFinite(options.imageWindowMs)
    ? Math.max(0, options.imageWindowMs)
    : DEFAULT_IMAGE_WINDOW_MS;
  const normalizedMessages = (events ?? [])
    .map((event) => normalizeFeishuMessage(event))
    .filter((message) => message.sourceMessageId || message.eventId)
    .sort(compareFeishuMessages);
  const mediaGroupIds = assignFeishuImageGroups(normalizedMessages, imageWindowMs);
  const metadataByMessageId = new Map();

  const telegramUpdates = normalizedMessages.map((message) => {
    metadataByMessageId.set(message.messageId, message);
    return {
      update_id: message.updateId,
      message: {
        message_id: message.messageId,
        media_group_id: mediaGroupIds.get(message.messageId) ?? null,
        caption: message.caption,
        text: message.text,
        chat: { id: message.chatId },
        date: message.dateUnix,
        ...(message.replyToMessageId
          ? {
              reply_to_message: {
                message_id: message.replyToMessageId,
              },
            }
          : {}),
        photo: message.imageKey
          ? [{
              file_id: message.imageKey,
              file_unique_id: message.imageKey,
              width: null,
              height: null,
              file_size: null,
            }]
          : [],
      },
    };
  });

  return groupTelegramUpdates(telegramUpdates, options).map((batch) =>
    attachFeishuMetadata(batch, metadataByMessageId)
  );
}

export function buildStableSafeInteger(value) {
  const seed = String(value ?? '').trim() || 'feishu:empty';
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 13);
  const numeric = Number(BigInt(`0x${hex}`));
  return numeric > 0 ? numeric : 1;
}

function parseFeishuContent(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeFeishuTextContent(content, messageType) {
  if (messageType !== 'text' && messageType !== 'post') {
    return '';
  }
  if (typeof content.text === 'string') {
    return content.text;
  }
  if (typeof content.title === 'string') {
    return content.title;
  }
  return '';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFeishuCreateTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function compareFeishuMessages(left, right) {
  return (
    String(left.chatId).localeCompare(String(right.chatId)) ||
    (left.createTimeMs ?? 0) - (right.createTimeMs ?? 0) ||
    left.messageId - right.messageId
  );
}

function assignFeishuImageGroups(messages, imageWindowMs) {
  const groupIds = new Map();
  const stateByChat = new Map();

  for (const message of messages) {
    if (!message.imageKey) {
      continue;
    }

    const chatKey = message.chatId || 'unknown';
    const previous = stateByChat.get(chatKey);
    const shouldReusePrevious =
      previous &&
      message.createTimeMs !== null &&
      previous.lastCreateTimeMs !== null &&
      message.createTimeMs - previous.lastCreateTimeMs <= imageWindowMs;
    const groupId = shouldReusePrevious
      ? previous.groupId
      : `feishu-${chatKey}-${message.createTimeMs ?? message.messageId}`;

    groupIds.set(message.messageId, groupId);
    stateByChat.set(chatKey, {
      groupId,
      lastCreateTimeMs: message.createTimeMs,
    });
  }

  return groupIds;
}

function attachFeishuMetadata(batch, metadataByMessageId) {
  const sourceBatch = {
    ...batch,
    sourceChannel: 'feishu',
    messages: (batch.messages ?? []).map((message) => attachFeishuMessageMetadata(message, metadataByMessageId)),
  };

  for (const key of ['thought', 'thoughtEdit', 'thoughtDelete', 'thoughtMove', 'analysis', 'help']) {
    if (sourceBatch[key]) {
      sourceBatch[key] = {
        ...sourceBatch[key],
        sourceChannel: 'feishu',
      };
    }
  }

  return sourceBatch;
}

function attachFeishuMessageMetadata(message, metadataByMessageId) {
  const metadata = metadataByMessageId.get(message.messageId);
  if (!metadata) {
    return message;
  }

  return {
    ...message,
    sourceChannel: 'feishu',
    sourceMessageId: metadata.sourceMessageId,
    sourceChatId: metadata.sourceChatId,
    replySourceMessageId: metadata.replySourceMessageId,
    replyToMessageId: metadata.replyToMessageId,
    eventId: metadata.eventId,
    senderId: metadata.senderId,
    messageType: metadata.messageType,
    rawEvent: metadata.rawEvent,
    photos: (message.photos ?? []).map((photo) => ({
      ...photo,
      source: 'feishu_image',
      imageKey: photo.fileId,
      sourceMessageId: metadata.sourceMessageId,
    })),
  };
}
