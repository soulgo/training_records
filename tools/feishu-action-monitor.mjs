import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getFeishuTenantAccessToken,
  resolveDispatchFeishuUpdates,
  sendFeishuMessage,
} from '../src/adapters/feishu/index.mjs';
import { isDispatchEventName } from '../src/adapters/telegram/polling.transport.mjs';

const stepLabels = [
  ['install', 'Install dependencies'],
  ['sync', 'Sync Feishu updates'],
  ['detect', 'Detect changes'],
  ['commit', 'Commit sync results'],
  ['rebase', 'Rebase on latest main'],
  ['push', 'Push changes'],
  ['deploy', '站点部署/页面刷新'],
];

export async function main() {
  const result = await notifyFeishuActionFailure({ env: process.env });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function notifyFeishuActionFailure(options = {}) {
  const env = options.env ?? process.env;
  const directTargets = collectDirectFeishuTargets(env);
  if (directTargets.length === 0 && !isDispatchEventName(env.GITHUB_EVENT_NAME) && !env.SYNC_DISPATCH_PAYLOAD) {
    return { notified: false, reason: 'not_dispatch_event' };
  }

  const targets = directTargets.length > 0
    ? directTargets
    : collectFeishuTargets(await resolveDispatchFeishuUpdates({
        githubEventName: env.GITHUB_EVENT_NAME,
        githubEventPath: env.SYNC_DISPATCH_EVENT_PATH ?? env.GITHUB_EVENT_PATH,
        dispatchPayload: env.SYNC_DISPATCH_PAYLOAD ?? env.DISPATCH_PAYLOAD,
      }));
  if (targets.length === 0) {
    return { notified: false, reason: 'missing_feishu_target' };
  }

  const failure = resolveFailureStage(env);
  const text = formatActionFailureMessage({ env, failure });
  const sendMessage = options.sendFeishuMessage ?? createFeishuMessageSender(env, options.fetchImpl ?? fetch);
  let sent = 0;

  for (const target of targets) {
    await sendMessage({
      chatId: target.chatId,
      text,
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

function collectDirectFeishuTargets(env) {
  const chatId = String(env.NOTIFICATION_CHAT_ID ?? '').trim();
  return chatId ? [{ chatId }] : [];
}

function collectFeishuTargets(updates) {
  const targetsByChat = new Map();
  for (const update of updates ?? []) {
    const chatId = update?.event?.message?.chat_id;
    if (!chatId) {
      continue;
    }
    targetsByChat.set(chatId, { chatId });
  }
  return [...targetsByChat.values()];
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

function formatActionFailureMessage({ env, failure }) {
  const runUrl = buildRunUrl(env);
  return [
    `GitHub Action 执行失败：${failure.stage}`,
    '失败分类：github_action',
    runUrl ? `查看日志：${runUrl}` : null,
  ].filter(Boolean).join('\n');
}

function buildRunUrl(env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) {
    return '';
  }
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function createFeishuMessageSender(env, fetchImpl) {
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  const apiBaseUrl = String(env.FEISHU_API_BASE_URL ?? '').replace(/\/+$/, '') || undefined;
  if (!appId || !appSecret) {
    return async () => {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
    };
  }

  let tokenPromise = null;
  return async ({ chatId, text }) => {
    tokenPromise ??= getFeishuTenantAccessToken({
      appId,
      appSecret,
      fetch: fetchImpl,
      apiBaseUrl,
      cacheKey: appId,
    });
    return sendFeishuMessage({
      tenantAccessToken: await tokenPromise,
      chatId,
      text,
      fetch: fetchImpl,
      apiBaseUrl,
    });
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
