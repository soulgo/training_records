import { AiProviderError } from './errors.mjs';
import { createOpenAICompatibleProvider } from './openai-compatible-provider.mjs';

const DEFAULT_AI_PROVIDER = 'openai-compatible';

export { AiProviderError, DEFAULT_AI_PROVIDER };

/**
 * Create the shared AI provider adapter used by image recognition and training analysis.
 *
 * Contract notes:
 * - The returned provider must expose `name`, `env`, and `requestChatCompletion()`.
 * - Callers may pass an env-like object; the default path only reads the AI-related keys.
 * - Unsupported provider names fail fast with `AiProviderError` so business logic stays on the
 *   existing adapter path and behavior remains unchanged.
 */
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
