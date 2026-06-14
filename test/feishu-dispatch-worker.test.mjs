import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  FeishuImageBuffer,
  handleFeishuWebhook,
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
  assert.match(metadataLog, /"event_type":"im\.message\.receive_v1"/);
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

  const dispatchLog = logs.find((line) => line.includes('[feishu-image-buffer]'));
  assert.ok(dispatchLog);
  assert.match(dispatchLog, /"eventType":"feishu_update_dev"/);
  assert.match(dispatchLog, /"eventCount":1/);
  assert.match(dispatchLog, /"status":401/);
  assert.match(dispatchLog, /"retryCount":1/);
  assert.doesNotMatch(dispatchLog, /github-token|bad credentials/);
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
