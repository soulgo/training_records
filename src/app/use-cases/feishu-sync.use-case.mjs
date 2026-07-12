import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAiProvider } from '../../adapters/ai/ai-provider.factory.mjs';
import {
  fetchFeishuImageResource,
  getFeishuTenantAccessToken,
  groupFeishuUpdates,
  resolveDispatchFeishuUpdates,
  sendFeishuMessage,
} from '../../adapters/feishu/index.mjs';
import {
  buildMessageSyncReport,
  buildSafeSyncReport,
  createRecognitionAiProvider,
  runMessageSync,
} from './telegram-sync.use-case.mjs';
import {
  writeStartedRecognitionAiCallLog as writeStartedRecognitionAiCallLogToDatabase,
} from '../../db/training/pending-recognition.mjs';
import { recognizeBatch } from './telegram-sync/image-processing.mjs';
import {
  notifyMessageSyncResultFromFile,
  notifyMessageSyncResultFromReport,
} from './telegram-sync/status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..', '..');

export async function main() {
  const result = await runFeishuSync();
  process.stdout.write(JSON.stringify(buildSafeSyncReport(result), null, 2));
  process.stdout.write('\n');
}

export async function runFeishuSync(options = {}) {
  const rawEnv = options.env ?? process.env;
  const feishuConfig = loadFeishuEnv(rawEnv);
  const sharedEnv = buildSharedSyncEnv(rawEnv);
  const aiProvider = options.aiProvider ?? createAiProvider(sharedEnv);
  const recognitionAiProvider =
    options.recognitionAiProvider ?? createRecognitionAiProvider(sharedEnv, aiProvider);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const getTenantAccessToken =
    options.getFeishuTenantAccessToken ??
    (() => getFeishuTenantAccessToken({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      fetch: fetchImpl,
      apiBaseUrl: feishuConfig.apiBaseUrl,
      cacheKey: feishuConfig.appId,
    }));
  const fetchImageFileById =
    options.fetchImageFileById ??
    (async (imageKey, context = {}) => fetchFeishuImageResource({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      tenantAccessToken: await getTenantAccessToken(),
      messageId: context.message?.sourceMessageId,
      imageKey,
      fetch: fetchImpl,
      apiBaseUrl: feishuConfig.apiBaseUrl,
      maxDownloadBytes: rawEnv.MAX_IMAGE_DOWNLOAD_BYTES,
    }));
  const sendMessage =
    options.sendFeishuMessage ??
    (async ({ chatId, text }) => sendFeishuMessage({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      tenantAccessToken: await getTenantAccessToken(),
      chatId,
      text,
      fetch: fetchImpl,
      apiBaseUrl: feishuConfig.apiBaseUrl,
    }));
  const persistNormalizedBatch =
    options.persistNormalizedBatch
      ? (input) => options.persistNormalizedBatch({ ...input, sourceChannel: 'feishu' })
      : undefined;
  const writeStartedRecognitionAiCallLog =
    options.writeStartedRecognitionAiCallLog ??
    (!options.persistNormalizedBatch && !options.recognizeBatch
      ? (event) =>
          writeStartedRecognitionAiCallLogToDatabase({
            ...event,
            env: sharedEnv,
            occurredAt: options.now ?? new Date(),
          })
      : undefined);

  return runMessageSync({
    ...options,
    adapter: {
      channel: 'feishu',
      allowedChatIdsEnvName: 'FEISHU_ALLOWED_CHAT_IDS',
      transportEnvName: 'FEISHU_SYNC_TRANSPORT',
    },
    rootDir: options.rootDir ?? rootDir,
    env: sharedEnv,
    sourceChannel: 'feishu',
    sleepBackfillSourceChannel: 'feishu_sync',
    resolveDispatchUpdates: ({ repositoryDispatchEvent, githubEventName, githubEventPath, dispatchPayload }) =>
      resolveDispatchFeishuUpdates({
        repositoryDispatchEvent,
        githubEventName,
        githubEventPath,
        dispatchPayload,
      }),
    groupUpdates: groupFeishuUpdates,
    getLastProcessedUpdateId: options.getLastProcessedUpdateId ?? (async () => 0),
    fetchTelegramUpdates: options.fetchTelegramUpdates ?? (async () => []),
    recognizeBatch:
      options.recognizeBatch ??
      ((batch, env) => recognizeBatch(batch, env, {
        aiProvider: recognitionAiProvider,
        rawEnv: sharedEnv,
        sourceChannel: 'feishu',
        fetchImageFileById,
        writeStartedRecognitionAiCallLog,
      })),
    persistNormalizedBatch,
    writeStartedRecognitionAiCallLog,
    sendTelegramMessage: sendMessage,
    fetchMessageFile: fetchImageFileById,
    aiProvider,
    recognitionAiProvider,
  });
}

export function buildFeishuSyncReport(result) {
  const report = buildMessageSyncReport(result);
  const batches = (report.batches ?? []).map(normalizeFeishuReportBatch);
  return {
    ...report,
    batches,
  };
}

function normalizeFeishuReportBatch(batch) {
  return {
    ...batch,
    recognitionErrors: normalizeFeishuRecognitionErrors(batch.recognitionErrors),
  };
}

function normalizeFeishuRecognitionErrors(errors) {
  if (!Array.isArray(errors)) {
    return errors;
  }
  return errors.map((error) => {
    const summary = normalizeFeishuRecognitionErrorSummary(error?.summary);
    return summary === error?.summary ? error : { ...error, summary };
  });
}

function normalizeFeishuRecognitionErrorSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return summary;
  }
  if (summary.sourceChannel !== 'feishu' || summary.reason !== 'image_download') {
    return summary;
  }
  return {
    ...summary,
    reason: 'feishu_api',
  };
}

export async function notifyFeishuSyncResultFromFile({
  resultPath,
  env = process.env,
  sendMessage,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const sharedEnv = buildSharedSyncEnv(env);
  const sender = sendMessage ?? createFeishuMessageSender(env, fetchImpl);
  return notifyMessageSyncResultFromFile({
    resultPath,
    env: sharedEnv,
    sendMessage: sender,
  });
}

export async function notifyFeishuSyncResultFromReport({
  report,
  env = process.env,
  sendMessage,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const sharedEnv = buildSharedSyncEnv(env);
  const sender = sendMessage ?? createFeishuMessageSender(env, fetchImpl);
  return notifyMessageSyncResultFromReport({
    report,
    env: sharedEnv,
    sendMessage: sender,
  });
}

function createFeishuMessageSender(env, fetchImpl) {
  const config = loadFeishuEnv(env, { requireAllowedChatIds: false });
  let tokenPromise = null;
  return async ({ chatId, text }) => {
    tokenPromise ??= getFeishuTenantAccessToken({
      appId: config.appId,
      appSecret: config.appSecret,
      fetch: fetchImpl,
      apiBaseUrl: config.apiBaseUrl,
      cacheKey: config.appId,
    });
    return sendFeishuMessage({
      tenantAccessToken: await tokenPromise,
      chatId,
      text,
      fetch: fetchImpl,
      apiBaseUrl: config.apiBaseUrl,
    });
  };
}

function loadFeishuEnv(env = process.env, options = {}) {
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  const allowedChatIds = env.FEISHU_ALLOWED_CHAT_IDS;
  const required = [
    ['FEISHU_APP_ID', appId],
    ['FEISHU_APP_SECRET', appSecret],
  ];
  if (options.requireAllowedChatIds !== false) {
    required.push(['FEISHU_ALLOWED_CHAT_IDS', allowedChatIds]);
  }
  for (const [name, value] of required) {
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  return {
    appId,
    appSecret,
    allowedChatIds,
    apiBaseUrl: String(env.FEISHU_API_BASE_URL ?? '').replace(/\/+$/, '') || undefined,
  };
}

function buildSharedSyncEnv(env) {
  return {
    ...env,
    TELEGRAM_SYNC_NOTIFY: env.FEISHU_SYNC_NOTIFY ?? env.TELEGRAM_SYNC_NOTIFY,
    TELEGRAM_SYNC_NOTIFY_STAGE: env.FEISHU_SYNC_NOTIFY_STAGE ?? env.TELEGRAM_SYNC_NOTIFY_STAGE,
    TELEGRAM_SYNC_RESULT_PATH: env.FEISHU_SYNC_RESULT_PATH ?? env.TELEGRAM_SYNC_RESULT_PATH,
    TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE:
      env.FEISHU_RECOGNITION_IMAGE_INPUT_MODE ??
      env.TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE ??
      'inline',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
