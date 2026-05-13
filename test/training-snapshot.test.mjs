import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildTrainingSnapshot } from '../tools/training-snapshot.mjs';

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
  await mkdir(path.join(rootDir, 'source', '_data'), { recursive: true });
  await writeFile(path.join(rootDir, '训练记录.md'), sampleMarkdown, 'utf8');

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
});

test('buildTrainingSnapshot can hydrate the canonical snapshot from core tables', async () => {
  const queryLog = [];
  const fakeClient = {
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
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const snapshot = await buildTrainingSnapshot({
    source: 'database',
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
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
  assert.ok(queryLog.some((sql) => /from core\.training_day/i.test(sql)));
});
