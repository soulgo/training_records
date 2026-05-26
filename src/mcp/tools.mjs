import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import frontMatter from 'hexo-front-matter';

import { buildDashboardViewModel } from '../../tools/dashboard-view.mjs';
import { exportTrainingMarkdown } from '../../tools/training-db-core.mjs';
import { buildTrainingSnapshot, resolveSnapshotSource } from '../../tools/training-snapshot.mjs';
import {
  buildTrainingAnalysisSummary,
  generateTrainingAnalysisReply,
  inferTrainingAnalysisFocus,
  normalizeAnalysisQuestion,
  normalizeTrainingGoal,
} from '../../tools/training-analysis.mjs';
import { getTelegramCommandRegistry } from '../telegram/command-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..', '..');
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const secretKeyPattern = /(?:TOKEN|SECRET|PASSWORD|KEY|URL)$/i;
const defaultToolTimeoutMs = 10_000;
const defaultMaxDateRangeDays = 366;
const cacheStore = new Map();

const publicConfigKeys = new Set([
  'TRAINING_SNAPSHOT_SOURCE',
  'TRAINING_DB_ENABLED',
  'TRAINING_DB_TIMEOUT_MS',
  'TRAINING_DB_APP_NAME',
  'AI_PROVIDER',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_TIMEOUT_MS',
  'AI_CONCURRENCY',
  'TRAINING_ANALYSIS_GOAL',
  'TELEGRAM_POLL_LIMIT',
  'TELEGRAM_SYNC_TRANSPORT',
  'TELEGRAM_RECOGNITION_CACHE_ENABLED',
  'MCP_ENABLED',
  'MCP_TRANSPORT',
  'MCP_READONLY',
  'MCP_TOOL_TIMEOUT_MS',
  'MCP_MAX_DATE_RANGE_DAYS',
  'MCP_ALLOWED_TOOLS',
  'MCP_REQUIRE_AUTH',
  'MCP_LOG_LEVEL',
]);

const toolDefinitions = [
  {
    name: 'training.get_snapshot',
    description: 'Return the canonical TrainingSnapshot from markdown or database.',
    ttlMs: 60_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
      include_body_feedback: booleanSchema(),
    }),
    handler: getSnapshotTool,
  },
  {
    name: 'training.get_daily_records',
    description: 'Return daily training records, optionally projected to selected sections.',
    ttlMs: 60_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
      types: arraySchema(enumSchema(['measurement', 'measurements', 'activities', 'workoutSummary', 'nutrition'])),
    }),
    handler: getDailyRecordsTool,
  },
  {
    name: 'training.get_latest_status',
    description: 'Return the latest measurement, latest day, and latest body feedback.',
    ttlMs: 60_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
    }),
    handler: getLatestStatusTool,
  },
  {
    name: 'training.get_measurements',
    description: 'Return body composition measurements from the snapshot.',
    ttlMs: 60_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
      limit: numberSchema(),
    }),
    handler: getMeasurementsTool,
  },
  {
    name: 'training.get_activities',
    description: 'Return activity records from the snapshot.',
    ttlMs: 60_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
      activity_type: stringSchema(),
      limit: numberSchema(),
    }),
    handler: getActivitiesTool,
  },
  {
    name: 'training.get_nutrition',
    description: 'Return nutrition records by day.',
    ttlMs: 60_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
    }),
    handler: getNutritionTool,
  },
  {
    name: 'training.get_body_feedback',
    description: 'Return body feedback thought entries.',
    ttlMs: 60_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
      keyword: stringSchema(),
      limit: numberSchema(),
    }),
    handler: getBodyFeedbackTool,
  },
  {
    name: 'training.get_dashboard_view',
    description: 'Return the dashboard view model generated from TrainingSnapshot.',
    ttlMs: 60_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
    }),
    handler: getDashboardViewTool,
  },
  {
    name: 'training.get_chart_data',
    description: 'Return chart point arrays from TrainingSnapshot.',
    ttlMs: 120_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
      metrics: arraySchema(stringSchema()),
    }),
    handler: getChartDataTool,
  },
  {
    name: 'training.get_analysis_summary',
    description: 'Return the structured analysis summary used by training analysis.',
    ttlMs: 120_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
    }),
    handler: getAnalysisSummaryTool,
  },
  {
    name: 'training.generate_analysis',
    description: 'Generate an AI training analysis reply without writing Telegram, Markdown, or database state.',
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      question: stringSchema(),
      goal: stringSchema(),
      date_from: dateSchema(),
      date_to: dateSchema(),
    }),
    handler: generateAnalysisTool,
  },
  {
    name: 'training.search_records',
    description: 'Search training markdown and thought posts.',
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      query: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
      types: arraySchema(enumSchema(['snapshot', 'markdown', 'thought'])),
      limit: numberSchema(),
      include_raw: booleanSchema(),
    }),
    handler: searchRecordsTool,
  },
  {
    name: 'training.get_markdown_record',
    description: 'Return a read-only markdown rendering of training records.',
    ttlMs: 60_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      source: enumSchema(['auto', 'markdown', 'database']),
      date_from: dateSchema(),
      date_to: dateSchema(),
    }),
    handler: getMarkdownRecordTool,
  },
  {
    name: 'training.get_config',
    description: 'Return allowlisted, non-secret runtime configuration.',
    ttlMs: 30_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      keys: arraySchema(stringSchema()),
    }),
    handler: getConfigTool,
  },
  {
    name: 'runtime.get_sync_status',
    description: 'Return read-only runtime queue and archive failure status.',
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      include_recent_errors: booleanSchema(),
      limit: numberSchema(),
    }),
    handler: getRuntimeStatusTool,
  },
  {
    name: 'telegram.get_command_registry',
    description: 'Return Telegram command registry aliases and priorities.',
    ttlMs: 300_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
    }),
    handler: getTelegramCommandRegistryTool,
  },
  {
    name: 'training.get_prompt_metadata',
    description: 'Return prompt metadata for recognition or analysis prompts.',
    ttlMs: 300_000,
    inputSchema: objectSchema({
      trace_id: stringSchema(),
      prompt_type: enumSchema(['recognition', 'analysis']),
    }),
    handler: getPromptMetadataTool,
  },
];

const toolsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

export function listMcpTools() {
  return toolDefinitions.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export function resolveMcpConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.MCP_ENABLED, true),
    transport: String(env.MCP_TRANSPORT ?? 'stdio').trim().toLowerCase() || 'stdio',
    readonly: parseBoolean(env.MCP_READONLY, true),
    toolTimeoutMs: parsePositiveInteger(env.MCP_TOOL_TIMEOUT_MS, defaultToolTimeoutMs),
    maxDateRangeDays: parsePositiveInteger(env.MCP_MAX_DATE_RANGE_DAYS, defaultMaxDateRangeDays),
    requireAuth: parseBoolean(env.MCP_REQUIRE_AUTH, false),
    logLevel: String(env.MCP_LOG_LEVEL ?? 'info').trim().toLowerCase() || 'info',
    allowedTools: parseAllowedTools(env.MCP_ALLOWED_TOOLS),
  };
}

export async function callMcpTool(name, args = {}, options = {}) {
  const env = options.env ?? process.env;
  const config = {
    ...resolveMcpConfig(env),
    ...(options.config ?? {}),
  };
  const startedAt = Date.now();
  const traceId = normalizeTraceId(args?.trace_id);
  const tool = toolsByName.get(name);

  try {
    if (!tool) {
      throw new McpToolError('TOOL_DISABLED', `Unknown MCP tool: ${name}`, { retryable: false });
    }
    if (!config.enabled) {
      throw new McpToolError('TOOL_DISABLED', 'MCP tools are disabled', { retryable: false });
    }
    if (config.allowedTools && !config.allowedTools.has(name)) {
      throw new McpToolError('UNAUTHORIZED', `MCP tool is not allowed: ${name}`, { retryable: false });
    }

    validateCommonArgs(args, config);
    const cacheKey = buildCacheKey(name, args, options);
    const cached = readCache(tool, cacheKey);
    if (cached) {
      return buildSuccessEnvelope({
        traceId,
        data: cached.data,
        meta: {
          ...cached.meta,
          cache: 'hit',
          duration_ms: Date.now() - startedAt,
        },
      });
    }

    const data = await runWithTimeout(
      tool.handler(args ?? {}, buildToolContext({ env, config, options })),
      options.timeoutMs ?? config.toolTimeoutMs,
    );
    const meta = {
      source: data?.source ?? resolveEffectiveSource(args?.source, env),
      generated_at: data?.generatedAt ?? data?.summary?.generatedAt ?? null,
      cache: tool.ttlMs ? 'miss' : 'disabled',
      duration_ms: Date.now() - startedAt,
    };
    const payload = data?.data !== undefined ? data.data : data;
    writeCache(tool, cacheKey, payload, meta);

    return buildSuccessEnvelope({ traceId, data: payload, meta });
  } catch (error) {
    const normalized = normalizeToolError(error);
    return {
      success: false,
      trace_id: traceId,
      data: null,
      error: normalized,
      meta: {
        duration_ms: Date.now() - startedAt,
      },
    };
  }
}

async function getSnapshotTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  return {
    data: args.include_body_feedback === false
      ? omitKey(snapshot, 'bodyFeedback')
      : snapshot,
    source: snapshot.source ?? resolveEffectiveSource(args.source, context.env),
    generatedAt: snapshot.generatedAt,
  };
}

async function getDailyRecordsTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const types = Array.isArray(args.types) && args.types.length ? new Set(args.types) : null;
  const days = (snapshot.daily ?? []).map((day) => {
    if (!types) {
      return day;
    }
    const projected = { date: day.date };
    for (const type of types) {
      projected[type] = day[type] ?? null;
    }
    return projected;
  });
  return {
    data: { days },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

async function getLatestStatusTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const bodyFeedback = [...(snapshot.bodyFeedback ?? [])].sort(compareFeedbackDesc);
  return {
    data: {
      latestMeasurement: snapshot.latest?.measurement ?? null,
      latestDay: snapshot.latest?.daily ?? null,
      bodyFeedbackLatest: bodyFeedback[0] ?? null,
    },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

async function getMeasurementsTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const measurements = limitItems(
    snapshot.daily
      .flatMap((day) => day.measurements ?? (day.measurement ? [day.measurement] : []))
      .filter(Boolean),
    args.limit,
  );
  return {
    data: { measurements },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

async function getActivitiesTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const activityType = String(args.activity_type ?? '').trim();
  let activities = snapshot.daily.flatMap((day) =>
    (day.activities ?? []).map((activity) => ({
      date: day.date,
      ...activity,
    })),
  );
  if (activityType) {
    activities = activities.filter((activity) =>
      String(activity.type ?? '').includes(activityType) ||
      String(activity.rawType ?? '').includes(activityType),
    );
  }
  return {
    data: { activities: limitItems(activities, args.limit) },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

async function getNutritionTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  return {
    data: {
      days: snapshot.daily.map((day) => ({
        date: day.date,
        nutrition: day.nutrition ?? null,
      })),
    },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

async function getBodyFeedbackTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const keyword = String(args.keyword ?? '').trim();
  let feedback = snapshot.bodyFeedback ?? [];
  if (keyword) {
    feedback = feedback.filter((entry) => String(entry.body ?? '').includes(keyword));
  }
  return {
    data: { feedback: limitItems(feedback, args.limit) },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

async function getDashboardViewTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  return {
    data: buildDashboardViewModel(snapshot),
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

async function getChartDataTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const requested = Array.isArray(args.metrics) && args.metrics.length
    ? new Set(args.metrics)
    : null;
  const charts = Object.fromEntries(
    Object.entries(snapshot.charts ?? {})
      .filter(([metric]) => !requested || requested.has(metric)),
  );
  return {
    data: { charts },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

async function getAnalysisSummaryTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const summary = buildTrainingAnalysisSummary(snapshot, context.options.now ?? new Date());
  return {
    data: { summary },
    source: snapshot.source,
    generatedAt: summary.generatedAt,
  };
}

async function generateAnalysisTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const question = normalizeAnalysisQuestion(args.question);
  const trainingGoal = normalizeTrainingGoal(args.goal ?? context.env.TRAINING_ANALYSIS_GOAL);
  const focus = inferTrainingAnalysisFocus(question);
  const summary = buildTrainingAnalysisSummary(snapshot, context.options.now ?? new Date());
  const reply = await generateTrainingAnalysisReply({
    env: context.env,
    rootDir: context.rootDir,
    question,
    trainingGoal,
    snapshot,
    now: context.options.now,
    fetchImpl: context.options.fetchImpl,
    aiProvider: context.options.aiProvider,
    maxAttempts: context.options.maxAttempts,
    baseDelayMs: context.options.baseDelayMs,
  });

  return {
    data: {
      reply,
      summary,
      focus,
      dataSource: summary.dataSource,
    },
    source: snapshot.source,
    generatedAt: summary.generatedAt,
  };
}

async function searchRecordsTool(args, context) {
  const query = String(args.query ?? '').trim();
  if (!query) {
    throw new McpToolError('INVALID_ARGUMENT', 'query is required', { retryable: false });
  }

  const types = Array.isArray(args.types) && args.types.length
    ? new Set(args.types)
    : new Set(['snapshot', 'markdown', 'thought']);
  const matches = [];

  if (types.has('snapshot')) {
    const snapshot = await loadSnapshot(args, context);
    for (const day of snapshot.daily ?? []) {
      const text = JSON.stringify(day);
      if (text.includes(query)) {
        matches.push({
          source: 'snapshot',
          date: day.date,
          text: summarizeMatch(text, query, args.include_raw),
        });
      }
    }
  }

  if (types.has('markdown')) {
    const markdownPath = path.join(context.rootDir, '训练记录.md');
    const markdown = await safeReadTextFile(markdownPath);
    collectTextMatches(matches, {
      source: 'markdown',
      text: markdown,
      query,
      includeRaw: args.include_raw,
      path: '训练记录.md',
    });
  }

  if (types.has('thought')) {
    for (const post of await readThoughtPosts(context.rootDir)) {
      collectTextMatches(matches, {
        source: 'thought',
        text: post.body,
        query,
        includeRaw: args.include_raw,
        path: post.markdownPath,
        date: post.date,
      });
    }
  }

  return {
    data: { matches: limitItems(matches, args.limit ?? 20) },
    source: resolveEffectiveSource(args.source, context.env),
  };
}

async function getMarkdownRecordTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  return {
    data: { markdown: exportTrainingMarkdown(snapshot) },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

async function getConfigTool(args, context) {
  const requested = Array.isArray(args.keys) && args.keys.length
    ? args.keys
    : [...publicConfigKeys];
  const config = {};
  for (const key of requested) {
    if (!publicConfigKeys.has(key) || secretKeyPattern.test(key)) {
      continue;
    }
    if (context.env[key] !== undefined) {
      config[key] = String(context.env[key]);
    }
  }
  return {
    data: { config },
    source: 'env',
  };
}

async function getRuntimeStatusTool(args, context) {
  const pending = await readNdjson(path.join(context.rootDir, 'runtime', 'telegram-sync-pending.ndjson'));
  const archiveFailures = await readNdjson(path.join(context.rootDir, 'runtime', 'training-db-sync.ndjson'));
  const limit = args.limit ?? 5;
  const data = {
    pendingCount: pending.valid.length,
    pendingInvalidLines: pending.invalidLines,
    archiveFailureCount: archiveFailures.valid.length,
    archiveFailureInvalidLines: archiveFailures.invalidLines,
  };
  if (args.include_recent_errors) {
    data.recentErrors = [...pending.valid, ...archiveFailures.valid]
      .slice(-limit)
      .map((entry) => ({
        failedAt: entry.failedAt ?? entry.runFinishedAt ?? null,
        error: summarizeErrorValue(entry.error ?? entry),
        batchId: entry.batch?.batchId ?? null,
      }));
  }
  return {
    data,
    source: 'runtime',
  };
}

async function getTelegramCommandRegistryTool() {
  return {
    data: {
      commands: getTelegramCommandRegistry().map((command) => ({
        name: command.name,
        priority: command.priority,
        aliases: command.aliases,
      })),
    },
    source: 'telegram_registry',
  };
}

async function getPromptMetadataTool(args, context) {
  const promptPath = args.prompt_type === 'analysis'
    ? context.env.TRAINING_ANALYSIS_PROMPT_PATH || path.join(context.rootDir, 'prompts', 'training-analysis.md')
    : context.env.TELEGRAM_RECOGNITION_PROMPT_PATH || path.join(context.rootDir, 'prompts', 'telegram-training-image-recognition.md');
  const prompt = await safeReadTextFile(promptPath);
  const metadata = parsePromptMetadata(prompt);
  return {
    data: {
      promptType: args.prompt_type,
      path: toPortableRelativePath(path.relative(context.rootDir, promptPath)),
      metadata,
    },
    source: 'prompt',
  };
}

async function loadSnapshot(args, context) {
  const source = normalizeSource(args.source, context.env);
  const snapshot = await buildTrainingSnapshot({
    source,
    rootDir: context.rootDir,
    env: context.env,
    now: context.options.now,
    createClient: context.options.createClient,
    dateFrom: args.date_from,
    dateTo: args.date_to,
  });
  return {
    ...snapshot,
    daily: filterDailyByDate(snapshot.daily ?? [], args.date_from, args.date_to),
    charts: filterChartsByDate(snapshot.charts ?? {}, args.date_from, args.date_to),
    bodyFeedback: filterFeedbackByDate(snapshot.bodyFeedback ?? [], args.date_from, args.date_to),
    source,
  };
}

function buildToolContext({ env, config, options }) {
  return {
    env,
    config,
    options,
    rootDir: options.rootDir ?? defaultRootDir,
  };
}

function validateCommonArgs(args = {}, config) {
  validateDateArg('date_from', args.date_from);
  validateDateArg('date_to', args.date_to);
  if (args.date_from && args.date_to && args.date_from > args.date_to) {
    throw new McpToolError('INVALID_ARGUMENT', 'date_from must be before or equal to date_to', {
      retryable: false,
    });
  }
  if (args.date_from && args.date_to) {
    const rangeDays = differenceInDays(args.date_from, args.date_to) + 1;
    if (rangeDays > config.maxDateRangeDays) {
      throw new McpToolError('INVALID_ARGUMENT', `date range exceeds ${config.maxDateRangeDays} days`, {
        retryable: false,
      });
    }
  }
  if (args.limit !== undefined && (!Number.isInteger(Number(args.limit)) || Number(args.limit) < 1)) {
    throw new McpToolError('INVALID_ARGUMENT', 'limit must be a positive integer', { retryable: false });
  }
}

function validateDateArg(name, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  if (!datePattern.test(String(value))) {
    throw new McpToolError('INVALID_ARGUMENT', `${name} must be YYYY-MM-DD`, { retryable: false });
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new McpToolError('INVALID_ARGUMENT', `${name} is not a valid date`, { retryable: false });
  }
}

function normalizeSource(source, env) {
  if (!source || source === 'auto') {
    return resolveSnapshotSource(env);
  }
  if (source === 'markdown' || source === 'database') {
    return source;
  }
  throw new McpToolError('INVALID_ARGUMENT', 'source must be auto, markdown, or database', {
    retryable: false,
  });
}

function resolveEffectiveSource(source, env) {
  return source && source !== 'auto' ? source : resolveSnapshotSource(env);
}

function filterDailyByDate(days, dateFrom, dateTo) {
  return days.filter((day) => isDateInWindow(day.date, dateFrom, dateTo));
}

function filterChartsByDate(charts, dateFrom, dateTo) {
  return Object.fromEntries(
    Object.entries(charts).map(([key, points]) => [
      key,
      (points ?? []).filter((point) => isDateInWindow(point?.date, dateFrom, dateTo)),
    ]),
  );
}

function filterFeedbackByDate(entries, dateFrom, dateTo) {
  return entries.filter((entry) => isDateInWindow(entry.date, dateFrom, dateTo));
}

function isDateInWindow(date, dateFrom, dateTo) {
  const normalized = String(date ?? '').slice(0, 10);
  if (dateFrom && normalized < dateFrom) {
    return false;
  }
  if (dateTo && normalized > dateTo) {
    return false;
  }
  return true;
}

function limitItems(items, limit) {
  const normalizedLimit = limit === undefined ? null : Number(limit);
  if (!normalizedLimit) {
    return items;
  }
  return items.slice(-normalizedLimit);
}

async function readThoughtPosts(rootDir) {
  const postsDir = path.join(rootDir, 'source', '_posts');
  const entries = await safeReadDir(postsDir);
  const posts = [];
  for (const entry of entries) {
    if (!/-telegram-thought-\d+\.md$/u.test(entry.name)) {
      continue;
    }
    const absolutePath = path.join(postsDir, entry.name);
    const raw = await safeReadTextFile(absolutePath);
    if (!raw) {
      continue;
    }
    try {
      const parsed = frontMatter.parse(raw);
      posts.push({
        date: normalizePostDate(parsed.date ?? extractRawFrontMatterValue(raw, 'date')),
        body: String(parsed._content ?? '').trim(),
        markdownPath: toPortableRelativePath(path.relative(rootDir, absolutePath)),
      });
    } catch {}
  }
  return posts;
}

function collectTextMatches(matches, { source, text, query, includeRaw, path: filePath, date }) {
  const index = String(text ?? '').indexOf(query);
  if (index < 0) {
    return;
  }
  matches.push({
    source,
    path: filePath,
    date: date ?? extractDateNearText(text, index),
    text: summarizeMatch(text, query, includeRaw),
  });
}

function summarizeMatch(text, query, includeRaw) {
  const value = String(text ?? '');
  if (includeRaw) {
    return value;
  }
  const index = value.indexOf(query);
  if (index < 0) {
    return value.slice(0, 200);
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(value.length, index + query.length + 80);
  return value.slice(start, end).replace(/\s+/g, ' ').trim();
}

function extractDateNearText(text, index) {
  const before = String(text ?? '').slice(Math.max(0, index - 500), index);
  return before.match(/(\d{4}-\d{2}-\d{2})/g)?.at(-1) ?? null;
}

async function readNdjson(filePath) {
  const raw = await safeReadTextFile(filePath);
  if (!raw) {
    return { valid: [], invalidLines: 0 };
  }
  const valid = [];
  let invalidLines = 0;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    try {
      valid.push(JSON.parse(line));
    } catch {
      invalidLines += 1;
    }
  }
  return { valid, invalidLines };
}

async function safeReadTextFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function safeReadDir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function parsePromptMetadata(prompt) {
  const match = String(prompt ?? '').match(/^<!--\s*prompt-metadata\s+(\{.+?\})\s*-->/u);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function buildCacheKey(name, args, options) {
  if (options.disableCache) {
    return null;
  }
  return JSON.stringify({
    name,
    args,
    rootDir: options.rootDir ?? defaultRootDir,
    now: options.now?.toISOString?.() ?? null,
  });
}

function readCache(tool, key) {
  if (!tool.ttlMs || !key) {
    return null;
  }
  const cached = cacheStore.get(key);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.storedAt > tool.ttlMs) {
    cacheStore.delete(key);
    return null;
  }
  return cached;
}

function writeCache(tool, key, data, meta) {
  if (!tool.ttlMs || !key) {
    return;
  }
  cacheStore.set(key, {
    data,
    meta,
    storedAt: Date.now(),
  });
}

function buildSuccessEnvelope({ traceId, data, meta }) {
  return {
    success: true,
    trace_id: traceId,
    data,
    error: null,
    meta,
  };
}

function normalizeToolError(error) {
  if (error instanceof McpToolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  if (error?.name === 'AbortError') {
    return {
      code: 'TIMEOUT',
      message: error.message || 'Tool timed out',
      retryable: true,
      details: {},
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: classifyErrorCode(message),
    message,
    retryable: /unavailable|timeout|ECONN|ENOTFOUND|rate/i.test(message),
    details: {},
  };
}

function classifyErrorCode(message) {
  if (/database/i.test(message)) {
    return 'DATABASE_UNAVAILABLE';
  }
  if (/markdown|ENOENT|训练记录/i.test(message)) {
    return 'MARKDOWN_UNAVAILABLE';
  }
  if (/AI|analysis|provider/i.test(message)) {
    return 'AI_PROVIDER_ERROR';
  }
  return 'INTERNAL_ERROR';
}

async function runWithTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Tool timed out after ${timeoutMs}ms`);
          error.name = 'AbortError';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTraceId(value) {
  const text = String(value ?? '').trim();
  if (text) {
    return text;
  }
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `mcp_${date}_${randomBytes(4).toString('hex')}`;
}

function parseAllowedTools(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  return new Set(text.split(',').map((item) => item.trim()).filter(Boolean));
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function differenceInDays(start, end) {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  return Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000);
}

function compareFeedbackDesc(left, right) {
  return `${right.date} ${right.time ?? ''}`.localeCompare(`${left.date} ${left.time ?? ''}`);
}

function omitKey(object, key) {
  const { [key]: _ignored, ...rest } = object;
  return rest;
}

function normalizePostDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

function extractRawFrontMatterValue(raw, key) {
  const match = String(raw ?? '').match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

function summarizeErrorValue(value) {
  const message = typeof value === 'string' ? value : value?.message ?? JSON.stringify(value);
  return String(message ?? '').slice(0, 240);
}

function toPortableRelativePath(value) {
  return String(value ?? '').split(path.sep).join('/');
}

function objectSchema(properties) {
  return {
    type: 'object',
    properties,
    additionalProperties: false,
  };
}

function stringSchema() {
  return { type: 'string' };
}

function numberSchema() {
  return { type: 'number' };
}

function booleanSchema() {
  return { type: 'boolean' };
}

function dateSchema() {
  return {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  };
}

function enumSchema(values) {
  return {
    type: 'string',
    enum: values,
  };
}

function arraySchema(items) {
  return {
    type: 'array',
    items,
  };
}

class McpToolError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}
