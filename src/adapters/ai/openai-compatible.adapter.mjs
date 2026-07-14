const DEFAULT_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function normalizeOpenAICompatibleProviderEnv(env = process.env) {
  const apiKey = env.AI_API_KEY;
  const baseUrl = env.AI_BASE_URL;
  const model = env.AI_MODEL;
  const timeoutMs = normalizeTimeoutMs(env.AI_TIMEOUT_MS);
  const apiProtocol = normalizeApiProtocol(env.AI_API_PROTOCOL);

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
    apiProtocol,
  };
}

export function createOpenAICompatibleProvider(env = process.env) {
  const normalizedEnv = normalizeOpenAICompatibleProviderEnv(env);

  return {
    name: 'openai-compatible',
    env: normalizedEnv,
    capabilities: {
      vision: normalizeCapability(env.AI_SUPPORTS_VISION, true),
      jsonSchema: normalizeCapability(env.AI_SUPPORTS_JSON_SCHEMA, true),
      jsonObject: normalizeCapability(env.AI_SUPPORTS_JSON_OBJECT, true),
      textJson: normalizeCapability(env.AI_SUPPORTS_TEXT_JSON, true),
    },
    async requestChatCompletion(input = {}) {
      return requestOpenAICompatibleChatCompletion(normalizedEnv, input);
    },
  };
}

async function requestOpenAICompatibleChatCompletion(env, input = {}) {
  const usesResponsesApi = env.apiProtocol === 'responses';
  const response = await fetchWithRetry(
    `${env.baseUrl}/${usesResponsesApi ? 'responses' : 'chat/completions'}`,
    {
      method: 'POST',
      headers: buildChatCompletionRequestHeaders(env, input),
      body: JSON.stringify(
        usesResponsesApi
          ? buildResponsesRequestBody(env, input)
          : buildChatCompletionRequestBody(env, input),
      ),
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

  return usesResponsesApi && response.ok
    ? adaptResponsesApiResponse(response)
    : response;
}

function normalizeApiProtocol(value) {
  const normalized = String(value ?? '').trim().toLowerCase() || 'chat_completions';
  if (!['chat_completions', 'responses'].includes(normalized)) {
    throw new Error(`Unsupported AI API protocol: ${normalized}`);
  }
  return normalized;
}

function normalizeCapability(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function buildChatCompletionRequestHeaders(env, input) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${env.apiKey}`,
  };
  const idempotencyKey = String(input.idempotencyKey ?? '').trim();
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return headers;
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

function buildResponsesRequestBody(env, input) {
  const body = {
    model: input.model ?? env.model,
    store: input.store ?? false,
    input: (input.messages ?? []).map(convertResponsesInputMessage),
  };

  const format = convertResponsesTextFormat(input.responseFormat);
  if (format) {
    body.text = { format };
  }

  return body;
}

function convertResponsesInputMessage(message) {
  if (!Array.isArray(message?.content)) {
    return message;
  }

  return {
    ...message,
    content: message.content.map(convertResponsesInputContent),
  };
}

function convertResponsesInputContent(content) {
  if (content?.type === 'text') {
    return {
      ...content,
      type: 'input_text',
    };
  }
  if (content?.type === 'image_url') {
    const imageUrl = content.image_url;
    return {
      type: 'input_image',
      image_url: typeof imageUrl === 'string' ? imageUrl : imageUrl?.url,
      ...(typeof imageUrl === 'object' && imageUrl?.detail ? { detail: imageUrl.detail } : {}),
    };
  }
  return content;
}

function convertResponsesTextFormat(responseFormat) {
  if (!responseFormat) {
    return null;
  }
  if (responseFormat.type === 'json_schema') {
    return {
      type: 'json_schema',
      ...(responseFormat.json_schema ?? {}),
    };
  }
  return responseFormat;
}

function adaptResponsesApiResponse(response) {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    url: response.url,
    async json() {
      return normalizeResponsesApiPayload(await response.json());
    },
  };
}

function normalizeResponsesApiPayload(payload) {
  const usage = payload?.usage && typeof payload.usage === 'object'
    ? {
        ...payload.usage,
        prompt_tokens: payload.usage.prompt_tokens ?? payload.usage.input_tokens,
        completion_tokens: payload.usage.completion_tokens ?? payload.usage.output_tokens,
      }
    : payload?.usage;

  return {
    ...payload,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: extractResponsesOutputText(payload),
        },
        finish_reason: payload?.status === 'incomplete' ? 'length' : 'stop',
      },
    ],
    usage,
  };
}

function extractResponsesOutputText(payload) {
  if (typeof payload?.output_text === 'string') {
    return payload.output_text;
  }

  return (payload?.output ?? [])
    .filter((item) => item?.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
    .map((content) => content.text)
    .join('');
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
    return 45000;
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
        throw new Error(finalErrorMessage, { cause: error });
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
