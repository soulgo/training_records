import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AiProviderError,
  AiSchemaError,
  extractAiResponseContent,
  parseAiJsonContent,
  validateAiJsonValue,
} from '../src/core/ai/schema-validator.mjs';
import {
  buildRecognitionSchema,
  RECOGNITION_SCHEMA_VERSION,
} from '../src/core/ai/telegram-recognition-schema.mjs';
import { applyRecognitionSemanticGate } from '../src/core/ai/recognition-semantic-validator.mjs';
import {
  evaluateRecognitionCompleteness,
  RECOGNITION_COMPLETENESS_VERSION,
} from '../src/core/ai/recognition-completeness.mjs';

function recognitionFor(imageType, records, overrides = {}) {
  return {
    imageType,
    detectedApp: null,
    detectedDate: '2026-07-16',
    dateEvidence: 'image header',
    confidence: 0.95,
    warnings: [],
    records: {
      measurement: null,
      activities: [],
      meals: [],
      totalCalories: null,
      details: [],
      dailyWorkoutSummary: null,
      sleep: null,
      ...records,
    },
    ...overrides,
  };
}

test('recognition completeness enforces four hard contracts without channel state', () => {
  const cases = [
    [recognitionFor('measurement', { measurement: { weightKg: 72.4 } }), 'complete', []],
    [recognitionFor('measurement', { measurement: { weightKg: null } }), 'incomplete', ['records.measurement.weightKg']],
    [recognitionFor('workout', { activities: [{ time: '07:30', type: '跑步', detail: '晨跑' }] }), 'complete', []],
    [recognitionFor('workout', { dailyWorkoutSummary: { activityCaloriesKcal: 520 } }), 'complete', []],
    [recognitionFor('workout', {}), 'incomplete', ['records.activities', 'records.dailyWorkoutSummary.activityCaloriesKcal']],
    [recognitionFor('nutrition', { totalCalories: 868 }), 'complete', []],
    [recognitionFor('nutrition', { meals: [{ name: '晚餐', calories: 868 }] }), 'complete', []],
    [recognitionFor('nutrition', { details: ['晚餐'] }), 'incomplete', ['records.totalCalories']],
    [recognitionFor('sleep', { sleep: { totalSleepMinutes: 438, nightSleepMinutes: null } }), 'complete', []],
    [recognitionFor('sleep', { sleep: { totalSleepMinutes: null, nightSleepMinutes: null, sleepScore: 90 } }), 'incomplete', ['records.sleep.duration']],
  ];

  for (const [recognition, status, missingFields] of cases) {
    const result = evaluateRecognitionCompleteness({ recognition });
    assert.equal(result.status, status);
    assert.equal(result.version, RECOGNITION_COMPLETENESS_VERSION);
    assert.deepEqual(result.missingFields, missingFields);
  }
});

test('recognition completeness only requires conditional fields backed by visible evidence', () => {
  const measurement = recognitionFor('measurement', {
    measurement: { weightKg: 72.4, bodyFatPct: null },
  });

  assert.equal(evaluateRecognitionCompleteness({ recognition: measurement }).status, 'complete');
  const visible = evaluateRecognitionCompleteness({
    recognition: measurement,
    ocrDocument: { text: '体重 72.4 kg\n体脂率', blocks: [] },
  });
  assert.equal(visible.status, 'incomplete');
  assert.deepEqual(visible.conditionalFields, ['records.measurement.bodyFatPct']);
  assert.ok(visible.evidenceCodes.includes('ocr:records.measurement.bodyFatPct'));

  const sleep = recognitionFor('sleep', {
    sleep: { totalSleepMinutes: 438, nightSleepMinutes: null, sleepScore: null },
  });
  assert.equal(evaluateRecognitionCompleteness({ recognition: sleep }).status, 'complete');
  assert.equal(evaluateRecognitionCompleteness({
    recognition: sleep,
    ocrDocument: { text: 'Sleep Score', blocks: [] },
  }).status, 'incomplete');
});

test('recognition completeness does not infer conditional fields from a generic app profile alone', () => {
  const measurement = recognitionFor('measurement', {
    measurement: { weightKg: 72.4, bodyFatPct: null },
  }, { detectedApp: 'Apple Health' });
  const appProfiles = {
    profiles: [{
      appName: 'Apple Health',
      appAliases: ['Apple 健康'],
      pageTypes: { measurement: ['Body Measurements', 'Weight', 'Body Fat Percentage'] },
      fieldAliases: {
        'records.measurement.bodyFatPct': ['Body Fat Percentage'],
      },
    }],
  };

  const result = evaluateRecognitionCompleteness({ recognition: measurement, appProfiles });

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.conditionalFields, []);
  assert.equal(result.evidenceCodes.some((code) => code.startsWith('app_profile:')), false);
});

test('recognition completeness ignores model-declared app profile evidence', () => {
  const recognition = recognitionFor('measurement', {
    measurement: { weightKg: 72.4, bodyFatPct: null },
  }, {
    detectedApp: 'Apple Health',
    appProfileEvidence: { visibleLabels: ['Body Fat Percentage'] },
  });
  const appProfiles = {
    profiles: [{
      appName: 'Apple Health',
      pageTypes: { measurement: ['Weight', 'Body Fat Percentage'] },
      fieldAliases: { 'records.measurement.bodyFatPct': ['Body Fat Percentage'] },
    }],
  };

  const result = evaluateRecognitionCompleteness({ recognition, appProfiles });

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.conditionalFields, []);
});

test('recognition completeness matches short English labels by word boundary', () => {
  const recognition = recognitionFor('workout', {
    activities: [{ time: '07:30', type: 'Walking', detail: 'Movement trends', calories: null }],
  });

  const result = evaluateRecognitionCompleteness({
    recognition,
    ocrDocument: { text: 'Movement trends', blocks: [] },
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.conditionalFields, []);
});

test('recognition completeness rejects non-positive business quantities', () => {
  const cases = [
    recognitionFor('workout', { dailyWorkoutSummary: { activityCaloriesKcal: -1 } }),
    recognitionFor('nutrition', { totalCalories: -1 }),
    recognitionFor('nutrition', { meals: [{ name: '晚餐', calories: -1 }] }),
    recognitionFor('sleep', { sleep: { totalSleepMinutes: -1, nightSleepMinutes: null } }),
  ];

  for (const recognition of cases) {
    assert.equal(evaluateRecognitionCompleteness({ recognition }).status, 'incomplete');
  }
});

test('recognition semantic gate clears non-positive workout and nutrition metrics without deleting activity identity', () => {
  const gated = applyRecognitionSemanticGate(recognitionFor('workout', {
    activities: [{
      time: '07:30', type: '跑步', detail: '晨跑', durationSeconds: 0, calories: 0,
      heartRate: 0, distanceKm: 0, avgSpeedKmh: 0,
    }],
    dailyWorkoutSummary: { activityCaloriesKcal: 0, workoutDurationMinutes: 0, activeHours: 0 },
  }));

  assert.equal(gated.records.activities.length, 1);
  assert.deepEqual(gated.records.activities[0], {
    time: '07:30', type: '跑步', detail: '晨跑', durationSeconds: null, calories: null,
    heartRate: null, distanceKm: null, avgSpeedKmh: null,
  });
  assert.deepEqual(gated.records.dailyWorkoutSummary, {
    activityCaloriesKcal: null, workoutDurationMinutes: null, activeHours: null,
  });
  assert.ok(gated.warnings.includes('semantic:activities[].calories must be positive'));
});

test('recognition completeness preserves semantic review and unknown behavior', () => {
  const needsReview = evaluateRecognitionCompleteness({
    recognition: recognitionFor('sleep', {
      sleep: { totalSleepMinutes: 438, nightSleepMinutes: null },
    }, {
      semanticGate: { status: 'needs_review', decisions: [{ action: 'review', path: 'sleep.totalSleepMinutes' }] },
    }),
  });
  assert.equal(needsReview.status, 'needs_review');
  assert.deepEqual(needsReview.reviewFields, ['records.sleep.totalSleepMinutes']);
  assert.equal(needsReview.requiresFallback, true);

  const unknown = evaluateRecognitionCompleteness({ recognition: recognitionFor('unknown', {}) });
  assert.equal(unknown.status, 'complete');
  assert.equal(unknown.requiresFallback, false);
  assert.ok(unknown.evidenceCodes.includes('unknown_type'));
});

test('recognition schema version is bumped for required records.sleep contract', () => {
  assert.equal(RECOGNITION_SCHEMA_VERSION, 'v4');
  assert.ok(buildRecognitionSchema().properties.records.required.includes('sleep'));
});

test('local schema validator enforces v4 composition and scalar collection bounds', () => {
  const schema = {
    type: 'object',
    required: ['schemaVersion', 'observations'],
    properties: {
      schemaVersion: { const: 'v4' },
      observations: {
        type: 'array', minItems: 1, maxItems: 2,
        items: {
          oneOf: [
            {
              type: 'object', required: ['recordType', 'confidence', 'label'],
              properties: {
                recordType: { const: 'measurement' },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                label: { type: 'string', minLength: 1, maxLength: 8 },
              },
            },
            {
              type: 'object', required: ['recordType', 'confidence', 'label'],
              properties: {
                recordType: { const: 'activity' },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                label: { type: 'string', minLength: 1, maxLength: 8 },
              },
            },
          ],
        },
      },
    },
  };

  assert.doesNotThrow(() => validateAiJsonValue({
    schemaVersion: 'v4',
    observations: [{ recordType: 'activity', confidence: 0.8, label: 'run' }],
  }, schema));
  for (const invalid of [
    { schemaVersion: 'v3', observations: [{ recordType: 'activity', confidence: 0.8, label: 'run' }] },
    { schemaVersion: 'v4', observations: [] },
    { schemaVersion: 'v4', observations: [{ recordType: 'activity', confidence: 1.1, label: 'run' }] },
    { schemaVersion: 'v4', observations: [{ recordType: 'unknown', confidence: 0.8, label: 'run' }] },
    { schemaVersion: 'v4', observations: [{ recordType: 'activity', confidence: 0.8, label: '' }] },
  ]) {
    assert.throws(() => validateAiJsonValue(invalid, schema), AiSchemaError);
  }
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

test('extractAiResponseContent explains incomplete Responses output with safe metadata', () => {
  assert.throws(
    () =>
      extractAiResponseContent(
        {
          choices: [{ message: { content: '' } }],
          __aiResponseMeta: {
            protocol: 'responses',
            status: 'incomplete',
            incompleteReason: 'max_output_tokens',
            outputTypes: ['reasoning'],
            contentTypes: [],
            hasRefusal: false,
          },
        },
        { label: 'AI recognition' },
      ),
    (error) => {
      assert.equal(error instanceof AiProviderError, true);
      assert.match(error.message, /incomplete Responses output/i);
      assert.match(error.message, /status=incomplete/);
      assert.match(error.message, /reason=max_output_tokens/);
      assert.match(error.message, /output_types=reasoning/);
      return true;
    },
  );
});

test('extractAiResponseContent rejects non-empty content from an incomplete Responses result', () => {
  assert.throws(
    () =>
      extractAiResponseContent(
        {
          choices: [{ message: { content: '{"records":[]}' } }],
          __aiResponseMeta: {
            protocol: 'responses',
            status: 'incomplete',
            incompleteReason: 'max_output_tokens',
            outputTypes: ['message'],
            contentTypes: ['output_text'],
            hasRefusal: false,
          },
        },
        { label: 'AI recognition' },
      ),
    (error) => {
      assert.equal(error instanceof AiProviderError, true);
      assert.match(error.message, /incomplete Responses output/i);
      assert.match(error.message, /reason=max_output_tokens/);
      return true;
    },
  );
});

test('extractAiResponseContent identifies refusal Responses output without refusal text', () => {
  assert.throws(
    () =>
      extractAiResponseContent(
        {
          choices: [{ message: { content: '' } }],
          __aiResponseMeta: {
            protocol: 'responses',
            status: 'completed',
            incompleteReason: null,
            outputTypes: ['message'],
            contentTypes: ['refusal'],
            hasRefusal: true,
          },
        },
        { label: 'AI recognition' },
      ),
    (error) => {
      assert.equal(error instanceof AiProviderError, true);
      assert.match(error.message, /refusal Responses output/i);
      assert.doesNotMatch(error.message, /sensitive refusal text/i);
      return true;
    },
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
          durationSeconds: 1800,
          calories: 180,
          heartRate: null,
          distanceKm: null,
          avgSpeedKmh: null,
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

test('recognition semantic gate sanitizes impossible fields and marks relational conflicts for review', () => {
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

  const validated = applyRecognitionSemanticGate(payload);

  assert.equal(validated.records.measurement.weightKg, null);
  assert.equal(validated.records.measurement.bmi, null);
  assert.equal(validated.records.sleep.sleepScore, null);
  assert.equal(validated.semanticGate.status, 'needs_review');
  assert.ok(validated.semanticGate.decisions.some((decision) => decision.action === 'sanitize'));
  assert.ok(validated.semanticGate.decisions.some((decision) => decision.action === 'review'));
  assert.equal(validated.semanticGate.rawResult.records.measurement.weightKg, 1000);
  assert.ok(validated.warnings.includes('semantic:measurement.weightKg outside supported range'));
  assert.ok(validated.warnings.includes('semantic:measurement.fatFreeMassKg exceeds weightKg'));
  assert.ok(validated.warnings.includes('semantic:sleep.totalSleepMinutes conflicts with component sleep minutes'));
  assert.ok(validated.warnings.includes('semantic:sleep.stageMinutes exceed totalSleepMinutes'));
  assert.doesNotMatch(JSON.stringify(validated.warnings), /1000|800|1200|300/);
});

test('semantic gate sanitizes fat-free mass exceeding weight and keeps the measurement complete', () => {
  const payload = {
    imageType: 'measurement',
    records: {
      measurement: { weightKg: 70, bodyFatPct: 22, fatFreeMassKg: 90 },
      activities: [],
      meals: [],
      totalCalories: null,
      details: [],
      dailyWorkoutSummary: null,
      sleep: null,
    },
  };

  const validated = applyRecognitionSemanticGate(payload);

  assert.equal(validated.records.measurement.weightKg, 70);
  assert.equal(validated.records.measurement.bodyFatPct, 22);
  assert.equal(validated.records.measurement.fatFreeMassKg, null);
  assert.equal(validated.semanticGate.status, 'sanitized');
  assert.ok(validated.semanticGate.decisions.some(
    (decision) => decision.action === 'sanitize' && decision.path === 'measurement.fatFreeMassKg',
  ));
  assert.ok(!validated.semanticGate.decisions.some((decision) => decision.action === 'review'));
  assert.ok(validated.warnings.includes('semantic:measurement.fatFreeMassKg exceeds weightKg'));

  const completeness = evaluateRecognitionCompleteness({ recognition: validated });
  assert.equal(completeness.status, 'complete');
  assert.equal(completeness.requiresFallback, false);
});
