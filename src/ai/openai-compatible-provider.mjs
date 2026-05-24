const DEFAULT_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function normalizeOpenAICompatibleProviderEnv(env = process.env) {
  const apiKey = env.AI_API_KEY;
  const baseUrl = env.AI_BASE_URL;
  const model = env.AI_MODEL;
  const timeoutMs = normalizeTimeoutMs(env.AI_TIMEOUT_MS);

  for (const [name, value] of [
    ['AI_API_KEY', apiKey],
    ['AI_BASE_URL', baseUrl],
    ['AI_MODEL', model],
  ]) {
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    timeoutMs,
  };
}

export function createOpenAICompatibleProvider(env = process.env) {
  const normalizedEnv = normalizeOpenAICompatibleProviderEnv(env);

  return {
    name: 'openai-compatible',
    env: normalizedEnv,
    async requestChatCompletion(input = {}) {
      return requestOpenAICompatibleChatCompletion(normalizedEnv, input);
    },
  };
}

async function requestOpenAICompatibleChatCompletion(env, input = {}) {
  const response = await fetchWithRetry(
    `${env.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify(buildChatCompletionRequestBody(env, input)),
    },
    {
      fetchImpl: createTimeoutFetch(input.fetchImpl ?? fetch, env.timeoutMs),
      maxAttempts: input.maxAttempts,
      baseDelayMs: input.baseDelayMs,
      retryableStatuses: input.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES,
      logPrefix: input.logPrefix ?? '[ai-provider]',
      finalErrorMessage: input.finalErrorMessage ?? 'AI request failed',
    },
  );

  return response;
}

function buildChatCompletionRequestBody(env, input) {
  const body = {
    model: input.model ?? env.model,
    messages: input.messages ?? [],
  };

  if (input.responseFormat) {
    body.response_format = input.responseFormat;
  }

  return body;
}

function createTimeoutFetch(fetchImpl, timeoutMs) {
  if (!(timeoutMs > 0)) {
    return fetchImpl;
  }

  return async (url, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`AI request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      return await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}

function normalizeTimeoutMs(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }
  return Math.floor(normalized);
}

async function fetchWithRetry(url, init, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 350));
  const retryableStatuses = options.retryableStatuses ?? new Set();
  const logPrefix = options.logPrefix ?? '[http-retry]';
  const finalErrorMessage = options.finalErrorMessage ?? 'HTTP request failed';
  let lastResponse = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (response.ok || !retryableStatuses.has(response.status) || attempt === maxAttempts) {
        return response;
      }
      lastResponse = response;
      process.stderr.write(
        `${logPrefix} request failed with HTTP ${response.status}; retrying (${attempt}/${maxAttempts})\n`,
      );
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }
      process.stderr.write(
        `${logPrefix} request failed: ${error instanceof Error ? error.message : String(error)}; retrying (${attempt}/${maxAttempts})\n`,
      );
    }

    await delay(baseDelayMs * attempt);
  }

  if (lastResponse) {
    return lastResponse;
  }
  throw lastError ?? new Error(finalErrorMessage);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
