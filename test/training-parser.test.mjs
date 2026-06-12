import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTrainingRecord } from '../src/domain/training/training-parser.mjs';

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
- 18:25 燃脂训练（华为记录显示为“自由训练”）：39分44秒，消耗424千卡，平均145次/分钟
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
  assert.equal(day.activities[2].type, '燃脂训练');
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

test('parses telegram-written workout and nutrition formats into dashboard-friendly summaries', () => {
  const telegramMarkdown = `
### 2026-05-06

#### 2026-05-06 饮食截图记录
<!-- telegram-sync-section -->
##### 餐次汇总

- 凉粉（早餐，1碗）：114千卡，建议范围527–949千卡
- 扯面（午餐，400克）：452千卡，建议范围633–1054千卡
- 兰州拉面（晚餐，1碗）：510千卡，建议范围317–738千卡
- 当日截图内已记录总热量：1076千卡
- 凉粉：114千卡，建议范围527–949千卡
- 扯面：452千卡，建议范围633–1054千卡
- 兰州拉面：510千卡，建议范围317–738千卡

##### 餐次明细

- 早餐 114千卡
- 午餐 452千卡
- 晚餐 510千卡

#### 当日运动截图记录
<!-- telegram-sync-section -->
- 07:15 自由训练：总消耗 565 千卡，时长 00:53:22，平均心率 141 次/分钟
- 20:04 自由训练：总消耗 162 千卡，时长 00:19:43，平均心率 124 次/分钟
- 20:27 力量训练：总消耗 250 千卡，时长 00:28:48，平均心率 125 次/分钟
- 07:15 自由训练：总消耗565千卡，时长00:53:22，平均心率141次/分钟
- 20:04 自由训练：总消耗162千卡，时长00:19:43，平均心率124次/分钟
- 20:27 力量训练：总消耗250千卡，时长00:28:48，平均心率125次/分钟
`;

  const parsed = parseTrainingRecord(telegramMarkdown);
  const day = parsed.daily.find((entry) => entry.date === '2026-05-06');

  assert.ok(day);
  assert.equal(day.activities.length, 3);
  assert.equal(day.workoutSummary.totalActivities, 3);
  assert.equal(day.workoutSummary.trainingCalories, 977);
  assert.deepEqual(day.workoutSummary.countsByType, {
    燃脂训练: 2,
    力量训练: 1,
  });
  assert.equal(day.activities[0].heartRate, 141);
  assert.equal(day.nutrition.totalCalories, 1076);
  assert.deepEqual(day.nutrition.meals, [
    { name: '早餐', calories: 114, recommendedMin: 527, recommendedMax: 949 },
    { name: '午餐', calories: 452, recommendedMin: 633, recommendedMax: 1054 },
    { name: '晚餐', calories: 510, recommendedMin: 317, recommendedMax: 738 },
  ]);
});

test('normalizes English activity type tokens before building dashboard tags', () => {
  const markdown = `
### 2026-05-13

#### 当日运动截图记录

- 08:04 outdoor_cycling：3.18公里，时长00:12:47，平均速度14.93公里/小时
- 08:17 stair_climbing：总消耗83千卡，时长00:09:07，平均心率134次/分钟
`;

  const snapshot = parseTrainingRecord(markdown);
  const day = snapshot.daily[0];

  assert.deepEqual(day.workoutSummary.countsByType, {
    户外骑行: 1,
    爬楼: 1,
  });
  assert.equal(day.workoutSummary.cyclingDistanceKm, 3.18);
});

test('uses daily activity overview screenshots to override training calories and expose workout duration', () => {
  const markdown = `
### 2026-05-10

#### 当日运动截图记录
<!-- telegram-sync-section -->
##### 当日活动总览

- 活动热量：643千卡
- 锻炼时长：78分钟
- 活动小时数：12小时

##### 活动明细

- 08:15 户外骑行：1.65公里，时长00:23:58，平均速度4.13公里/小时
- 08:49 户外骑行：8.49公里，时长00:36:04，平均速度14.12公里/小时
`;

  const parsed = parseTrainingRecord(markdown);
  const day = parsed.daily.find((entry) => entry.date === '2026-05-10');

  assert.ok(day);
  assert.equal(day.workoutSummary.totalActivities, 2);
  assert.equal(day.workoutSummary.trainingCalories, 643);
  assert.equal(day.workoutSummary.workoutDurationMinutes, 78);
  assert.equal(day.workoutSummary.activeHours, 12);
  assert.equal(day.workoutSummary.totalDurationSeconds, 3602);
  assert.equal(day.workoutSummary.cyclingDistanceKm, 10.14);
});
