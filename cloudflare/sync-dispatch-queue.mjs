const GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GITHUB_OWNER = 'soulgo';
const DEFAULT_GITHUB_REPO = 'training_records';
const DEFAULT_QUEUE_NAME = 'sync-dispatch';
const QUEUE_KEY = 'queue';
const PROCESSING_KEY = 'processing';
const DEAD_LETTER_KEY = 'deadLetters';
const POLL_DELAY_MS = 10_000;
const RETRY_BASE_DELAY_MS = 10_000;
const RETRY_MAX_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 5;
const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

export class SyncDispatchQueue {
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

    if (!payload?.event_type || !payload?.client_payload) {
      return jsonResponse(400, { ok: false, error: 'missing_dispatch_payload' });
    }

    const task = {
      id: buildTaskId(payload),
      eventType: payload.event_type,
      clientPayload: payload.client_payload,
      source: payload.source ?? null,
      notification: payload.notification ?? null,
      enqueuedAt: getNow(this.env),
      attempts: 0,
    };
    const queue = await readArray(this.state, QUEUE_KEY);
    if (!queue.some((item) => item.id === task.id)) {
      queue.push(task);
      queue.sort(compareTasks);
      await this.state.storage.put(QUEUE_KEY, queue);
    }

    await setStateAlarm(this.state, getNow(this.env));
    return jsonResponse(202, { ok: true, queued: true, taskId: task.id });
  }

  async alarm() {
    const processing = await this.state.storage.get(PROCESSING_KEY);
    if (processing) {
      await this.continueProcessing(processing);
      return;
    }

    const queue = await readArray(this.state, QUEUE_KEY);
    const task = queue.shift();
    await this.state.storage.put(QUEUE_KEY, queue);
    if (!task) {
      return;
    }

    await this.continueProcessing({
      task,
      phase: 'dispatch',
      attempts: task.attempts ?? 0,
    });
  }

  async continueProcessing(processing) {
    try {
      if (processing.phase === 'wait_for_completion') {
        await this.pollRun(processing);
        return;
      }
      if (processing.phase === 'wait_for_run') {
        await this.pollRun(processing);
        return;
      }

      const dispatchStartedAt = new Date(getNow(this.env)).toISOString();
      await dispatchGithubTask({
        fetchImpl: this.env.__dispatchFetchImpl ?? fetch,
        env: this.env,
        task: processing.task,
      });

      const runId = await findDispatchedRunId({
        fetchImpl: this.env.__dispatchFetchImpl ?? fetch,
        env: this.env,
        workflowFile: resolveWorkflowFile(this.env, processing.task.eventType),
        dispatchStartedAt,
      });

      if (!runId) {
        await this.storeProcessing({
          ...processing,
          phase: 'wait_for_run',
          dispatchStartedAt,
        }, POLL_DELAY_MS);
        return;
      }

      await this.pollRun({
        ...processing,
        phase: 'wait_for_completion',
        dispatchStartedAt,
        runId,
      });
    } catch (error) {
      await this.retryOrDeadLetter(processing, error);
    }
  }

  async pollRun(processing) {
    let runId = processing.runId;
    if (!runId) {
      runId = await findDispatchedRunId({
        fetchImpl: this.env.__dispatchFetchImpl ?? fetch,
        env: this.env,
        workflowFile: resolveWorkflowFile(this.env, processing.task.eventType),
        dispatchStartedAt: processing.dispatchStartedAt,
      });
      if (!runId) {
        await this.storeProcessing(processing, POLL_DELAY_MS);
        return;
      }
    }

    const run = await getWorkflowRun({
      fetchImpl: this.env.__dispatchFetchImpl ?? fetch,
      env: this.env,
      runId,
    });
    if (run.status !== 'completed') {
      await this.storeProcessing({
        ...processing,
        phase: 'wait_for_completion',
        runId,
      }, POLL_DELAY_MS);
      return;
    }

    await this.state.storage.delete(PROCESSING_KEY);
    await setStateAlarm(this.state, getNow(this.env));
  }

  async storeProcessing(processing, delayMs) {
    await this.state.storage.put(PROCESSING_KEY, processing);
    await setStateAlarm(this.state, getNow(this.env) + delayMs);
  }

  async retryOrDeadLetter(processing, error) {
    const attempts = Number(processing.attempts ?? 0) + 1;
    if (attempts < MAX_ATTEMPTS) {
      await this.storeProcessing({
        ...processing,
        attempts,
        lastError: summarizeError(error),
      }, calculateRetryDelayMs(attempts));
      return;
    }

    const deadLetters = await readArray(this.state, DEAD_LETTER_KEY);
    deadLetters.push({
      task: processing.task,
      failedAt: new Date(getNow(this.env)).toISOString(),
      error: summarizeError(error),
    });
    await this.state.storage.put(DEAD_LETTER_KEY, deadLetters.slice(-100));
    await notifyTaskNotStarted({
      fetchImpl: this.env.__dispatchFetchImpl ?? fetch,
      env: this.env,
      task: processing.task,
      reason: summarizeError(error),
    });
    await this.state.storage.delete(PROCESSING_KEY);
    await setStateAlarm(this.state, getNow(this.env));
  }
}

export async function enqueueSyncDispatchTask({ env, payload }) {
  const namespace = env?.SYNC_DISPATCH_QUEUE;
  if (!namespace) {
    return null;
  }
  const stubId = namespace.idFromName(DEFAULT_QUEUE_NAME);
  const stub = namespace.get(stubId);
  return stub.fetch(new Request('https://sync-dispatch-queue.internal/enqueue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));
}

export function buildTelegramDispatchPayload({ env, updates }) {
  const eventType = env?.GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM?.trim() ||
    env?.GITHUB_DISPATCH_EVENT_TYPE?.trim() ||
    'telegram_update';
  const firstMessage = findFirstTelegramMessage(updates);
  return {
    event_type: eventType,
    client_payload: {
      telegram_updates: updates,
    },
    source: {
      channel: 'telegram',
      sortKey: updates.map((update) => update?.update_id ?? 0).filter(Boolean).at(0) ?? Date.now(),
    },
    notification: firstMessage?.chat?.id ? {
      channel: 'telegram',
      chatId: firstMessage.chat.id,
      replyToMessageId: firstMessage.message_id,
    } : null,
  };
}

export function buildFeishuDispatchPayload({ env, events }) {
  const eventType = env?.GITHUB_DISPATCH_EVENT_TYPE_FEISHU?.trim() ||
    env?.GITHUB_DISPATCH_EVENT_TYPE?.trim() ||
    'feishu_update';
  const clientPayload = events.length === 1
    ? { feishu_update: events[0] }
    : { feishu_updates: events };
  return {
    event_type: eventType,
    client_payload: clientPayload,
    source: {
      channel: 'feishu',
      sortKey: resolveFeishuSortKey(events[0]),
    },
  };
}

async function dispatchGithubTask({ fetchImpl, env, task }) {
  const { owner, repo } = resolveGithubRepository(env);
  const response = await fetchImpl(
    `${env.GITHUB_API_BASE_URL?.trim() || GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`,
    {
      method: 'POST',
      headers: buildGithubHeaders(env),
      body: JSON.stringify({
        event_type: task.eventType,
        client_payload: task.clientPayload,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`github_dispatch_failed_http_${response.status}`);
  }
}

async function findDispatchedRunId({ fetchImpl, env, workflowFile, dispatchStartedAt }) {
  const { owner, repo } = resolveGithubRepository(env);
  const response = await fetchImpl(
    `${env.GITHUB_API_BASE_URL?.trim() || GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=repository_dispatch&per_page=20`,
    {
      method: 'GET',
      headers: buildGithubHeaders(env),
    },
  );
  if (!response.ok) {
    throw new Error(`github_runs_lookup_failed_http_${response.status}`);
  }
  const payload = await response.json();
  const startedAt = Date.parse(dispatchStartedAt || '');
  const run = (payload.workflow_runs ?? []).find((candidate) =>
    candidate?.id && Date.parse(candidate.created_at) >= startedAt - 5_000
  );
  return run?.id ?? null;
}

async function getWorkflowRun({ fetchImpl, env, runId }) {
  const { owner, repo } = resolveGithubRepository(env);
  const response = await fetchImpl(
    `${env.GITHUB_API_BASE_URL?.trim() || GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`,
    {
      method: 'GET',
      headers: buildGithubHeaders(env),
    },
  );
  if (!response.ok) {
    throw new Error(`github_run_lookup_failed_http_${response.status}`);
  }
  return response.json();
}

function buildGithubHeaders(env) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'content-type': 'application/json',
    'user-agent': 'sync-dispatch-queue',
  };
}

function resolveWorkflowFile(env, eventType) {
  return env?.GITHUB_SYNC_WORKFLOW_FILE?.trim() ||
    (String(eventType ?? '').endsWith('_dev') ? 'sync-dev.yml' : 'sync.yml');
}

function resolveGithubRepository(env) {
  return {
    owner: env?.GITHUB_OWNER?.trim() || DEFAULT_GITHUB_OWNER,
    repo: env?.GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO,
  };
}

function buildTaskId(payload) {
  const source = payload?.source ?? {};
  return [
    source.channel ?? 'sync',
    source.sortKey ?? '',
    payload.event_type,
    JSON.stringify(payload.client_payload),
  ].join(':');
}

function compareTasks(left, right) {
  const leftSort = String(left?.source?.sortKey ?? left?.enqueuedAt ?? '');
  const rightSort = String(right?.source?.sortKey ?? right?.enqueuedAt ?? '');
  return leftSort.localeCompare(rightSort, undefined, { numeric: true }) ||
    String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

function findFirstTelegramMessage(updates) {
  for (const update of updates ?? []) {
    const message = update?.message ?? update?.edited_message ?? null;
    if (message) {
      return message;
    }
  }
  return null;
}

function resolveFeishuSortKey(event) {
  return event?.event?.message?.create_time ??
    event?.header?.create_time ??
    event?.header?.event_id ??
    Date.now();
}

async function notifyTaskNotStarted({ fetchImpl, env, task, reason }) {
  const notification = task?.notification;
  if (notification?.channel !== 'telegram' || !notification.chatId) {
    return null;
  }
  const botToken = env?.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return null;
  }
  const apiBaseUrl = env?.TELEGRAM_API_BASE_URL?.trim() || TELEGRAM_API_BASE_URL;
  try {
    return await fetchImpl(`${apiBaseUrl}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: notification.chatId,
        text: `GitHub Action 未能启动：${reason || '未知原因'}`,
        reply_to_message_id: notification.replyToMessageId,
        allow_sending_without_reply: true,
        disable_web_page_preview: true,
      }),
    });
  } catch {
    return null;
  }
}

async function readArray(state, key) {
  const value = await state.storage.get(key);
  return Array.isArray(value) ? value : [];
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

function calculateRetryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts) - 1, 6));
  return Math.min(RETRY_BASE_DELAY_MS * (2 ** exponent), RETRY_MAX_DELAY_MS);
}

function summarizeError(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown_error');
}

function getNow(env) {
  return typeof env?.__now === 'function' ? env.__now() : Date.now();
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
