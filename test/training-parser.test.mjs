import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTrainingRecord } from '../tools/training-parser.mjs';

const sampleMarkdown = `
### 2026-05-07

#### 当日体脂秤截图记录

- 测量时间：2026-05-07 12:35
- 身体得分：77分
- 体重：73.55 kg
- BMI：23.7
- 体脂率：22.4%
- 骨骼肌量：30.9 kg
- 内脏脂肪等级：9.0
- 基础代谢率：1609 kcal/日

### 2026-05-08

#### 当日运动截图记录

- 08:16 户外骑行：3.18公里，16分49秒，均速11.35公里/小时
- 08:35 爬楼：4分04秒，总消耗43千卡，记录值144次/分钟
- 18:25 自由训练：39分44秒，消耗424千卡，平均145次/分钟
- 19:12 力量训练：20分49秒，消耗189千卡，平均132次/分钟

#### 2026-05-08 饮食截图记录

##### 餐次汇总

- 早餐：108千卡，建议范围518–932千卡
- 午餐：420千卡，建议范围621–1035千卡
- 晚餐：308千卡，建议范围311–725千卡
- 当日截图内已记录总热量：836千卡

#### 次日晨起体脂秤补充记录（归入2026-05-08）

- 说明：本次为 \`2026-05-09 06:42\` 晨起称重，按用户口径归档到 \`2026-05-08\`
- 体脂秤本次截图以“斤”为单位展示，以下同时保留截图原值与换算值，便于后续趋势对比

##### 体脂秤数据

- 测量时间：2026-05-09 06:42
- 身体得分：74分
- 体重：145.7斤（约72.85 kg）
- BMI：23.5
- 体脂率：22.8%
- 骨骼肌量：60.9斤（约30.45 kg）
- 内脏脂肪等级：8.0
- 基础代谢率：1587 kcal/日
`;

test('parses next-morning measurement into the archived day', () => {
  const parsed = parseTrainingRecord(sampleMarkdown);
  const latest = parsed.latest.measurement;

  assert.equal(latest.archivedDate, '2026-05-08');
  assert.equal(latest.measuredAt, '2026-05-09 06:42');
  assert.equal(latest.weightKg, 72.85);
  assert.equal(latest.bodyFatPct, 22.8);
});

test('aggregates daily workout and nutrition totals for the dashboard', () => {
  const parsed = parseTrainingRecord(sampleMarkdown);
  const day = parsed.daily.find((entry) => entry.date === '2026-05-08');

  assert.ok(day);
  assert.equal(day.workoutSummary.totalActivities, 4);
  assert.equal(day.workoutSummary.trainingCalories, 656);
  assert.equal(day.workoutSummary.cyclingDistanceKm, 3.18);
  assert.equal(day.nutrition.totalCalories, 836);
  assert.equal(day.nutrition.meals.length, 3);
});

test('builds chart series from archived daily measurements', () => {
  const parsed = parseTrainingRecord(sampleMarkdown);

  assert.deepEqual(parsed.charts.weightKg, [
    { date: '2026-05-07', value: 73.55 },
    { date: '2026-05-08', value: 72.85 },
  ]);
  assert.deepEqual(parsed.charts.bodyFatPct, [
    { date: '2026-05-07', value: 22.4 },
    { date: '2026-05-08', value: 22.8 },
  ]);
});
