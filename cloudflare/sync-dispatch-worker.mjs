import {
  TelegramAlbumBuffer,
  handleTelegramWebhook,
} from './telegram-sync-dispatch-worker.mjs';
import {
  FeishuImageBuffer,
  handleFeishuWebhook,
} from './feishu-sync-dispatch-worker.mjs';
import {
  SyncDispatchQueue,
} from './sync-dispatch-queue.mjs';

export { TelegramAlbumBuffer, FeishuImageBuffer, SyncDispatchQueue, handleTelegramWebhook, handleFeishuWebhook };

const TELEGRAM_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const LARK_SIGNATURE_HEADERS = [
  'X-Lark-Signature',
  'X-Lark-Request-Timestamp',
  'X-Lark-Request-Nonce',
];

export default {
  async fetch(request, env) {
    return handleSyncDispatchWebhook(request, env);
  },
};

export async function handleSyncDispatchWebhook(request, env, options = {}) {
  if (request.method !== 'POST') {
    return await logResponseIfNeeded(jsonResponse(405, { ok: false, error: 'method_not_allowed' }), {
      env,
      options,
      channel: null,
    });
  }

  const channel = await detectSyncDispatchChannel(request);
  let response;
  if (channel === 'telegram') {
    response = await handleTelegramWebhook(request, env, options);
    return await logResponseIfNeeded(response, { env, options, channel });
  }
  if (channel === 'feishu') {
    response = await handleFeishuWebhook(request, env, options);
    return await logResponseIfNeeded(response, { env, options, channel });
  }
  return await logResponseIfNeeded(jsonResponse(400, { ok: false, error: 'unknown_channel' }), {
    env,
    options,
    channel: null,
  });
}

export async function detectSyncDispatchChannel(request) {
  if (request.headers.has(TELEGRAM_SECRET_HEADER)) {
    return 'telegram';
  }
  if (LARK_SIGNATURE_HEADERS.some((name) => request.headers.has(name))) {
    return 'feishu';
  }

  const body = await readJsonBodyClone(request);
  if (isLikelyFeishuEnvelope(body)) {
    return 'feishu';
  }
  return null;
}

async function readJsonBodyClone(request) {
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

function isLikelyFeishuEnvelope(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (typeof value.encrypt === 'string' && value.encrypt.trim()) {
    return true;
  }
  if (isFeishuUrlVerification(value)) {
    return true;
  }
  return Boolean(
    value.schema &&
    value.header &&
    typeof value.header === 'object' &&
    value.event &&
    typeof value.event === 'object'
  );
}

function isFeishuUrlVerification(value) {
  return value?.type === 'url_verification' ||
    value?.event?.type === 'url_verification' ||
    value?.header?.event_type === 'url_verification';
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function logResponseIfNeeded(response, { env, options, channel }) {
  if (response.status < 500) {
    return response;
  }
  const logger = options?.logger ?? env?.__logger ?? console;
  const metadata = {
    outcome: 'worker_5xx',
    channel,
    status: response.status,
    error: await resolveWorkerError(response),
  };
  try {
    const line = `[sync-dispatch-worker] ${JSON.stringify(metadata)}`;
    if (typeof logger?.error === 'function') {
      logger.error(line);
    } else {
      logger?.log?.(line);
    }
  } catch {
    // Diagnostic logging must not affect webhook responses.
  }
  return response;
}

async function resolveWorkerError(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  try {
    const payload = await response.clone().json();
    return payload?.error ?? null;
  } catch {
    return null;
  }
}
