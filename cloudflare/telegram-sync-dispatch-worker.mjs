const GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GITHUB_OWNER = 'soulgo';
const DEFAULT_GITHUB_REPO = 'training_records';
const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const TELEGRAM_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const ALBUM_BUFFER_DELAY_MS = 3_000;
const TELEGRAM_HELP_TEXT = [
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
].join('\n');

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

    const existingAlarm = await getStateAlarm(this.state);
    if (!existingAlarm) {
      await setStateAlarm(this.state, Date.now() + ALBUM_BUFFER_DELAY_MS);
    }

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

    await dispatchTelegramUpdates({
      fetchImpl: this.env.__dispatchFetchImpl ?? fetch,
      env: this.env,
      updates,
    });

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
    return jsonResponse(500, { ok: false, error: dispatchConfigError });
  }

  const albumKey = getAlbumBufferKey(update);
  if (albumKey && env?.TELEGRAM_ALBUM_BUFFER) {
    const stubId = env.TELEGRAM_ALBUM_BUFFER.idFromName(albumKey);
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
      albumKey,
    });
  }

  const response = await dispatchTelegramUpdates({
    fetchImpl,
    env,
    updates: [update],
  });

  if (!response.ok) {
    return jsonResponse(502, {
      ok: false,
      error: 'github_dispatch_failed',
      status: response.status,
      body: await safeReadText(response),
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
  const text = String(message.text ?? '').trim();
  return /^(?:\/(?:help|start)(?:@[A-Za-z0-9_]+)?|帮助|命令|指令|使用说明)$/u.test(text);
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

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function dispatchTelegramUpdates({ fetchImpl, env, updates }) {
  const { owner, repo } = resolveGithubRepository(env);
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
        event_type: 'telegram_update',
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

function getAlbumBufferKey(update) {
  const message = update?.message ?? update?.edited_message ?? null;
  const chatId = message?.chat?.id;
  const mediaGroupId = message?.media_group_id;
  if (chatId == null || !mediaGroupId) {
    return null;
  }
  return `${chatId}:${mediaGroupId}`;
}

async function readBufferedUpdates(state) {
  return (await state.storage.get('updates')) ?? [];
}

async function getStateAlarm(state) {
  if (typeof state.storage?.getAlarm === 'function') {
    return state.storage.getAlarm();
  }
  if (typeof state.getAlarm === 'function') {
    return state.getAlarm();
  }
  return null;
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
