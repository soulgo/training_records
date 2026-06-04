export const RECOGNITION_SCHEMA_NAME = 'telegram_training_image';
export const RECOGNITION_SCHEMA_VERSION = 'v1';

export function buildRecognitionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['imageType', 'detectedDate', 'dateEvidence', 'records', 'confidence', 'warnings'],
    properties: {
      imageType: {
        type: 'string',
        enum: ['measurement', 'workout', 'nutrition', 'sleep', 'unknown'],
      },
      detectedDate: {
        type: ['string', 'null'],
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      dateEvidence: {
        type: 'string',
      },
      confidence: {
        type: 'number',
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
      },
      records: {
        type: 'object',
        additionalProperties: false,
        required: ['measurement', 'activities', 'meals', 'totalCalories', 'details', 'dailyWorkoutSummary'],
        properties: {
          measurement: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: [
              'measuredAt',
              'bodyScore',
              'weightKg',
              'bmi',
              'bodyFatPct',
              'skeletalMuscleKg',
              'visceralFatLevel',
              'basalMetabolismKcal',
              'bodyWaterPct',
              'proteinPct',
              'boneMassKg',
              'fatFreeMassKg',
              'bodyAge',
              'bodyType',
            ],
            properties: {
              measuredAt: { type: ['string', 'null'] },
              bodyScore: { type: ['number', 'null'] },
              weightKg: { type: ['number', 'null'] },
              bmi: { type: ['number', 'null'] },
              bodyFatPct: { type: ['number', 'null'] },
              skeletalMuscleKg: { type: ['number', 'null'] },
              visceralFatLevel: { type: ['number', 'null'] },
              basalMetabolismKcal: { type: ['number', 'null'] },
              bodyWaterPct: { type: ['number', 'null'] },
              proteinPct: { type: ['number', 'null'] },
              boneMassKg: { type: ['number', 'null'] },
              fatFreeMassKg: { type: ['number', 'null'] },
              bodyAge: { type: ['number', 'null'] },
              bodyType: { type: ['string', 'null'] },
            },
          },
          activities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['time', 'type', 'detail'],
              properties: {
                time: { type: 'string' },
                type: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
          meals: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'calories', 'recommendedMin', 'recommendedMax'],
              properties: {
                name: { type: 'string' },
                calories: { type: 'number' },
                recommendedMin: { type: 'number' },
                recommendedMax: { type: 'number' },
              },
            },
          },
          totalCalories: {
            type: ['number', 'null'],
          },
          details: {
            type: 'array',
            items: { type: 'string' },
          },
          dailyWorkoutSummary: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['activityCaloriesKcal', 'workoutDurationMinutes', 'activeHours'],
            properties: {
              activityCaloriesKcal: { type: ['number', 'null'] },
              workoutDurationMinutes: { type: ['number', 'null'] },
              activeHours: { type: ['number', 'null'] },
            },
          },
          sleep: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: [
              'sleepType',
              'bedtime',
              'wakeTime',
              'nightSleepMinutes',
              'totalSleepMinutes',
              'napMinutes',
              'deepSleepMinutes',
              'lightSleepMinutes',
              'remSleepMinutes',
              'awakeMinutes',
              'sleepStageText',
              'sleepStageDetail',
            ],
            properties: {
              sleepType: { type: 'string' },
              bedtime: { type: ['string', 'null'] },
              wakeTime: { type: ['string', 'null'] },
              nightSleepMinutes: { type: ['number', 'null'] },
              totalSleepMinutes: { type: ['number', 'null'] },
              napMinutes: { type: ['number', 'null'] },
              deepSleepMinutes: { type: ['number', 'null'] },
              lightSleepMinutes: { type: ['number', 'null'] },
              remSleepMinutes: { type: ['number', 'null'] },
              awakeMinutes: { type: ['number', 'null'] },
              sleepStageText: { type: ['string', 'null'] },
              sleepStageDetail: {
                type: ['array', 'null'],
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}
