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
const QUEUE_TABLE = 'sync_dispatch_queue';
const PROCESSING_TABLE = 'sync_dispatch_processing';

export class SyncDispatchQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.kvMutation = Promise.resolve();
    if (this.state.storage?.sql) {
      this.state.blockConcurrencyWhile?.(async () => {
        initializeSqlStorage(this.state);
      });
      if (!this.state.blockConcurrencyWhile) {
        initializeSqlStorage(this.state);
      }
    }
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
    await this.enqueueTask(task);

    await setStateAlarm(this.state, getNow(this.env));
    return jsonResponse(202, { ok: true, queued: true, taskId: task.id });
  }

  async alarm() {
    const processing = await this.readProcessing();
    if (processing) {
      await this.continueProcessing(processing);
      return;
    }

    const task = await this.dequeueTask();
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
        task: processing.task,
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
        task: processing.task,
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

    await this.deleteProcessing();
    await setStateAlarm(this.state, getNow(this.env));
  }

  async storeProcessing(processing, delayMs) {
    await this.writeProcessing(processing);
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
    await this.deleteProcessing();
    await setStateAlarm(this.state, getNow(this.env));
  }

  async enqueueTask(task) {
    if (this.hasSqlStorage()) {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO ${QUEUE_TABLE}
          (id, sort_key, enqueued_at, task_json)
          VALUES (?, ?, ?, ?)`,
        task.id,
        String(task?.source?.sortKey ?? task.enqueuedAt ?? ''),
        Number(task.enqueuedAt ?? 0),
        JSON.stringify(task),
      );
      return;
    }

    await this.withKvMutation(async () => {
      const queue = await readArray(this.state, QUEUE_KEY);
      if (!queue.some((item) => item.id === task.id)) {
        queue.push(task);
        queue.sort(compareTasks);
        await this.state.storage.put(QUEUE_KEY, queue);
      }
    });
  }

  async dequeueTask() {
    if (this.hasSqlStorage()) {
      const row = this.state.storage.sql.exec(
        `SELECT id, task_json FROM ${QUEUE_TABLE}
          ORDER BY sort_key, enqueued_at, id
          LIMIT 1`,
      ).toArray()[0];
      if (!row) {
        return null;
      }
      this.state.storage.sql.exec(`DELETE FROM ${QUEUE_TABLE} WHERE id = ?`, row.id);
      return JSON.parse(row.task_json);
    }

    return this.withKvMutation(async () => {
      const queue = await readArray(this.state, QUEUE_KEY);
      const task = queue.shift();
      await this.state.storage.put(QUEUE_KEY, queue);
      return task ?? null;
    });
  }

  async readProcessing() {
    if (this.hasSqlStorage()) {
      const row = this.state.storage.sql.exec(
        `SELECT processing_json FROM ${PROCESSING_TABLE} WHERE id = 'current'`,
      ).toArray()[0];
      return row ? JSON.parse(row.processing_json) : null;
    }
    return this.state.storage.get(PROCESSING_KEY);
  }

  async writeProcessing(processing) {
    if (this.hasSqlStorage()) {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO ${PROCESSING_TABLE} (id, processing_json) VALUES ('current', ?)`,
        JSON.stringify(processing),
      );
      return;
    }
    await this.state.storage.put(PROCESSING_KEY, processing);
  }

  async deleteProcessing() {
    if (this.hasSqlStorage()) {
      this.state.storage.sql.exec(`DELETE FROM ${PROCESSING_TABLE} WHERE id = 'current'`);
      return;
    }
    await this.state.storage.delete(PROCESSING_KEY);
  }

  async withKvMutation(callback) {
    const run = this.kvMutation.then(callback, callback);
    this.kvMutation = run.catch(() => {});
    return run;
  }

  hasSqlStorage() {
    return Boolean(this.state.storage?.sql);
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
  const workflowFile = resolveWorkflowFile(env, task.eventType);
  const ref = resolveWorkflowRef(env, task.eventType);
  const payload = buildWorkflowDispatchPayload({ task, ref });
  const response = await fetchImpl(
    `${env.GITHUB_API_BASE_URL?.trim() || GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    {
      method: 'POST',
      headers: buildGithubHeaders(env),
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(`github_workflow_dispatch_failed_http_${response.status}`);
  }
}

async function findDispatchedRunId({ fetchImpl, env, workflowFile, dispatchStartedAt, task }) {
  const { owner, repo } = resolveGithubRepository(env);
  const ref = resolveWorkflowRef(env, task?.eventType);
  const response = await fetchImpl(
    `${env.GITHUB_API_BASE_URL?.trim() || GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=20`,
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
    candidate?.id &&
    Date.parse(candidate.created_at) >= startedAt - 5_000 &&
    workflowRunMatchesTask(candidate, task)
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

function resolveWorkflowRef(env, eventType) {
  return env?.GITHUB_SYNC_REF?.trim() ||
    (String(eventType ?? '').endsWith('_dev') ? 'dev' : 'main');
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

function buildWorkflowDispatchPayload({ task, ref }) {
  const clientPayload = {
    ...task.clientPayload,
    queue_task_id: task.id,
  };
  return {
    ref,
    inputs: {
      channel: task?.source?.channel === 'feishu' ? 'feishu' : 'telegram',
      queue_task_id: task.id,
      dispatch_payload: JSON.stringify({
        action: task.eventType,
        client_payload: clientPayload,
      }),
    },
  };
}

function workflowRunMatchesTask(candidate, task) {
  if (!task?.id) {
    return true;
  }
  const text = [
    candidate.name,
    candidate.display_title,
    candidate.run_name,
  ].filter(Boolean).join('\n');
  return text.includes(task.id);
}

function initializeSqlStorage(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${QUEUE_TABLE} (
      id TEXT PRIMARY KEY,
      sort_key TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      task_json TEXT NOT NULL
    )
  `);
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${PROCESSING_TABLE} (
      id TEXT PRIMARY KEY,
      processing_json TEXT NOT NULL
    )
  `);
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
