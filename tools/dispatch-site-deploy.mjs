import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const GITHUB_API_URL = 'https://api.github.com';

export async function dispatchSiteDeploy(options = {}) {
  const repository = String(options.repository ?? '').trim();
  const token = String(options.token ?? '').trim();
  const workflowFile = String(options.workflowFile ?? '').trim();
  const ref = String(options.ref ?? '').trim();
  if (!repository || !token || !workflowFile || !ref) {
    throw new Error('repository, token, workflowFile, and ref are required');
  }
  const notification = await readDispatchNotification(options.syncDispatchEventPath);

  const inputs = compactInputs({
    strict_database_snapshot: 'true',
    sync_db_mode: 'never',
    run_tests: 'false',
    queue_task_id: options.queueTaskId,
    source_channel: options.sourceChannel,
    notification_chat_id: options.notificationChatId ?? notification?.chatId,
    notification_message_id: options.notificationMessageId ?? notification?.replyToMessageId,
    target_thought_id: options.thoughtCheck?.id,
    target_thought_module: options.thoughtCheck?.module,
    target_thought_path: options.thoughtCheck?.path,
    target_thought_expectation: options.thoughtCheck?.expectation,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${GITHUB_API_URL}/repos/${repository}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ref, inputs }),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed with HTTP ${response.status}`);
  }
  return { dispatched: true, workflowFile, ref };
}

async function readDispatchNotification(eventPath) {
  if (!eventPath) {
    return null;
  }
  try {
    const notification = JSON.parse(await readFile(String(eventPath), 'utf8')).notification;
    if (!notification || typeof notification !== 'object') {
      return null;
    }
    return notification;
  } catch {
    return null;
  }
}

function compactInputs(values) {
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, String(value ?? '').trim()])
      .filter(([, value]) => value !== ''),
  );
}

async function main() {
  const env = process.env;
  const result = await dispatchSiteDeploy({
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    workflowFile: env.SITE_DEPLOY_WORKFLOW_FILE,
    ref: env.SITE_DEPLOY_REF,
    queueTaskId: env.QUEUE_TASK_ID,
    sourceChannel: env.SOURCE_CHANNEL,
    syncDispatchEventPath: env.SYNC_DISPATCH_EVENT_PATH,
    notificationChatId: env.NOTIFICATION_CHAT_ID,
    notificationMessageId: env.NOTIFICATION_MESSAGE_ID,
    thoughtCheck: {
      id: env.THOUGHT_CHECK_ID,
      module: env.THOUGHT_CHECK_MODULE,
      path: env.THOUGHT_CHECK_PATH,
      expectation: env.THOUGHT_CHECK_EXPECTATION,
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
