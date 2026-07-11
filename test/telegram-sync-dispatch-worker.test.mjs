import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SyncDispatchQueue,
  TelegramAlbumBuffer,
  handleTelegramWebhook,
} from '../cloudflare/sync-dispatch-worker.mjs';
import { buildTelegramDispatchPayload } from '../cloudflare/sync-dispatch-queue.mjs';
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

test('handleTelegramWebhook rejects disallowed chats before buffering or GitHub dispatch', async () => {
  let fetchCount = 0;
  const response = await handleTelegramWebhook(
    createTelegramRequest({
      update_id: 122,
      message: { message_id: 1, chat: { id: 999 } },
    }),
    { ...createEnv(), TELEGRAM_ALLOWED_CHAT_IDS: '42,43' },
    { fetchImpl: async () => { fetchCount += 1; return new Response(null, { status: 204 }); } },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: 'chat_not_allowed' });
  assert.equal(fetchCount, 0);
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

test('buildTelegramDispatchPayload uses the original message for Telegram task-start notifications', () => {
  const payload = buildTelegramDispatchPayload({
    env: { GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM: 'telegram_update_dev' },
    updates: [
      {
        update_id: 130,
        message: {
          message_id: 10,
          chat: { id: 42 },
          text: '/随想 原始消息',
        },
        edited_message: {
          message_id: 11,
          chat: { id: 42 },
          text: '/随想 编辑后的消息',
        },
      },
    ],
  });

  assert.equal(payload.event_type, 'telegram_update_dev');
  assert.deepEqual(payload.notification, {
    channel: 'telegram',
    chatId: 42,
    replyToMessageId: 10,
  });
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
    GITHUB_SYNC_REF: 'dev',
    __now: () => 1_000,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/actions/workflows/sync-dev.yml/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        const taskId = JSON.parse(dispatched.at(-1).inputs.dispatch_payload).client_payload.queue_task_id;
        return Response.json({
          workflow_runs: [
            {
              id: runs[dispatched.length - 1].id,
              name: `Sync queue task ${taskId}`,
              created_at: '2026-06-17T00:00:01Z',
              event: 'workflow_dispatch',
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
    dispatched.map((body) => JSON.parse(body.inputs.dispatch_payload).client_payload.telegram_updates[0].update_id),
    [1, 2, 3],
  );
  assert.deepEqual(dispatched.map((body) => body.ref), ['dev', 'dev', 'dev']);
  assert.deepEqual(await state.storage.get('queue'), []);
  assert.equal(await state.storage.get('processing'), undefined);
});

test('SyncDispatchQueue dispatches workflow_dispatch payloads to the configured branch ref', async () => {
  const state = createDurableObjectState();
  const dispatched = [];
  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
    GITHUB_SYNC_REF: 'dev',
    __now: () => 1_000,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/actions/workflows/sync-dev.yml/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        const dispatchPayload = JSON.parse(dispatched[0].inputs.dispatch_payload);
        return Response.json({
          workflow_runs: [
            {
              id: 201,
              name: `Sync queue task ${dispatchPayload.client_payload.queue_task_id}`,
              created_at: '2026-06-17T00:00:01Z',
              event: 'workflow_dispatch',
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

  const taskId = dispatched[0].inputs.queue_task_id;
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], {
    ref: 'dev',
    inputs: {
      channel: 'telegram',
      queue_task_id: taskId,
      dispatch_payload: JSON.stringify({
        action: 'telegram_update_dev',
        client_payload: {
          telegram_updates: [{ update_id: 1 }],
          queue_task_id: taskId,
        },
      }),
    },
  });
});

test('SyncDispatchQueue matches workflow runs by queue task id instead of first recent run', async () => {
  const state = createDurableObjectState();
  const dispatched = [];
  let lookupCount = 0;
  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
    GITHUB_SYNC_REF: 'dev',
    __now: () => 1_000,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/actions/workflows/sync-dev.yml/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        lookupCount += 1;
        const taskId = JSON.parse(dispatched[0].inputs.dispatch_payload).client_payload.queue_task_id;
        return Response.json({
          workflow_runs: lookupCount === 1 ? [] : [
            {
              id: 999,
              name: 'Sync queue task unrelated',
              created_at: '2026-06-17T00:00:01Z',
              event: 'workflow_dispatch',
            },
            {
              id: 201,
              name: `Sync queue task ${taskId}`,
              created_at: '2026-06-17T00:00:01Z',
              event: 'workflow_dispatch',
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

test('SyncDispatchQueue dead-letters Feishu tasks when workflow runs never appear and continues', async () => {
  const state = createDurableObjectState();
  const dispatched = [];
  const feishuMessages = [];
  const logs = [];
  let now = 1_000;
  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
    GITHUB_SYNC_REF: 'dev',
    GITHUB_RUN_LOOKUP_TIMEOUT_MS: '30000',
    FEISHU_APP_ID: 'feishu-app-id',
    FEISHU_APP_SECRET: 'feishu-app-secret',
    __logger: {
      error: (line) => logs.push(line),
    },
    __now: () => now,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/actions/workflows/sync-dev.yml/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        if (dispatched.length < 2) {
          return Response.json({ workflow_runs: [] });
        }
        const taskId = dispatched[1].inputs.queue_task_id;
        return Response.json({
          workflow_runs: [
            {
              id: 601,
              name: `Sync queue task ${taskId}`,
              created_at: new Date(now).toISOString(),
              event: 'workflow_dispatch',
            },
          ],
        });
      }
      if (urlText.includes('/actions/runs/601')) {
        return Response.json({
          id: 601,
          status: 'completed',
          conclusion: 'success',
        });
      }
      if (urlText.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return Response.json({
          code: 0,
          tenant_access_token: 'tenant-token',
        });
      }
      if (urlText.includes('/open-apis/im/v1/messages')) {
        feishuMessages.push(JSON.parse(init.body));
        return Response.json({ code: 0, data: { message_id: 'om_notice_1' } });
      }
      throw new Error(`unexpected fetch: ${urlText}`);
    },
  });

  for (const [index, sortKey] of ['1781680601000', '1781680602000'].entries()) {
    const event = createFeishuQueueEvent({
      eventId: `evt-timeout-${index + 1}`,
      messageId: `om_timeout_${index + 1}`,
      text: `/随想编 ${index + 3} 身体反馈 超时恢复${index + 1}`,
      createTime: sortKey,
    });
    assert.equal((await queue.fetch(createQueueRequest({
      event_type: 'feishu_update_dev',
      client_payload: { feishu_update: event },
      source: { channel: 'feishu', sortKey },
      notification: {
        channel: 'feishu',
        chatId: event.event.message.chat_id,
        sourceMessageId: event.event.message.message_id,
      },
    }))).status, 202);
  }

  await queue.alarm();
  assert.equal(dispatched.length, 1);
  assert.equal((await state.storage.get('processing')).phase, 'wait_for_run');

  now += 40_000;
  await queue.alarm();

  const deadLetters = await state.storage.get('deadLetters');
  assert.equal(deadLetters.length, 1);
  assert.match(deadLetters[0].error, /github_workflow_run_not_found/);
  assert.equal(feishuMessages.length, 1);
  assert.equal(feishuMessages[0].receive_id, 'oc_queue_chat');
  assert.match(JSON.parse(feishuMessages[0].content).text, /GitHub Action 未能启动/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[sync-dispatch-queue\]/);
  assert.match(logs[0], /"outcome":"dead_letter"/);
  assert.match(logs[0], /"channel":"feishu"/);
  assert.match(logs[0], /github_workflow_run_not_found_after_dispatch/);
  assert.doesNotMatch(logs[0], /om_timeout_1|超时恢复/);

  await queue.alarm();
  assert.equal(dispatched.length, 2);
  assert.equal(JSON.parse(dispatched[1].inputs.dispatch_payload).client_payload.feishu_update.header.event_id, 'evt-timeout-2');

  await queue.alarm();
  assert.equal(await state.storage.get('processing'), undefined);
});

test('SyncDispatchQueue logs failed task-start notifications for Telegram and Feishu dead letters', async () => {
  for (const channel of ['telegram', 'feishu']) {
    const state = createDurableObjectState();
    const logs = [];
    const dispatched = [];
    let now = 1_000;
    const queue = new SyncDispatchQueue(state, {
      ...createEnv(),
      GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
      GITHUB_SYNC_REF: 'dev',
      GITHUB_RUN_LOOKUP_TIMEOUT_MS: '30000',
      TELEGRAM_API_BASE_URL: 'https://telegram.example.com',
      FEISHU_API_BASE_URL: 'https://feishu.example.com',
      FEISHU_APP_ID: 'feishu-app-id',
      FEISHU_APP_SECRET: 'feishu-app-secret',
      __logger: {
        error: (line) => logs.push(line),
      },
      __now: () => now,
      __dispatchFetchImpl: async (url) => {
        const urlText = String(url);
        if (urlText.endsWith('/actions/workflows/sync-dev.yml/dispatches')) {
          dispatched.push(urlText);
          return new Response(null, { status: 204 });
        }
        if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
          return Response.json({ workflow_runs: [] });
        }
        if (urlText.includes('/bottelegram-token/sendMessage')) {
          return new Response('telegram send failed', { status: 429 });
        }
        if (urlText.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
          return new Response('tenant token failed', { status: 500 });
        }
        throw new Error(`unexpected fetch: ${urlText}`);
      },
    });
    const sourceSortKey = channel === 'telegram' ? 42 : '1781680601000';
    const payload = channel === 'telegram'
      ? {
          event_type: 'telegram_update_dev',
          client_payload: { telegram_updates: [{ update_id: 42 }] },
          source: { channel: 'telegram', sortKey: sourceSortKey },
          notification: {
            channel: 'telegram',
            chatId: 42,
            replyToMessageId: 7,
          },
        }
      : {
          event_type: 'feishu_update_dev',
          client_payload: {
            feishu_update: createFeishuQueueEvent({
              eventId: 'evt-notify-failed',
              messageId: 'om_notify_failed',
              text: '/随想编 3 身体反馈 通知失败',
            }),
          },
          source: { channel: 'feishu', sortKey: sourceSortKey },
          notification: {
            channel: 'feishu',
            chatId: 'oc_queue_chat',
            sourceMessageId: 'om_notify_failed',
          },
        };

    assert.equal((await queue.fetch(createQueueRequest(payload))).status, 202);

    await queue.alarm();
    now += 40_000;
    await queue.alarm();

    const deadLetters = await state.storage.get('deadLetters');
    assert.equal(deadLetters.length, 1);
    assert.equal(dispatched.length, 1);
    const deadLetterLog = logs.find((line) => line.includes('"outcome":"dead_letter"'));
    const notificationFailedLog = logs.find((line) => line.includes('"outcome":"notification_failed"'));
    assert.ok(deadLetterLog);
    assert.ok(notificationFailedLog);
    assert.match(deadLetterLog, /\[sync-dispatch-queue\]/);
    assert.match(notificationFailedLog, /\[sync-dispatch-queue\]/);
    assert.match(deadLetterLog, new RegExp(`"channel":"${channel}"`));
    assert.match(notificationFailedLog, new RegExp(`"channel":"${channel}"`));
    assert.match(deadLetterLog, /"taskId":/);
    assert.match(notificationFailedLog, /"taskId":/);
    assert.match(deadLetterLog, /github_workflow_run_not_found_after_dispatch/);
    assert.match(notificationFailedLog, /github_workflow_run_not_found_after_dispatch/);
  }
});

test('SyncDispatchQueue uses short task ids that do not expose Feishu payload content', async () => {
  const state = createDurableObjectState();
  const dispatched = [];
  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
    GITHUB_SYNC_REF: 'dev',
    __now: () => 1_000,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/actions/workflows/sync-dev.yml/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        const taskId = dispatched[0].inputs.queue_task_id;
        return Response.json({
          workflow_runs: [
            {
              id: 301,
              name: `Sync queue task ${taskId}`,
              created_at: '2026-06-17T00:00:01Z',
              event: 'workflow_dispatch',
            },
          ],
        });
      }
      return Response.json({
        id: 301,
        status: 'completed',
        conclusion: 'success',
      });
    },
  });

  assert.equal((await queue.fetch(createQueueRequest({
    event_type: 'feishu_update_dev',
    client_payload: {
      feishu_updates: [
        createFeishuQueueEvent({
          eventId: 'evt-short-id-1',
          messageId: 'om_short_id_1',
          token: 'sensitive-feishu-token',
          text: '/随想编 3 身体反馈 不应该出现在 queue task id',
        }),
        createFeishuQueueEvent({
          eventId: 'evt-short-id-2',
          messageId: 'om_short_id_2',
          token: 'another-sensitive-token',
          text: '/随想编 4 杂七杂八 也不应该出现在 queue task id',
          createTime: '1781680302000',
        }),
      ],
    },
    source: { channel: 'feishu', sortKey: '1781680301000' },
  }))).status, 202);

  await queue.alarm();

  const taskId = dispatched[0].inputs.queue_task_id;
  assert.match(taskId, /^feishu:1781680301000:feishu_update_dev:[a-f0-9]{16}$/);
  assert.ok(taskId.length < 80);
  assert.doesNotMatch(taskId, /sensitive-feishu-token|不应该出现在|om_short_id/);
});

test('SyncDispatchQueue matches legacy long queue task ids when GitHub truncates the run title', async () => {
  const state = createDurableObjectState();
  const dispatched = [];
  const legacyPayload = {
    event_type: 'feishu_update_dev',
    client_payload: {
      feishu_update: createFeishuQueueEvent({
        eventId: 'evt-legacy-truncated',
        messageId: 'om_legacy_truncated',
        text: `/随想编 3 身体反馈 ${'长内容'.repeat(120)}`,
      }),
    },
    source: { channel: 'feishu', sortKey: '1781680401000' },
  };
  const legacyTaskId = [
    legacyPayload.source.channel,
    legacyPayload.source.sortKey,
    legacyPayload.event_type,
    JSON.stringify(legacyPayload.client_payload),
  ].join(':');
  await state.storage.put('processing', {
    task: {
      id: legacyTaskId,
      eventType: legacyPayload.event_type,
      clientPayload: legacyPayload.client_payload,
      source: legacyPayload.source,
      notification: null,
      enqueuedAt: 1_000,
      attempts: 0,
    },
    phase: 'wait_for_run',
    attempts: 0,
    dispatchStartedAt: '2026-06-17T00:00:00Z',
  });

  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
    GITHUB_SYNC_REF: 'dev',
    __now: () => 1_000,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/actions/workflows/sync-dev.yml/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        return Response.json({
          workflow_runs: [
            {
              id: 401,
              display_title: `Sync queue task ${legacyTaskId}`.slice(0, 494),
              created_at: '2026-06-17T00:00:01Z',
              event: 'workflow_dispatch',
            },
          ],
        });
      }
      return Response.json({
        id: 401,
        status: 'completed',
        conclusion: 'success',
      });
    },
  });

  await queue.alarm();

  assert.equal(dispatched.length, 0);
  assert.equal(await state.storage.get('processing'), undefined);
});

test('SyncDispatchQueue continues after matching a truncated legacy Feishu run title', async () => {
  const state = createDurableObjectState();
  const dispatched = [];
  const completedRunIds = [];
  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
    GITHUB_SYNC_REF: 'dev',
    __now: () => 1_000,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/actions/workflows/sync-dev.yml/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        const taskId = JSON.parse(dispatched.at(-1).inputs.dispatch_payload).client_payload.queue_task_id;
        const runId = dispatched.length === 1 ? 501 : 502;
        return Response.json({
          workflow_runs: [
            {
              id: runId,
              display_title: `Sync queue task ${taskId}`.slice(0, 494),
              created_at: '2026-06-17T00:00:01Z',
              event: 'workflow_dispatch',
            },
          ],
        });
      }
      const runId = Number(urlText.match(/\/actions\/runs\/(\d+)/)?.[1]);
      completedRunIds.push(runId);
      return Response.json({
        id: runId,
        status: 'completed',
        conclusion: 'success',
      });
    },
  });

  for (const [index, sortKey] of ['1781680501000', '1781680502000'].entries()) {
    assert.equal((await queue.fetch(createQueueRequest({
      event_type: 'feishu_update_dev',
      client_payload: {
        feishu_update: createFeishuQueueEvent({
          eventId: `evt-continue-${index + 1}`,
          messageId: `om_continue_${index + 1}`,
          text: `/随想编 ${index + 3} 身体反馈 ${'长内容'.repeat(120)}`,
          createTime: sortKey,
        }),
      },
      source: { channel: 'feishu', sortKey },
    }))).status, 202);
  }

  for (let i = 0; i < 6; i += 1) {
    await queue.alarm();
  }

  assert.equal(dispatched.length, 2);
  assert.deepEqual(completedRunIds, [501, 502]);
  assert.deepEqual(await state.storage.get('queue'), []);
  assert.equal(await state.storage.get('processing'), undefined);
});

test('SyncDispatchQueue keeps concurrent enqueues instead of overwriting the middle task', async () => {
  const state = createDurableObjectState();
  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    __now: () => 1_000,
  });

  await Promise.all([1, 2, 3].map((updateId) => queue.fetch(createQueueRequest({
    event_type: 'telegram_update_dev',
    client_payload: { telegram_updates: [{ update_id: updateId }] },
    source: { channel: 'telegram', sortKey: updateId },
  }))));

  const storedQueue = await state.storage.get('queue');
  assert.deepEqual(
    storedQueue.map((task) => task.clientPayload.telegram_updates[0].update_id),
    [1, 2, 3],
  );
});

test('SyncDispatchQueue uses Durable Object SQL storage for FIFO queue state when available', async () => {
  const state = createDurableObjectSqlState();
  const dispatched = [];
  const queue = new SyncDispatchQueue(state, {
    ...createEnv(),
    GITHUB_SYNC_WORKFLOW_FILE: 'sync-dev.yml',
    GITHUB_SYNC_REF: 'dev',
    __now: () => 1_000,
    __dispatchFetchImpl: async (url, init) => {
      const urlText = String(url);
      if (urlText.endsWith('/actions/workflows/sync-dev.yml/dispatches')) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (urlText.includes('/actions/workflows/sync-dev.yml/runs')) {
        const taskId = JSON.parse(dispatched.at(-1).inputs.dispatch_payload).client_payload.queue_task_id;
        return Response.json({
          workflow_runs: [
            {
              id: 301,
              name: `Sync queue task ${taskId}`,
              created_at: '2026-06-17T00:00:01Z',
              event: 'workflow_dispatch',
            },
          ],
        });
      }
      return Response.json({
        id: 301,
        status: 'completed',
        conclusion: 'success',
      });
    },
  });

  for (const updateId of [3, 1, 2]) {
    assert.equal((await queue.fetch(createQueueRequest({
      event_type: 'telegram_update_dev',
      client_payload: { telegram_updates: [{ update_id: updateId }] },
      source: { channel: 'telegram', sortKey: updateId },
    }))).status, 202);
  }

  for (let i = 0; i < 3; i += 1) {
    await queue.alarm();
  }

  assert.deepEqual(
    dispatched.map((body) => JSON.parse(body.inputs.dispatch_payload).client_payload.telegram_updates[0].update_id),
    [1, 2, 3],
  );
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

test('TelegramAlbumBuffer keeps buffered updates and schedules retry when dispatch and notification fail', async () => {
  const originalNow = Date.now;
  const calls = [];
  const logs = [];
  const state = createDurableObjectState();
  const buffer = new TelegramAlbumBuffer(state, {
    ...createEnv(),
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_API_BASE_URL: 'https://telegram.example.com',
    __logger: {
      log: (line) => logs.push(line),
    },
    __dispatchFetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/dispatches')) {
        return new Response('dispatch unavailable', { status: 503 });
      }
      throw new Error('telegram notification unavailable');
    },
  });

  try {
    Date.now = () => 10_000;
    await buffer.fetch(
      new Request('https://worker.example.com/buffer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update: {
            update_id: 303,
            message: {
              message_id: 33,
              chat: { id: 7 },
              photo: [{ file_id: 'photo-retry' }],
            },
          },
        }),
      }),
    );

    await buffer.alarm();

    const storedUpdates = await state.storage.get('updates');
    assert.deepEqual(storedUpdates.map((update) => update.update_id), [303]);
    assert.equal(await state.storage.get('dispatchRetryCount'), 1);
    assert.equal(await state.getAlarm(), 20_000);
    assert.equal(calls.some((url) => url.includes('/dispatches')), true);
    assert.equal(calls.some((url) => url.includes('/botbot-token/sendMessage')), true);
    assert.equal(logs.some((line) => line.includes('"outcome":"notification_failed"')), true);
    assert.equal(logs.some((line) => line.includes('"update_id":303')), true);
  } finally {
    Date.now = originalNow;
  }
});

test('TelegramAlbumBuffer dead-letters buffered updates after max dispatch retries', async () => {
  const originalNow = Date.now;
  const state = createDurableObjectState();
  const buffer = new TelegramAlbumBuffer(state, {
    ...createEnv(),
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_API_BASE_URL: 'https://telegram.example.com',
    __dispatchFetchImpl: async (url) => {
      if (String(url).includes('/dispatches')) {
        return new Response('dispatch still unavailable', { status: 500 });
      }
      return new Response(null, { status: 200 });
    },
  });

  try {
    Date.now = () => Date.parse('2026-06-20T08:00:00.000Z');
    await buffer.fetch(
      new Request('https://worker.example.com/buffer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update: {
            update_id: 304,
            message: {
              message_id: 34,
              media_group_id: 'album-dead-letter',
              chat: { id: 7 },
              photo: [{ file_id: 'photo-dead-letter' }],
            },
          },
        }),
      }),
    );
    await state.storage.put('dispatchRetryCount', 4);

    await buffer.alarm();

    const deadLetters = await state.storage.get('deadLetters');
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0].reason, 'github_dispatch_failed');
    assert.equal(deadLetters[0].status, 500);
    assert.equal(deadLetters[0].retryCount, 5);
    assert.deepEqual(deadLetters[0].updates, [
      {
        update_id: 304,
        chat_id: 7,
        message_id: 34,
        media_group_id: 'album-dead-letter',
      },
    ]);
    assert.equal(await state.storage.get('updates'), undefined);
    assert.equal(await state.storage.get('dispatchRetryCount'), undefined);
  } finally {
    Date.now = originalNow;
  }
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

function createFeishuQueueEvent({
  eventId,
  messageId,
  text,
  token = 'verification-token',
  chatId = 'oc_queue_chat',
  createTime = '1781680301000',
}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      token,
      create_time: String(Number(createTime) + 500),
      event_type: 'im.message.receive_v1',
      tenant_key: 'tenant-key',
      app_id: 'cli_test',
    },
    event: {
      message: {
        chat_id: chatId,
        chat_type: 'p2p',
        content: JSON.stringify({ text }),
        create_time: createTime,
        message_id: messageId,
        message_type: 'text',
      },
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

function createDurableObjectSqlState() {
  const storage = createDurableObjectState().storage;
  const queueRows = new Map();
  const processingRows = new Map();
  storage.sql = {
    exec(sql, ...params) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('CREATE TABLE')) {
        return createSqlResult([]);
      }
      if (normalized.startsWith('INSERT OR IGNORE INTO sync_dispatch_queue')) {
        const [id, sortKey, enqueuedAt, taskJson] = params;
        if (!queueRows.has(id)) {
          queueRows.set(id, { id, sort_key: sortKey, enqueued_at: enqueuedAt, task_json: taskJson });
        }
        return createSqlResult([]);
      }
      if (normalized.startsWith('SELECT id, task_json FROM sync_dispatch_queue')) {
        return createSqlResult([...queueRows.values()].sort((left, right) =>
          String(left.sort_key).localeCompare(String(right.sort_key), undefined, { numeric: true }) ||
          Number(left.enqueued_at) - Number(right.enqueued_at) ||
          String(left.id).localeCompare(String(right.id))
        ));
      }
      if (normalized.startsWith('DELETE FROM sync_dispatch_queue')) {
        queueRows.delete(params[0]);
        return createSqlResult([]);
      }
      if (normalized.startsWith('SELECT processing_json FROM sync_dispatch_processing')) {
        return createSqlResult(processingRows.has('current') ? [processingRows.get('current')] : []);
      }
      if (normalized.startsWith('INSERT OR REPLACE INTO sync_dispatch_processing')) {
        processingRows.set('current', { processing_json: params[0] });
        return createSqlResult([]);
      }
      if (normalized.startsWith('DELETE FROM sync_dispatch_processing')) {
        processingRows.delete('current');
        return createSqlResult([]);
      }
      throw new Error(`unexpected sql: ${normalized}`);
    },
  };
  return {
    storage,
    blockConcurrencyWhile(callback) {
      return callback();
    },
    async getAlarm() {
      return null;
    },
    async setAlarm() {
      return null;
    },
  };
}

function createSqlResult(rows) {
  return {
    toArray() {
      return rows;
    },
  };
}
