import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SyncDispatchQueue,
  TelegramAlbumBuffer,
  handleTelegramWebhook,
} from '../cloudflare/sync-dispatch-worker.mjs';
import { TELEGRAM_HELP_TEXT } from '../src/telegram/help.mjs';

function createEnv() {
  return {
    GITHUB_OWNER: 'soulgo',
    GITHUB_REPO: 'training_records',
    GITHUB_TOKEN: 'github-token',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_SECRET_TOKEN: 'secret-token',
  };
}

test('handleTelegramWebhook dispatches non-album telegram updates to GitHub immediately', async () => {
  const calls = [];
  const request = new Request('https://worker.example.com', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'secret-token',
    },
    body: JSON.stringify({
      update_id: 123,
      message: {
        message_id: 1,
      },
    }),
  });

  const response = await handleTelegramWebhook(request, createEnv(), {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/soulgo/training_records/dispatches');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'telegram_update',
    client_payload: {
      telegram_updates: [
        {
          update_id: 123,
          message: {
            message_id: 1,
          },
        },
      ],
    },
  });
});

test('handleTelegramWebhook falls back to the documented repository when owner and repo are omitted', async () => {
  const calls = [];
  const request = new Request('https://worker.example.com', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'secret-token',
    },
    body: JSON.stringify({
      update_id: 124,
      message: {
        message_id: 2,
      },
    }),
  });

  const response = await handleTelegramWebhook(
    request,
    {
      GITHUB_TOKEN: 'github-token',
      TELEGRAM_SECRET_TOKEN: 'secret-token',
    },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      },
    },
  );

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/soulgo/training_records/dispatches');
});

test('handleTelegramWebhook dispatches with a configured GitHub event type', async () => {
  const calls = [];
  const request = createTelegramRequest({
    update_id: 128,
    message: {
      message_id: 8,
    },
  });

  const response = await handleTelegramWebhook(
    request,
    {
      ...createEnv(),
      GITHUB_DISPATCH_EVENT_TYPE: 'telegram_update_dev',
    },
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

test('handleTelegramWebhook enqueues non-album telegram updates when the sync dispatch queue is bound', async () => {
  const enqueued = [];
  const request = createTelegramRequest({
    update_id: 123,
    message: {
      message_id: 1,
      chat: { id: 42 },
      text: '/随想 第一条',
    },
  });

  const response = await handleTelegramWebhook(request, {
    ...createEnv(),
    GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM: 'telegram_update_dev',
    SYNC_DISPATCH_QUEUE: createSyncDispatchQueueNamespace(enqueued),
  }, {
    fetchImpl: async () => {
      throw new Error('GitHub dispatch should be handled by the queue');
    },
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    updateId: 123,
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].event_type, 'telegram_update_dev');
  assert.deepEqual(enqueued[0].client_payload, {
    telegram_updates: [
      {
        update_id: 123,
        message: {
          message_id: 1,
          chat: { id: 42 },
          text: '/随想 第一条',
        },
      },
    ],
  });
});

test('handleTelegramWebhook prefers the Telegram-specific dispatch event type', async () => {
  const calls = [];
  const response = await handleTelegramWebhook(
    createTelegramRequest({
      update_id: 129,
      message: {
        message_id: 9,
      },
    }),
    {
      ...createEnv(),
      GITHUB_DISPATCH_EVENT_TYPE: 'legacy_dev_event',
      GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM: 'telegram_update_dev',
    },
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

test('handleTelegramWebhook notifies Telegram when the GitHub token is missing', async () => {
  const calls = [];
  const request = createTelegramRequest({
    update_id: 125,
    message: {
      message_id: 5,
      chat: { id: 42 },
      text: '/随想 今天训练后背阔发力更明显',
    },
  });

  const response = await handleTelegramWebhook(
    request,
    {
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_SECRET_TOKEN: 'secret-token',
    },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  );

  assert.equal(response.status, 500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bottelegram-token/sendMessage');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, 42);
  assert.equal(body.reply_to_message_id, 5);
  assert.match(body.text, /GitHub Action 未能启动/);
  assert.match(body.text, /missing_github_token/);
});

test('handleTelegramWebhook notifies Telegram when GitHub dispatch fails', async () => {
  const calls = [];
  const request = createTelegramRequest({
    update_id: 126,
    message: {
      message_id: 6,
      chat: { id: 42 },
      photo: [{ file_id: 'file-a' }],
    },
  });

  const response = await handleTelegramWebhook(request, createEnv(), {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (String(url).includes('/dispatches')) {
        return new Response('bad credentials', { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 102 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(response.status, 502);
  assert.equal(calls.length, 2);
  const telegramCall = calls.find((call) => String(call.url).includes('/sendMessage'));
  assert.ok(telegramCall);
  const body = JSON.parse(telegramCall.init.body);
  assert.equal(body.chat_id, 42);
  assert.equal(body.reply_to_message_id, 6);
  assert.match(body.text, /GitHub Action 未能启动/);
  assert.match(body.text, /github_dispatch_failed/);
  assert.match(body.text, /401/);
});

test('handleTelegramWebhook replies to help messages without dispatching GitHub Actions', async () => {
  const calls = [];
  const request = createTelegramRequest({
    update_id: 130,
    message: {
      message_id: 3,
      chat: { id: 42 },
      text: '帮助',
    },
  });

  const response = await handleTelegramWebhook(request, createEnv(), {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    handled: 'help',
    updateId: 130,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bottelegram-token/sendMessage');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    chat_id: 42,
    text: TELEGRAM_HELP_TEXT,
    reply_to_message_id: 3,
    disable_web_page_preview: true,
  });
});

test('handleTelegramWebhook can reply to help messages without a GitHub token', async () => {
  const calls = [];
  const request = createTelegramRequest({
    update_id: 131,
    message: {
      message_id: 4,
      chat: { id: 42 },
      text: '/help',
    },
  });

  const response = await handleTelegramWebhook(
    request,
    {
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_SECRET_TOKEN: 'secret-token',
    },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    handled: 'help',
    updateId: 131,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bottelegram-token/sendMessage');
});

test('handleTelegramWebhook treats /帮助 and bare help as local help commands', async () => {
  for (const [text, updateId] of [
    ['/帮助', 132],
    ['help', 133],
  ]) {
    const calls = [];
    const request = createTelegramRequest({
      update_id: updateId,
      message: {
        message_id: updateId - 120,
        chat: { id: 42 },
        text,
      },
    });

    const response = await handleTelegramWebhook(request, createEnv(), {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, result: { message_id: updateId } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).handled, 'help');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.telegram.org/bottelegram-token/sendMessage');
  }
});

test('handleTelegramWebhook buffers album updates and dispatches them together after the alarm fires', async () => {
  const calls = [];
  const env = createEnv();
  const namespace = createAlbumBufferNamespace(env, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });

  const firstResponse = await handleTelegramWebhook(
    createTelegramRequest({
      update_id: 201,
      message: {
        message_id: 21,
        media_group_id: 'album-1',
        chat: { id: 42 },
        photo: [{ file_id: 'photo-21' }],
      },
    }),
    {
      ...env,
      TELEGRAM_ALBUM_BUFFER: namespace,
    },
  );

  const secondResponse = await handleTelegramWebhook(
    createTelegramRequest({
      update_id: 202,
      message: {
        message_id: 22,
        media_group_id: 'album-1',
        chat: { id: 42 },
        photo: [{ file_id: 'photo-22' }],
      },
    }),
    {
      ...env,
      TELEGRAM_ALBUM_BUFFER: namespace,
    },
  );

  assert.equal(firstResponse.status, 202);
  assert.equal(secondResponse.status, 202);
  assert.equal(calls.length, 0);

  await namespace.flush('42:images');

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'telegram_update',
    client_payload: {
      telegram_updates: [
        {
          update_id: 201,
          message: {
            message_id: 21,
            media_group_id: 'album-1',
            chat: { id: 42 },
            photo: [{ file_id: 'photo-21' }],
          },
        },
        {
          update_id: 202,
          message: {
            message_id: 22,
            media_group_id: 'album-1',
            chat: { id: 42 },
            photo: [{ file_id: 'photo-22' }],
          },
        },
      ],
    },
  });
});

test('TelegramAlbumBuffer enqueues a buffered image burst as one sync dispatch queue task', async () => {
  const enqueued = [];
  const env = {
    ...createEnv(),
    GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM: 'telegram_update_dev',
    SYNC_DISPATCH_QUEUE: createSyncDispatchQueueNamespace(enqueued),
  };
  const namespace = createAlbumBufferNamespace(env);
  const workerEnv = {
    ...env,
    TELEGRAM_ALBUM_BUFFER: namespace,
  };

  for (const update of [
    {
      update_id: 202,
      message: {
        message_id: 22,
        media_group_id: 'album-1',
        chat: { id: 42 },
        photo: [{ file_id: 'photo-22' }],
      },
    },
    {
      update_id: 201,
      message: {
        message_id: 21,
        media_group_id: 'album-1',
        chat: { id: 42 },
        photo: [{ file_id: 'photo-21' }],
      },
    },
  ]) {
    const response = await handleTelegramWebhook(createTelegramRequest(update), workerEnv);
    assert.equal(response.status, 202);
  }

  await namespace.flush('42:images');

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].client_payload.telegram_updates.map((update) => update.update_id), [201, 202]);
});

test('SyncDispatchQueue processes queued tasks FIFO and continues after a failed workflow run', async () => {
  const state = createDurableObjectState();
  const dispatched = [];
  const runs = [
    { id: 101, status: 'completed', conclusion: 'failure' },
    { id: 102, status: 'completed', conclusion: 'success' },
    { id: 103, status: 'completed', conclusion: 'success' },
  ];
  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
    __now: () => 1_000,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        return Response.json({
          workflow_runs: [
            {
              id: runs[dispatched.length - 1].id,
              created_at: '2026-06-17T00:00:01Z',
              event: 'repository_dispatch',
            },
          ],
        });
      }
      const runId = Number(urlText.match(/\/actions\/runs\/(\d+)/)?.[1]);
      const run = runs.find((item) => item.id === runId);
      return Response.json({
        id: run.id,
        status: run.status,
        conclusion: run.conclusion,
        html_url: `https://github.com/soulgo/training_records/actions/runs/${run.id}`,
      });
    },
  });

  for (const updateId of [1, 2, 3]) {
    assert.equal((await queue.fetch(createQueueRequest({
      event_type: 'telegram_update_dev',
      client_payload: { telegram_updates: [{ update_id: updateId }] },
      source: { channel: 'telegram', sortKey: updateId },
    }))).status, 202);
  }

  for (let i = 0; i < 9; i += 1) {
    await queue.alarm();
  }

  assert.deepEqual(
    dispatched.map((body) => body.client_payload.telegram_updates[0].update_id),
    [1, 2, 3],
  );
  assert.deepEqual(await state.storage.get('queue'), []);
  assert.equal(await state.storage.get('processing'), undefined);
});

test('SyncDispatchQueue does not dispatch a task twice while waiting for the workflow run to appear', async () => {
  const state = createDurableObjectState();
  const dispatched = [];
  let lookupCount = 0;
  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
    __now: () => 1_000,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        lookupCount += 1;
        return Response.json({
          workflow_runs: lookupCount === 1 ? [] : [
            {
              id: 201,
              created_at: '2026-06-17T00:00:01Z',
              event: 'repository_dispatch',
            },
          ],
        });
      }
      return Response.json({
        id: 201,
        status: 'completed',
        conclusion: 'success',
      });
    },
  });

  assert.equal((await queue.fetch(createQueueRequest({
    event_type: 'telegram_update_dev',
    client_payload: { telegram_updates: [{ update_id: 1 }] },
    source: { channel: 'telegram', sortKey: 1 },
  }))).status, 202);

  await queue.alarm();
  await queue.alarm();
  await queue.alarm();

  assert.equal(dispatched.length, 1);
  assert.deepEqual(await state.storage.get('queue'), []);
  assert.equal(await state.storage.get('processing'), undefined);
});

test('handleTelegramWebhook buffers consecutive image batches from the same chat in update order', async () => {
  const calls = [];
  const env = createEnv();
  const recordDispatch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };
  const namespace = createAlbumBufferNamespace(env, {
    fetchImpl: recordDispatch,
  });
  const workerEnv = {
    ...env,
    TELEGRAM_ALBUM_BUFFER: namespace,
  };

  const updates = [
    {
      update_id: 402,
      message: {
        message_id: 42,
        media_group_id: 'album-a',
        chat: { id: 42 },
        photo: [{ file_id: 'photo-42' }],
      },
    },
    {
      update_id: 401,
      message: {
        message_id: 41,
        media_group_id: 'album-a',
        chat: { id: 42 },
        photo: [{ file_id: 'photo-41' }],
      },
    },
    {
      update_id: 403,
      message: {
        message_id: 43,
        chat: { id: 42 },
        photo: [{ file_id: 'photo-43' }],
      },
    },
  ];

  for (const update of updates) {
    const response = await handleTelegramWebhook(createTelegramRequest(update), workerEnv, {
      fetchImpl: recordDispatch,
    });
    assert.equal(response.status, 202);
  }

  assert.equal(calls.length, 0);

  await namespace.flush('42:images');

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'telegram_update',
    client_payload: {
      telegram_updates: [
        {
          update_id: 401,
          message: {
            message_id: 41,
            media_group_id: 'album-a',
            chat: { id: 42 },
            photo: [{ file_id: 'photo-41' }],
          },
        },
        {
          update_id: 402,
          message: {
            message_id: 42,
            media_group_id: 'album-a',
            chat: { id: 42 },
            photo: [{ file_id: 'photo-42' }],
          },
        },
        {
          update_id: 403,
          message: {
            message_id: 43,
            chat: { id: 42 },
            photo: [{ file_id: 'photo-43' }],
          },
        },
      ],
    },
  });
});

test('TelegramAlbumBuffer keeps the image burst window open as more updates arrive', async () => {
  const originalNow = Date.now;
  const state = createDurableObjectState();
  const buffer = new TelegramAlbumBuffer(state, {
    ...createEnv(),
    __dispatchFetchImpl: async () => new Response(null, { status: 204 }),
  });

  try {
    Date.now = () => 1_000;
    await buffer.fetch(
      new Request('https://worker.example.com/buffer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update: {
            update_id: 410,
            message: { message_id: 50, chat: { id: 42 }, photo: [{ file_id: 'photo-50' }] },
          },
        }),
      }),
    );
    assert.equal(await state.getAlarm(), 4_000);

    Date.now = () => 2_500;
    await buffer.fetch(
      new Request('https://worker.example.com/buffer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update: {
            update_id: 411,
            message: { message_id: 51, chat: { id: 42 }, photo: [{ file_id: 'photo-51' }] },
          },
        }),
      }),
    );

    assert.equal(await state.getAlarm(), 5_500);
  } finally {
    Date.now = originalNow;
  }
});

test('TelegramAlbumBuffer deduplicates repeated updates inside the same album batch', async () => {
  const calls = [];
  const env = {
    ...createEnv(),
    __dispatchFetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  };
  const state = createDurableObjectState();
  const buffer = new TelegramAlbumBuffer(state, env);
  const requestBody = {
    update: {
      update_id: 301,
      message: {
        message_id: 31,
        media_group_id: 'album-dup',
        chat: { id: 7 },
      },
    },
  };

  await buffer.fetch(
    new Request('https://worker.example.com/buffer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }),
  );
  await buffer.fetch(
    new Request('https://worker.example.com/buffer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }),
  );
  await buffer.alarm();

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'telegram_update',
    client_payload: {
      telegram_updates: [
        {
          update_id: 301,
          message: {
            message_id: 31,
            media_group_id: 'album-dup',
            chat: { id: 7 },
          },
        },
      ],
    },
  });
});

test('TelegramAlbumBuffer dispatches with a configured GitHub event type after the alarm fires', async () => {
  const calls = [];
  const env = {
    ...createEnv(),
    GITHUB_DISPATCH_EVENT_TYPE: 'telegram_update_dev',
    __dispatchFetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  };
  const state = createDurableObjectState();
  const buffer = new TelegramAlbumBuffer(state, env);

  await buffer.fetch(
    new Request('https://worker.example.com/buffer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        update: {
          update_id: 302,
          message: {
            message_id: 32,
            media_group_id: 'album-dev',
            chat: { id: 7 },
          },
        },
      }),
    }),
  );
  await buffer.alarm();

  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).event_type, 'telegram_update_dev');
});

test('handleTelegramWebhook rejects requests with the wrong Telegram secret', async () => {
  const request = new Request('https://worker.example.com', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
    },
    body: JSON.stringify({ update_id: 123 }),
  });

  const response = await handleTelegramWebhook(request, createEnv(), {
    fetchImpl: async () => {
      throw new Error('GitHub dispatch should not run when the secret is invalid');
    },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'unauthorized',
  });
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

function createQueueRequest(payload) {
  return new Request('https://sync-dispatch-queue.internal/enqueue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
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

function createAlbumBufferNamespace(baseEnv, options = {}) {
  const instances = new Map();

  return {
    idFromName(name) {
      return { name };
    },
    get(id) {
      if (!instances.has(id.name)) {
        const state = createDurableObjectState();
        const env = {
          ...baseEnv,
          __dispatchFetchImpl: options.fetchImpl,
        };
        instances.set(id.name, {
          state,
          object: new TelegramAlbumBuffer(state, env),
        });
      }
      return instances.get(id.name).object;
    },
    async flush(name) {
      const instance = instances.get(name);
      assert.ok(instance, `missing buffered album instance for ${name}`);
      await instance.object.alarm();
    },
  };
}

function createDurableObjectState() {
  const storageMap = new Map();
  let alarmAt = null;

  return {
    storage: {
      async get(key) {
        return storageMap.get(key);
      },
      async put(key, value) {
        storageMap.set(key, value);
      },
      async delete(key) {
        storageMap.delete(key);
      },
      async deleteAll() {
        storageMap.clear();
      },
    },
    async getAlarm() {
      return alarmAt;
    },
    async setAlarm(value) {
      alarmAt = value;
    },
  };
}
