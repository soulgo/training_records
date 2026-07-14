export async function readLastProcessedUpdateIdForRun({
  readLastProcessedUpdateId,
  dispatchUpdates,
  allowFallback = false,
}) {
  try {
    return await readLastProcessedUpdateId();
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[telegram-sync] could not read last processed update id: ${message}; continuing with repository dispatch payload\n`,
    );
    return 0;
  }
}

export function normalizeMessageSyncAdapter(adapter = {}) {
  const channel = String(adapter.channel ?? 'telegram').trim().toLowerCase() || 'telegram';
  return {
    channel,
    botTokenEnvName: adapter.botTokenEnvName ?? (channel === 'telegram' ? 'TELEGRAM_BOT_TOKEN' : null),
    allowedChatIdsEnvName:
      adapter.allowedChatIdsEnvName ?? (channel === 'telegram' ? 'TELEGRAM_ALLOWED_CHAT_IDS' : null),
    transportEnvName:
      adapter.transportEnvName ?? (channel === 'telegram' ? 'TELEGRAM_SYNC_TRANSPORT' : null),
  };
}

export function loadRequiredEnv(env = process.env, options = {}) {
  const adapter = options.adapter ?? normalizeMessageSyncAdapter();
  const botToken = adapter.botTokenEnvName
    ? env[adapter.botTokenEnvName]
    : env.TELEGRAM_BOT_TOKEN ?? adapter.channel;
  const apiKey = env.AI_API_KEY ?? '';
  const baseUrl = env.AI_BASE_URL ?? '';
  const model = env.AI_MODEL ?? '';
  const allowedChatIdsRaw = adapter.allowedChatIdsEnvName
    ? env[adapter.allowedChatIdsEnvName]
    : env.TELEGRAM_ALLOWED_CHAT_IDS;
  const dbEnabled = env.TRAINING_DB_ENABLED;
  const dbUrl = env.TRAINING_DB_URL;
  const pollLimit = Number(env.TELEGRAM_POLL_LIMIT ?? 20);
  const aiConcurrency = normalizeAiConcurrency(env.AI_CONCURRENCY, {
    maxValue: env.AI_CONCURRENCY_MAX,
  });

  const required = [
    ['TRAINING_DB_ENABLED', dbEnabled],
    ['TRAINING_DB_URL', dbUrl],
  ];
  if (adapter.botTokenEnvName) {
    required.unshift([adapter.botTokenEnvName, botToken]);
  }
  if (adapter.allowedChatIdsEnvName) {
    required.push([adapter.allowedChatIdsEnvName, allowedChatIdsRaw]);
  }

  for (const [name, value] of required) {
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  const syncTransportValue = adapter.transportEnvName
    ? env[adapter.transportEnvName]
    : env.TELEGRAM_SYNC_TRANSPORT;

  return {
    botToken,
    apiKey,
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    model,
    syncTransport:
      String(syncTransportValue ?? 'poll').toLowerCase() === 'webhook'
        ? 'webhook'
        : 'poll',
    githubEventName: env.GITHUB_EVENT_NAME?.trim() || '',
    githubEventPath: env.SYNC_DISPATCH_EVENT_PATH?.trim() || env.GITHUB_EVENT_PATH?.trim() || '',
    dispatchPayload: env.SYNC_DISPATCH_PAYLOAD ?? env.DISPATCH_PAYLOAD ?? '',
    replayMode: String(env.SYNC_REPLAY_MODE ?? '').toLowerCase() === 'scheduled' ? 'scheduled' : 'disabled',
    pollLimit: Number.isFinite(pollLimit) && pollLimit > 0 ? pollLimit : 20,
    aiConcurrency,
    allowedChatIds: parseAllowedChatIds(allowedChatIdsRaw),
  };
}

function normalizeAiConcurrency(value, options = {}) {
  const defaultValue = 3;
  const configured = Number(value ?? defaultValue);
  const maxValue = Number(options.maxValue ?? 5);
  const limit = Number.isFinite(maxValue) && maxValue > 0 ? Math.floor(maxValue) : 5;
  const normalized =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : defaultValue;
  return Math.min(normalized, limit);
}

function parseAllowedChatIds(value) {
  const ids = new Set();
  for (const entry of String(value ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    ids.add(trimmed);
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      ids.add(numeric);
    }
  }
  return ids;
}
