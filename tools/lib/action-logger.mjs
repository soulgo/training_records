import { createHash } from 'node:crypto';

const SENSITIVE_KEY_PATTERN =
  /(?:secret|token|api[_-]?key|password|db[_-]?url|database[_-]?url|sql|params|prompt|caption|text|body|file[_-]?id|file[_-]?unique[_-]?id|image[_-]?key|chat[_-]?id|chat[_-]?ids|source[_-]?id|source[_-]?chat[_-]?id|bucket|path[_-]?prefix|cos[_-]?key|object[_-]?key|key)$/iu;

const SAFE_EVENT_KEYS = new Set([
  'ts',
  'level',
  'domain',
  'event',
  'traceId',
  'queueTaskId',
  'workflow',
  'runId',
  'job',
  'step',
  'channel',
  'batchId',
  'durationMs',
  'outcome',
  'status',
  'attempt',
  'maxAttempts',
  'deployRunId',
  'workflowFile',
  'elapsedMs',
  'lastStatus',
  'lastConclusion',
  'url',
  'businessOutcome',
  'messageCount',
  'imageCount',
  'payloadHash',
  'reason',
  'transactionId',
  'pendingStatus',
  'rollbackStatus',
]);

export function deriveTraceId(queueTaskId) {
  const normalized = String(queueTaskId ?? '').trim();
  if (!normalized) {
    return null;
  }
  return `tr_${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)}`;
}

export function buildTraceContext(env = {}) {
  const queueTaskId = firstNonEmpty(
    env.QUEUE_TASK_ID,
    env.GITHUB_EVENT_INPUT_QUEUE_TASK_ID,
    env.INPUT_QUEUE_TASK_ID,
    env.queue_task_id,
  );
  const traceId = firstNonEmpty(env.TRACE_ID, env.traceId) ?? deriveTraceId(queueTaskId);
  return compactObject({
    traceId,
    queueTaskId,
    workflow: firstNonEmpty(env.GITHUB_WORKFLOW, env.WORKFLOW, env.workflow),
    runId: firstNonEmpty(env.GITHUB_RUN_ID, env.RUN_ID, env.runId),
  });
}

export function hashSensitive(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)}`;
}

export function redactSensitive(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, key));
  }
  if (value && typeof value === 'object') {
    return compactObject(
      Object.fromEntries(
        Object.entries(value)
          .filter(([entryKey]) => !shouldDropSensitiveKey(entryKey))
          .map(([entryKey, entryValue]) => [entryKey, redactSensitive(entryValue, entryKey)]),
      ),
    );
  }
  if (SENSITIVE_KEY_PATTERN.test(String(key))) {
    return hashSensitive(value);
  }
  return value;
}

export function formatActionLogEvent(fields = {}) {
  const now = new Date().toISOString();
  const normalized = compactObject({
    ts: fields.ts ?? now,
    ...redactSensitive(fields),
    level: normalizeLevel(fields.level),
    domain: normalizeToken(fields.domain),
    event: normalizeEvent(fields.event),
    durationMs: normalizeDuration(fields.durationMs),
    elapsedMs: normalizeDuration(fields.elapsedMs),
  });
  const safe = compactObject(
    Object.fromEntries(
      Object.entries(normalized).filter(([key]) => SAFE_EVENT_KEYS.has(key) || !shouldDropSensitiveKey(key)),
    ),
  );
  return `[action-log] ${JSON.stringify(safe)}\n`;
}

export function compactObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const entries = [];
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue === undefined || entryValue === null || entryValue === '') {
      continue;
    }
    if (Array.isArray(entryValue) && entryValue.length === 0) {
      continue;
    }
    if (
      entryValue &&
      typeof entryValue === 'object' &&
      !Array.isArray(entryValue) &&
      Object.keys(entryValue).length === 0
    ) {
      continue;
    }
    entries.push([key, entryValue]);
  }
  return Object.fromEntries(entries);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeLevel(value) {
  const normalized = String(value ?? 'INFO').trim().toUpperCase();
  return ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(normalized) ? normalized : 'INFO';
}

function normalizeToken(value) {
  return String(value ?? 'ACTION').trim().toUpperCase();
}

function normalizeEvent(value) {
  return String(value ?? 'event').trim();
}

function normalizeDuration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function shouldDropSensitiveKey(key) {
  return /^(?:sql|params|prompt|caption|text|body)$/iu.test(String(key));
}
