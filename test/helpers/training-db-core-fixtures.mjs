import assert from 'node:assert/strict';

export const normalizedBatch = {
  batchId: 'album-20260509',
  status: 'ready',
  archivedDate: '2026-05-09',
  measurement: {
    measuredAt: '2026-05-09 06:42',
    bodyScore: 74,
    weightKg: 72.85,
    bmi: 23.5,
    bodyFatPct: 22.8,
    skeletalMuscleKg: 30.45,
    visceralFatLevel: 8,
    basalMetabolismKcal: 1587,
    bodyWaterPct: 49.7,
    proteinPct: 23.3,
    boneMassKg: 2.955,
    fatFreeMassKg: 56.6,
    bodyAge: 32,
    bodyType: '肥胖型',
  },
  activities: [
    {
      time: '19:13',
      type: '力量训练',
      detail: '总消耗241千卡，时长00:27:50，平均心率129次/分钟',
    },
  ],
  workoutDailySummary: {
    activityCaloriesKcal: 643,
    workoutDurationMinutes: 78,
    activeHours: 12,
  },
  nutrition: {
    meals: [
      { name: '晚餐', calories: 1065, recommendedMin: 317, recommendedMax: 740 },
    ],
    totalCalories: 1593,
    details: ['晚餐 1065 千卡（建议范围 317-740 千卡）'],
  },
  warnings: [],
  issues: [],
  confidence: 0.97,
  updateIds: [901, 902],
  recognitions: [
    {
      messageId: 71,
      imageType: 'workout',
      detectedDate: '2026-05-09',
      confidence: 0.97,
    },
  ],
  messages: [
    {
      updateId: 901,
      messageId: 71,
      mediaGroupId: 'album-20260509',
      caption: '归档到 2026-05-09',
      text: '',
      chatId: 42,
      dateUnix: 1746748800,
      photos: [{ fileId: 'abc', fileUniqueId: 'u-abc' }],
    },
  ],
};

export function buildCoreTestDay(date, { calories, activityTime, mealName }) {
  return {
    date,
    measurement: {
      archivedDate: date,
      measuredAt: `${date} 07:00`,
      bodyScore: 75,
      weightKg: 72.5,
      bmi: 23.4,
      bodyFatPct: 22.1,
      skeletalMuscleKg: 30.5,
      visceralFatLevel: null,
      basalMetabolismKcal: null,
      bodyWaterPct: null,
      proteinPct: null,
      boneMassKg: null,
      fatFreeMassKg: null,
      bodyAge: null,
      bodyType: null,
    },
    measurements: [
      {
        archivedDate: date,
        measuredAt: `${date} 07:00`,
        bodyScore: 75,
        weightKg: 72.5,
        bmi: 23.4,
        bodyFatPct: 22.1,
        skeletalMuscleKg: 30.5,
        visceralFatLevel: null,
        basalMetabolismKcal: null,
        bodyWaterPct: null,
        proteinPct: null,
        boneMassKg: null,
        fatFreeMassKg: null,
        bodyAge: null,
        bodyType: null,
      },
    ],
    activities: [
      {
        time: activityTime,
        type: '力量训练',
        rawType: '力量训练',
        detail: `总消耗${calories}千卡，时长00:32:00`,
        calories,
        heartRate: null,
        distanceKm: null,
        avgSpeedKmh: null,
        durationText: '00:32:00',
        durationSeconds: 1920,
      },
    ],
    workoutSummary: {
      totalActivities: 1,
      totalDurationSeconds: 1920,
      trainingCalories: calories,
      workoutDurationMinutes: 32,
      activeHours: 13,
      cyclingDistanceKm: 0,
      countsByType: {
        力量训练: 1,
      },
    },
    nutrition: {
      meals: [{ name: mealName, calories: 800, recommendedMin: 317, recommendedMax: 740 }],
      totalCalories: 800,
      details: [],
    },
  };
}

export function createIncrementalPersistClient({
  activitySummary = {},
  mealSummary = {},
  daySummary = {},
  measurementRows = [],
  activityRows = [],
  mealRows = [],
  sleepRows = [],
} = {}) {
  const calls = [];
  const client = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.measurement/i.test(sql) && !/insert into core\.measurement/i.test(sql)) {
        return { rows: measurementRows };
      }
      if (/count\(\*\)::integer as total_activities/i.test(sql)) {
        return {
          rows: [{
            total_activities: activitySummary.total_activities ?? 0,
            total_duration_seconds: activitySummary.total_duration_seconds ?? 0,
            training_calories: activitySummary.training_calories ?? 0,
            cycling_distance_km: activitySummary.cycling_distance_km ?? 0,
          }],
        };
      }
      if (/select coalesce\(sum\(calories\), 0\)::integer as intake_calories/i.test(sql)) {
        return { rows: [{ intake_calories: mealSummary.intake_calories ?? 0 }] };
      }
      if (/from core\.activity/i.test(sql) && !/insert into core\.activity/i.test(sql)) {
        return { rows: activityRows };
      }
      if (/from core\.meal/i.test(sql) && !/insert into core\.meal/i.test(sql)) {
        return { rows: mealRows };
      }
      if (/from core\.sleep/i.test(sql) && !/insert into core\.sleep/i.test(sql)) {
        return { rows: sleepRows };
      }
      if (
        /from core\.training_day/i.test(sql) &&
        /workout_duration_minutes/i.test(sql) &&
        !/insert into core\.training_day/i.test(sql)
      ) {
        return {
          rows: [{
            workout_duration_minutes: daySummary.workout_duration_minutes ?? null,
            active_hours: daySummary.active_hours ?? null,
            intake_calories: daySummary.intake_calories ?? null,
            nutrition_details_json: daySummary.nutrition_details_json ?? [],
          }],
        };
      }
      if (
        /from core\.training_day/i.test(sql) &&
        /where archived_date = \$1/i.test(sql) &&
        !/insert into core\.training_day/i.test(sql)
      ) {
        return {
          rows: [{
            archived_date: params?.[0] ?? normalizedBatch.archivedDate,
            total_activities: activitySummary.total_activities ?? activityRows.length,
            total_duration_seconds: activitySummary.total_duration_seconds ?? 0,
            training_calories: activitySummary.training_calories ?? 0,
            workout_duration_minutes: daySummary.workout_duration_minutes ?? null,
            active_hours: daySummary.active_hours ?? null,
            cycling_distance_km: activitySummary.cycling_distance_km ?? 0,
            intake_calories: daySummary.intake_calories ?? mealSummary.intake_calories ?? null,
            nutrition_details_json: daySummary.nutrition_details_json ?? [],
          }],
        };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };
  return { calls, client };
}

export function assertSequentialUnnestParameters(sql, expectedCount) {
  const unnestSql = sql.match(/from unnest\(([\s\S]*?)\)\s*on conflict/i)?.[1] ?? '';
  const actual = [...unnestSql.matchAll(/\$(\d+)::/g)].map((match) => Number(match[1]));
  const expected = Array.from({ length: expectedCount }, (_, index) => index + 1);
  assert.deepEqual(actual, expected);
}
