export { resolveTrainingCoreConfig } from './training-db-config.mjs';
export {
  readTrainingSnapshotFromDatabase,
  getLastProcessedTelegramUpdateId,
  readTrainingSnapshotFromDatabaseClient,
  readArchiveTrainingSnapshotFromDatabaseClient,
} from './training-db-read.mjs';
export {
  persistNormalizedBatch,
  persistTrainingSnapshotToCore,
  backfillCoreFromLatestArchiveSnapshot,
  importTrainingMarkdownToDatabase,
} from './training-db-write.mjs';

export function exportTrainingMarkdown(snapshot) {
  const lines = ['# 训练记录', ''];

  for (const day of snapshot.daily ?? []) {
    lines.push(`### ${day.date}`);
    lines.push('');

    if (day.measurement) {
      lines.push('#### 当日体脂秤截图记录');
      lines.push('');
      lines.push(`- 测量时间：${day.measurement.measuredAt ?? day.date}`);
      appendMetric(lines, '身体得分', day.measurement.bodyScore, '分');
      appendMetric(lines, '体重', day.measurement.weightKg, ' kg');
      appendMetric(lines, 'BMI', day.measurement.bmi);
      appendMetric(lines, '体脂率', day.measurement.bodyFatPct, '%');
      appendMetric(lines, '骨骼肌量', day.measurement.skeletalMuscleKg, ' kg');
      appendMetric(lines, '内脏脂肪等级', day.measurement.visceralFatLevel);
      appendMetric(lines, '基础代谢率', day.measurement.basalMetabolismKcal, ' kcal/日');
      appendMetric(lines, '水分率', day.measurement.bodyWaterPct, '%');
      appendMetric(lines, '蛋白质', day.measurement.proteinPct, '%');
      appendMetric(lines, '骨盐量', day.measurement.boneMassKg, ' kg');
      appendMetric(lines, '去脂体重', day.measurement.fatFreeMassKg, ' kg');
      appendMetric(lines, '身体年龄', day.measurement.bodyAge, '岁');
      if (day.measurement.bodyType) {
        lines.push(`- 身体类型：${day.measurement.bodyType}`);
      }
      lines.push('');
    }

    if ((day.activities?.length ?? 0) > 0 || day.workoutSummary) {
      lines.push('#### 当日运动截图记录');
      lines.push('');
      if (
        day.workoutSummary?.trainingCalories !== null ||
        day.workoutSummary?.workoutDurationMinutes !== null ||
        day.workoutSummary?.activeHours !== null
      ) {
        lines.push('##### 当日活动总览');
        lines.push('');
        appendMetric(lines, '活动热量', day.workoutSummary.trainingCalories, '千卡');
        appendMetric(lines, '锻炼时长', day.workoutSummary.workoutDurationMinutes, '分钟');
        appendMetric(lines, '活动小时数', day.workoutSummary.activeHours, '小时');
        lines.push('');
      }

      if ((day.activities?.length ?? 0) > 0) {
        lines.push('##### 活动明细');
        lines.push('');
        for (const activity of day.activities) {
          lines.push(`- ${activity.time} ${activity.type}：${activity.detail}`);
        }
        lines.push('');
      }
    }

    if ((day.nutrition?.meals?.length ?? 0) > 0 || day.nutrition?.totalCalories !== null) {
      lines.push(`#### ${day.date} 饮食截图记录`);
      lines.push('');
      lines.push('##### 餐次汇总');
      lines.push('');
      for (const meal of day.nutrition.meals ?? []) {
        lines.push(
          `- ${meal.name}：${meal.calories}千卡，建议范围${meal.recommendedMin}–${meal.recommendedMax}千卡`,
        );
      }
      if (day.nutrition.totalCalories !== null) {
        lines.push(`- 当日截图内已记录总热量：${day.nutrition.totalCalories}千卡`);
      }

      if ((day.nutrition.details?.length ?? 0) > 0) {
        lines.push('');
        lines.push('##### 餐次明细');
        lines.push('');
        for (const detail of day.nutrition.details) {
          lines.push(`- ${detail}`);
        }
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

function appendMetric(lines, label, value, suffix = '') {
  if (value === null || value === undefined || value === '') {
    return;
  }
  lines.push(`- ${label}：${value}${suffix}`);
}
