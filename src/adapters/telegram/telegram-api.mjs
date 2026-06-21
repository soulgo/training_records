import { downloadBinaryWithLimit } from '../http/download-binary.mjs';

export async function sendTelegramMessage({
  botToken,
  chatId,
  text,
  replyToMessageId = null,
  fetch: fetchImpl = globalThis.fetch,
}) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
    payload.allow_sending_without_reply = true;
  }

  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  }
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram sendMessage failed: ${result.description ?? 'unknown error'}`);
  }
  return result.result;
}

export async function resolveTelegramFileUrl(botToken, fileId) {
  const file = await resolveTelegramFileInfo(botToken, fileId);
  return file.url;
}

export async function resolveTelegramFileInfo(botToken, fileId, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!response.ok) {
    throw new Error(`Telegram getFile failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.ok || !payload.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${payload.description ?? 'missing file_path'}`);
  }
  return {
    filePath: payload.result.file_path,
    url: `https://api.telegram.org/file/bot${botToken}/${payload.result.file_path}`,
  };
}

export async function fetchTelegramFile({
  botToken,
  fileId,
  fetch: fetchImpl = globalThis.fetch,
  maxDownloadBytes,
}) {
  const file = await resolveTelegramFileInfo(botToken, fileId, fetchImpl);
  const response = await fetchImpl(file.url);
  if (!response.ok) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  }
  const data = await downloadBinaryWithLimit(response, {
    maxBytes: maxDownloadBytes,
    label: 'Telegram file download',
  });
  return {
    ...file,
    contentType: response.headers.get('content-type') ?? '',
    data,
  };
}
