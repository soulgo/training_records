import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AiProviderError,
  createAiProvider,
  normalizeAiProviderName,
} from '../src/adapters/ai/index.mjs';

test('normalizeAiProviderName defaults to openai-compatible', () => {
  assert.equal(normalizeAiProviderName(''), 'openai-compatible');
  assert.equal(normalizeAiProviderName('  '), 'openai-compatible');
  assert.equal(normalizeAiProviderName(undefined), 'openai-compatible');
  assert.equal(normalizeAiProviderName('OpenAI-Compatible'), 'openai-compatible');
});

test('createAiProvider defaults to openai-compatible and trims the base url', () => {
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1/',
    AI_MODEL: 'gpt-test',
  });

  assert.equal(provider.name, 'openai-compatible');
  assert.equal(provider.env.baseUrl, 'https://example.com/v1');
  assert.equal(provider.env.timeoutMs, 45000);
  assert.equal(provider.env.apiProtocol, 'chat_completions');
  assert.deepEqual(provider.capabilities, {
    vision: true,
    jsonSchema: true,
    jsonObject: true,
    textJson: true,
  });
});

test('createAiProvider exposes independently configurable protocol capabilities', () => {
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
    AI_SUPPORTS_VISION: 'false',
    AI_SUPPORTS_JSON_SCHEMA: 'false',
    AI_SUPPORTS_JSON_OBJECT: 'true',
    AI_SUPPORTS_TEXT_JSON: 'false',
  });

  assert.deepEqual(provider.capabilities, {
    vision: false,
    jsonSchema: false,
    jsonObject: true,
    textJson: false,
  });
});

test('createAiProvider sends the same chat completion shape used by analysis and recognition', async () => {
  let request = null;
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
  });

  const response = await provider.requestChatCompletion({
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'telegram_training_image',
        strict: true,
        schema: { type: 'object' },
      },
    },
    fetchImpl: async (url, init) => {
      request = {
        url,
        body: JSON.parse(init.body),
      };
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: 'ok',
                },
              },
            ],
          };
        },
      };
    },
  });

  assert.equal(request.url, 'https://example.com/v1/chat/completions');
  assert.equal(request.body.model, 'gpt-test');
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal(request.body.response_format.type, 'json_schema');
  assert.equal(response.ok, true);
});

test('createAiProvider adapts multimodal structured requests and responses for the Responses API', async () => {
  let request = null;
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
    AI_API_PROTOCOL: 'responses',
  });

  const response = await provider.requestChatCompletion({
    messages: [
      { role: 'system', content: 'Return structured training data.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this screenshot.' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/jpeg;base64,abc123',
              detail: 'high',
            },
          },
        ],
      },
    ],
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'telegram_training_image',
        strict: true,
        schema: { type: 'object' },
      },
    },
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'resp_123',
            output: [
              { type: 'reasoning', content: [] },
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '{"records":[]}', annotations: [] }],
              },
            ],
            usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
          };
        },
      };
    },
  });

  assert.equal(provider.env.apiProtocol, 'responses');
  assert.equal(request.url, 'https://example.com/v1/responses');
  assert.deepEqual(request.body, {
    model: 'gpt-test',
    store: false,
    input: [
      { role: 'system', content: 'Return structured training data.' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Read this screenshot.' },
          {
            type: 'input_image',
            image_url: 'data:image/jpeg;base64,abc123',
            detail: 'high',
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'telegram_training_image',
        strict: true,
        schema: { type: 'object' },
      },
    },
  });

  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, '{"records":[]}');
  assert.deepEqual(payload.usage, {
    input_tokens: 12,
    output_tokens: 7,
    total_tokens: 19,
    prompt_tokens: 12,
    completion_tokens: 7,
  });
});

test('createAiProvider preserves chat-shaped content returned by a Responses-compatible gateway', async () => {
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
    AI_API_PROTOCOL: 'responses',
  });

  const response = await provider.requestChatCompletion({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          id: 'resp_gateway_123',
          status: 'completed',
          choices: [{ message: { role: 'assistant', content: '{"records":[]}' } }],
        };
      },
    }),
  });

  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, '{"records":[]}');
});

test('createAiProvider falls back to chat-shaped content when Responses output_text is empty', async () => {
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
    AI_API_PROTOCOL: 'responses',
  });

  const response = await provider.requestChatCompletion({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          id: 'resp_gateway_empty_output_text',
          status: 'completed',
          output_text: '',
          choices: [{ message: { role: 'assistant', content: '{"records":[]}' } }],
        };
      },
    }),
  });

  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, '{"records":[]}');
});

test('createAiProvider exposes safe metadata for an incomplete Responses result', async () => {
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
    AI_API_PROTOCOL: 'responses',
  });

  const response = await provider.requestChatCompletion({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          id: 'resp_incomplete_123',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'reasoning', content: [] }],
        };
      },
    }),
  });

  const payload = await response.json();
  assert.deepEqual(payload.__aiResponseMeta, {
    protocol: 'responses',
    status: 'incomplete',
    incompleteReason: 'max_output_tokens',
    outputTypes: ['reasoning'],
    contentTypes: [],
    hasRefusal: false,
  });
  assert.equal(JSON.stringify(payload.__aiResponseMeta).includes('hello'), false);
});

test('createAiProvider records refusal type without retaining refusal text in metadata', async () => {
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
    AI_API_PROTOCOL: 'responses',
  });

  const response = await provider.requestChatCompletion({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'completed',
          output: [{
            type: 'message',
            content: [{ type: 'refusal', refusal: 'sensitive refusal text' }],
          }],
        };
      },
    }),
  });

  const payload = await response.json();
  assert.equal(payload.__aiResponseMeta.hasRefusal, true);
  assert.deepEqual(payload.__aiResponseMeta.contentTypes, ['refusal']);
  assert.equal(JSON.stringify(payload.__aiResponseMeta).includes('sensitive refusal text'), false);
});

test('createAiProvider forwards idempotency keys on chat completion requests', async () => {
  let requestHeaders = null;
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
  });

  await provider.requestChatCompletion({
    messages: [{ role: 'user', content: 'hello' }],
    idempotencyKey: 'recognition:abc123',
    fetchImpl: async (_url, init) => {
      requestHeaders = init.headers;
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: 'ok' } }],
          };
        },
      };
    },
  });

  assert.equal(requestHeaders['Idempotency-Key'], 'recognition:abc123');
});

test('createAiProvider attaches an AbortController signal when AI_TIMEOUT_MS is omitted', async () => {
  let signal = null;
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
  });

  await provider.requestChatCompletion({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: 'ok' } }],
          };
        },
      };
    },
  });

  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test('createAiProvider uses configured AI_TIMEOUT_MS for request aborts', async () => {
  let signal = null;
  const provider = createAiProvider({
    AI_API_KEY: 'key',
    AI_BASE_URL: 'https://example.com/v1',
    AI_MODEL: 'gpt-test',
    AI_TIMEOUT_MS: '5',
  });

  await assert.rejects(
    provider.requestChatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      maxAttempts: 1,
      fetchImpl: async (_url, init) => {
        signal = init.signal;
        await new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      },
    }),
    /AI request failed/,
  );

  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, true);
  assert.match(String(signal.reason?.message ?? signal.reason), /timed out after 5ms/);
});

test('createAiProvider rejects unsupported API protocols instead of silently using chat completions', () => {
  assert.throws(
    () => createAiProvider({
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      AI_API_PROTOCOL: 'legacy',
    }),
    /Unsupported AI API protocol: legacy/,
  );
});

test('createAiProvider rejects unsupported providers with a typed adapter error', () => {
  assert.throws(
    () =>
      createAiProvider({
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        AI_PROVIDER: 'custom',
      }),
    (error) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.name, 'AiProviderError');
      assert.match(error.message, /Unsupported AI provider: custom/);
      return true;
    },
  );
});
