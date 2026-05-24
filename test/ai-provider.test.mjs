import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AiProviderError,
  createAiProvider,
  normalizeAiProviderName,
} from '../src/ai/provider.mjs';

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
  assert.equal(provider.env.timeoutMs, null);
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

test('createAiProvider rejects unsupported providers', () => {
  assert.throws(
    () =>
      createAiProvider({
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
        AI_PROVIDER: 'custom',
      }),
    AiProviderError,
  );
});
