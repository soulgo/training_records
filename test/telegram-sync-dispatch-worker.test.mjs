import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TelegramAlbumBuffer,
  handleTelegramWebhook,
} from '../cloudflare/telegram-sync-dispatch-worker.mjs';

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
    text: [
      '当前可用命令：',
      '',
      '/help 或 帮助：查看这份命令说明',
      '/随想 内容：记录锻炼随想',
      '/随想 杂七杂八 内容：记录杂项随想',
      '/随想 身体反馈 内容：记录疼痛、疲劳或恢复异常',
      '/随想编 id 内容：按 id 编辑随想',
      '/随想编 id 模块 内容：编辑并移动到指定模块',
      '/随想删 id：按 id 删除随想；回复原消息时可只发 /随想删',
      '/移动 id 模块：把随想移动到 锻炼 / 杂七杂八 / 身体反馈',
      '/分析 问题：基于训练、体脂、饮食和身体反馈生成训练建议',
      '/ai 问题：调用 MCP 工具查询历史、同步状态或综合分析',
      '',
      '图片：直接发送训练/饮食/体脂截图会自动识别；图片 caption 以 /随想 开头时会归档为带图随想。',
    ].join('\n'),
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

  await namespace.flush('42:album-1');

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
          },
        },
        {
          update_id: 202,
          message: {
            message_id: 22,
            media_group_id: 'album-1',
            chat: { id: 42 },
          },
        },
      ],
    },
  });
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
