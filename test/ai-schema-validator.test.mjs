import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AiProviderError,
  AiSchemaError,
  extractAiResponseContent,
  parseAiJsonContent,
} from '../src/core/ai/schema-validator.mjs';
import {
  buildRecognitionSchema,
  RECOGNITION_SCHEMA_VERSION,
} from '../src/core/ai/telegram-recognition-schema.mjs';
import { applyRecognitionSemanticWarnings } from '../src/core/ai/recognition-semantic-validator.mjs';

test('recognition schema version is bumped for required records.sleep contract', () => {
  assert.equal(RECOGNITION_SCHEMA_VERSION, 'v3');
  assert.ok(buildRecognitionSchema().properties.records.required.includes('sleep'));
});

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
          detectedApp: null,
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
        { schemaName: 'telegram_training_image', schemaVersion: RECOGNITION_SCHEMA_VERSION },
      ),
    (error) => {
      assert.ok(error instanceof AiSchemaError);
      assert.equal(error.schemaName, 'telegram_training_image');
      assert.equal(error.schemaVersion, RECOGNITION_SCHEMA_VERSION);
      assert.match(error.message, /warnings/);
      return true;
    },
  );
});

test('parseAiJsonContent requires detectedApp in recognition payloads', () => {
  assert.throws(
    () =>
      parseAiJsonContent(
        JSON.stringify({
          imageType: 'measurement',
          detectedDate: null,
          dateEvidence: 'no reliable image date',
          confidence: 0.9,
          warnings: [],
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
        { schemaName: 'telegram_training_image', schemaVersion: RECOGNITION_SCHEMA_VERSION },
      ),
    (error) => {
      assert.ok(error instanceof AiSchemaError);
      assert.equal(error.schemaVersion, RECOGNITION_SCHEMA_VERSION);
      assert.match(error.message, /detectedApp/);
      return true;
    },
  );
});

test('parseAiJsonContent returns a valid recognition payload unchanged', () => {
  const payload = {
    imageType: 'workout',
    detectedApp: 'Apple Health',
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
    schemaVersion: RECOGNITION_SCHEMA_VERSION,
  });

  assert.deepEqual(parsed, payload);
});

test('parseAiJsonContent requires records.sleep to be explicit even for non-sleep images', () => {
  assert.throws(
    () =>
      parseAiJsonContent(
        JSON.stringify({
          imageType: 'nutrition',
          detectedApp: 'Food App',
          detectedDate: '2026-06-01',
          dateEvidence: 'image header',
          confidence: 0.9,
          warnings: [],
          records: {
            measurement: null,
            activities: [],
            meals: [{ name: '晚餐', calories: 500, recommendedMin: null, recommendedMax: null }],
            totalCalories: 500,
            details: [],
            dailyWorkoutSummary: null,
          },
        }),
        buildRecognitionSchema(),
        { schemaName: 'telegram_training_image', schemaVersion: RECOGNITION_SCHEMA_VERSION },
      ),
    (error) => {
      assert.ok(error instanceof AiSchemaError);
      assert.match(error.message, /sleep/);
      return true;
    },
  );
});

test('recognition semantic validator adds safe warnings for impossible measurement and sleep fields', () => {
  const payload = {
    imageType: 'sleep',
    detectedApp: 'Health',
    detectedDate: '2026-06-01',
    dateEvidence: 'image header',
    confidence: 0.9,
    warnings: [],
    records: {
      measurement: {
        measuredAt: null,
        bodyScore: null,
        weightKg: 1000,
        bmi: 800,
        bodyFatPct: 180,
        skeletalMuscleKg: null,
        visceralFatLevel: null,
        basalMetabolismKcal: null,
        bodyWaterPct: null,
        proteinPct: null,
        boneMassKg: 90,
        fatFreeMassKg: 1200,
        bodyAge: null,
        bodyType: null,
      },
      activities: [],
      meals: [],
      totalCalories: null,
      details: [],
      dailyWorkoutSummary: null,
      sleep: {
        sleepType: '夜间睡眠',
        bedtime: null,
        wakeTime: null,
        nightSleepMinutes: 300,
        totalSleepMinutes: 100,
        napMinutes: 0,
        deepSleepMinutes: 300,
        lightSleepMinutes: 300,
        remSleepMinutes: 300,
        awakeMinutes: null,
        sleepStageText: null,
        sleepStageDetail: null,
        sleepScore: 200,
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

  const validated = applyRecognitionSemanticWarnings(payload);

  assert.deepEqual(validated.records.measurement.weightKg, 1000);
  assert.ok(validated.warnings.includes('semantic:measurement.weightKg outside supported range'));
  assert.ok(validated.warnings.includes('semantic:measurement.fatFreeMassKg exceeds weightKg'));
  assert.ok(validated.warnings.includes('semantic:sleep.totalSleepMinutes conflicts with component sleep minutes'));
  assert.ok(validated.warnings.includes('semantic:sleep.stageMinutes exceed totalSleepMinutes'));
  assert.doesNotMatch(JSON.stringify(validated.warnings), /1000|800|1200|300/);
});
