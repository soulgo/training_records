const GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GITHUB_OWNER = 'soulgo';
const DEFAULT_GITHUB_REPO = 'training_records';
const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const TELEGRAM_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const IMAGE_BURST_BUFFER_DELAY_MS = 3_000;

import { TELEGRAM_HELP_TEXT, isTelegramHelpText } from '../src/telegram/help.mjs';

export default {
  async fetch(request, env) {
    return handleTelegramWebhook(request, env);
  },
};

export class TelegramAlbumBuffer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(400, { ok: false, error: 'invalid_json' });
    }

    const update = payload?.update;
    if (!update) {
      return jsonResponse(400, { ok: false, error: 'missing_update' });
    }

    const updates = await readBufferedUpdates(this.state);
    if (!updates.some((item) => item?.update_id === update?.update_id)) {
      updates.push(update);
      updates.sort((left, right) => (left?.update_id ?? 0) - (right?.update_id ?? 0));
      await this.state.storage.put('updates', updates);
    }

    await setStateAlarm(this.state, Date.now() + IMAGE_BURST_BUFFER_DELAY_MS);

    return jsonResponse(202, {
      ok: true,
      buffered: true,
      updateCount: updates.length,
    });
  }

  async alarm() {
    const updates = await readBufferedUpdates(this.state);
    if (!updates.length) {
      return;
    }

    const response = await dispatchTelegramUpdates({
      fetchImpl: this.env.__dispatchFetchImpl ?? fetch,
      env: this.env,
      updates,
    });
    if (!response.ok) {
      const body = await safeReadText(response);
      for (const update of updates) {
        await notifyTelegramActionNotStarted({
          fetchImpl: this.env.__dispatchFetchImpl ?? fetch,
          env: this.env,
          update,
          reason: 'github_dispatch_failed',
          status: response.status,
          body,
        });
      }
    }

    await this.state.storage.delete('updates');
  }
}

export async function handleTelegramWebhook(request, env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
  }

  const configError = validateBaseConfig(env);
  if (configError) {
    return jsonResponse(500, { ok: false, error: configError });
  }

  const expectedSecret = env.TELEGRAM_SECRET_TOKEN.trim();
  const providedSecret = request.headers.get(TELEGRAM_SECRET_HEADER) ?? '';
  if (providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResponse(400, { ok: false, error: 'invalid_json' });
  }

  if (isTelegramHelpUpdate(update)) {
    const helpResponse = await sendTelegramHelpMessage({
      fetchImpl,
      env,
      update,
    });
    if (!helpResponse.ok) {
      return jsonResponse(502, {
        ok: false,
        error: 'telegram_help_failed',
        status: helpResponse.status,
        body: await safeReadText(helpResponse),
      });
    }

    return jsonResponse(200, {
      ok: true,
      handled: 'help',
      updateId: update?.update_id ?? null,
    });
  }

  const dispatchConfigError = validateDispatchConfig(env);
  if (dispatchConfigError) {
    await notifyTelegramActionNotStarted({
      fetchImpl,
      env,
      update,
      reason: dispatchConfigError,
    });
    return jsonResponse(500, { ok: false, error: dispatchConfigError });
  }

  const imageBufferKey = getImageBufferKey(update);
  if (imageBufferKey && env?.TELEGRAM_ALBUM_BUFFER) {
    const stubId = env.TELEGRAM_ALBUM_BUFFER.idFromName(imageBufferKey);
    const stub = env.TELEGRAM_ALBUM_BUFFER.get(stubId);
    const response = await stub.fetch(
      new Request('https://telegram-album-buffer.internal/enqueue', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ update }),
      }),
    );

    if (!response.ok) {
      return jsonResponse(502, {
        ok: false,
        error: 'album_buffer_failed',
        status: response.status,
        body: await safeReadText(response),
      });
    }

    return jsonResponse(202, {
      ok: true,
      buffered: true,
      updateId: update?.update_id ?? null,
      bufferKey: imageBufferKey,
      albumKey: imageBufferKey,
    });
  }

  const response = await dispatchTelegramUpdates({
    fetchImpl,
    env,
    updates: [update],
  });

  if (!response.ok) {
    const body = await safeReadText(response);
    await notifyTelegramActionNotStarted({
      fetchImpl,
      env,
      update,
      reason: 'github_dispatch_failed',
      status: response.status,
      body,
    });
    return jsonResponse(502, {
      ok: false,
      error: 'github_dispatch_failed',
      status: response.status,
      body,
    });
  }

  return jsonResponse(202, {
    ok: true,
    dispatched: true,
    updateId: update?.update_id ?? null,
  });
}

function validateBaseConfig(env) {
  for (const name of ['TELEGRAM_SECRET_TOKEN']) {
    if (!env?.[name]?.trim()) {
      return `missing_${name.toLowerCase()}`;
    }
  }
  return null;
}

function validateDispatchConfig(env) {
  if (!env?.GITHUB_TOKEN?.trim()) {
    return 'missing_github_token';
  }
  return null;
}

function isTelegramHelpUpdate(update) {
  const message = update?.message ?? null;
  if (!message || message.chat?.id == null) {
    return false;
  }
  return isTelegramHelpText(message.text);
}

async function sendTelegramHelpMessage({ fetchImpl, env, update }) {
  const message = update?.message ?? {};
  const botToken = env?.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return new Response('missing_telegram_bot_token', { status: 500 });
  }
  const apiBaseUrl = env?.TELEGRAM_API_BASE_URL?.trim() || TELEGRAM_API_BASE_URL;
  return fetchImpl(`${apiBaseUrl}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: message.chat.id,
      text: TELEGRAM_HELP_TEXT,
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    }),
  });
}

async function notifyTelegramActionNotStarted({ fetchImpl, env, update, reason, status, body }) {
  const message = update?.message ?? update?.edited_message ?? null;
  if (!message?.chat?.id) {
    return null;
  }

  return sendTelegramFailureMessage({
    fetchImpl,
    env,
    chatId: message.chat.id,
    replyToMessageId: message.message_id,
    text: formatActionNotStartedMessage({ reason, status, body }),
  });
}

async function sendTelegramFailureMessage({
  fetchImpl,
  env,
  chatId,
  replyToMessageId,
  text,
}) {
  const botToken = env?.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return null;
  }
  const apiBaseUrl = env?.TELEGRAM_API_BASE_URL?.trim() || TELEGRAM_API_BASE_URL;
  try {
    return await fetchImpl(`${apiBaseUrl}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
        allow_sending_without_reply: true,
        disable_web_page_preview: true,
      }),
    });
  } catch {
    return null;
  }
}

function formatActionNotStartedMessage({ reason, status, body }) {
  const details = [
    reason,
    status ? `HTTP ${status}` : '',
    summarizeText(body),
  ].filter(Boolean).join('；');
  return `GitHub Action 未能启动：${details || '未知原因'}`;
}

function summarizeText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function dispatchTelegramUpdates({ fetchImpl, env, updates }) {
  const { owner, repo } = resolveGithubRepository(env);
  const eventType = env?.GITHUB_DISPATCH_EVENT_TYPE?.trim() || 'telegram_update';
  return fetchImpl(
    `${env.GITHUB_API_BASE_URL?.trim() || GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'telegram-sync-dispatch-worker',
      },
      body: JSON.stringify({
        event_type: eventType,
        client_payload: {
          telegram_updates: updates,
        },
      }),
    },
  );
}

function resolveGithubRepository(env) {
  return {
    owner: env?.GITHUB_OWNER?.trim() || DEFAULT_GITHUB_OWNER,
    repo: env?.GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO,
  };
}

function getImageBufferKey(update) {
  const message = update?.message ?? update?.edited_message ?? null;
  const chatId = message?.chat?.id;
  if (chatId == null || !messageHasImage(message)) {
    return null;
  }
  return `${chatId}:images`;
}

function messageHasImage(message) {
  if (!message) {
    return false;
  }
  if ((message.photo ?? []).length > 0) {
    return true;
  }
  return isImageDocument(message.document);
}

function isImageDocument(document) {
  if (!document?.file_id) {
    return false;
  }
  const mimeType = document.mime_type?.trim().toLowerCase() || '';
  const fileName = document.file_name?.trim() || '';
  return mimeType.startsWith('image/') || /\.(?:jpe?g|png|webp|gif|bmp|heic|heif|tiff?)$/i.test(fileName);
}

async function readBufferedUpdates(state) {
  return (await state.storage.get('updates')) ?? [];
}

async function setStateAlarm(state, value) {
  if (typeof state.storage?.setAlarm === 'function') {
    return state.storage.setAlarm(value);
  }
  if (typeof state.setAlarm === 'function') {
    return state.setAlarm(value);
  }
  return null;
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
