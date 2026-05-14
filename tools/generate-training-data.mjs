import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendTrainingArchiveFailureLog,
  persistTrainingArchive,
  resolveTrainingArchiveRuntimeContext,
} from './training-db-archive.mjs';
import { buildDashboardViewModel } from './dashboard-view.mjs';
import { resolveTrainingCoreConfig } from './training-db-core.mjs';
import {
  buildTrainingSnapshot,
  isIncompleteDatabaseSnapshotError,
  isUnavailableDatabaseSnapshotError,
} from './training-snapshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..');

export async function generateTrainingData(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const persistArchive = options.persistArchive ?? persistTrainingArchive;
  const appendArchiveFailureLog =
    options.appendArchiveFailureLog ?? appendTrainingArchiveFailureLog;
  const buildSnapshot = options.buildSnapshot ?? buildTrainingSnapshot;
  const runStartedAt = options.runStartedAt ?? new Date();

  const recordPath = path.join(rootDir, '训练记录.md');
  const outputDir = path.join(rootDir, 'source', '_data');
  const outputPath = path.join(outputDir, 'training.json');
  const dashboardViewPath = path.join(outputDir, 'dashboardView.json');
  const debugOutputPath = path.join(rootDir, '训练数据解析.md');
  const snapshotSource = resolveSnapshotSource(argv, env);
  const trainingDbConfig = resolveTrainingCoreConfig(env);
  const canFallbackFromDatabase =
    snapshotSource === 'database' && trainingDbConfig.enabled && Boolean(trainingDbConfig.url);

  const markdown = await readFile(recordPath, 'utf8');
  const snapshotOptions = {
    source: snapshotSource,
    rootDir,
    env,
    now: runStartedAt,
  };
  let parsed;

  try {
    parsed = await buildSnapshot(snapshotOptions);
  } catch (error) {
    if (canFallbackFromDatabase && canUseMarkdownFallback(error)) {
      stderr.write(
        `[generate-training-data] ${error.message}; falling back to markdown\n`,
      );
      parsed = await buildSnapshot({
        ...snapshotOptions,
        source: 'markdown',
      });
    } else {
      throw error;
    }
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  await writeFile(
    dashboardViewPath,
    `${JSON.stringify(buildDashboardViewModel(parsed), null, 2)}\n`,
    'utf8',
  );
  await writeFile(debugOutputPath, renderTrainingDebugMarkdown(parsed), 'utf8');

  stdout.write(`Generated ${path.relative(rootDir, outputPath)}\n`);
  stdout.write(`Generated ${path.relative(rootDir, dashboardViewPath)}\n`);
  stdout.write(`Generated ${path.relative(rootDir, debugOutputPath)}\n`);

  const runtimeContext = resolveTrainingArchiveRuntimeContext({ env, argv });
  const runFinishedAt = options.runFinishedAt ?? new Date();

  try {
    await persistArchive({
      markdownRaw: markdown,
      parsed,
      env,
      runtimeContext,
      runStartedAt,
      runFinishedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[training-db-archive] ${message}\n`);
    await appendArchiveFailureLog({
      rootDir,
      env,
      runtimeContext,
      error,
      runStartedAt,
      runFinishedAt,
      parsed,
    });
  }

  return {
    rootDir,
    recordPath,
    outputPath,
    dashboardViewPath,
    debugOutputPath,
    parsed,
  };
}

export function renderTrainingDebugMarkdown(parsed) {
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await generateTrainingData();
}

function resolveSnapshotSource(argv, env) {
  const explicit = argv.find((arg) => arg.startsWith('--source='))?.slice('--source='.length);
  if (explicit === 'database' || explicit === 'markdown') {
    return explicit;
  }
  const configured = String(env.TRAINING_SNAPSHOT_SOURCE ?? 'markdown').trim().toLowerCase();
  return configured === 'database' ? 'database' : 'markdown';
}

function canUseMarkdownFallback(error) {
  return isIncompleteDatabaseSnapshotError(error) || isUnavailableDatabaseSnapshotError(error);
}
