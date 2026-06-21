import { AiProviderError } from '../../core/ai/errors.mjs';
import { createOpenAICompatibleProvider } from './openai-compatible.adapter.mjs';

export const DEFAULT_AI_PROVIDER = 'openai-compatible';

export { AiProviderError };

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

export function isAiSchedulerEnabled(env = process.env) {
  const normalized = String(env?.AI_SCHEDULER_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(normalized);
}
