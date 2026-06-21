import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import worker, {
  FeishuImageBuffer,
  TelegramAlbumBuffer,
  handleSyncDispatchWebhook,
} from '../cloudflare/sync-dispatch-worker.mjs';

const subtleCrypto = globalThis.crypto?.subtle ?? webcrypto.subtle;

function createEnv(overrides = {}) {
  return {
    FEISHU_ENCRYPT_KEY: 'encrypt-key',
    FEISHU_EVENT_LOGGING: 'false',
    FEISHU_VERIFICATION_TOKEN: 'verification-token',
    GITHUB_DISPATCH_EVENT_TYPE_FEISHU: 'feishu_update_dev',
    GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM: 'telegram_update_dev',
    GITHUB_OWNER: 'soulgo',
    GITHUB_REPO: 'training_records',
    GITHUB_TOKEN: 'github-token',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_SECRET_TOKEN: 'secret-token',
    ...overrides,
  };
}

test('unified dev worker routes Telegram webhook requests by secret header', async () => {
  const calls = [];
  const response = await handleSyncDispatchWebhook(
    createTelegramRequest({
      update_id: 901,
      message: { message_id: 1 },
    }),
    createEnv(),
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      },
    },
  );

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).event_type, 'telegram_update_dev');
});

test('unified dev worker routes Feishu event requests by Lark signature headers', async () => {
  const calls = [];
  const event = createFeishuImageEvent();
  const response = await handleSyncDispatchWebhook(
    createFeishuRequest(event, {
      'X-Lark-Signature': 'test-signature',
      'X-Lark-Request-Timestamp': '1710000000',
      'X-Lark-Request-Nonce': 'nonce',
    }),
    createEnv(),
    {
      skipSignatureVerification: true,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'feishu_update_dev',
    client_payload: {
      feishu_update: event,
    },
  });
});

test('unified dev worker routes plain Feishu URL verification by body shape without Lark headers', async () => {
  const response = await handleSyncDispatchWebhook(
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
        challenge: 'plain-challenge',
      },
    }),
    createEnv(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: 'plain-challenge' });
});

test('unified dev worker routes encrypted Feishu events by encrypt body without Lark headers', async () => {
  const calls = [];
  const event = createFeishuImageEvent({
    eventId: 'evt-encrypted-image',
    messageId: 'om_encrypted_image',
    imageKey: 'img_v3_encrypted',
  });
  const response = await handleSyncDispatchWebhook(
    await createEncryptedFeishuRequest(event),
    createEnv(),
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).event_type, 'feishu_update_dev');
});

test('unified dev worker rejects unknown webhook requests without consuming supported handlers', async () => {
  const response = await handleSyncDispatchWebhook(
    new Request('https://worker.example.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    }),
    createEnv(),
    {
      fetchImpl: async () => {
        throw new Error('unknown requests must not dispatch');
      },
    },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'unknown_channel',
  });
});

test('unified dev worker rejects non-POST requests before channel detection', async () => {
  const response = await worker.fetch(new Request('https://worker.example.com'), createEnv());

  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'method_not_allowed',
  });
});

test('unified dev worker logs structured alert metadata for 5xx responses', async () => {
  const logs = [];
  const response = await handleSyncDispatchWebhook(
    createTelegramRequest({
      update_id: 902,
      message: {
        message_id: 2,
        chat: { id: 42 },
        text: 'hello',
      },
    }),
    createEnv({ GITHUB_TOKEN: '' }),
    {
      logger: {
        error(message) {
          logs.push(String(message));
        },
      },
    },
  );

  assert.equal(response.status, 500);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[sync-dispatch-worker\]/);
  assert.match(logs[0], /"outcome":"worker_5xx"/);
  assert.match(logs[0], /"channel":"telegram"/);
  assert.match(logs[0], /"status":500/);
  assert.match(logs[0], /"error":"missing_github_token"/);
  assert.doesNotMatch(logs[0], /github-token|telegram-token|secret-token|hello/);
});

test('unified dev worker exports both Durable Object classes', () => {
  assert.equal(typeof TelegramAlbumBuffer, 'function');
  assert.equal(typeof FeishuImageBuffer, 'function');
});

function createTelegramRequest(update) {
  return new Request('https://worker.example.com', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'secret-token',
    },
    body: JSON.stringify(update),
  });
}

function createFeishuRequest(event, headers = {}) {
  return new Request('https://worker.example.com', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(event),
  });
}

function createFeishuImageEvent({
  eventId = 'evt-image-1',
  messageId = 'om_feishu_1',
  chatId = 'oc_chat_1',
  imageKey = 'img_v3_1',
} = {}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'im.message.receive_v1',
      token: 'verification-token',
      app_id: 'cli_a',
      create_time: '1710000000000',
    },
    event: {
      message: {
        message_id: messageId,
        chat_id: chatId,
        message_type: 'image',
        create_time: '1710000000000',
        content: JSON.stringify({ image_key: imageKey }),
      },
    },
  };
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
