import { resolveTrainingCoreConfig } from '../db/training/config.mjs';
import { DEFAULT_AI_PROVIDER, normalizeAiProviderName } from '../adapters/ai/index.mjs';

export function resolveConfig(env = process.env) {
  return {
    database: resolveTrainingCoreConfig(env),
    ai: {
      provider: normalizeAiProviderName(env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER),
      apiKey: env.AI_API_KEY ?? '',
      baseUrl: env.AI_BASE_URL ?? '',
      model: env.AI_MODEL ?? '',
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN ?? '',
      transport: normalizeTelegramTransport(env.TELEGRAM_TRANSPORT),
    },
    hexo: {},
  };
}

export function validateConfig(config) {
  if (config.database.enabled && !config.database.url) {
    throw new Error('Missing required configuration: database.url');
  }
  return config;
}

function normalizeTelegramTransport(value) {
  const normalized = String(value ?? 'polling').trim().toLowerCase();
  return normalized === 'webhook' ? 'webhook' : 'polling';
}
