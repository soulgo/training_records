import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTrainingRecord } from './training-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const recordPath = path.join(rootDir, '训练记录.md');
const outputDir = path.join(rootDir, 'source', '_data');
const outputPath = path.join(outputDir, 'training.json');
const debugOutputPath = path.join(rootDir, '训练数据解析.md');

const markdown = await readFile(recordPath, 'utf8');
const parsed = parseTrainingRecord(markdown);

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
await writeFile(debugOutputPath, renderTrainingDebugMarkdown(parsed), 'utf8');

process.stdout.write(`Generated ${path.relative(rootDir, outputPath)}\n`);
process.stdout.write(`Generated ${path.relative(rootDir, debugOutputPath)}\n`);

function renderTrainingDebugMarkdown(parsed) {
  const lines = [
    '# 训练数据解析排查',
    '',
    `- 生成时间：${parsed.generatedAt}`,
    `- 解析天数：${parsed.daily.length}`,
    '',
  ];

  for (const day of parsed.daily) {
    lines.push(`## ${day.date}`);
    lines.push('');

    if (day.measurement) {
      lines.push('### 体脂秤');
      lines.push('');
      lines.push(`- 测量时间：${day.measurement.measuredAt ?? '无'}`);
      lines.push(`- 体重：${formatDebugValue(day.measurement.weightKg)} kg`);
      lines.push(`- 体脂率：${formatDebugValue(day.measurement.bodyFatPct)}%`);
      lines.push(`- 骨骼肌量：${formatDebugValue(day.measurement.skeletalMuscleKg)} kg`);
      lines.push('');
    }

    lines.push('### 运动');
    lines.push('');
    lines.push(`- 活动次数：${day.workoutSummary.totalActivities}`);
    lines.push(`- 训练消耗：${day.workoutSummary.trainingCalories} kcal`);
    lines.push(`- 锻炼时长：${day.workoutSummary.workoutDurationMinutes ?? '无'} 分钟`);
    lines.push(`- 活动小时数：${day.workoutSummary.activeHours ?? '无'} 小时`);
    lines.push(`- 骑行里程：${day.workoutSummary.cyclingDistanceKm} km`);
    for (const activity of day.activities) {
      lines.push(
        `- ${activity.time} ${activity.type}：${activity.calories ?? '无'} kcal，${activity.durationText ?? '无时长'}，心率 ${activity.heartRate ?? '无'}`,
      );
    }
    lines.push('');

    lines.push('### 饮食');
    lines.push('');
    lines.push(`- 总热量：${day.nutrition.totalCalories ?? '无'} kcal`);
    for (const meal of day.nutrition.meals) {
      lines.push(
        `- ${meal.name}：${meal.calories} kcal，建议 ${meal.recommendedMin}-${meal.recommendedMax} kcal`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

function formatDebugValue(value) {
  return value === null || value === undefined ? '无' : value;
}
