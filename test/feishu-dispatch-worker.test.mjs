import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  FeishuImageBuffer,
  handleFeishuWebhook,
  verifyFeishuSignature,
} from '../cloudflare/feishu-sync-dispatch-worker.mjs';

const subtleCrypto = globalThis.crypto?.subtle ?? webcrypto.subtle;

function createEnv(overrides = {}) {
  return {
    FEISHU_ENCRYPT_KEY: 'encrypt-key',
    FEISHU_EVENT_LOGGING: 'false',
    FEISHU_VERIFICATION_TOKEN: 'verification-token',
    GITHUB_OWNER: 'soulgo',
    GITHUB_REPO: 'training_records',
    GITHUB_TOKEN: 'github-token',
    ...overrides,
  };
}

test('handleFeishuWebhook answers Feishu v2 URL verification without requiring signature headers', async () => {
  const response = await handleFeishuWebhook(
    createFeishuRequest({
      schema: '2.0',
      header: {
        event_id: 'evt-url-verification',
        event_type: 'url_verification',
        token: 'verification-token',
        app_id: 'cli_a',
      },
      event: {
        type: 'url_verification',
        token: 'verification-token',
        challenge: 'challenge-value',
      },
    }),
    createEnv(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: 'challenge-value' });
});

test('handleFeishuWebhook answers encrypted Feishu v2 URL verification challenges', async () => {
  const response = await handleFeishuWebhook(
    await createEncryptedFeishuRequest({
      schema: '2.0',
      header: {
        event_id: 'evt-url-verification-encrypted',
        event_type: 'url_verification',
        token: 'verification-token',
        app_id: 'cli_a',
      },
      event: {
        type: 'url_verification',
        token: 'verification-token',
        challenge: 'encrypted-challenge-value',
      },
    }),
    createEnv(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: 'encrypted-challenge-value' });
});

test('handleFeishuWebhook dispatches a single Feishu event with the singular payload field', async () => {
  const calls = [];
  const event = createFeishuImageEvent({
    eventId: 'evt-image-1',
    messageId: 'om_feishu_1',
    chatId: 'oc_chat_1',
    imageKey: 'img_v3_1',
  });
  const request = createFeishuRequest(event);

  const response = await handleFeishuWebhook(request, createEnv(), {
    skipSignatureVerification: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/soulgo/training_records/dispatches');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'feishu_update',
    client_payload: {
      feishu_update: event,
    },
  });
});

test('handleFeishuWebhook rejects disallowed chats before buffering or GitHub dispatch', async () => {
  let fetchCount = 0;
  const event = createFeishuImageEvent({
    eventId: 'evt-disallowed',
    messageId: 'om_disallowed',
    chatId: 'oc_not_allowed',
    imageKey: 'img_disallowed',
  });
  const response = await handleFeishuWebhook(
    createFeishuRequest(event),
    createEnv({ FEISHU_ALLOWED_CHAT_IDS: 'oc_chat_1' }),
    {
      skipSignatureVerification: true,
      fetchImpl: async () => { fetchCount += 1; return new Response(null, { status: 204 }); },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: 'chat_not_allowed' });
  assert.equal(fetchCount, 0);
});

test('handleFeishuWebhook enqueues single Feishu text events when the sync dispatch queue is bound', async () => {
  const enqueued = [];
  const event = createFeishuTextEvent({
    eventId: 'evt-text-queue-1',
    messageId: 'om_feishu_text_queue_1',
    chatId: 'oc_chat_1',
    text: '/随想 第一条飞书随想',
  });

  const response = await handleFeishuWebhook(createFeishuRequest(event), createEnv({
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
    SYNC_DISPATCH_QUEUE: createSyncDispatchQueueNamespace(enqueued),
  }), {
    skipSignatureVerification: true,
    fetchImpl: async () => {
      throw new Error('GitHub dispatch should be handled by the queue');
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    eventId: 'evt-text-queue-1',
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].event_type, 'feishu_update_dev');
  assert.deepEqual(enqueued[0].client_payload, {
    feishu_update: event,
  });
});

test('handleFeishuWebhook bypasses the image buffer for single Feishu text events', async () => {
  const enqueued = [];
  let env;
  const bufferNamespace = createFeishuBufferNamespace(() => env);
  env = createEnv({
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
    FEISHU_IMAGE_BUFFER: bufferNamespace,
    SYNC_DISPATCH_QUEUE: createSyncDispatchQueueNamespace(enqueued),
  });
  const firstEvent = createFeishuTextEvent({
    eventId: 'evt-text-bypass-1',
    messageId: 'om_feishu_text_bypass_1',
    chatId: 'oc_chat_1',
    text: '/随想 第一条飞书随想',
    createTime: '1781398801000',
  });

  const response = await handleFeishuWebhook(createFeishuRequest(firstEvent), env, {
    skipSignatureVerification: true,
    fetchImpl: async () => {
      throw new Error('GitHub dispatch should be handled by the queue');
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    eventId: 'evt-text-bypass-1',
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].event_type, 'feishu_update_dev');
  assert.deepEqual(enqueued[0].client_payload, {
    feishu_update: firstEvent,
  });
});

test('handleFeishuWebhook enqueues consecutive Feishu text messages as ordered queue tasks', async () => {
  const enqueued = [];
  let env;
  const bufferNamespace = createFeishuBufferNamespace(() => env);
  env = createEnv({
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
    FEISHU_IMAGE_BUFFER: bufferNamespace,
    SYNC_DISPATCH_QUEUE: createSyncDispatchQueueNamespace(enqueued),
  });
  const firstEvent = createFeishuTextEvent({
    eventId: 'evt-text-immediate-1',
    messageId: 'om_feishu_text_immediate_1',
    chatId: 'oc_chat_1',
    text: '/随想编 600 身体反馈 第一条',
    createTime: '1781398801000',
  });
  const secondEvent = createFeishuTextEvent({
    eventId: 'evt-text-immediate-2',
    messageId: 'om_feishu_text_immediate_2',
    chatId: 'oc_chat_1',
    text: '/随想编 601 杂七杂八 第二条',
    createTime: '1781398802000',
  });

  const firstResponse = await handleFeishuWebhook(createFeishuRequest(firstEvent), env, {
    skipSignatureVerification: true,
    fetchImpl: async () => {
      throw new Error('GitHub dispatch should be handled by the queue');
    },
  });
  const secondResponse = await handleFeishuWebhook(createFeishuRequest(secondEvent), env, {
    skipSignatureVerification: true,
    fetchImpl: async () => {
      throw new Error('GitHub dispatch should be handled by the queue');
    },
  });

  assert.equal(firstResponse.status, 200);
  assert.deepEqual(await firstResponse.json(), {
    ok: true,
    queued: true,
    eventId: 'evt-text-immediate-1',
  });
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(await secondResponse.json(), {
    ok: true,
    queued: true,
    eventId: 'evt-text-immediate-2',
  });
  assert.equal(enqueued.length, 2);
  assert.deepEqual(enqueued.map((item) => item.source.sortKey), ['1781398801000', '1781398802000']);
  assert.deepEqual(enqueued.map((item) => item.client_payload.feishu_update.header.event_id), [
    'evt-text-immediate-1',
    'evt-text-immediate-2',
  ]);
});

test('handleFeishuWebhook dispatches encrypted Feishu events without Lark signature headers', async () => {
  const calls = [];
  const event = createFeishuImageEvent({
    eventId: 'evt-image-encrypted-1',
    messageId: 'om_feishu_encrypted_1',
    chatId: 'oc_chat_1',
    imageKey: 'img_v3_encrypted_1',
  });
  const request = await createEncryptedFeishuRequest(event);

  const response = await handleFeishuWebhook(request, createEnv({
    GITHUB_DISPATCH_EVENT_TYPE: 'feishu_update_dev',
  }), {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/soulgo/training_records/dispatches');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'feishu_update_dev',
    client_payload: {
      feishu_update: event,
    },
  });
});

test('verifyFeishuSignature rejects signed requests outside the timestamp freshness window', async () => {
  const nowSeconds = 1_781_398_800;
  const event = createFeishuTextEvent({
    eventId: 'evt-signature-timestamp-window',
    messageId: 'om_feishu_signature_timestamp_window',
    chatId: 'oc_chat_1',
    text: '/随想 timestamp freshness',
  });

  const current = await createSignedFeishuRequest(event, {
    timestamp: String(nowSeconds),
    nonce: 'nonce-current',
  });
  const currentBody = await current.clone().text();
  assert.equal(
    await verifyFeishuSignature(current, currentBody, 'encrypt-key', { nowSeconds }),
    true,
  );

  const stale = await createSignedFeishuRequest(event, {
    timestamp: String(nowSeconds - 601),
    nonce: 'nonce-stale',
  });
  const staleBody = await stale.clone().text();
  assert.equal(
    await verifyFeishuSignature(stale, staleBody, 'encrypt-key', { nowSeconds }),
    false,
  );

  const future = await createSignedFeishuRequest(event, {
    timestamp: String(nowSeconds + 601),
    nonce: 'nonce-future',
  });
  const futureBody = await future.clone().text();
  assert.equal(
    await verifyFeishuSignature(future, futureBody, 'encrypt-key', { nowSeconds }),
    false,
  );
});

test('handleFeishuWebhook logs a replay warning for duplicate Feishu nonce signatures in the freshness window', async () => {
  const logs = [];
  const enqueued = [];
  const event = createFeishuTextEvent({
    eventId: 'evt-signature-replay-warning',
    messageId: 'om_feishu_signature_replay_warning',
    chatId: 'oc_chat_1',
    text: '/随想 replay warning',
  });
  const env = createEnv({
    SYNC_DISPATCH_QUEUE: createSyncDispatchQueueNamespace(enqueued),
  });
  const logger = {
    warn(message) {
      logs.push(String(message));
    },
  };
  const requestOptions = {
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: 'nonce-replay-warning',
  };

  const firstResponse = await handleFeishuWebhook(
    await createSignedFeishuRequest(event, requestOptions),
    env,
    {
      logger,
      fetchImpl: async () => {
        throw new Error('GitHub dispatch should be handled by the queue');
      },
    },
  );
  const secondResponse = await handleFeishuWebhook(
    await createSignedFeishuRequest(event, requestOptions),
    env,
    {
      logger,
      fetchImpl: async () => {
        throw new Error('GitHub dispatch should be handled by the queue');
      },
    },
  );

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(enqueued.length, 2);
  const replayLog = logs.find((line) => line.includes('[feishu-signature]') && line.includes('"outcome":"replay_warning"'));
  assert.ok(replayLog);
  assert.match(replayLog, /"nonce":"nonce-replay-warning"/);
});

test('handleFeishuWebhook prefers the Feishu-specific dispatch event type', async () => {
  const calls = [];
  const event = createFeishuImageEvent({
    eventId: 'evt-image-specific-event-type',
    messageId: 'om_feishu_specific_event_type',
    chatId: 'oc_chat_1',
    imageKey: 'img_v3_specific_event_type',
  });

  const response = await handleFeishuWebhook(createFeishuRequest(event), createEnv({
    GITHUB_DISPATCH_EVENT_TYPE: 'legacy_dev_event',
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
  }), {
    skipSignatureVerification: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).event_type, 'feishu_update_dev');
});

test('handleFeishuWebhook logs Feishu event metadata with chat id for discovery', async () => {
  const logs = [];
  const event = createFeishuImageEvent({
    eventId: 'evt-image-log-1',
    messageId: 'om_feishu_log_1',
    chatId: 'oc_chat_for_logs',
    imageKey: 'img_v3_should_not_be_logged',
  });

  const response = await handleFeishuWebhook(createFeishuRequest(event), createEnv({
    FEISHU_EVENT_LOGGING: 'true',
  }), {
    skipSignatureVerification: true,
    logger: {
      log(message) {
        logs.push(String(message));
      },
    },
    fetchImpl: async () => new Response(null, { status: 204 }),
  });

  assert.equal(response.status, 200);
  const metadataLog = logs.find((line) => line.includes('[feishu-webhook]'));
  assert.ok(metadataLog);
  assert.match(metadataLog, /"chat_id":"oc_chat_for_logs"/);
  assert.match(metadataLog, /"message_type":"image"/);
  assert.doesNotMatch(metadataLog, /img_v3_should_not_be_logged/);
});

test('FeishuImageBuffer dispatches buffered image bursts with the plural payload field', async () => {
  const calls = [];
  const state = createDurableObjectState();
  const buffer = new FeishuImageBuffer(state, createEnv({
    __dispatchFetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  }));
  const firstEvent = createFeishuImageEvent({
    eventId: 'evt-image-1',
    messageId: 'om_feishu_1',
    chatId: 'oc_chat_1',
    imageKey: 'img_v3_1',
  });
  const secondEvent = createFeishuImageEvent({
    eventId: 'evt-image-2',
    messageId: 'om_feishu_2',
    chatId: 'oc_chat_1',
    imageKey: 'img_v3_2',
    createTime: '1781398802000',
  });

  assert.equal((await buffer.fetch(createBufferRequest(firstEvent))).status, 202);
  assert.equal((await buffer.fetch(createBufferRequest(secondEvent))).status, 202);

  await buffer.alarm();

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'feishu_update',
    client_payload: {
      feishu_updates: [firstEvent, secondEvent],
    },
  });
  assert.equal(await state.storage.get('events'), undefined);
});

test('FeishuImageBuffer enqueues buffered image bursts as one sync dispatch queue task', async () => {
  const enqueued = [];
  const state = createDurableObjectState();
  const firstEvent = createFeishuImageEvent({
    eventId: 'evt-image-queue-1',
    messageId: 'om_feishu_queue_1',
    chatId: 'oc_chat_1',
    imageKey: 'img_v3_queue_1',
  });
  const secondEvent = createFeishuImageEvent({
    eventId: 'evt-image-queue-2',
    messageId: 'om_feishu_queue_2',
    chatId: 'oc_chat_1',
    imageKey: 'img_v3_queue_2',
    createTime: '1781398802000',
  });
  const buffer = new FeishuImageBuffer(state, createEnv({
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
    SYNC_DISPATCH_QUEUE: createSyncDispatchQueueNamespace(enqueued),
  }));

  assert.equal((await buffer.fetch(createBufferRequest(firstEvent))).status, 202);
  assert.equal((await buffer.fetch(createBufferRequest(secondEvent))).status, 202);

  await buffer.alarm();

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].client_payload, {
    feishu_updates: [firstEvent, secondEvent],
  });
  assert.equal(await state.storage.get('events'), undefined);
});

test('FeishuImageBuffer sorts buffered text messages with identical create_time by event id', async () => {
  const enqueued = [];
  const state = createDurableObjectState();
  const firstEvent = createFeishuTextEvent({
    eventId: 'evt-text-same-time-a',
    messageId: 'om_feishu_same_time_a',
    chatId: 'oc_chat_1',
    text: '/随想编 600 身体反馈 第一条',
    createTime: '1781398800000',
  });
  const secondEvent = createFeishuTextEvent({
    eventId: 'evt-text-same-time-b',
    messageId: 'om_feishu_same_time_b',
    chatId: 'oc_chat_1',
    text: '/随想编 601 杂七杂八 第二条',
    createTime: '1781398800000',
  });
  const buffer = new FeishuImageBuffer(state, createEnv({
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
    SYNC_DISPATCH_QUEUE: createSyncDispatchQueueNamespace(enqueued),
  }));

  assert.equal((await buffer.fetch(createBufferRequest(secondEvent))).status, 202);
  assert.equal((await buffer.fetch(createBufferRequest(firstEvent))).status, 202);

  await buffer.alarm();

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].client_payload, {
    feishu_updates: [firstEvent, secondEvent],
  });
});

test('FeishuImageBuffer enqueues a single buffered text message with the singular payload field', async () => {
  const enqueued = [];
  const state = createDurableObjectState();
  const event = createFeishuTextEvent({
    eventId: 'evt-text-single-buffer-1',
    messageId: 'om_feishu_text_single_buffer_1',
    chatId: 'oc_chat_1',
    text: '/随想编 600 身体反馈 单条',
  });
  const buffer = new FeishuImageBuffer(state, createEnv({
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
    SYNC_DISPATCH_QUEUE: createSyncDispatchQueueNamespace(enqueued),
  }));

  assert.equal((await buffer.fetch(createBufferRequest(event))).status, 202);

  await buffer.alarm();

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].client_payload, {
    feishu_update: event,
  });
});

test('FeishuImageBuffer keeps buffered events and schedules a retry when GitHub dispatch fails', async () => {
  const logs = [];
  const state = createDurableObjectState();
  const event = createFeishuImageEvent({
    eventId: 'evt-image-retry-1',
    messageId: 'om_feishu_retry_1',
    chatId: 'oc_chat_1',
    imageKey: 'img_v3_retry_1',
  });
  const buffer = new FeishuImageBuffer(state, createEnv({
    FEISHU_EVENT_LOGGING: 'true',
    GITHUB_DISPATCH_EVENT_TYPE: 'feishu_update_dev',
    __logger: {
      log(message) {
        logs.push(String(message));
      },
    },
    __dispatchFetchImpl: async () => new Response('bad credentials', { status: 401 }),
  }));

  assert.equal((await buffer.fetch(createBufferRequest(event))).status, 202);
  const firstAlarm = await state.storage.get('alarm');

  await buffer.alarm();

  assert.deepEqual(await state.storage.get('events'), [event]);
  assert.equal(await state.storage.get('dispatchRetryCount'), 1);
  assert.ok(await state.storage.get('alarm') > firstAlarm);

  const dispatchLog = logs.find((line) => line.includes('[feishu-message-buffer]') && line.includes('"outcome":"queue_failed"'));
  assert.ok(dispatchLog);
  assert.match(dispatchLog, /"eventType":"feishu_update_dev"/);
  assert.match(dispatchLog, /"eventCount":1/);
  assert.match(dispatchLog, /"status":401/);
  assert.match(dispatchLog, /"retryCount":1/);
  assert.doesNotMatch(dispatchLog, /github-token|bad credentials/);
});

test('FeishuImageBuffer keeps buffered text events and retries when sync queue enqueue fails', async () => {
  const state = createDurableObjectState();
  const event = createFeishuTextEvent({
    eventId: 'evt-text-retry-1',
    messageId: 'om_feishu_text_retry_1',
    chatId: 'oc_chat_1',
    text: '/随想编 600 身体反馈 重试',
  });
  const buffer = new FeishuImageBuffer(state, createEnv({
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
    SYNC_DISPATCH_QUEUE: createFailingSyncDispatchQueueNamespace(),
  }));

  assert.equal((await buffer.fetch(createBufferRequest(event))).status, 202);
  const firstAlarm = await state.storage.get('alarm');

  await buffer.alarm();

  assert.deepEqual(await state.storage.get('events'), [event]);
  assert.equal(await state.storage.get('dispatchRetryCount'), 1);
  assert.ok(await state.storage.get('alarm') > firstAlarm);
});

test('FeishuImageBuffer dead-letters buffered events after max dispatch retries', async () => {
  const logs = [];
  const state = createDurableObjectState();
  const event = createFeishuImageEvent({
    eventId: 'evt-image-dead-letter-1',
    messageId: 'om_feishu_dead_letter_1',
    chatId: 'oc_chat_dead_letter',
    imageKey: 'img_v3_dead_letter_1',
  });
  const buffer = new FeishuImageBuffer(state, createEnv({
    FEISHU_EVENT_LOGGING: 'true',
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
    SYNC_DISPATCH_QUEUE: createFailingSyncDispatchQueueNamespace(),
    __logger: {
      log(message) {
        logs.push(String(message));
      },
    },
  }));

  assert.equal((await buffer.fetch(createBufferRequest(event))).status, 202);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await buffer.alarm();
  }

  assert.equal(await state.storage.get('events'), undefined);
  assert.equal(await state.storage.get('dispatchRetryCount'), undefined);
  const deadLetters = await state.storage.get('deadLetters');
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].reason, 'dispatch_failed');
  assert.equal(deadLetters[0].retryCount, 5);
  assert.equal(deadLetters[0].eventType, 'feishu_update_dev');
  assert.deepEqual(deadLetters[0].events, [
    {
      event_id: 'evt-image-dead-letter-1',
      message_id: 'om_feishu_dead_letter_1',
      chat_id: 'oc_chat_dead_letter',
      message_type: 'image',
      create_time: '1781398800000',
    },
  ]);

  const deadLetterLog = logs.find((line) => line.includes('[feishu-message-buffer]') && line.includes('"outcome":"dead_letter"'));
  assert.ok(deadLetterLog);
  assert.match(deadLetterLog, /"retryCount":5/);
  assert.doesNotMatch(deadLetterLog, /img_v3_dead_letter_1/);
});

function createFeishuRequest(event) {
  return new Request('https://worker.example.com', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(event),
  });
}

async function createSignedFeishuRequest(event, {
  timestamp = String(Math.floor(Date.now() / 1000)),
  nonce = 'nonce-1',
  encryptKey = 'encrypt-key',
} = {}) {
  const body = JSON.stringify(event);
  const signature = await signFeishuRequestBody({
    timestamp,
    nonce,
    encryptKey,
    body,
  });
  return new Request('https://worker.example.com', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Lark-Request-Timestamp': timestamp,
      'X-Lark-Request-Nonce': nonce,
      'X-Lark-Signature': signature,
    },
    body,
  });
}

async function signFeishuRequestBody({
  timestamp,
  nonce,
  encryptKey,
  body,
}) {
  const encoder = new TextEncoder();
  const key = await subtleCrypto.importKey(
    'raw',
    encoder.encode(encryptKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await subtleCrypto.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}${nonce}${encryptKey}${body}`),
  );
  return [...new Uint8Array(signed)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function createEncryptedFeishuRequest(event, encryptKey = 'encrypt-key') {
  return createFeishuRequest({
    encrypt: await encryptFeishuEvent(event, encryptKey),
  });
}

async function encryptFeishuEvent(event, encryptKey) {
  const encoder = new TextEncoder();
  const keyBytes = await subtleCrypto.digest('SHA-256', encoder.encode(encryptKey));
  const iv = Uint8Array.from([
    0x66, 0x65, 0x69, 0x73, 0x68, 0x75, 0x2d, 0x69,
    0x76, 0x2d, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31,
  ]);
  const key = await subtleCrypto.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  const encrypted = await subtleCrypto.encrypt(
    { name: 'AES-CBC', iv },
    key,
    encoder.encode(JSON.stringify(event)),
  );
  const encryptedBytes = new Uint8Array(encrypted);
  const payload = new Uint8Array(iv.length + encryptedBytes.length);
  payload.set(iv, 0);
  payload.set(encryptedBytes, iv.length);
  return Buffer.from(payload).toString('base64');
}

function createBufferRequest(event) {
  return new Request('https://feishu-image-buffer.internal/enqueue', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event }),
  });
}

function createDurableObjectState() {
  const values = new Map();
  return {
    storage: {
      async get(key) {
        return values.get(key);
      },
      async put(key, value) {
        values.set(key, value);
      },
      async delete(key) {
        values.delete(key);
      },
      async setAlarm(value) {
        values.set('alarm', value);
      },
    },
  };
}

function createFeishuBufferNamespace(resolveEnv) {
  const instances = new Map();
  return {
    idFromName(name) {
      return { name };
    },
    get(id) {
      const name = id.name;
      if (!instances.has(name)) {
        const state = createDurableObjectState();
        instances.set(name, {
          object: new FeishuImageBuffer(state, resolveEnv()),
          state,
        });
      }
      return {
        fetch(request) {
          return instances.get(name).object.fetch(request);
        },
      };
    },
    async flush(name) {
      await instances.get(name).object.alarm();
    },
  };
}

function createSyncDispatchQueueNamespace(enqueued) {
  return {
    idFromName(name) {
      return { name };
    },
    get() {
      return {
        async fetch(request) {
          enqueued.push(await request.json());
          return Response.json({ ok: true, queued: true }, { status: 202 });
        },
      };
    },
  };
}

function createFailingSyncDispatchQueueNamespace() {
  return {
    idFromName(name) {
      return { name };
    },
    get() {
      return {
        async fetch() {
          return Response.json({ ok: false, error: 'queue_failed' }, { status: 503 });
        },
      };
    },
  };
}

function createFeishuImageEvent({
  eventId,
  messageId,
  chatId,
  imageKey,
  createTime = '1781398800000',
}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'im.message.receive_v1',
      create_time: createTime,
      token: 'verification-token',
      app_id: 'cli_a',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_sender_1' },
        sender_type: 'user',
      },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
        create_time: createTime,
      },
    },
  };
}

function createFeishuTextEvent({
  eventId,
  messageId,
  chatId,
  text,
  createTime = '1781398800000',
}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'im.message.receive_v1',
      create_time: createTime,
      token: 'verification-token',
      app_id: 'cli_a',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_sender_1' },
        sender_type: 'user',
      },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text }),
        create_time: createTime,
      },
    },
  };
}
