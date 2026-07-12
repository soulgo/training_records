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
