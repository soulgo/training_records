import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildTrainingSnapshot } from '../src/domain/training/training-snapshot.mjs';

const sampleMarkdown = `
### 2026-05-09

#### 当日体脂秤截图记录

- 测量时间：2026-05-09 06:42
- 身体得分：74分
- 体重：72.85 kg
- BMI：23.5
- 体脂率：22.8%
- 骨骼肌量：30.45 kg
- 内脏脂肪等级：8
- 基础代谢率：1587 kcal/日

#### 当日运动截图记录

##### 当日活动总览

- 活动热量：643千卡
- 锻炼时长：78分钟
- 活动小时数：12小时

##### 活动明细

- 08:15 户外骑行：1.65公里，时长00:23:58，平均速度4.13公里/小时
- 19:13 力量训练：总消耗241千卡，时长00:27:50，平均心率129次/分钟

#### 2026-05-09 饮食截图记录

##### 餐次汇总

- 晚餐：1065千卡，建议范围317–740千卡
- 当日截图内已记录总热量：1593千卡
`;

test('buildTrainingSnapshot reads the canonical snapshot from markdown', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'training-snapshot-md-'));
  await mkdir(path.join(rootDir, 'source', '_posts'), { recursive: true });
  await writeFile(path.join(rootDir, '训练记录.md'), sampleMarkdown, 'utf8');
  await writeFile(
    path.join(rootDir, 'source', '_posts', '2026-05-09-telegram-thought-610.md'),
    [
      '---',
      'date: 2026-05-09 22:15:00',
      'tags:',
      '  - 身体反馈',
      '  - 随想',
      '  - Telegram',
      'thought_module: body_feedback',
      'telegram_message_id: 610',
      'telegram_chat_id: 42',
      '---',
      '',
      '硬拉后右侧腰背有点刺痛',
      '',
    ].join('\n'),
    'utf8',
  );

  const snapshot = await buildTrainingSnapshot({
    source: 'markdown',
    rootDir,
    now: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(snapshot.daily.length, 1);
  assert.equal(snapshot.latest.measurement?.weightKg, 72.85);
  assert.equal(snapshot.latest.daily?.workoutSummary.trainingCalories, 643);
  assert.equal(snapshot.latest.daily?.nutrition.totalCalories, 1593);
  assert.equal(snapshot.charts.weightKg.length, 1);
  assert.equal(snapshot.bodyFeedback.length, 1);
  assert.equal(snapshot.bodyFeedback[0].date, '2026-05-09');
  assert.equal(snapshot.bodyFeedback[0].time, '22:15');
  assert.equal(snapshot.bodyFeedback[0].body, '硬拉后右侧腰背有点刺痛');
  assert.equal(snapshot.bodyFeedback[0].telegramMessageId, 610);
});

async function waitForCondition(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('buildTrainingSnapshot can hydrate the canonical snapshot from core tables', async () => {
  const queryLog = [];
  function createFakeClient() {
    return {
      async connect() {},
      async end() {},
      async query(sql) {
        queryLog.push(sql);
        if (/from core\.training_day/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-05-09',
                total_activities: 2,
                total_duration_seconds: 3112,
                training_calories: 643,
                workout_duration_minutes: 78,
                active_hours: 12,
                cycling_distance_km: '1.65',
                intake_calories: 1593,
              },
            ],
          };
        }
        if (/from core\.measurement/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-05-09',
                measured_at: '2026-05-09 06:42',
                body_score: 74,
                weight_kg: '72.85',
                bmi: '23.5',
                body_fat_pct: '22.8',
                skeletal_muscle_kg: '30.45',
                visceral_fat_level: '8',
                basal_metabolism_kcal: 1587,
                body_water_pct: null,
                protein_pct: null,
                bone_mass_kg: null,
                fat_free_mass_kg: null,
                body_age: null,
                body_type: null,
              },
            ],
          };
        }
        if (/from core\.activity/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-05-09',
                activity_time: '08:15',
                activity_type: '户外骑行',
                raw_type: '户外骑行',
                detail: '1.65公里，时长00:23:58，平均速度4.13公里/小时',
                calories: null,
                heart_rate: null,
                distance_km: '1.65',
                avg_speed_kmh: '4.13',
                duration_text: '00:23:58',
                duration_seconds: 1438,
              },
              {
                archived_date: '2026-05-09',
                activity_time: '19:13',
                activity_type: '力量训练',
                raw_type: '力量训练',
                detail: '总消耗241千卡，时长00:27:50，平均心率129次/分钟',
                calories: 241,
                heart_rate: 129,
                distance_km: null,
                avg_speed_kmh: null,
                duration_text: '00:27:50',
                duration_seconds: 1670,
              },
            ],
          };
        }
        if (/from core\.meal/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-05-09',
                meal_name: '晚餐',
                calories: 1065,
                recommended_min: 317,
                recommended_max: 740,
              },
            ],
          };
        }
        if (/from core\.sleep/i.test(sql)) {
          return { rows: [] };
        }
        if (/from core\.thought/i.test(sql)) {
          return {
            rows: [
              {
                telegram_message_id: 610,
                telegram_chat_id: 42,
                body: '硬拉后右侧腰背有点刺痛',
                message_date_unix: 1778336100,
                markdown_path: 'source/_posts/2026-05-09-telegram-thought-610.md',
                updated_at: '2026-05-09T22:15:00.000+08:00',
              },
            ],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
  }

  const snapshot = await buildTrainingSnapshot({
    source: 'database',
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return createFakeClient();
    },
    now: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(snapshot.daily.length, 1);
  assert.equal(snapshot.latest.measurement?.measuredAt, '2026-05-09 06:42');
  assert.equal(snapshot.latest.daily?.activities.length, 2);
  assert.equal(snapshot.latest.daily?.workoutSummary.cyclingDistanceKm, 1.65);
  assert.deepEqual(snapshot.latest.daily?.nutrition.meals, [
    {
      name: '晚餐',
      calories: 1065,
      recommendedMin: 317,
      recommendedMax: 740,
    },
  ]);
  assert.equal(snapshot.bodyFeedback.length, 1);
  assert.equal(snapshot.bodyFeedback[0].date, '2026-05-09');
  assert.equal(snapshot.bodyFeedback[0].time, '22:15');
  assert.equal(snapshot.bodyFeedback[0].body, '硬拉后右侧腰背有点刺痛');
  assert.ok(queryLog.some((sql) => /from core\.training_day/i.test(sql)));
  assert.ok(queryLog.some((sql) => /from core\.thought/i.test(sql)));
});

test('buildTrainingSnapshot starts database reads in parallel with independent clients', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'training-snapshot-serial-db-'));
  await mkdir(path.join(rootDir, 'source', '_data'), { recursive: true });
  await writeFile(path.join(rootDir, '训练记录.md'), sampleMarkdown, 'utf8');

  let activeQueries = 0;
  let maxActiveQueries = 0;
  let startedQueries = 0;
  let releaseQueries;
  const releasePromise = new Promise((resolve) => {
    releaseQueries = resolve;
  });

  function createParallelClient() {
    return {
      async connect() {},
      async end() {},
      async query(sql) {
        startedQueries += 1;
        activeQueries += 1;
        maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
        try {
          await releasePromise;
          if (/from core\.training_day/i.test(sql)) {
            return {
              rows: [
                {
                  archived_date: '2026-04-06',
                  total_activities: 0,
                  total_duration_seconds: 0,
                  training_calories: 402,
                  workout_duration_minutes: 30,
                  active_hours: 16,
                  cycling_distance_km: '0',
                  intake_calories: null,
                },
                {
                  archived_date: '2026-05-09',
                  total_activities: 2,
                  total_duration_seconds: 3112,
                  training_calories: 643,
                  workout_duration_minutes: 78,
                  active_hours: 12,
                  cycling_distance_km: '1.65',
                  intake_calories: 1593,
                },
              ],
            };
          }
          if (/from core\.measurement/i.test(sql)) {
            return {
              rows: [
                {
                  archived_date: '2026-05-09',
                  measured_at: '2026-05-09 06:42',
                  body_score: 74,
                  weight_kg: '72.85',
                  bmi: '23.5',
                  body_fat_pct: '22.8',
                  skeletal_muscle_kg: '30.45',
                  visceral_fat_level: '8',
                  basal_metabolism_kcal: 1587,
                  body_water_pct: null,
                  protein_pct: null,
                  bone_mass_kg: null,
                  fat_free_mass_kg: null,
                  body_age: null,
                  body_type: null,
                },
              ],
            };
          }
          if (/from core\.activity/i.test(sql)) {
            return { rows: [] };
          }
          if (/from core\.meal/i.test(sql)) {
            return { rows: [] };
          }
          if (/from core\.sleep/i.test(sql)) {
            return { rows: [] };
          }
          if (/from core\.thought/i.test(sql)) {
            return { rows: [] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        } finally {
          activeQueries -= 1;
        }
      },
    };
  }

  const snapshotPromise = buildTrainingSnapshot({
    source: 'database',
    rootDir,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return createParallelClient();
    },
    now: new Date('2026-05-13T00:00:00.000Z'),
  });

  await waitForCondition(() => startedQueries === 6);
  assert.equal(startedQueries, 6);
  releaseQueries();
  const snapshot = await snapshotPromise;

  assert.deepEqual(
    snapshot.daily.map((day) => day.date),
    ['2026-04-06', '2026-05-09'],
  );
  assert.equal(snapshot.daily[0].workoutSummary.trainingCalories, 402);
  assert.equal(maxActiveQueries, 6);
});

test('buildTrainingSnapshot retries database snapshot with one client when parallel reads fail', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'training-snapshot-db-retry-'));
  await mkdir(path.join(rootDir, 'source', '_data'), { recursive: true });
  await writeFile(path.join(rootDir, '训练记录.md'), sampleMarkdown, 'utf8');

  const clientEvents = [];
  let nextClientId = 0;

  function createRetryClient() {
    const clientId = nextClientId;
    nextClientId += 1;
    return {
      async connect() {
        clientEvents.push(['connect', clientId]);
      },
      async end() {
        clientEvents.push(['end', clientId]);
      },
      async query(sql) {
        clientEvents.push(['query', clientId, sql]);
        if (clientId < 6 && /from core\.training_day/i.test(sql)) {
          throw new Error('timeout expired');
        }
        if (/from core\.training_day/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-05-09',
                total_activities: 2,
                total_duration_seconds: 3112,
                training_calories: 643,
                workout_duration_minutes: 78,
                active_hours: 12,
                cycling_distance_km: '1.65',
                intake_calories: 1593,
              },
            ],
          };
        }
        if (/from core\.measurement/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-05-09',
                measured_at: '2026-05-09 06:42',
                body_score: 74,
                weight_kg: '72.85',
                bmi: '23.5',
                body_fat_pct: '22.8',
                skeletal_muscle_kg: '30.45',
                visceral_fat_level: '8',
                basal_metabolism_kcal: 1587,
                body_water_pct: null,
                protein_pct: null,
                bone_mass_kg: null,
                fat_free_mass_kg: null,
                body_age: null,
                body_type: null,
              },
            ],
          };
        }
        if (/from core\.activity/i.test(sql)) {
          return { rows: [] };
        }
        if (/from core\.meal/i.test(sql)) {
          return { rows: [] };
        }
        if (/from core\.sleep/i.test(sql)) {
          return { rows: [] };
        }
        if (/from core\.thought/i.test(sql)) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
  }

  const snapshot = await buildTrainingSnapshot({
    source: 'database',
    rootDir,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return createRetryClient();
    },
    now: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(nextClientId, 7);
  assert.equal(snapshot.latest.measurement?.weightKg, 72.85);
  assert.deepEqual(snapshot.daily.map((day) => day.date), ['2026-05-09']);
  assert.equal(snapshot.latest.daily?.nutrition.totalCalories, 1593);
  assert.equal(
    clientEvents.filter(([event, clientId]) => event === 'query' && clientId === 6).length,
    6,
  );
});

test('buildTrainingSnapshot throws when database snapshot is empty in database mode', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'training-snapshot-empty-db-'));
  await mkdir(path.join(rootDir, 'source', '_data'), { recursive: true });
  await writeFile(path.join(rootDir, '训练记录.md'), sampleMarkdown, 'utf8');

  await assert.rejects(
    buildTrainingSnapshot({
      source: 'database',
      rootDir,
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      createClient() {
        return {
          async connect() {},
          async end() {},
          async query() {
            return { rows: [] };
          },
        };
      },
      now: new Date('2026-05-13T00:00:00.000Z'),
    }),
    /database snapshot/i,
  );
});

test('buildTrainingSnapshot throws when database snapshot lacks measurements in database mode', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'training-snapshot-partial-db-'));
  await mkdir(path.join(rootDir, 'source', '_data'), { recursive: true });
  await writeFile(path.join(rootDir, '训练记录.md'), sampleMarkdown, 'utf8');

  await assert.rejects(
    buildTrainingSnapshot({
      source: 'database',
      rootDir,
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      createClient() {
        return {
          async connect() {},
          async end() {},
          async query(sql) {
            if (/from core\.training_day/i.test(sql)) {
              return {
                rows: [
                  {
                    archived_date: '2026-05-09',
                    total_activities: 2,
                    total_duration_seconds: 3112,
                    training_calories: 643,
                    workout_duration_minutes: 78,
                    active_hours: 12,
                    cycling_distance_km: '1.65',
                    intake_calories: 1593,
                  },
                ],
              };
            }
            return { rows: [] };
          },
        };
      },
      now: new Date('2026-05-13T00:00:00.000Z'),
    }),
    /database snapshot/i,
  );
});

test('buildTrainingSnapshot throws when database read fails in database mode', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'training-snapshot-db-error-'));
  await mkdir(path.join(rootDir, 'source', '_data'), { recursive: true });
  await writeFile(path.join(rootDir, '训练记录.md'), sampleMarkdown, 'utf8');

  await assert.rejects(
    buildTrainingSnapshot({
      source: 'database',
      rootDir,
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      createClient() {
        return {
          async connect() {},
          async end() {},
          async query() {
            throw new Error('db unavailable');
          },
        };
      },
      now: new Date('2026-05-13T00:00:00.000Z'),
    }),
    /db unavailable|database snapshot/i,
  );
});

test('buildTrainingSnapshot can return a filtered database window', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'training-snapshot-window-'));
  await mkdir(path.join(rootDir, 'source', '_data'), { recursive: true });
  await writeFile(path.join(rootDir, '训练记录.md'), sampleMarkdown, 'utf8');

  const snapshot = await buildTrainingSnapshot({
    source: 'database',
    rootDir,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return {
        async connect() {},
        async end() {},
        async query(sql) {
          if (/from core\.training_day/i.test(sql)) {
            return {
              rows: [
                {
                  archived_date: '2026-05-08',
                  total_activities: 1,
                  total_duration_seconds: 600,
                  training_calories: 120,
                  workout_duration_minutes: 10,
                  active_hours: 1,
                  cycling_distance_km: 0,
                  intake_calories: 800,
                },
                {
                  archived_date: '2026-05-09',
                  total_activities: 2,
                  total_duration_seconds: 1200,
                  training_calories: 240,
                  workout_duration_minutes: 20,
                  active_hours: 2,
                  cycling_distance_km: 1.2,
                  intake_calories: 900,
                },
              ],
            };
          }
          if (/from core\.measurement/i.test(sql)) {
            return {
              rows: [
                {
                  archived_date: '2026-05-09',
                  measured_at: '2026-05-09 06:42',
                  body_score: 74,
                  weight_kg: '72.85',
                  bmi: '23.5',
                  body_fat_pct: '22.8',
                  skeletal_muscle_kg: '30.45',
                  visceral_fat_level: '8',
                  basal_metabolism_kcal: 1587,
                  body_water_pct: null,
                  protein_pct: null,
                  bone_mass_kg: null,
                  fat_free_mass_kg: null,
                  body_age: null,
                  body_type: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };
    },
    dateFrom: '2026-05-09',
    dateTo: '2026-05-09',
  });

  assert.deepEqual(snapshot.daily.map((day) => day.date), ['2026-05-09']);
  assert.equal(snapshot.charts.trainingCalories.length, 1);
});
