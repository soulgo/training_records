import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecognitionCacheKey,
  isRecognitionCacheEnabled,
  recognizeTelegramImageMessage,
} from '../src/ai/recognition-service.mjs';

const promptMetadata = {
  version: '2026-05-24',
  schemaName: 'telegram_training_image',
  schemaVersion: 'v1',
};

test('recognition cache key includes file id, prompt version, schema version, and model', () => {
  const key = buildRecognitionCacheKey({
    fileUniqueId: 'file-1',
    promptVersion: '2026-05-24',
    schemaVersion: 'v1',
    model: 'gpt-test',
  });

  assert.equal(key, 'telegram:file_unique_id:file-1:prompt:2026-05-24:schema:v1:model:gpt-test');
  assert.equal(buildRecognitionCacheKey({ fileUniqueId: '', promptVersion: '1', schemaVersion: 'v1', model: 'm' }), null);
});

test('recognition cache is opt-in by default', () => {
  assert.equal(isRecognitionCacheEnabled({ TELEGRAM_RECOGNITION_CACHE_ENABLED: '' }), false);
  assert.equal(isRecognitionCacheEnabled({ TELEGRAM_RECOGNITION_CACHE_ENABLED: 'true' }), true);
});

test('recognizeTelegramImageMessage skips cache when disabled and keeps runtime metadata out of payload', async () => {
  let requestCount = 0;
  const result = await recognizeTelegramImageMessage({
    aiProvider: {
      env: { model: 'gpt-test' },
      async requestChatCompletion() {
        requestCount += 1;
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      imageType: 'workout',
                      detectedDate: '2026-05-24',
                      dateEvidence: 'image header: 2026-05-24',
                      confidence: 0.92,
                      warnings: [],
                      records: {
                        measurement: null,
                        activities: [],
                        meals: [],
                        totalCalories: null,
                        details: [],
                        dailyWorkoutSummary: null,
                      },
                    }),
                  },
                },
              ],
            };
          },
        };
      },
    },
    message: {
      messageId: 77,
      caption: 'test',
      text: '',
      photos: [{ fileUniqueId: 'file-1' }],
    },
    imageUrl: 'https://example.com/image.jpg',
    systemPrompt: 'system prompt',
    promptMetadata,
    env: {
      AI_MODEL: 'gpt-test',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: '',
    },
  });

  assert.equal(requestCount, 1);
  assert.equal(result.cacheStatus, 'disabled');
  assert.equal(result.promptVersion, '2026-05-24');
  assert.equal(result.schemaVersion, 'v1');
  assert.equal(result.model, 'gpt-test');
  assert.equal(result.messageId, 77);
  assert.equal(result.imageType, 'workout');
});

test('recognizeTelegramImageMessage hits cache when versioned metadata matches', async () => {
  let requestCount = 0;
  const cached = {
    imageType: 'measurement',
    detectedDate: '2026-05-24',
    dateEvidence: 'image header: 2026-05-24',
    confidence: 0.99,
    warnings: [],
    records: {
      measurement: null,
      activities: [],
      meals: [],
      totalCalories: null,
      details: [],
      dailyWorkoutSummary: null,
    },
  };

  const result = await recognizeTelegramImageMessage({
    aiProvider: {
      env: { model: 'gpt-test' },
      async requestChatCompletion() {
        requestCount += 1;
        return { ok: false, status: 500 };
      },
    },
    message: {
      messageId: 78,
      caption: 'test',
      text: '',
      photos: [{ fileUniqueId: 'file-2' }],
    },
    imageUrl: 'https://example.com/image.jpg',
    systemPrompt: 'system prompt',
    promptMetadata,
    env: {
      AI_MODEL: 'gpt-test',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: 'true',
    },
    readRecognitionCache: async ({ cacheKey, promptVersion, schemaVersion, model }) => {
      assert.equal(cacheKey, 'telegram:file_unique_id:file-2:prompt:2026-05-24:schema:v1:model:gpt-test');
      assert.equal(promptVersion, '2026-05-24');
      assert.equal(schemaVersion, 'v1');
      assert.equal(model, 'gpt-test');
      return cached;
    },
  });

  assert.equal(requestCount, 0);
  assert.equal(result.cacheStatus, 'hit');
  assert.equal(result.cacheKey, 'telegram:file_unique_id:file-2:prompt:2026-05-24:schema:v1:model:gpt-test');
  assert.equal(result.imageType, 'measurement');
  assert.equal(result.messageId, 78);
  assert.equal(result.promptVersion, undefined);
});

test('recognizeTelegramImageMessage misses cache when prompt version changes', async () => {
  let requestCount = 0;
  const result = await recognizeTelegramImageMessage({
    aiProvider: {
      env: { model: 'gpt-test' },
      async requestChatCompletion() {
        requestCount += 1;
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      imageType: 'nutrition',
                      detectedDate: null,
                      dateEvidence: 'no reliable image date',
                      confidence: 0.88,
                      warnings: [],
                      records: {
                        measurement: null,
                        activities: [],
                        meals: [],
                        totalCalories: null,
                        details: [],
                        dailyWorkoutSummary: null,
                      },
                    }),
                  },
                },
              ],
            };
          },
        };
      },
    },
    message: {
      messageId: 79,
      caption: 'test',
      text: '',
      photos: [{ fileUniqueId: 'file-3' }],
    },
    imageUrl: 'https://example.com/image.jpg',
    systemPrompt: 'system prompt',
    promptMetadata: {
      ...promptMetadata,
      version: '2026-05-25',
    },
    env: {
      AI_MODEL: 'gpt-test',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: 'true',
    },
    readRecognitionCache: async () => null,
  });

  assert.equal(requestCount, 1);
  assert.equal(result.cacheStatus, 'miss');
  assert.equal(result.promptVersion, '2026-05-25');
  assert.equal(result.schemaVersion, 'v1');
});
