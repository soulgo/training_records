const SAFE_KEYS = new Set([
  'status',
  'batchId',
  'archivedDate',
  'transactionId',
  'sourceChannel',
  'rowCounts',
  'pendingStatus',
  'rollbackStatus',
  'durationMs',
  'slowQueries',
  'dbTimingsMs',
  'reason',
]);

export function buildPersistenceSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = value.persistenceResult && typeof value.persistenceResult === 'object'
    ? value.persistenceResult
    : value;
  const summary = {};
  for (const key of SAFE_KEYS) {
    if (source[key] === undefined) {
      continue;
    }
    if (key === 'rowCounts') {
      summary.rowCounts = normalizeRowCounts(source.rowCounts);
      continue;
    }
    if (key === 'slowQueries') {
      summary.slowQueries = normalizeSlowQueries(source.slowQueries);
      continue;
    }
    if (key === 'dbTimingsMs') {
      summary.dbTimingsMs = normalizeDbTimings(source.dbTimingsMs);
      continue;
    }
    if (key === 'durationMs') {
      summary.durationMs = normalizeNonNegativeInteger(source.durationMs);
      continue;
    }
    summary[key] = source[key];
  }
  if (!summary.status && value.status) {
    summary.status = value.status;
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function normalizeRowCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => Number.isFinite(Number(count)))
      .map(([key, count]) => [key, Math.max(0, Math.round(Number(count)))]),
  );
}

function normalizeSlowQueries(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((query) => query && typeof query === 'object' && !Array.isArray(query))
    .map((query, index) => ({
      queryOrdinal: normalizeNonNegativeInteger(query.queryOrdinal) ?? index + 1,
      operation: String(query.operation ?? 'database.query'),
      table: String(query.table ?? 'unknown'),
      durationMs: normalizeNonNegativeInteger(query.durationMs),
      thresholdMs: normalizeNonNegativeInteger(query.thresholdMs),
    }))
    .filter((query) => query.durationMs !== null && query.thresholdMs !== null);
}

function normalizeDbTimings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    ['connect', 'begin', 'query', 'commit', 'aiCallLog']
      .map((key) => [key, normalizeNonNegativeInteger(value[key])])
      .filter(([, durationMs]) => durationMs !== null),
  );
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}
