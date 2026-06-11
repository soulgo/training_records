import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecognitionCacheKey,
  isRecognitionCacheEnabled,
  recognizeTelegramImageMessage,
} from '../src/app/use-cases/image-recognition.use-case.mjs';

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

test('recognizeTelegramImageMessage normalizes incomplete Huawei sleep payloads before schema validation', async () => {
  const result = await recognizeTelegramImageMessage({
    aiProvider: {
      env: { model: 'gpt-test' },
      async requestChatCompletion() {
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      imageType: 'sleep',
                      detectedDate: '2026-06-04',
                      dateEvidence: 'image header: 2026-06-04',
                      confidence: 0.98,
                      warnings: [],
                      records: {
                        sleep: {
                          bedtime: '6/3 23:26',
                          totalSleepMinutes: 411,
                          deepSleepMinutes: 145,
                          lightSleepMinutes: 195,
                          remSleepMinutes: 71,
                          sleepScore: 81,
                          sleepScorePercentile: 77,
                          deepSleepRatioPct: 35,
                          lightSleepRatioPct: 47,
                          remSleepRatioPct: 18,
                          deepSleepContinuityScore: 85,
                          wakeCount: 1,
                          breathingQualityScore: 98,
                          averageHeartRateBpm: 68,
                          hrvMs: 34,
                          averageSpo2Pct: 97,
                          averageRespiratoryRate: 14,
                          analysisText: '睡眠质量良好。',
                          suggestionText: '建议睡觉时关灯。',
                        },
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
      messageId: 80,
      caption: '',
      text: '',
      photos: [{ fileUniqueId: 'sleep-file-1' }],
    },
    imageUrl: 'https://example.com/sleep.jpg',
    systemPrompt: 'system prompt',
    promptMetadata,
    env: {
      AI_MODEL: 'gpt-test',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: '',
    },
  });

  assert.equal(result.imageType, 'sleep');
  assert.equal(result.records.sleep.wakeTime, null);
  assert.equal(result.records.sleep.nightSleepMinutes, null);
  assert.equal(result.records.sleep.sleepScore, 81);
  assert.equal(result.records.sleep.averageHeartRateBpm, 68);
  assert.deepEqual(result.records.sleep.sleepStageDetail, []);
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

test('recognizeTelegramImageMessage treats cache read failures as cache misses', async () => {
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
                      detectedDate: '2026-06-08',
                      dateEvidence: 'image header: 2026-06-08',
                      confidence: 0.91,
                      warnings: [],
                      records: {
                        measurement: null,
                        activities: [],
                        meals: [],
                        totalCalories: null,
                        details: [],
                        dailyWorkoutSummary: {
                          activityCaloriesKcal: 864,
                          workoutDurationMinutes: 119,
                          activeHours: 16,
                        },
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
      messageId: 84,
      caption: '',
      text: '',
      photos: [{ fileUniqueId: 'file-cache-timeout' }],
    },
    imageUrl: 'https://example.com/workout.jpg',
    systemPrompt: 'system prompt',
    promptMetadata,
    env: {
      AI_MODEL: 'gpt-test',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: 'true',
    },
    readRecognitionCache: async () => {
      throw new Error('timeout expired');
    },
  });

  assert.equal(requestCount, 1);
  assert.equal(result.cacheStatus, 'miss');
  assert.equal(result.imageType, 'workout');
});

test('recognizeTelegramImageMessage retries configured fallback provider after empty primary content', async () => {
  const calls = [];
  const fallbackProvider = {
    name: 'openai-compatible',
    env: { model: 'gpt-fallback' },
    async requestChatCompletion() {
      calls.push('fallback');
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    imageType: 'workout',
                    detectedDate: '2026-06-08',
                    dateEvidence: 'image header: 2026-06-08',
                    confidence: 0.93,
                    warnings: [],
                    records: {
                      measurement: null,
                      activities: [],
                      meals: [],
                      totalCalories: null,
                      details: [],
                      dailyWorkoutSummary: {
                        activityCaloriesKcal: 864,
                        workoutDurationMinutes: 119,
                        activeHours: 16,
                      },
                    },
                  }),
                },
              },
            ],
          };
        },
      };
    },
  };
  const primaryProvider = {
    name: 'openai-compatible',
    env: { model: 'gpt-primary' },
    fallbackProvider,
    async requestChatCompletion() {
      calls.push('primary');
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: '',
                },
              },
            ],
          };
        },
      };
    },
  };

  const result = await recognizeTelegramImageMessage({
    aiProvider: primaryProvider,
    message: {
      messageId: 85,
      caption: '',
      text: '',
      photos: [{ fileUniqueId: 'file-empty-primary' }],
    },
    imageUrl: 'https://example.com/workout.jpg',
    systemPrompt: 'system prompt',
    promptMetadata,
    env: {
      AI_MODEL: 'gpt-primary',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: '',
    },
  });

  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.imageType, 'workout');
  assert.equal(result.model, 'gpt-fallback');
});

test('recognizeTelegramImageMessage retries fallback provider when primary timeout is wrapped', async () => {
  const calls = [];
  const result = await recognizeTelegramImageMessage({
    aiProvider: {
      name: 'openai-compatible',
      env: { model: 'gpt-primary' },
      fallbackProvider: {
        name: 'openai-compatible',
        env: { model: 'gpt-fallback' },
        async requestChatCompletion() {
          calls.push('fallback');
          return {
            ok: true,
            async json() {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        imageType: 'nutrition',
                        detectedDate: '2026-06-08',
                        dateEvidence: 'image header: 2026-06-08',
                        confidence: 0.9,
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
      async requestChatCompletion() {
        calls.push('primary');
        throw new Error('AI recognition request failed', {
          cause: new Error('AI request timed out after 8000ms'),
        });
      },
    },
    message: {
      messageId: 86,
      caption: '',
      text: '',
      photos: [{ fileUniqueId: 'file-wrapped-timeout' }],
    },
    imageUrl: 'https://example.com/nutrition.jpg',
    systemPrompt: 'system prompt',
    promptMetadata,
    env: {
      AI_MODEL: 'gpt-primary',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: '',
    },
  });

  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.imageType, 'nutrition');
  assert.equal(result.model, 'gpt-fallback');
});

test('recognizeTelegramImageMessage parses SSE-style data response bodies', async () => {
  const recognitionContent = JSON.stringify({
    imageType: 'nutrition',
    detectedDate: '2026-05-29',
    dateEvidence: 'image header: 2026-05-29',
    confidence: 0.95,
    warnings: [],
    records: {
      measurement: null,
      activities: [],
      meals: [
        { name: '早餐', calories: 225, recommendedMin: 512, recommendedMax: 922 },
        { name: '午餐', calories: 266, recommendedMin: 615, recommendedMax: 1024 },
        { name: '晚餐', calories: 360, recommendedMin: 308, recommendedMax: 717 },
      ],
      totalCalories: 851,
      details: ['粗粮粥 111 千卡', '炸鸡排 266 千卡', '炒拉条 360 千卡'],
      dailyWorkoutSummary: null,
    },
  });
  const payload = {
    choices: [
      {
        message: {
          content: `\`\`\`json\n${recognitionContent}\n\`\`\``,
        },
      },
    ],
  };

  const result = await recognizeTelegramImageMessage({
    aiProvider: {
      env: { model: 'gpt-test' },
      async requestChatCompletion() {
        return {
          ok: true,
          async text() {
            return `data: ${JSON.stringify(payload)}\n\n`;
          },
        };
      },
    },
    message: {
      messageId: 80,
      caption: '',
      text: '',
      photos: [{ fileUniqueId: 'file-4' }],
    },
    imageUrl: 'https://example.com/image.jpg',
    systemPrompt: 'system prompt',
    promptMetadata,
    env: {
      AI_MODEL: 'gpt-test',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: '',
    },
  });

  assert.equal(result.imageType, 'nutrition');
  assert.equal(result.detectedDate, '2026-05-29');
  assert.equal(result.records.totalCalories, 851);
  assert.equal(result.records.meals.length, 3);
});

test('recognizeTelegramImageMessage includes a safe summary when message content is invalid JSON', async () => {
  await assert.rejects(
    () =>
      recognizeTelegramImageMessage({
        aiProvider: {
          env: { model: 'gpt-test' },
          async requestChatCompletion() {
            return {
              ok: true,
              headers: new Headers({
                'content-type': 'application/json',
              }),
              async text() {
                return JSON.stringify({
                  choices: [
                    {
                      message: {
                        content: 'telegram_training_image returned invalid JSON with extra diagnostic text',
                      },
                    },
                  ],
                });
              },
            };
          },
        },
        message: {
          messageId: 82,
          caption: '',
          text: '',
          photos: [{ fileUniqueId: 'file-6' }],
        },
        imageUrl: 'https://api.telegram.org/file/bottoken/photos/file_82.jpg',
        systemPrompt: 'system prompt',
        promptMetadata,
        env: {
          AI_MODEL: 'gpt-test',
          TELEGRAM_RECOGNITION_CACHE_ENABLED: '',
        },
      }),
    (error) => {
      assert.equal(error.name, 'AiSchemaError');
      assert.match(error.message, /invalid JSON/);
      assert.equal(error.summary.contentType, 'application/json');
      assert.equal(error.summary.parseStage, 'message_content_json');
      assert.match(error.summary.snippet, /telegram_training_image returned invalid JSON/);
      assert.doesNotMatch(error.summary.snippet, /api\.telegram\.org/);
      assert.equal(error.summary.snippet.length <= 200, true);
      return true;
    },
  );
});

test('recognizeTelegramImageMessage retries once with strict JSON guidance when content is invalid JSON', async () => {
  let requestCount = 0;
  const result = await recognizeTelegramImageMessage({
    aiProvider: {
      env: { model: 'gpt-test' },
      async requestChatCompletion(input) {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            ok: true,
            async json() {
              return {
                choices: [
                  {
                    message: {
                      content: 'telegram_training_image returned invalid JSON',
                    },
                  },
                ],
              };
            },
          };
        }

        const userText = input.messages?.[1]?.content?.find((part) => part.type === 'text')?.text ?? '';
        assert.match(userText, /previous response was not valid json/i);
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      imageType: 'nutrition',
                      detectedDate: '2026-05-31',
                      dateEvidence: 'image header: 2026-05-31',
                      confidence: 0.96,
                      warnings: [],
                      records: {
                        measurement: null,
                        activities: [],
                        meals: [{ name: '晚餐', calories: 868, recommendedMin: 310, recommendedMax: 723 }],
                        totalCalories: 868,
                        details: ['晚餐 868 千卡'],
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
      messageId: 83,
      caption: '',
      text: '',
      photos: [{ fileUniqueId: 'file-7' }],
    },
    imageUrl: 'https://example.com/image.jpg',
    systemPrompt: 'system prompt',
    promptMetadata,
    env: {
      AI_MODEL: 'gpt-test',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: '',
    },
  });

  assert.equal(requestCount, 2);
  assert.equal(result.imageType, 'nutrition');
  assert.equal(result.records.totalCalories, 868);
});

test('recognizeTelegramImageMessage lowers confidence when measurement payload has no measurement data', async () => {
  const result = await recognizeTelegramImageMessage({
    aiProvider: {
      env: { model: 'gpt-test' },
      async requestChatCompletion() {
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      imageType: 'measurement',
                      detectedDate: '2026-05-29',
                      dateEvidence: 'image header: 2026-05-29',
                      confidence: 0.96,
                      warnings: [],
                      records: {
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
      messageId: 81,
      caption: '',
      text: '',
      photos: [{ fileUniqueId: 'file-5' }],
    },
    imageUrl: 'https://example.com/image.jpg',
    systemPrompt: 'system prompt',
    promptMetadata,
    env: {
      AI_MODEL: 'gpt-test',
      TELEGRAM_RECOGNITION_CACHE_ENABLED: '',
    },
  });

  assert.equal(result.imageType, 'measurement');
  assert.equal(result.records.measurement, null);
  assert.equal(result.confidence < 0.75, true);
  assert.match(result.warnings.join('\n'), /measurement image missing measurement data/i);
});
