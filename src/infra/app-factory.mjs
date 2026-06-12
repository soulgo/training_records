import { createAiProvider } from '../adapters/ai/index.mjs';
import { HexoGeneratorAdapter, HexoGeneratorPort } from '../adapters/hexo/index.mjs';
import { PostgresTrainingRepository } from '../adapters/postgres/index.mjs';
import {
  buildTelegramWebhookConfig,
  fetchTelegramUpdates,
  sendTelegramMessage,
  setTelegramWebhook,
  TelegramBotAdapter,
  TelegramBotPort,
} from '../adapters/telegram/index.mjs';
import { resolveConfig, validateConfig } from './config.mjs';

export {
  buildTelegramWebhookConfig,
  fetchTelegramUpdates,
  HexoGeneratorPort,
  resolveConfig,
  sendTelegramMessage,
  setTelegramWebhook,
  TelegramBotPort,
};

export function createApp(config = resolveConfig()) {
  const appConfig = validateConfig(config);
  const aiProvider = createOptionalAiProvider(appConfig);
  const telegramBot = new TelegramBotAdapter(appConfig.telegram);
  const hexoGenerator = new HexoGeneratorAdapter();

  return {
    config: appConfig,
    aiProvider,
    telegramBot,
    hexoGenerator,
    createTrainingRepository(client) {
      return new PostgresTrainingRepository(client);
    },
  };
}

function createOptionalAiProvider(config) {
  if (!config.ai.apiKey || !config.ai.baseUrl || !config.ai.model) {
    return null;
  }
  return createAiProvider({
    AI_PROVIDER: config.ai.provider,
    AI_API_KEY: config.ai.apiKey,
    AI_BASE_URL: config.ai.baseUrl,
    AI_MODEL: config.ai.model,
  });
}
