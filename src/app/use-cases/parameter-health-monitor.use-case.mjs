const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WARNING_DAYS = 30;
const DEFAULT_CRITICAL_DAYS = 7;

const HEALTH_STATUSES = new Set([
  'healthy',
  'present',
  'invalid',
  'missing',
  'not_configured',
  'unreachable',
  'unsupported',
  'unknown',
]);
const HEALTH_CHECK_TYPES = new Set([
  'postgres_connect',
  'openai_models',
  'telegram_get_me',
  'feishu_tenant_token',
  'cos_head_bucket',
  'cloudflare_token_verify',
  'presence',
  'unsupported',
]);
const VALID_SCOPES = new Set([
  'github_actions_secret',
  'github_actions_variable',
  'cloudflare_worker_secret',
  'wrangler_var',
  'runtime_env',
  'config_file',
]);
const VALID_CATEGORIES = new Set([
  'database', 'ai', 'telegram', 'feishu', 'cos', 'cloudflare', 'github', 'monitor', 'site',
]);
const VALIDITY_MODES = new Set([
  'fixed_expires_at', 'rotation_cycle', 'review_after', 'non_expiring_manual_review', 'provider_metadata',
]);
const SENSITIVE_DETAIL_KEYS = /(^|_)(value|secret|token|password|api[_-]?key|db[_-]?url|connection[_-]?string|tenant[_-]?access)(_|$)/iu;

export function validateParameterHealthRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('parameter health registry must be an object');
  }
  if (!normalizeText(registry.environment)) {
    throw new Error('parameter health registry environment is required');
  }
  if (!Array.isArray(registry.probes)) {
    throw new Error('parameter health registry probes must be an array');
  }
  if (!Array.isArray(registry.parameters)) {
    throw new Error('parameter health registry parameters must be an array');
  }

  const probesByKey = new Map();
  for (const [index, probe] of registry.probes.entries()) {
    const key = normalizeText(probe?.key);
    if (!key) {
      throw new Error(`health probe ${index} key is required`);
    }
    if (probesByKey.has(key)) {
      throw new Error(`duplicate health probe key: ${key}`);
    }
    if (!HEALTH_CHECK_TYPES.has(probe?.type)) {
      throw new Error(`health probe ${key} has unsupported type: ${probe?.type}`);
    }
    if (probe.env !== undefined && (!probe.env || typeof probe.env !== 'object' || Array.isArray(probe.env))) {
      throw new Error(`health probe ${key} env must be an object`);
    }
    for (const [role, envName] of Object.entries(probe.env ?? {})) {
      if (!normalizeText(role) || !/^[A-Z][A-Z0-9_]*$/u.test(String(envName))) {
        throw new Error(`health probe ${key} has invalid env mapping`);
      }
    }
    probesByKey.set(key, probe);
  }

  const parameterKeys = new Set();
  for (const [index, parameter] of registry.parameters.entries()) {
    validateParameter(parameter, index);
    if (parameterKeys.has(parameter.key)) {
      throw new Error(`duplicate parameter key: ${parameter.key}`);
    }
    parameterKeys.add(parameter.key);
    if (!probesByKey.has(parameter.healthProbeKey)) {
      throw new Error(`parameter ${parameter.key} references unknown health probe: ${parameter.healthProbeKey}`);
    }
  }
  return registry;
}

export function runParameterHealthAudit(options = {}) {
  const registry = validateParameterHealthRegistry(options.registry);
  const environment = normalizeText(options.environment) ?? registry.environment;
  const now = normalizeDate(options.now) ?? new Date();
  const runId = normalizePositiveInteger(options.runId);
  const probeResultsByKey = normalizeLookup(options.probeResultsByKey);
  const probesByKey = new Map(registry.probes.map((probe) => [probe.key, probe]));

  const parameters = registry.parameters.map((parameter) => {
    const probe = probesByKey.get(parameter.healthProbeKey);
    return {
      key: parameter.key,
      environment,
      name: parameter.name,
      scope: parameter.scope,
      category: parameter.category,
      required: Boolean(parameter.required),
      sensitive: Boolean(parameter.sensitive),
      healthProbeKey: parameter.healthProbeKey,
      healthCheckType: probe.type,
      validityMode: parameter.validityMode,
      validFrom: normalizeIso(parameter.validFrom),
      expiresAt: normalizeIso(parameter.expiresAt),
      reviewAfterAt: normalizeIso(parameter.reviewAfterAt),
      rotationCycleDays: normalizePositiveInteger(parameter.rotationCycleDays),
      warningDays: normalizePositiveInteger(parameter.warningDays) ?? DEFAULT_WARNING_DAYS,
      criticalDays: normalizePositiveInteger(parameter.criticalDays) ?? DEFAULT_CRITICAL_DAYS,
      owner: normalizeText(parameter.owner),
      sourceDoc: parameter.sourceDoc,
      sourceCode: Array.isArray(parameter.sourceCode) ? parameter.sourceCode : [],
      metadata: sanitizeDetails(parameter.metadata ?? {}),
    };
  });

  const checks = parameters.map((parameter) => {
    const probe = probesByKey.get(parameter.healthProbeKey);
    const rawResult = probeResultsByKey.get(parameter.healthProbeKey);
    const probeResult = normalizeProbeResult(rawResult, probe, now);
    const status = probeResult.status === 'missing' && !parameter.required
      ? 'not_configured'
      : probeResult.status;
    const expiry = evaluateExpiry({
      now,
      warningDays: parameter.warningDays,
      registeredExpiresAt: parameter.expiresAt,
      observedExpiresAt: probeResult.observedExpiresAt,
    });

    return {
      parameterKey: parameter.key,
      environment,
      runId,
      checkedAt: probeResult.checkedAt,
      status,
      checkType: parameter.healthCheckType,
      latencyMs: probeResult.latencyMs,
      failureKind: probeResult.failureKind,
      observedExpiresAt: probeResult.observedExpiresAt,
      daysUntilDue: expiry.daysUntilDue,
      evidenceSource: probeResult.evidenceSource,
      message: status === 'not_configured' ? '可选参数未配置' : probeResult.message,
      details: sanitizeDetails({
        healthProbeKey: parameter.healthProbeKey,
        expiryStatus: expiry.status,
        dueKind: expiry.dueKind,
        dueAt: expiry.dueAt,
        provider: probeResult.details,
      }),
    };
  });

  return {
    environment,
    checkedAt: now.toISOString(),
    parameters,
    checks,
    summary: buildParameterHealthSummary(checks),
  };
}

export function buildParameterHealthSummary(checks = []) {
  const counts = {
    total: 0,
    healthy: 0,
    present: 0,
    invalid: 0,
    missing: 0,
    notConfigured: 0,
    unreachable: 0,
    unsupported: 0,
    unknown: 0,
  };
  const expiryCounts = { known: 0, warning: 0, expired: 0, unknown: 0 };

  for (const check of Array.isArray(checks) ? checks : []) {
    const status = HEALTH_STATUSES.has(check?.status) ? check.status : 'unknown';
    counts.total += 1;
    counts[toCountKey(status)] += 1;
    const expiryStatus = check?.details?.expiryStatus;
    if (expiryStatus === 'warning') {
      expiryCounts.known += 1;
      expiryCounts.warning += 1;
    } else if (expiryStatus === 'expired') {
      expiryCounts.known += 1;
      expiryCounts.expired += 1;
    } else if (expiryStatus === 'ok') {
      expiryCounts.known += 1;
    } else {
      expiryCounts.unknown += 1;
    }
  }

  return { counts, expiryCounts };
}

export function formatParameterHealthSummaryMarkdown(audit) {
  const counts = audit?.summary?.counts ?? buildParameterHealthSummary([]).counts;
  const expiry = audit?.summary?.expiryCounts ?? buildParameterHealthSummary([]).expiryCounts;
  const lines = [
    '## System Parameter Health',
    '',
    `- Environment: ${audit?.environment ?? 'unknown'}`,
    `- Checked at: ${audit?.checkedAt ?? 'unknown'}`,
    `- Healthy: ${counts.healthy}/${counts.total}`,
    `- Present only: ${counts.present}`,
    `- Invalid: ${counts.invalid}`,
    `- Missing: ${counts.missing}`,
    `- Not configured: ${counts.notConfigured}`,
    `- Unreachable: ${counts.unreachable}`,
    `- Unsupported: ${counts.unsupported}`,
    `- Unknown: ${counts.unknown}`,
    `- Verified expiry: ${expiry.known} (warning ${expiry.warning}, expired ${expiry.expired})`,
    '',
    '| Parameter | Health | Check | Evidence | Message |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const check of audit?.checks ?? []) {
    lines.push(`| ${check.parameterKey} | ${check.status} | ${check.checkType} | ${check.evidenceSource} | ${check.message} |`);
  }
  return `${lines.join('\n')}\n`;
}

function validateParameter(parameter, index) {
  const requiredText = ['key', 'name', 'scope', 'category', 'healthProbeKey', 'validityMode', 'sourceDoc'];
  for (const field of requiredText) {
    if (!normalizeText(parameter?.[field])) {
      throw new Error(`parameter ${index} field ${field} is required`);
    }
  }
  if (!VALID_SCOPES.has(parameter.scope)) {
    throw new Error(`parameter ${parameter.key} has unsupported scope: ${parameter.scope}`);
  }
  if (!VALID_CATEGORIES.has(parameter.category)) {
    throw new Error(`parameter ${parameter.key} has unsupported category: ${parameter.category}`);
  }
  if (!VALIDITY_MODES.has(parameter.validityMode)) {
    throw new Error(`parameter ${parameter.key} has unsupported validityMode: ${parameter.validityMode}`);
  }
  if (typeof parameter.required !== 'boolean' || typeof parameter.sensitive !== 'boolean') {
    throw new Error(`parameter ${parameter.key} required and sensitive must be boolean`);
  }
  if (Object.hasOwn(parameter, 'value')) {
    throw new Error(`parameter ${parameter.key} must not contain a value`);
  }
}

function normalizeProbeResult(result, probe, now) {
  if (!result) {
    if (probe.type === 'unsupported') {
      return {
        status: 'unsupported', checkedAt: now.toISOString(), checkType: probe.type, latencyMs: 0,
        failureKind: 'no_safe_probe', observedExpiresAt: null, evidenceSource: 'registry',
        message: '当前没有安全且可靠的自动探测方式', details: {},
      };
    }
    return {
      status: 'unknown', checkedAt: now.toISOString(), checkType: probe.type, latencyMs: 0,
      failureKind: 'probe_not_run', observedExpiresAt: null, evidenceSource: 'registry',
      message: '本次未执行健康探测', details: {},
    };
  }
  const status = HEALTH_STATUSES.has(result.status) ? result.status : 'unknown';
  return {
    status,
    checkedAt: normalizeIso(result.checkedAt) ?? now.toISOString(),
    checkType: probe.type,
    latencyMs: normalizeNonNegativeInteger(result.latencyMs) ?? 0,
    failureKind: normalizeText(result.failureKind),
    observedExpiresAt: normalizeIso(result.observedExpiresAt),
    evidenceSource: normalizeText(result.evidenceSource) ?? 'registry',
    message: normalizeText(result.message) ?? '健康状态未知',
    details: sanitizeDetails(result.details ?? {}),
  };
}

function evaluateExpiry({ now, warningDays, registeredExpiresAt, observedExpiresAt }) {
  const dueAt = normalizeDate(observedExpiresAt ?? registeredExpiresAt);
  if (!dueAt) {
    return { status: 'unknown', dueKind: 'unknown', dueAt: null, daysUntilDue: null };
  }
  const daysUntilDue = Math.ceil((dueAt.getTime() - now.getTime()) / DAY_MS);
  return {
    status: dueAt.getTime() < now.getTime() ? 'expired' : daysUntilDue <= warningDays ? 'warning' : 'ok',
    dueKind: observedExpiresAt ? 'provider_expiry' : 'registered_expiry',
    dueAt: dueAt.toISOString(),
    daysUntilDue,
  };
}

function toCountKey(status) {
  return status === 'not_configured' ? 'notConfigured' : status;
}

function normalizeLookup(value) {
  if (value instanceof Map) {
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return new Map();
  }
  return new Map(Object.entries(value));
}

function sanitizeDetails(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeDetails);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEYS.test(key)) {
      continue;
    }
    safe[key] = sanitizeDetails(entry);
  }
  return safe;
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeIso(value) {
  return normalizeDate(value)?.toISOString() ?? null;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
