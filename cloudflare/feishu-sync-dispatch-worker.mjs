import {
  buildFeishuDispatchPayload,
  enqueueSyncDispatchTask,
} from './sync-dispatch-queue.mjs';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GITHUB_OWNER = 'soulgo';
const DEFAULT_GITHUB_REPO = 'training_records';
const MESSAGE_BURST_BUFFER_DELAY_MS = 3_000;
const MESSAGE_BUFFER_RETRY_BASE_DELAY_MS = 10_000;
const MESSAGE_BUFFER_RETRY_MAX_DELAY_MS = 60_000;
const MESSAGE_BUFFER_MAX_DISPATCH_RETRIES = 5;
const DEAD_LETTER_KEY = 'deadLetters';
const DEFAULT_FEISHU_SIGNATURE_MAX_SKEW_SECONDS = 300;
const feishuSignatureReplayCache = new Map();

export default {
  async fetch(request, env) {
    return handleFeishuWebhook(request, env);
  },
};

export class FeishuImageBuffer {
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

    const event = payload?.event;
    if (!event) {
      return jsonResponse(400, { ok: false, error: 'missing_event' });
    }

    const events = await readBufferedEvents(this.state);
    const eventId = event?.header?.event_id;
    if (!events.some((item) => item?.header?.event_id === eventId)) {
      events.push(event);
      events.sort(compareFeishuEvents);
      await this.state.storage.put('events', events);
    }

    await setStateAlarm(this.state, Date.now() + MESSAGE_BURST_BUFFER_DELAY_MS);
    logFeishuMessageBuffer(this.env, this.env.__logger ?? console, {
      outcome: 'buffered',
      ...getFeishuEventMetadata(event),
      eventCount: events.length,
    });

    return jsonResponse(202, {
      ok: true,
      buffered: true,
      eventCount: events.length,
    });
  }

  async alarm() {
    const events = await readBufferedEvents(this.state);
    if (!events.length) {
      return;
    }

    const logger = this.env.__logger ?? console;
    const eventType = resolveGithubDispatchEventType(this.env);
    try {
      const response = await dispatchFeishuUpdates({
        fetchImpl: this.env.__dispatchFetchImpl ?? fetch,
        env: this.env,
        events,
      });
      if (!response.ok) {
        await scheduleMessageBufferRetry({
          state: this.state,
          env: this.env,
          logger,
          eventType,
          eventCount: events.length,
          events,
          status: response.status,
          reason: 'dispatch_failed',
        });
        return;
      }

      await this.state.storage.delete('events');
      await this.state.storage.delete('dispatchRetryCount');
      logFeishuMessageBuffer(this.env, logger, {
        outcome: 'flushed',
        eventType,
        eventCount: events.length,
        status: response.status,
        retryCount: 0,
      });
    } catch (error) {
      await scheduleMessageBufferRetry({
        state: this.state,
        env: this.env,
        logger,
        eventType,
        eventCount: events.length,
        events,
        status: null,
        error,
        reason: 'dispatch_exception',
      });
    }
  }
}

export async function handleFeishuWebhook(request, env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
  }

  const configError = validateBaseConfig(env);
  if (configError) {
    return jsonResponse(500, { ok: false, error: configError });
  }

  const body = await request.text();
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    return jsonResponse(400, { ok: false, error: 'invalid_json' });
  }

  let event;
  let encrypted = false;
  if (isFeishuEncryptedEnvelope(envelope)) {
    encrypted = true;
    try {
      event = await decryptFeishuEncryptedEvent(envelope.encrypt, env.FEISHU_ENCRYPT_KEY.trim());
    } catch {
      return jsonResponse(401, { ok: false, error: 'invalid_encrypted_payload' });
    }
  } else {
    event = envelope;
  }

  const token = getFeishuVerificationToken(event);
  if (token !== env.FEISHU_VERIFICATION_TOKEN.trim()) {
    return jsonResponse(401, { ok: false, error: 'invalid_token' });
  }

  if (isFeishuUrlVerification(event)) {
    return jsonResponse(200, { challenge: getFeishuChallenge(event) });
  }

  if (!encrypted && !options.skipSignatureVerification) {
    const maxSkewSeconds = parseFeishuSignatureMaxSkewSeconds(env.FEISHU_SIGNATURE_MAX_SKEW_SECONDS);
    const signatureOk = await verifyFeishuSignature(request, body, env.FEISHU_ENCRYPT_KEY.trim(), {
      maxSkewSeconds,
      nowSeconds: options.nowSeconds,
    });
    if (!signatureOk) {
      return jsonResponse(401, { ok: false, error: 'unauthorized' });
    }
    logFeishuSignatureReplayWarning(request, {
      logger: options.logger ?? console,
      maxSkewSeconds,
      nowSeconds: options.nowSeconds,
    });
  }

  if (event?.header?.event_type !== 'im.message.receive_v1') {
    return jsonResponse(200, { ok: true, ignored: true });
  }

  if (!isAllowedChat(event?.event?.message?.chat_id, env.FEISHU_ALLOWED_CHAT_IDS)) {
    return jsonResponse(403, { ok: false, error: 'chat_not_allowed' });
  }

  logFeishuEventMetadata(event, env, options.logger ?? console);

  const dispatchConfigError = validateDispatchConfig(env);
  if (dispatchConfigError) {
    return jsonResponse(500, { ok: false, error: dispatchConfigError });
  }

  const messageBufferKey = getMessageBufferKey(event);
  if (messageBufferKey && env?.FEISHU_IMAGE_BUFFER) {
    const stubId = env.FEISHU_IMAGE_BUFFER.idFromName(messageBufferKey);
    const stub = env.FEISHU_IMAGE_BUFFER.get(stubId);
    const response = await stub.fetch(
      new Request('https://feishu-message-buffer.internal/enqueue', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ event }),
      }),
    );

    if (!response.ok) {
      return jsonResponse(502, {
        ok: false,
        error: 'message_buffer_failed',
        status: response.status,
        body: await safeReadText(response),
      });
    }

    logFeishuMessageBuffer(env, options.logger ?? console, {
      outcome: 'accepted',
      bufferKey: messageBufferKey,
      ...getFeishuEventMetadata(event),
    });

    return jsonResponse(200, {
      ok: true,
      buffered: true,
      eventId: event?.header?.event_id ?? null,
      bufferKey: messageBufferKey,
    });
  }

  const response = await dispatchFeishuUpdates({
    fetchImpl,
    env,
    events: [event],
  });

  if (!response.ok) {
    return jsonResponse(502, {
      ok: false,
      error: 'github_dispatch_failed',
      status: response.status,
      body: await safeReadText(response),
    });
  }

  return jsonResponse(200, {
    ok: true,
    [response.queued ? 'queued' : 'dispatched']: true,
    eventId: event?.header?.event_id ?? null,
  });
}

function isAllowedChat(chatId, configuredIds) {
  const values = String(configuredIds ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || !chatId) {
    return true;
  }
  return values.includes(String(chatId));
}

export async function verifyFeishuSignature(request, body, encryptKey, options = {}) {
  const timestamp = request.headers.get('X-Lark-Request-Timestamp');
  const nonce = request.headers.get('X-Lark-Request-Nonce');
  const signature = request.headers.get('X-Lark-Signature');
  if (!timestamp || !nonce || !signature || !encryptKey) {
    return false;
  }
  if (!isFeishuSignatureTimestampFresh(timestamp, options)) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}${nonce}${encryptKey}${body}`),
  );
  const expected = [...new Uint8Array(signed)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return expected === signature;
}

function isFeishuSignatureTimestampFresh(timestamp, options = {}) {
  if (!/^\d+$/.test(timestamp)) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return false;
  }
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxSkewSeconds = options.maxSkewSeconds ?? DEFAULT_FEISHU_SIGNATURE_MAX_SKEW_SECONDS;
  return Math.abs(nowSeconds - timestampSeconds) <= maxSkewSeconds;
}

function parseFeishuSignatureMaxSkewSeconds(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_FEISHU_SIGNATURE_MAX_SKEW_SECONDS;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_FEISHU_SIGNATURE_MAX_SKEW_SECONDS;
  }
  return parsed;
}

function logFeishuSignatureReplayWarning(request, options = {}) {
  const timestamp = request.headers.get('X-Lark-Request-Timestamp');
  const nonce = request.headers.get('X-Lark-Request-Nonce');
  const signature = request.headers.get('X-Lark-Signature');
  const cacheKey = `feishu-signature:${timestamp}:${nonce}:${signature}`;
  const maxSkewSeconds = options.maxSkewSeconds ?? DEFAULT_FEISHU_SIGNATURE_MAX_SKEW_SECONDS;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  pruneFeishuSignatureReplayCache(nowSeconds);

  const expiresAt = feishuSignatureReplayCache.get(cacheKey);
  if (expiresAt && expiresAt >= nowSeconds) {
    options.logger?.warn?.(JSON.stringify({
      tag: '[feishu-signature]',
      outcome: 'replay_warning',
      timestamp,
      nonce,
    }));
    return;
  }
  feishuSignatureReplayCache.set(cacheKey, nowSeconds + maxSkewSeconds);
}

function pruneFeishuSignatureReplayCache(nowSeconds) {
  for (const [cacheKey, expiresAt] of feishuSignatureReplayCache.entries()) {
    if (expiresAt < nowSeconds) {
      feishuSignatureReplayCache.delete(cacheKey);
    }
  }
}

async function decryptFeishuEncryptedEvent(encryptedPayload, encryptKey) {
  const encryptedBytes = base64ToBytes(encryptedPayload);
  if (encryptedBytes.length <= 16 || (encryptedBytes.length - 16) % 16 !== 0) {
    throw new Error('invalid_encrypted_payload');
  }

  const encoder = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(encryptKey));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: encryptedBytes.slice(0, 16) },
    key,
    encryptedBytes.slice(16),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function base64ToBytes(value) {
  const input = String(value ?? '').trim();
  if (!input) {
    return new Uint8Array();
  }
  if (typeof atob === 'function') {
    const binary = atob(input);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(input, 'base64'));
  }
  throw new Error('base64_decode_unavailable');
}

function validateBaseConfig(env) {
  for (const name of ['FEISHU_ENCRYPT_KEY', 'FEISHU_VERIFICATION_TOKEN']) {
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

function getFeishuVerificationToken(event) {
  return event?.header?.token ?? event?.event?.token ?? event?.token ?? '';
}

function isFeishuEncryptedEnvelope(event) {
  return typeof event?.encrypt === 'string' && event.encrypt.trim().length > 0;
}

function isFeishuUrlVerification(event) {
  return event?.type === 'url_verification' ||
    event?.event?.type === 'url_verification' ||
    event?.header?.event_type === 'url_verification';
}

function getFeishuChallenge(event) {
  return event?.challenge ?? event?.event?.challenge ?? '';
}

function logFeishuEventMetadata(event, env, logger) {
  if (isFeishuEventLoggingDisabled(env)) {
    return;
  }

  const message = event?.event?.message ?? {};
  const metadata = {
    event_id: event?.header?.event_id ?? null,
    chat_id: message.chat_id ?? null,
    message_id: message.message_id ?? null,
    message_type: message.message_type ?? null,
  };

  try {
    logger?.log?.(`[feishu-webhook] ${JSON.stringify(metadata)}`);
  } catch {
    // Logging is only for diagnostics and must never affect callback handling.
  }
}

function isFeishuEventLoggingDisabled(env) {
  const value = String(env?.FEISHU_EVENT_LOGGING ?? 'true').trim().toLowerCase();
  return ['0', 'false', 'no', 'off'].includes(value);
}

async function dispatchFeishuUpdates({ fetchImpl, env, events }) {
  const queuePayload = buildFeishuDispatchPayload({ env, events });
  const queueResponse = await enqueueSyncDispatchTask({
    env,
    payload: queuePayload,
  });
  if (queueResponse) {
    queueResponse.queued = true;
    return queueResponse;
  }

  const { owner, repo } = resolveGithubRepository(env);
  return fetchImpl(
    `${env.GITHUB_API_BASE_URL?.trim() || GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'feishu-sync-dispatch-worker',
      },
      body: JSON.stringify({
        event_type: queuePayload.event_type,
        client_payload: queuePayload.client_payload,
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

function resolveGithubDispatchEventType(env) {
  return env?.GITHUB_DISPATCH_EVENT_TYPE_FEISHU?.trim() ||
    env?.GITHUB_DISPATCH_EVENT_TYPE?.trim() ||
    'feishu_update';
}

function getMessageBufferKey(event) {
  const message = event?.event?.message ?? null;
  if (message?.message_type === 'text') {
    return null;
  }
  if (!message?.chat_id) {
    return null;
  }
  return `${message.chat_id}:messages`;
}

async function readBufferedEvents(state) {
  return (await state.storage.get('events')) ?? [];
}

async function scheduleMessageBufferRetry({
  state,
  env,
  logger,
  eventType,
  eventCount,
  events,
  status,
  error,
  reason,
}) {
  const retryCount = Number(await state.storage.get('dispatchRetryCount') ?? 0) + 1;
  if (retryCount >= MESSAGE_BUFFER_MAX_DISPATCH_RETRIES) {
    await deadLetterFeishuMessageBuffer({
      state,
      events,
      reason,
      status,
      retryCount,
      eventType,
    });
    logFeishuMessageBuffer(env, logger, {
      outcome: 'dead_letter',
      eventType,
      eventCount,
      status,
      retryCount,
      reason,
      errorName: error instanceof Error ? error.name : null,
    });
    return;
  }

  await state.storage.put('dispatchRetryCount', retryCount);
  const retryDelayMs = calculateMessageBufferRetryDelayMs(retryCount);
  const nextAlarmAt = getNow(env) + retryDelayMs;
  await setStateAlarm(state, nextAlarmAt);
  logFeishuMessageBuffer(env, logger, {
    outcome: 'queue_failed',
    eventType,
    eventCount,
    status,
    retryCount,
    retryDelayMs,
    nextAlarmAt,
    errorName: error instanceof Error ? error.name : null,
  });
}

async function deadLetterFeishuMessageBuffer({
  state,
  events,
  reason,
  status,
  retryCount,
  eventType,
}) {
  const deadLetters = (await state.storage.get(DEAD_LETTER_KEY)) ?? [];
  deadLetters.push({
    reason,
    status,
    retryCount,
    eventType,
    failedAt: new Date(Date.now()).toISOString(),
    events: events.map(summarizeFeishuEvent),
  });
  await state.storage.put(DEAD_LETTER_KEY, deadLetters.slice(-100));
  await state.storage.delete('events');
  await state.storage.delete('dispatchRetryCount');
}

function summarizeFeishuEvent(event) {
  const message = event?.event?.message ?? {};
  return {
    event_id: event?.header?.event_id ?? null,
    message_id: message.message_id ?? null,
    chat_id: message.chat_id ?? null,
    message_type: message.message_type ?? null,
    create_time: message.create_time ?? event?.header?.create_time ?? null,
  };
}

function calculateMessageBufferRetryDelayMs(retryCount) {
  const exponent = Math.max(0, Math.min(Number(retryCount) - 1, 6));
  return Math.min(
    MESSAGE_BUFFER_RETRY_BASE_DELAY_MS * (2 ** exponent),
    MESSAGE_BUFFER_RETRY_MAX_DELAY_MS,
  );
}

function getNow(env) {
  return typeof env?.__now === 'function' ? env.__now() : Date.now();
}

function logFeishuMessageBuffer(env, logger, metadata) {
  if (isFeishuEventLoggingDisabled(env)) {
    return;
  }
  try {
    logger?.log?.(`[feishu-message-buffer] ${JSON.stringify(metadata)}`);
  } catch {
    // Diagnostic logging must never affect buffered message delivery.
  }
}

function getFeishuEventMetadata(event) {
  const message = event?.event?.message ?? {};
  return {
    event_id: event?.header?.event_id ?? null,
    message_id: message.message_id ?? null,
    chat_id: message.chat_id ?? null,
    message_type: message.message_type ?? null,
  };
}

function compareFeishuEvents(left, right) {
  const leftTime = Number(left?.event?.message?.create_time ?? left?.header?.create_time ?? 0);
  const rightTime = Number(right?.event?.message?.create_time ?? right?.header?.create_time ?? 0);
  return leftTime - rightTime || String(left?.header?.event_id ?? '').localeCompare(String(right?.header?.event_id ?? ''));
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

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
