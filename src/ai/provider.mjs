import { AiProviderError } from './errors.mjs';
import { createOpenAICompatibleProvider } from './openai-compatible-provider.mjs';

const DEFAULT_AI_PROVIDER = 'openai-compatible';

export { AiProviderError, DEFAULT_AI_PROVIDER };

export function normalizeAiProviderName(providerName) {
  const normalized = String(providerName ?? '').trim().toLowerCase();
  return normalized || DEFAULT_AI_PROVIDER;
}

export function createAiProvider(env = process.env) {
  const activeEnv = env ?? process.env;
  const providerName = normalizeAiProviderName(activeEnv.AI_PROVIDER);

  if (providerName === DEFAULT_AI_PROVIDER) {
    return createOpenAICompatibleProvider(activeEnv);
  }

  throw new AiProviderError(`Unsupported AI provider: ${providerName}`);
}
