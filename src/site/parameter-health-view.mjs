const DEFAULT_PAGE_SIZE = 5;
const PAGINATION_THRESHOLD = 4;
const STATUS_ORDER = new Map([
  ['invalid', 1],
  ['missing', 2],
  ['unreachable', 3],
  ['unknown', 4],
  ['unsupported', 5],
  ['present', 6],
  ['not_configured', 7],
  ['healthy', 8],
]);

export function buildParameterHealthViewModel(rows = [], options = {}) {
  const now = normalizeDate(options.now) ?? new Date();
  const environment = normalizeText(options.environment) ?? 'dev';
  const pageSize = normalizePositiveInteger(options.pageSize) ?? DEFAULT_PAGE_SIZE;
  const items = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeItem(row, { now }))
    .filter(Boolean)
    .filter((item) => !item.environment || item.environment === environment)
    .sort(compareItems);
  const counts = countStatuses(items);

  return {
    title: '系统参数健康',
    environment,
    pageSize,
    total: items.length,
    status: formatRange(0, pageSize, items.length),
    paginationEnabled: items.length > PAGINATION_THRESHOLD,
    summaryCards: [
      { label: '监控参数', value: `${counts.total} 个`, hint: `${environment} 环境` },
      { label: '健康', value: `${counts.healthy} 个`, hint: counts.healthy ? '真实探测通过' : '暂无真实健康证据' },
      { label: '凭证无效', value: `${counts.invalid} 个`, hint: counts.invalid ? '需要立即轮换' : '当前无鉴权失败' },
      { label: '配置缺失', value: `${counts.missing} 个`, hint: counts.missing ? '必填参数未注入' : '当前无必填缺失' },
      { label: '服务不可达', value: `${counts.unreachable} 个`, hint: counts.unreachable ? '需区分网络与 Provider 故障' : '当前无不可达项' },
      { label: '仅存在性', value: `${counts.present} 个`, hint: counts.present ? '未执行外部鉴权' : '无仅存在性检查' },
      {
        label: '未主动验证',
        value: `${counts.unknown + counts.unsupported} 个`,
        hint: counts.unknown + counts.unsupported ? '不代表参数有效' : '所有已配置参数均有证据',
      },
    ],
    items,
    visibleItems: items.slice(0, pageSize),
    emptyMessage: `暂无 ${environment} 参数健康数据`,
  };
}

function normalizeItem(row, { now }) {
  const key = normalizeText(row.parameterKey ?? row.parameter_key ?? row.key);
  const name = normalizeText(row.parameterName ?? row.parameter_name ?? row.name);
  if (!key || !name) {
    return null;
  }
  const status = normalizeStatus(row.status);
  const checkedAt = normalizeIso(row.checkedAt ?? row.checked_at);
  const lastHealthyAt = normalizeIso(row.lastHealthyAt ?? row.last_healthy_at);
  const evidenceSource = normalizeText(row.evidenceSource ?? row.evidence_source) ?? 'registry';
  const observedExpiresAt = normalizeIso(row.observedExpiresAt ?? row.observed_expires_at);
  const dueAt = normalizeIso(row.details?.dueAt ?? row.details?.due_at ?? observedExpiresAt ?? row.expiresAt ?? row.expires_at);
  const dueKind = normalizeText(row.details?.dueKind ?? row.details?.due_kind) ?? (observedExpiresAt ? 'provider_expiry' : dueAt ? 'registered_expiry' : 'unknown');
  const daysUntilDue = normalizeInteger(row.daysUntilDue ?? row.days_until_due);
  const latencyMs = normalizeNonNegativeInteger(row.latencyMs ?? row.latency_ms);

  return {
    key,
    environment: normalizeText(row.monitorEnvironment ?? row.monitor_environment ?? row.environment) ?? inferEnvironment(key),
    name,
    scope: normalizeText(row.scope) ?? 'unknown',
    category: normalizeText(row.category) ?? 'unknown',
    status,
    statusLabel: formatStatusLabel(status),
    tone: formatTone(status),
    checkType: normalizeText(row.checkType ?? row.check_type ?? row.healthCheckType ?? row.health_check_type) ?? 'unknown',
    checkTypeLabel: formatCheckType(row.checkType ?? row.check_type ?? row.healthCheckType ?? row.health_check_type),
    latencyMs,
    latencyLabel: latencyMs === null ? '—' : `${latencyMs} ms`,
    failureKind: normalizeText(row.failureKind ?? row.failure_kind),
    checkedAt,
    checkedAtLabel: formatDateTime(checkedAt),
    lastCheckedLabel: formatRelativeTime(checkedAt, now),
    lastHealthyAt,
    lastHealthyLabel: lastHealthyAt ? formatRelativeTime(lastHealthyAt, now) : '尚无成功记录',
    evidenceSource,
    evidenceLabel: formatEvidenceLabel(evidenceSource),
    observedExpiresAt,
    daysUntilDue,
    expiryStatus: normalizeText(row.details?.expiryStatus ?? row.details?.expiry_status) ?? 'unknown',
    expiryLabel: formatExpiryLabel({ dueAt, dueKind, daysUntilDue }),
    message: normalizeText(row.message) ?? '健康状态未知',
  };
}

function countStatuses(items) {
  const counts = {
    total: items.length,
    healthy: 0,
    present: 0,
    invalid: 0,
    missing: 0,
    notConfigured: 0,
    unreachable: 0,
    unsupported: 0,
    unknown: 0,
  };
  for (const item of items) {
    const key = item.status === 'not_configured' ? 'notConfigured' : item.status;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function compareItems(left, right) {
  const statusDiff = (STATUS_ORDER.get(left.status) ?? 99) - (STATUS_ORDER.get(right.status) ?? 99);
  return statusDiff || left.name.localeCompare(right.name, 'zh-CN');
}

function normalizeStatus(value) {
  const status = normalizeText(value) ?? 'unknown';
  return STATUS_ORDER.has(status) ? status : 'unknown';
}

function formatStatusLabel(status) {
  return {
    healthy: '健康',
    present: '仅确认已配置',
    invalid: '凭证无效',
    missing: '配置缺失',
    not_configured: '可选未配置',
    unreachable: '服务不可达',
    unsupported: '不支持自动探测',
    unknown: '健康状态未知',
  }[status] ?? '健康状态未知';
}

function formatTone(status) {
  if (status === 'healthy') {
    return 'success';
  }
  if (status === 'invalid' || status === 'missing') {
    return 'failure';
  }
  if (status === 'unreachable') {
    return 'warning';
  }
  return 'neutral';
}

function formatCheckType(value) {
  return {
    postgres_connect: 'PostgreSQL 只读探测',
    openai_models: 'AI 模型列表鉴权',
    telegram_get_me: 'Telegram getMe',
    feishu_tenant_token: '飞书 tenant token',
    cos_head_bucket: 'COS HeadBucket',
    cloudflare_token_verify: 'Cloudflare Token Verify',
    presence: '运行时存在性',
    unsupported: '无安全探测方式',
  }[normalizeText(value)] ?? '未知探测方式';
}

function formatEvidenceLabel(source) {
  if (source.startsWith('active_probe:')) {
    return '真实 API 探测';
  }
  if (source === 'runtime_env_presence') {
    return '仅运行时存在性';
  }
  return '仅 registry 登记';
}

function formatExpiryLabel({ dueAt, dueKind, daysUntilDue }) {
  if (!dueAt) {
    return 'Provider 未提供到期时间';
  }
  const prefix = dueKind === 'provider_expiry' ? '真实到期' : '登记到期';
  const dayLabel = Number.isFinite(daysUntilDue)
    ? daysUntilDue < 0 ? `已过期 ${Math.abs(daysUntilDue)} 天` : `${daysUntilDue} 天`
    : '剩余天数未知';
  return `${prefix} ${dueAt.slice(0, 10)} · ${dayLabel}`;
}

function formatRange(pageIndex, pageSize, total) {
  if (!total) {
    return '0 / 共 0 个';
  }
  const start = pageIndex * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);
  return `${start}-${end} / 共 ${total} 个`;
}

function formatDateTime(value) {
  const date = normalizeDate(value);
  return date ? date.toISOString().replace('T', ' ').slice(0, 16) : '—';
}

function formatRelativeTime(value, now) {
  const date = normalizeDate(value);
  if (!date) {
    return '—';
  }
  const diffSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (diffSeconds < 60) {
    return `${Math.max(1, diffSeconds)} 秒前`;
  }
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  return `${Math.floor(hours / 24)} 天前`;
}

function inferEnvironment(key) {
  const prefix = String(key).split('.')[0];
  return prefix === 'dev' || prefix === 'main' ? prefix : null;
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

function normalizeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
