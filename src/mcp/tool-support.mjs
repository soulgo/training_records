import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import frontMatter from 'hexo-front-matter';

import { buildTrainingSnapshot, resolveSnapshotSource } from '../../tools/training-snapshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const defaultRootDir = path.resolve(__dirname, '..', '..');
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export const secretKeyPattern = /(?:TOKEN|SECRET|PASSWORD|KEY|URL)$/i;
export const defaultToolTimeoutMs = 10_000;
export const defaultMaxDateRangeDays = 366;
const cacheStore = new Map();

export const publicConfigKeys = new Set([
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

export function buildToolContext({ env, config, options }) {
  return {
    env,
    config,
    options,
    rootDir: options.rootDir ?? defaultRootDir,
  };
}

export function validateCommonArgs(args = {}, config) {
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

export async function loadSnapshot(args, context) {
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

export function resolveEffectiveSource(source, env) {
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

export function limitItems(items, limit) {
  const normalizedLimit = limit === undefined ? null : Number(limit);
  if (!normalizedLimit) {
    return items;
  }
  return items.slice(-normalizedLimit);
}

export async function readThoughtPosts(rootDir) {
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

export function collectTextMatches(matches, { source, text, query, includeRaw, path: filePath, date }) {
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

export function summarizeMatch(text, query, includeRaw) {
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

export async function readNdjson(filePath) {
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

export async function safeReadTextFile(filePath) {
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

export function parsePromptMetadata(prompt) {
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

export function buildCacheKey(name, args, options) {
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

export function readCache(tool, key) {
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

export function writeCache(tool, key, data, meta) {
  if (!tool.ttlMs || !key) {
    return;
  }
  cacheStore.set(key, {
    data,
    meta,
    storedAt: Date.now(),
  });
}

export function buildSuccessEnvelope({ traceId, data, meta }) {
  return {
    success: true,
    trace_id: traceId,
    data,
    error: null,
    meta,
  };
}

export function normalizeToolError(error) {
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

export async function runWithTimeout(promise, timeoutMs) {
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

export function normalizeTraceId(value) {
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

export function compareFeedbackDesc(left, right) {
  return `${right.date} ${right.time ?? ''}`.localeCompare(`${left.date} ${left.time ?? ''}`);
}

export function omitKey(object, key) {
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

export function summarizeErrorValue(value) {
  const message = typeof value === 'string' ? value : value?.message ?? JSON.stringify(value);
  return String(message ?? '').slice(0, 240);
}

export function toPortableRelativePath(value) {
  return String(value ?? '').split(path.sep).join('/');
}

export class McpToolError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}
