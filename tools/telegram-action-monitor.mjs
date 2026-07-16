import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isDispatchEventName,
  readInlineDispatchPayload,
  shouldReadDispatchEventFile,
} from '../src/shared/dispatch-payload.mjs';

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

const stepLabels = [
  ['install', 'Install dependencies'],
  ['sync', 'Sync Telegram updates'],
  ['detect', 'Detect changes'],
  ['test', 'Run tests'],
  ['commit', 'Commit sync results'],
  ['rebase', 'Rebase on latest main'],
  ['push', 'Push changes'],
  ['deploy', '站点部署/页面刷新'],
];

export async function main() {
  const result = await notifyTelegramActionFailure({ env: process.env });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function notifyTelegramActionFailure(options = {}) {
  const env = options.env ?? process.env;
  const directTargets = collectDirectTelegramTargets(env);
  if (directTargets.length === 0 && !isDispatchEventName(env.GITHUB_EVENT_NAME) && !env.SYNC_DISPATCH_PAYLOAD) {
    return { notified: false, reason: 'not_dispatch_event' };
  }

  const targets = directTargets.length > 0
    ? directTargets
    : collectTelegramTargets(await readRepositoryDispatchUpdates({
        eventPath: env.SYNC_DISPATCH_EVENT_PATH ?? env.GITHUB_EVENT_PATH,
        githubEventName: env.GITHUB_EVENT_NAME,
        dispatchPayload: env.SYNC_DISPATCH_PAYLOAD ?? env.DISPATCH_PAYLOAD,
      }));
  if (targets.length === 0) {
    return { notified: false, reason: 'missing_telegram_target' };
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { notified: false, reason: 'missing_telegram_bot_token' };
  }

  const failure = resolveFailureStage(env);
  const failureSummary = await readFailureSummary(env.SYNC_FAILURE_SUMMARY_PATH);
  const text = formatActionFailureMessage({ env, failure, failureSummary });
  const sendMessage = options.sendTelegramMessage ?? sendTelegramMessageViaApi;
  let sent = 0;

  for (const target of targets) {
    await sendMessage({
      botToken,
      chatId: target.chatId,
      replyToMessageId: target.messageId,
      text,
      apiBaseUrl: env.TELEGRAM_API_BASE_URL ?? TELEGRAM_API_BASE_URL,
      fetchImpl: options.fetchImpl ?? fetch,
    });
    sent += 1;
  }

  return {
    notified: sent > 0,
    sent,
    failureCategory: 'github_action',
    failureStage: failure.stage,
  };
}

async function readRepositoryDispatchUpdates({ eventPath, githubEventName, dispatchPayload }) {
  try {
    const event =
      readInlineDispatchPayload(dispatchPayload) ??
      (shouldReadDispatchEventFile({ githubEventName, githubEventPath: eventPath })
        ? JSON.parse(await readFile(eventPath, 'utf8'))
        : null);
    const payload = event.client_payload ?? {};
    if (Array.isArray(payload.telegram_updates)) {
      return payload.telegram_updates;
    }
    if (payload.telegram_update) {
      return [payload.telegram_update];
    }
  } catch {}
  return [];
}

function collectTelegramTargets(updates) {
  const targetsByKey = new Map();
  for (const update of updates ?? []) {
    const message = update?.message ?? update?.edited_message ?? null;
    const chatId = message?.chat?.id;
    const messageId = message?.message_id;
    if (chatId === null || chatId === undefined || !messageId) {
      continue;
    }
    targetsByKey.set(`${chatId}:${messageId}`, { chatId, messageId });
  }
  return [...targetsByKey.values()];
}

function resolveFailureStage(env) {
  for (const [id, label] of stepLabels) {
    const outcome = env[`STEP_${id.toUpperCase()}_OUTCOME`];
    if (outcome === 'failure' || outcome === 'cancelled') {
      return {
        id,
        stage: label,
        outcome,
      };
    }
  }
  return {
    id: 'unknown',
    stage: 'Unknown workflow stage',
    outcome: 'failure',
  };
}

async function readFailureSummary(summaryPath) {
  if (!summaryPath) {
    return '';
  }
  try {
    return sanitizeFailureSummary(await readFile(summaryPath, 'utf8'));
  } catch {
    return '';
  }
}

function collectDirectTelegramTargets(env) {
  const chatId = String(env.NOTIFICATION_CHAT_ID ?? '').trim();
  const messageId = String(env.NOTIFICATION_MESSAGE_ID ?? '').trim();
  return chatId && messageId ? [{ chatId, messageId }] : [];
}

function sanitizeFailureSummary(content) {
  const text = String(content ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ');
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function formatActionFailureMessage({ env, failure, failureSummary = '' }) {
  const runUrl = buildRunUrl(env);
  return [
    `GitHub Action 执行失败：${failure.stage}`,
    '失败分类：github_action',
    failureSummary ? `失败摘要：${failureSummary}` : null,
    runUrl ? `查看日志：${runUrl}` : null,
  ].filter(Boolean).join('\n');
}

function buildRunUrl(env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) {
    return '';
  }
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

async function sendTelegramMessageViaApi({
  botToken,
  chatId,
  replyToMessageId,
  text,
  apiBaseUrl,
  fetchImpl,
}) {
  const response = await fetchImpl(`${apiBaseUrl}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  }
  return response;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
