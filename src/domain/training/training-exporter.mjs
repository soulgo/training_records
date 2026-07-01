import { appendMetric } from '../../shared/markdown-render.mjs';

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

    if (
      (day.nutrition?.meals?.length ?? 0) > 0 ||
      day.nutrition?.totalCalories !== null ||
      (day.nutrition?.details?.length ?? 0) > 0
    ) {
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

    const sleepRecords = day.sleep?.length ? day.sleep : day.sleepSummary?.records ?? [];
    if (sleepRecords.length > 0 || hasSleepSummary(day.sleepSummary)) {
      lines.push(`#### ${day.date} 睡眠截图记录`);
      lines.push('');

      if (sleepRecords.length > 0) {
        lines.push('##### 睡眠明细');
        lines.push('');
        for (const record of sleepRecords) {
          lines.push(`- 睡眠类型：${record.sleepType ?? '夜间睡眠'}`);
          const bedtime = record.bedtime ?? record.sleepStartTime ?? null;
          const wakeTime = record.wakeTime ?? record.sleepEndTime ?? null;
          if (bedtime || wakeTime) {
            lines.push(`- 入睡/起床：${bedtime ?? 'null'} → ${wakeTime ?? 'null'}`);
          }
          renderSleepMetrics(lines, record);
        }
      } else {
        renderSleepMetrics(lines, day.sleepSummary);
      }

      lines.push('');
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

function renderSleepMetrics(lines, sleep) {
  appendMetric(lines, '总睡眠', sleep.totalSleepMinutes, '分钟');
  appendMetric(lines, '夜间睡眠', sleep.nightSleepMinutes, '分钟');
  appendMetric(lines, '午睡', sleep.napMinutes, '分钟');
  appendMetric(lines, '深睡', sleep.deepSleepMinutes, '分钟');
  appendMetric(lines, '浅睡', sleep.lightSleepMinutes, '分钟');
  appendMetric(lines, '快动眼睡眠', sleep.remSleepMinutes, '分钟');
  appendMetric(lines, '清醒', sleep.awakeMinutes, '分钟');
  appendMetric(lines, '睡眠评分', sleep.sleepScore, '分');
  appendMetric(lines, '超过用户', sleep.sleepScorePercentile, '%');
  appendMetric(lines, '深睡比例', sleep.deepSleepRatioPct, '%');
  appendMetric(lines, '浅睡比例', sleep.lightSleepRatioPct, '%');
  appendMetric(lines, '快速眼动比例', sleep.remSleepRatioPct, '%');
  appendMetric(lines, '深睡连续性', sleep.deepSleepContinuityScore, '分');
  appendMetric(lines, '清醒次数', sleep.wakeCount, '次');
  appendMetric(lines, '呼吸质量', sleep.breathingQualityScore, '分');
  appendMetric(lines, '平均心率', sleep.averageHeartRateBpm, '次/分钟');
  appendMetric(lines, '平均心率变异性', sleep.hrvMs, '毫秒');
  appendMetric(lines, '平均血氧饱和度', sleep.averageSpo2Pct, '%');
  appendMetric(lines, '平均呼吸率', sleep.averageRespiratoryRate, '次/分钟');
  if (sleep.sleepStageText) {
    lines.push(`- 睡眠阶段：${sleep.sleepStageText}`);
  }
  if (Array.isArray(sleep.sleepStageDetail) && sleep.sleepStageDetail.length) {
    lines.push('- 睡眠阶段明细：');
    for (const detail of sleep.sleepStageDetail) {
      lines.push(`  - ${detail}`);
    }
  }
  if (sleep.analysisText) {
    lines.push(`- 睡眠解读：${sleep.analysisText}`);
  }
  if (sleep.suggestionText) {
    lines.push(`- 睡眠建议：${sleep.suggestionText}`);
  }
}

function hasSleepSummary(sleep) {
  if (!sleep) {
    return false;
  }
  return [
    sleep.totalSleepMinutes,
    sleep.nightSleepMinutes,
    sleep.napMinutes,
    sleep.sleepStartTime,
    sleep.sleepEndTime,
    sleep.deepSleepMinutes,
    sleep.lightSleepMinutes,
    sleep.remSleepMinutes,
    sleep.awakeMinutes,
    sleep.sleepScore,
    sleep.sleepScorePercentile,
    sleep.deepSleepRatioPct,
    sleep.lightSleepRatioPct,
    sleep.remSleepRatioPct,
    sleep.deepSleepContinuityScore,
    sleep.wakeCount,
    sleep.breathingQualityScore,
    sleep.averageHeartRateBpm,
    sleep.hrvMs,
    sleep.averageSpo2Pct,
    sleep.averageRespiratoryRate,
    sleep.analysisText,
    sleep.suggestionText,
  ].some((value) => value !== null && value !== undefined && value !== '');
}
