import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import {
  appendTrainingArchiveFailureLog,
  persistTrainingArchive,
  resolveTrainingArchiveRuntimeContext,
} from '../../db/training/archive.mjs';
import { resolveTrainingCoreConfig } from '../../db/training/config.mjs';
import { canFallbackToMarkdownSnapshot, canUseDatabaseFallback } from '../../shared/snapshot-fallback.mjs';
import { buildTrainingSnapshot } from '../../domain/training/training-snapshot.mjs';
import {
  ActionMonitorGenerator,
  BodyMetricGenerator,
  DashboardGenerator,
  HexoGeneratorAdapter,
  MonitorGenerator,
  TrainingDayGenerator,
} from '../../adapters/hexo/index.mjs';
import {
  PostgresGitHubActionMonitorRepository,
  PostgresParameterValidityMonitorRepository,
} from '../../adapters/postgres/index.mjs';
import {
  listGitHubActionRunsForMonitor,
  mergeActionMonitorRows,
} from './github-action-monitor.use-case.mjs';
import { runParameterValidityAudit } from './parameter-validity-monitor.use-case.mjs';
import { buildActionMonitorViewModel } from '../../site/action-monitor-view.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..', '..', '..');
const { Client } = pg;

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
  const monitorViewPath = path.join(outputDir, 'monitorView.json');
  const actionMonitorViewPath = path.join(outputDir, 'actionMonitorView.json');
  const debugOutputPath = path.join(rootDir, '训练数据解析.md');
  const snapshotSource = resolveSnapshotSource(argv, env);
  const trainingDbConfig = resolveTrainingCoreConfig(env);
  const canFallbackFromDatabase = canUseDatabaseFallback({
    source: snapshotSource,
    config: trainingDbConfig,
  }) && !isStrictDatabaseSnapshotMode(env);

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
    if (canFallbackFromDatabase && canFallbackToMarkdownSnapshot(error)) {
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
  const hexoGenerator = new HexoGeneratorAdapter({
    generators: [
      new TrainingDayGenerator(),
      new BodyMetricGenerator(),
      new DashboardGenerator(),
      new MonitorGenerator(),
      new ActionMonitorGenerator({
        loadActionMonitorView: options.loadActionMonitorView ?? loadActionMonitorViewFromPostgres,
      }),
    ],
    writeJson: async (relativePath, payload) => {
      await writeFile(path.join(outputDir, relativePath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    },
  });
  await hexoGenerator.generate({
    snapshot: parsed,
    env,
    rootDir,
    now: runStartedAt,
    stderr,
    fetchImpl: options.fetchImpl,
    logger: options.logger,
  });
  await writeFile(debugOutputPath, renderTrainingDebugMarkdown(parsed), 'utf8');

  stdout.write(`Generated ${toPosixRelativePath(rootDir, outputPath)}\n`);
  stdout.write(`Generated ${toPosixRelativePath(rootDir, dashboardViewPath)}\n`);
  stdout.write(`Generated ${toPosixRelativePath(rootDir, monitorViewPath)}\n`);
  stdout.write(`Generated ${toPosixRelativePath(rootDir, actionMonitorViewPath)}\n`);
  stdout.write(`Generated ${toPosixRelativePath(rootDir, debugOutputPath)}\n`);

  const runtimeContext = resolveTrainingArchiveRuntimeContext({ env, argv });
  const runFinishedAt = options.runFinishedAt ?? new Date();
  const archiveWriteDecision = resolveBuildArchiveWriteDecision({
    env,
    snapshotSource,
    strictDatabaseSnapshot: isStrictDatabaseSnapshotMode(env),
  });

  if (!archiveWriteDecision.enabled) {
    stderr.write(`[training-db-archive] skipped by TRAINING_BUILD_ARCHIVE_WRITE=${archiveWriteDecision.mode}\n`);
    return {
      rootDir,
      recordPath,
      outputPath,
      dashboardViewPath,
      monitorViewPath,
      actionMonitorViewPath,
      debugOutputPath,
      parsed,
    };
  }

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
    monitorViewPath,
    actionMonitorViewPath,
    debugOutputPath,
    parsed,
  };
}

export async function loadActionMonitorViewFromPostgres(options = {}) {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? new Date();
  const config = resolveActionMonitorReadConfig(env);
  const githubConfig = resolveActionMonitorGitHubReadConfig(env, {
    environment: config.environment,
    limit: config.limit,
  });
  const registryParameterRows = await loadParameterValidityRowsFromRegistry({
    rootDir: options.rootDir ?? defaultRootDir,
    environment: config.environment,
    env,
    now,
    stderr,
  });

  if (!config.enabled && !githubConfig.enabled) {
    return buildActionMonitorViewModel([], {
      environment: config.environment,
      now,
      limit: config.limit,
      parameterValidityRows: registryParameterRows,
    });
  }

  let databaseRows = [];
  let githubRows = [];
  let parameterValidityRows = [];

  if (githubConfig.enabled) {
    try {
      githubRows = await listGitHubActionRunsForMonitor({
        owner: githubConfig.owner,
        repo: githubConfig.repo,
        token: githubConfig.token,
        branch: githubConfig.branch,
        monitorEnvironment: config.environment,
        limit: config.limit,
        fetchImpl: options.fetchImpl,
        logger: options.logger,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`[github-action-monitor-view] GitHub API fallback failed: ${message}\n`);
    }
  }

  if (!config.enabled) {
    return buildActionMonitorViewModel(githubRows, {
      environment: config.environment,
      now,
      limit: config.limit,
      parameterValidityRows: registryParameterRows,
    });
  }

  const client = new Client({
    connectionString: config.url,
    application_name: config.appName,
    connectionTimeoutMillis: config.timeoutMs,
  });

  try {
    await client.connect();
    const repository = new PostgresGitHubActionMonitorRepository(client);
    databaseRows = await repository.listRecentActionRuns({
      monitorEnvironment: config.environment,
      limit: config.limit,
    });
    try {
      const parameterRepository = new PostgresParameterValidityMonitorRepository(client);
      const databaseParameterRows = await parameterRepository.listLatestParameterChecks({
        monitorEnvironment: config.environment,
      });
      parameterValidityRows = mergeParameterValidityRows({
        registryRows: registryParameterRows,
        databaseRows: databaseParameterRows,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`[parameter-validity-monitor-view] ${message}; using registry parameter validity data\n`);
      parameterValidityRows = registryParameterRows;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[github-action-monitor-view] ${message}; using GitHub API fallback rows\n`);
    parameterValidityRows = registryParameterRows;
  } finally {
    await client.end().catch(() => {});
  }

  return buildActionMonitorViewModel(mergeActionMonitorRows({
    databaseRows,
    githubRows,
    limit: config.limit,
  }), {
    environment: config.environment,
    now,
    limit: config.limit,
    parameterValidityRows,
  });
}

export async function loadParameterValidityRowsFromRegistry(options = {}) {
  const rootDir = normalizeRootDir(options.rootDir ?? defaultRootDir);
  const environment = firstNonEmpty([options.environment, 'dev']);
  const registryPath = path.join(rootDir, 'config', 'parameter-validity', `${environment}.json`);

  try {
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    const audit = runParameterValidityAudit({
      registry,
      environment,
      env: options.env ?? {},
      now: options.now ?? new Date(),
    });
    return mapParameterValidityAuditToRows(audit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.stderr?.write?.(`[parameter-validity-monitor-view] registry ${registryPath} unavailable: ${message}\n`);
    return [];
  }
}

function mapParameterValidityAuditToRows(audit) {
  const checksByKey = new Map((audit.checks ?? []).map((check) => [check.parameterKey, check]));
  return (audit.parameters ?? []).map((parameter) => {
    const check = checksByKey.get(parameter.key) ?? {};
    return {
      parameterKey: parameter.key,
      monitorEnvironment: parameter.environment ?? audit.environment,
      parameterName: parameter.name,
      scope: parameter.scope,
      category: parameter.category,
      required: parameter.required,
      sensitive: parameter.sensitive,
      validityMode: parameter.validityMode,
      validFrom: parameter.validFrom,
      expiresAt: parameter.expiresAt,
      reviewAfterAt: parameter.reviewAfterAt,
      rotationCycleDays: parameter.rotationCycleDays,
      warningDays: parameter.warningDays,
      criticalDays: parameter.criticalDays,
      owner: parameter.owner,
      sourceDoc: parameter.sourceDoc,
      sourceCode: parameter.sourceCode,
      metadata: parameter.metadata,
      checkedAt: check.checkedAt ?? audit.checkedAt,
      status: check.status ?? 'unknown',
      daysUntilDue: check.daysUntilDue ?? null,
      evidenceSource: check.evidenceSource ?? 'registry',
      message: check.message ?? '缺少有效期或复核时间元数据',
      details: check.details ?? {},
    };
  });
}

function mergeParameterValidityRows({ registryRows = [], databaseRows = [] } = {}) {
  const rowsByKey = new Map();
  for (const row of registryRows) {
    const key = firstNonEmpty([row.parameterKey, row.parameter_key, row.key]);
    if (key) {
      rowsByKey.set(key, row);
    }
  }
  for (const row of databaseRows) {
    const key = firstNonEmpty([row.parameterKey, row.parameter_key, row.key]);
    if (key) {
      rowsByKey.set(key, row);
    }
  }
  return Array.from(rowsByKey.values());
}

function resolveActionMonitorReadConfig(env) {
  const actionMonitorUrl = firstNonEmpty([
    env.GITHUB_ACTION_MONITOR_READONLY_DB_URL,
    env.GITHUB_ACTION_MONITOR_DB_URL,
  ]);
  const trainingDbFallbackUrl = shouldUseTrainingDbForActionMonitor(env)
    ? firstNonEmpty([
        env.TRAINING_DB_READONLY_URL,
        env.TRAINING_DB_URL,
      ])
    : '';
  const url = actionMonitorUrl || trainingDbFallbackUrl;
  const environment = firstNonEmpty([
    env.GITHUB_ACTION_MONITOR_ENVIRONMENT,
    env.GITHUB_REF_NAME,
    env.CF_PAGES_BRANCH,
    env.BRANCH,
    'dev',
  ]);

  return {
    enabled: Boolean(url),
    url,
    environment,
    appName: firstNonEmpty([
      env.GITHUB_ACTION_MONITOR_DB_APP_NAME,
      env.TRAINING_DB_APP_NAME,
      'github-action-monitor-view',
    ]),
    timeoutMs: parsePositiveInteger(env.GITHUB_ACTION_MONITOR_DB_TIMEOUT_MS, 5000),
    limit: parseOptionalPositiveInteger(env.GITHUB_ACTION_MONITOR_VIEW_LIMIT),
  };
}

function resolveActionMonitorGitHubReadConfig(env, options = {}) {
  if (isExplicitlyDisabledFlag(env.GITHUB_ACTION_MONITOR_GITHUB_API_ENABLED)) {
    return { enabled: false };
  }

  const repositoryFullName = firstNonEmpty([
    env.GITHUB_ACTION_MONITOR_REPOSITORY,
    env.GITHUB_REPOSITORY,
  ]);
  const [owner, repo] = repositoryFullName.split('/');
  const token = firstNonEmpty([
    env.GITHUB_ACTION_MONITOR_GITHUB_TOKEN,
    env.GITHUB_TOKEN,
    env.GH_TOKEN,
  ]);

  return {
    enabled: Boolean(owner && repo && token),
    owner,
    repo,
    token,
    branch: firstNonEmpty([
      env.GITHUB_ACTION_MONITOR_BRANCH,
      options.environment,
      env.GITHUB_REF_NAME,
      env.CF_PAGES_BRANCH,
      env.BRANCH,
    ]),
    limit: options.limit,
  };
}

function firstNonEmpty(values) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
}

function shouldUseTrainingDbForActionMonitor(env) {
  if (!isEnabledFlag(env.TRAINING_DB_ENABLED)) {
    return false;
  }
  if (isEnabledFlag(env.GITHUB_ACTION_MONITOR_VIEW_ENABLED)) {
    return true;
  }
  return isEnabledFlag(env.GITHUB_ACTIONS) || Boolean(firstNonEmpty([
    env.GITHUB_REF_NAME,
    env.CF_PAGES_BRANCH,
  ]));
}

function isEnabledFlag(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function isExplicitlyDisabledFlag(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value ?? '').trim().toLowerCase());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRootDir(value) {
  if (value instanceof URL) {
    return fileURLToPath(value);
  }
  return path.resolve(String(value ?? defaultRootDir));
}

function toPosixRelativePath(rootDir, targetPath) {
  return path.relative(rootDir, targetPath).split(path.sep).join('/');
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

    lines.push('### 睡眠');
    lines.push('');
    const sleep = day.sleepSummary ?? {};
    lines.push(`- 总睡眠：${formatDebugValue(sleep.totalSleepMinutes)} 分钟`);
    lines.push(`- 夜间睡眠：${formatDebugValue(sleep.nightSleepMinutes)} 分钟`);
    lines.push(`- 入睡/起床：${sleep.sleepStartTime ?? '无'} → ${sleep.sleepEndTime ?? '无'}`);
    lines.push(`- 深睡：${formatDebugValue(sleep.deepSleepMinutes)} 分钟`);
    lines.push(`- 浅睡：${formatDebugValue(sleep.lightSleepMinutes)} 分钟`);
    lines.push(`- REM：${formatDebugValue(sleep.remSleepMinutes)} 分钟`);
    lines.push(`- 清醒：${formatDebugValue(sleep.awakeMinutes)} 分钟`);
    lines.push(`- 睡眠评分：${formatDebugValue(sleep.sleepScore)} 分`);
    lines.push(`- 平均心率：${formatDebugValue(sleep.averageHeartRateBpm)} 次/分钟`);
    lines.push(`- HRV：${formatDebugValue(sleep.hrvMs)} 毫秒`);
    lines.push(`- 平均血氧：${formatDebugValue(sleep.averageSpo2Pct)}%`);
    lines.push(`- 平均呼吸率：${formatDebugValue(sleep.averageRespiratoryRate)} 次/分钟`);
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

function isStrictDatabaseSnapshotMode(env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.TRAINING_SNAPSHOT_STRICT_DATABASE ?? '').trim().toLowerCase(),
  );
}

function resolveBuildArchiveWriteDecision({ env, snapshotSource, strictDatabaseSnapshot }) {
  const mode = normalizeBuildArchiveWriteMode(env.TRAINING_BUILD_ARCHIVE_WRITE);

  if (mode === 'true') {
    return {
      mode,
      enabled: true,
    };
  }

  if (mode === 'false') {
    return {
      mode,
      enabled: false,
    };
  }

  return {
    mode,
    enabled: snapshotSource === 'markdown' && !strictDatabaseSnapshot,
  };
}

function normalizeBuildArchiveWriteMode(value) {
  const normalized = String(value ?? 'auto').trim().toLowerCase();
  return ['auto', 'true', 'false'].includes(normalized) ? normalized : 'auto';
}
