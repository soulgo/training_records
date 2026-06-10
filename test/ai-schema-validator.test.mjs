import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AiProviderError,
  AiSchemaError,
  extractAiResponseContent,
  parseAiJsonContent,
} from '../src/core/ai/schema-validator.mjs';
import { buildRecognitionSchema } from '../tools/telegram-recognition-schema.mjs';

test('extractAiResponseContent throws AiProviderError when content is empty', () => {
  assert.throws(
    () =>
      extractAiResponseContent(
        {
          choices: [
            {
              message: {
                content: '',
              },
            },
          ],
        },
        { label: 'AI recognition', schemaName: 'telegram_training_image', schemaVersion: 'v1' },
      ),
    AiProviderError,
  );
});

test('parseAiJsonContent throws AiSchemaError for invalid JSON', () => {
  assert.throws(
    () =>
      parseAiJsonContent(
        '{not-json',
        buildRecognitionSchema(),
        { schemaName: 'telegram_training_image', schemaVersion: 'v1' },
      ),
    AiSchemaError,
  );
});

test('parseAiJsonContent throws AiSchemaError for missing required fields', () => {
  assert.throws(
    () =>
      parseAiJsonContent(
        JSON.stringify({
          imageType: 'measurement',
          detectedDate: null,
          dateEvidence: 'no reliable image date',
          confidence: 0.9,
          records: {
            measurement: null,
            activities: [],
            meals: [],
            totalCalories: null,
            details: [],
            dailyWorkoutSummary: null,
            sleep: null,
          },
        }),
        buildRecognitionSchema(),
        { schemaName: 'telegram_training_image', schemaVersion: 'v1' },
      ),
    (error) => {
      assert.ok(error instanceof AiSchemaError);
      assert.equal(error.schemaName, 'telegram_training_image');
      assert.equal(error.schemaVersion, 'v1');
      assert.match(error.message, /warnings/);
      return true;
    },
  );
});

test('parseAiJsonContent returns a valid recognition payload unchanged', () => {
  const payload = {
    imageType: 'workout',
    detectedDate: null,
    dateEvidence: 'no reliable image date',
    confidence: 0.92,
    warnings: [],
    records: {
      measurement: null,
      activities: [
        {
          time: '07:00',
          type: '力量训练',
          detail: '30分钟，消耗180千卡',
        },
      ],
      meals: [],
      totalCalories: null,
      details: [],
      dailyWorkoutSummary: {
        activityCaloriesKcal: 180,
        workoutDurationMinutes: 30,
        activeHours: 1,
      },
      sleep: {
        sleepType: 'night',
        bedtime: null,
        wakeTime: null,
        nightSleepMinutes: null,
        totalSleepMinutes: null,
        napMinutes: null,
        deepSleepMinutes: null,
        lightSleepMinutes: null,
        remSleepMinutes: null,
        awakeMinutes: null,
        sleepStageText: null,
        sleepStageDetail: null,
        sleepScore: null,
        sleepScorePercentile: null,
        deepSleepRatioPct: null,
        lightSleepRatioPct: null,
        remSleepRatioPct: null,
        deepSleepContinuityScore: null,
        wakeCount: null,
        breathingQualityScore: null,
        averageHeartRateBpm: null,
        hrvMs: null,
        averageSpo2Pct: null,
        averageRespiratoryRate: null,
        analysisText: null,
        suggestionText: null,
      },
    },
  };

  const parsed = parseAiJsonContent(JSON.stringify(payload), buildRecognitionSchema(), {
    schemaName: 'telegram_training_image',
    schemaVersion: 'v1',
  });

  assert.deepEqual(parsed, payload);
});
