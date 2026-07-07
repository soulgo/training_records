const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WARNING_DAYS = 30;
const DEFAULT_CRITICAL_DAYS = 7;

const VALID_SCOPES = new Set([
  'github_actions_secret',
  'github_actions_variable',
  'cloudflare_worker_secret',
  'wrangler_var',
  'runtime_env',
  'config_file',
]);
const VALID_CATEGORIES = new Set([
  'database',
  'ai',
  'telegram',
  'feishu',
  'cos',
  'cloudflare',
  'github',
  'monitor',
  'site',
]);
const VALIDITY_MODES = new Set([
  'fixed_expires_at',
  'rotation_cycle',
  'review_after',
  'non_expiring_manual_review',
  'provider_metadata',
]);
const STATUS_KEYS = ['ok', 'warning', 'expired', 'missing', 'unknown'];
const SENSITIVE_DETAIL_KEYS = /(^|_|\b)(value|secret|token|password|api[_-]?key|db[_-]?url|chat[_-]?id)(_|$|\b)/iu;

export function validateParameterRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('parameter registry must be an object');
  }
  if (!normalizeText(registry.environment)) {
    throw new Error('parameter registry environment is required');
  }
  if (!Array.isArray(registry.parameters)) {
    throw new Error('parameter registry parameters must be an array');
  }

  const seenKeys = new Set();
  for (const [index, parameter] of registry.parameters.entries()) {
    validateParameter(parameter, index);
    if (seenKeys.has(parameter.key)) {
      throw new Error(`duplicate parameter key: ${parameter.key}`);
    }
    seenKeys.add(parameter.key);
  }

  return registry;
}

export function runParameterValidityAudit(options = {}) {
  const registry = validateParameterRegistry(options.registry);
  const environment = normalizeText(options.environment) ?? registry.environment;
  const now = normalizeDate(options.now) ?? new Date();
  const presenceByKey = normalizeLookup(options.presenceByKey);
  const presenceByName = normalizeLookup(options.presenceByName);
  const metadataByKey = normalizeLookup(options.metadataByKey);
  const env = options.env ?? {};

  const parameters = registry.parameters.map((parameter) => {
    const metadata = sanitizeDetails(metadataByKey.get(parameter.key) ?? parameter.metadata ?? {});
    return {
      key: parameter.key,
      environment,
      name: parameter.name,
      scope: parameter.scope,
      category: parameter.category,
      required: Boolean(parameter.required),
      sensitive: Boolean(parameter.sensitive),
      validityMode: parameter.validityMode,
      validFrom: parameter.validFrom ?? null,
      expiresAt: parameter.expiresAt ?? null,
      reviewAfterAt: parameter.reviewAfterAt ?? null,
      rotationCycleDays: normalizePositiveInteger(parameter.rotationCycleDays),
      warningDays: normalizePositiveInteger(parameter.warningDays) ?? DEFAULT_WARNING_DAYS,
      criticalDays: normalizePositiveInteger(parameter.criticalDays) ?? DEFAULT_CRITICAL_DAYS,
      owner: normalizeText(parameter.owner),
      sourceDoc: parameter.sourceDoc,
      sourceCode: Array.isArray(parameter.sourceCode) ? parameter.sourceCode : [],
      metadata,
    };
  });

  const checks = parameters.map((parameter) => {
    const presence = resolvePresence(parameter, { env, presenceByKey, presenceByName });
    const evaluated = evaluateParameterValidity(parameter, {
      now,
      presence,
      metadata: parameter.metadata,
      evidenceSource: presence === undefined ? 'registry' : 'registry+runtime_env',
    });

    return {
      parameterKey: parameter.key,
      environment,
      runId: normalizePositiveInteger(options.runId),
      checkedAt: now.toISOString(),
      status: evaluated.status,
      daysUntilDue: evaluated.daysUntilDue,
      evidenceSource: evaluated.evidenceSource,
      message: evaluated.message,
      details: evaluated.details,
    };
  });

  return {
    environment,
    checkedAt: now.toISOString(),
    parameters,
    checks,
    summary: buildParameterValiditySummary(checks),
  };
}

export function evaluateParameterValidity(parameter, options = {}) {
  const now = normalizeDate(options.now) ?? new Date();
  const warningDays = normalizePositiveInteger(parameter.warningDays) ?? DEFAULT_WARNING_DAYS;
  const criticalDays = normalizePositiveInteger(parameter.criticalDays) ?? DEFAULT_CRITICAL_DAYS;
  const metadata = sanitizeDetails(options.metadata ?? parameter.metadata ?? {});
  const due = resolveDue(parameter, metadata);
  const daysUntilDue = due.date ? Math.ceil((due.date.getTime() - now.getTime()) / DAY_MS) : null;
  const presence = typeof options.presence === 'boolean' ? options.presence : undefined;
  const evidenceSource = normalizeText(options.evidenceSource) ?? (presence === undefined ? 'registry' : 'registry+runtime_env');
  let status;

  if (parameter.required && presence === false) {
    status = 'missing';
  } else if (!due.date) {
    status = 'unknown';
  } else if (due.date.getTime() < now.getTime()) {
    status = 'expired';
  } else if (daysUntilDue <= warningDays) {
    status = 'warning';
  } else {
    status = 'ok';
  }

  const details = sanitizeDetails({
    validityMode: parameter.validityMode,
    dueField: due.field,
    dueAt: due.date ? due.date.toISOString() : null,
    warningDays,
    criticalDays,
    presence: presence === undefined ? 'unknown' : presence,
    metadata,
  });

  return {
    parameterKey: parameter.key,
    name: parameter.name,
    status,
    daysUntilDue,
    dueAt: due.date ? due.date.toISOString() : null,
    evidenceSource,
    message: buildStatusMessage({ status, daysUntilDue }),
    details,
  };
}

export function buildParameterValiditySummary(checks = []) {
  const counts = {
    total: 0,
    ok: 0,
    warning: 0,
    expired: 0,
    missing: 0,
    unknown: 0,
  };

  for (const check of Array.isArray(checks) ? checks : []) {
    const status = STATUS_KEYS.includes(check?.status) ? check.status : 'unknown';
    counts.total += 1;
    counts[status] += 1;
  }

  return { counts };
}

export function formatParameterValiditySummaryMarkdown(audit) {
  const counts = audit?.summary?.counts ?? buildParameterValiditySummary(audit?.checks).counts;
  const riskChecks = (audit?.checks ?? [])
    .filter((check) => ['expired', 'missing', 'warning', 'unknown'].includes(check.status))
    .slice(0, 10);
  const parameterNameByKey = new Map((audit?.parameters ?? []).map((parameter) => [parameter.key, parameter.name]));
  const lines = [
    '## Parameter Validity Audit',
    '',
    `Environment: ${audit?.environment ?? 'unknown'}`,
    '',
    '| Status | Count |',
    '| --- | ---: |',
    `| total | ${counts.total} |`,
    `| expired | ${counts.expired} |`,
    `| missing | ${counts.missing} |`,
    `| warning | ${counts.warning} |`,
    `| unknown | ${counts.unknown} |`,
    `| ok | ${counts.ok} |`,
  ];

  if (riskChecks.length) {
    lines.push('', '| Parameter | Status | Message |', '| --- | --- | --- |');
    for (const check of riskChecks) {
      const name = parameterNameByKey.get(check.parameterKey) ?? check.parameterKey;
      lines.push(`| ${escapeMarkdownCell(name)} | ${check.status} | ${escapeMarkdownCell(check.message ?? '')} |`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function validateParameter(parameter, index) {
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) {
    throw new Error(`parameter at index ${index} must be an object`);
  }
  for (const field of ['key', 'name', 'scope', 'category', 'validityMode', 'sourceDoc']) {
    if (!normalizeText(parameter[field])) {
      throw new Error(`parameter at index ${index} is missing ${field}`);
    }
  }
  if (Object.hasOwn(parameter, 'value')) {
    throw new Error(`parameter ${parameter.key} must not store a value`);
  }
  if (!VALID_SCOPES.has(parameter.scope)) {
    throw new Error(`parameter ${parameter.key} has invalid scope: ${parameter.scope}`);
  }
  if (!VALID_CATEGORIES.has(parameter.category)) {
    throw new Error(`parameter ${parameter.key} has invalid category: ${parameter.category}`);
  }
  if (!VALIDITY_MODES.has(parameter.validityMode)) {
    throw new Error(`parameter ${parameter.key} has invalid validityMode: ${parameter.validityMode}`);
  }
  if (typeof parameter.required !== 'boolean') {
    throw new Error(`parameter ${parameter.key} required must be boolean`);
  }
  if (typeof parameter.sensitive !== 'boolean') {
    throw new Error(`parameter ${parameter.key} sensitive must be boolean`);
  }
  if (parameter.sourceCode !== undefined && !Array.isArray(parameter.sourceCode)) {
    throw new Error(`parameter ${parameter.key} sourceCode must be an array when provided`);
  }
  for (const field of ['validFrom', 'expiresAt', 'reviewAfterAt']) {
    if (parameter[field] !== undefined && !normalizeDate(parameter[field])) {
      throw new Error(`parameter ${parameter.key} has invalid ${field}`);
    }
  }
}

function resolvePresence(parameter, { env, presenceByKey, presenceByName }) {
  if (presenceByKey.has(parameter.key)) {
    return Boolean(presenceByKey.get(parameter.key));
  }
  if (presenceByName.has(parameter.name)) {
    return Boolean(presenceByName.get(parameter.name));
  }
  if (parameter.scope === 'runtime_env' && Object.hasOwn(env, parameter.name)) {
    return Boolean(String(env[parameter.name] ?? '').trim());
  }
  return undefined;
}

function resolveDue(parameter, metadata = {}) {
  const expiresAt = normalizeDate(parameter.expiresAt ?? metadata.expiresAt);
  if (expiresAt) {
    return { date: expiresAt, field: 'expiresAt' };
  }

  const reviewAfterAt = normalizeDate(parameter.reviewAfterAt ?? metadata.reviewAfterAt);
  if (reviewAfterAt) {
    return { date: reviewAfterAt, field: 'reviewAfterAt' };
  }

  const rotationCycleDays = normalizePositiveInteger(parameter.rotationCycleDays ?? metadata.rotationCycleDays);
  if (rotationCycleDays) {
    const rotationBase = normalizeDate(
      metadata.providerUpdatedAt ?? metadata.updatedAt ?? parameter.validFrom ?? metadata.validFrom,
    );
    if (rotationBase) {
      return {
        date: new Date(rotationBase.getTime() + rotationCycleDays * DAY_MS),
        field: 'rotationCycleDays',
      };
    }
  }

  return { date: null, field: null };
}

function buildStatusMessage({ status, daysUntilDue }) {
  if (status === 'missing') {
    return '必填参数缺失';
  }
  if (status === 'unknown') {
    return '缺少有效期或复核时间元数据';
  }
  if (status === 'expired') {
    return `已超过到期或复核日期 ${Math.abs(daysUntilDue ?? 0)} 天`;
  }
  if (status === 'warning') {
    return `距离到期或复核日期 ${daysUntilDue} 天`;
  }
  return daysUntilDue === null ? '正常' : `距离到期或复核日期 ${daysUntilDue} 天`;
}

function sanitizeDetails(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDetails(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEYS.test(key)) {
      continue;
    }
    sanitized[key] = sanitizeDetails(entry);
  }
  return sanitized;
}

function normalizeLookup(value) {
  if (value instanceof Map) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return new Map();
  }
  return new Map(Object.entries(value));
}

function normalizeText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizePositiveInteger(value) {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function escapeMarkdownCell(value) {
  return String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}
