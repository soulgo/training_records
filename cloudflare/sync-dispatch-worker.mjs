import {
  TelegramAlbumBuffer,
  handleTelegramWebhook,
} from './telegram-sync-dispatch-worker.mjs';
import {
  FeishuImageBuffer,
  handleFeishuWebhook,
} from './feishu-sync-dispatch-worker.mjs';

export { TelegramAlbumBuffer, FeishuImageBuffer };

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
    return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
  }

  const channel = await detectSyncDispatchChannel(request);
  if (channel === 'telegram') {
    return handleTelegramWebhook(request, env, options);
  }
  if (channel === 'feishu') {
    return handleFeishuWebhook(request, env, options);
  }
  return jsonResponse(400, { ok: false, error: 'unknown_channel' });
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
