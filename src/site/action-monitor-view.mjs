const DEFAULT_HISTORY_PAGE_SIZE = 15;
const DEFAULT_PARAMETER_VALIDITY_PAGE_SIZE = 5;
const PARAMETER_VALIDITY_PAGINATION_THRESHOLD = 4;
const SUCCESS_CONCLUSIONS = new Set(['success']);
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);
const PARAMETER_STATUS_ORDER = new Map([
  ['expired', 1],
  ['missing', 2],
  ['warning', 3],
  ['unknown', 4],
  ['ok', 5],
]);

export function buildActionMonitorViewModel(rows = [], options = {}) {
  const now = normalizeDate(options.now) ?? new Date();
  const environment = normalizeText(options.environment) ?? 'dev';
  const limit = normalizePositiveInteger(options.limit);
  const historyPageSize = normalizePositiveInteger(options.historyPageSize) ?? DEFAULT_HISTORY_PAGE_SIZE;
  const normalizedRuns = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeRun(row, { now }))
    .filter(Boolean);
  const actionRuns = limit ? normalizedRuns.slice(0, limit) : normalizedRuns;
  const visibleRuns = actionRuns.slice(0, historyPageSize);

  return {
    title: 'action 监控',
    environment,
    generatedAt: now.toISOString(),
    updatedTime: formatUpdatedTime(now),
    summaryCards: buildSummaryCards(actionRuns),
    recentWindowLabel: '全部 Action 日志',
    historyTitle: 'Action 日志',
    historyPageSize,
    historyTotal: actionRuns.length,
    historyStatus: formatHistoryRange(0, historyPageSize, actionRuns.length),
    recentRuns: visibleRuns,
    historyRuns: actionRuns,
    runs: visibleRuns,
    allRuns: actionRuns,
    parameterValidity: buildParameterValidityViewModel(options.parameterValidityRows, {
      environment,
      now,
    }),
  };
}

export function buildParameterValidityViewModel(rows = [], options = {}) {
  const now = normalizeDate(options.now) ?? new Date();
  const environment = normalizeText(options.environment) ?? 'dev';
  const pageSize = normalizePositiveInteger(options.pageSize) ?? DEFAULT_PARAMETER_VALIDITY_PAGE_SIZE;
  const items = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeParameterValidityItem(row, { now }))
    .filter(Boolean)
    .filter((item) => isParameterValidityItemForEnvironment(item, environment))
    .sort(compareParameterValidityItems);
  const counts = countParameterStatuses(items);
  const visibleItems = items.slice(0, pageSize);

  return {
    title: '系统参数有效期',
    environment,
    pageSize,
    total: items.length,
    status: formatParameterValidityRange(0, pageSize, items.length),
    paginationEnabled: items.length > PARAMETER_VALIDITY_PAGINATION_THRESHOLD,
    summaryCards: [
      {
        label: '监控参数',
        value: `${counts.total} 个`,
        hint: `${environment} 环境`,
      },
      {
        label: '已过期',
        value: `${counts.expired} 个`,
        hint: counts.expired ? '需要立即处理' : '当前无过期参数',
      },
      {
        label: '配置缺失',
        value: `${counts.missing} 个`,
        hint: counts.missing ? '需要补齐配置' : '当前无缺失参数',
      },
      {
        label: '即将到期',
        value: `${counts.warning} 个`,
        hint: counts.warning ? '进入预警窗口' : '当前无预警参数',
      },
      {
        label: '未知有效期',
        value: `${counts.unknown} 个`,
        hint: counts.unknown ? '需要补齐元数据' : '元数据完整',
      },
    ],
    items,
    visibleItems,
    emptyMessage: `暂无 ${environment} 参数有效期数据`,
  };
}

function normalizeRun(row, { now }) {
  const runId = normalizePositiveInteger(row.runId ?? row.run_id);
  if (!runId) {
    return null;
  }

  const conclusion = normalizeText(row.conclusion);
  const status = normalizeText(row.status) ?? 'unknown';
  const startTime = normalizeIso(row.startTime ?? row.start_time);
  const endTime = normalizeIso(row.endTime ?? row.end_time);
  const duration = normalizeNonNegativeInteger(row.duration);
  const title = firstLine(row.headCommitMessage ?? row.head_commit_message) ||
    normalizeText(row.workflowName ?? row.workflow_name) ||
    `Action Run #${runId}`;

  return {
    runId,
    workflowName: normalizeText(row.workflowName ?? row.workflow_name) ?? 'Unknown workflow',
    runNumber: normalizePositiveInteger(row.runNumber ?? row.run_number),
    branch: normalizeText(row.branch) ?? normalizeText(row.monitorEnvironment ?? row.monitor_environment) ?? '',
    title,
    commitSha: normalizeText(row.commitSha ?? row.commit_sha) ?? '',
    commitShortSha: shortenSha(row.commitShortSha ?? row.commit_short_sha ?? row.commitSha ?? row.commit_sha),
    actorLogin: normalizeText(row.actorLogin ?? row.actor_login) ?? '',
    status,
    conclusion,
    statusLabel: formatStatusLabel({ status, conclusion }),
    tone: resolveTone({ status, conclusion }),
    startTime,
    endTime,
    timeLabel: formatRelativeTime(startTime ?? endTime, now),
    duration,
    durationLabel: formatDuration(duration),
    htmlUrl: normalizeText(row.htmlUrl ?? row.html_url) ?? '',
    errorSummary: normalizeText(row.errorSummary ?? row.error_summary) ?? '',
    jobCount: normalizeNonNegativeInteger(row.jobCount ?? row.job_count) ?? 0,
    stepCount: normalizeNonNegativeInteger(row.stepCount ?? row.step_count) ?? 0,
    failureCount: normalizeNonNegativeInteger(row.failureCount ?? row.failure_count) ?? 0,
  };
}

function normalizeParameterValidityItem(row, { now }) {
  const key = normalizeText(row.parameterKey ?? row.parameter_key ?? row.key);
  const name = normalizeText(row.parameterName ?? row.parameter_name ?? row.name);
  if (!key || !name) {
    return null;
  }

  const environment = normalizeText(row.monitorEnvironment ?? row.monitor_environment ?? row.environment) ??
    inferParameterEnvironment(key);
  const status = normalizeParameterStatus(row.status);
  const daysUntilDue = normalizeInteger(row.daysUntilDue ?? row.days_until_due);
  const dueAt = normalizeIso(
    row.dueAt ??
    row.due_at ??
    row.expiresAt ??
    row.expires_at ??
    row.reviewAfterAt ??
    row.review_after_at ??
    row.details?.dueAt ??
    row.details?.due_at,
  );
  const checkedAt = normalizeIso(row.checkedAt ?? row.checked_at ?? row.lastCheckedAt ?? row.last_checked_at);

  return {
    key,
    environment,
    name,
    scope: normalizeText(row.scope) ?? 'unknown',
    category: normalizeText(row.category) ?? 'unknown',
    status,
    statusLabel: formatParameterStatusLabel(status),
    tone: formatParameterStatusTone(status),
    dueAt,
    dueDateLabel: formatDateLabel(dueAt),
    daysUntilDue,
    dueLabel: formatDueLabel(daysUntilDue),
    checkedAt,
    checkedAtLabel: formatDateLabel(checkedAt),
    lastCheckedLabel: formatRelativeTime(checkedAt, now),
    evidenceSource: normalizeText(row.evidenceSource ?? row.evidence_source) ?? 'registry',
    message: normalizeText(row.message) ?? '',
  };
}

function isParameterValidityItemForEnvironment(item, environment) {
  return !item.environment || item.environment === environment;
}

function inferParameterEnvironment(key) {
  const [prefix] = String(key ?? '').split('.');
  return prefix === 'dev' || prefix === 'main' ? prefix : null;
}

function compareParameterValidityItems(left, right) {
  const statusDiff = (PARAMETER_STATUS_ORDER.get(left.status) ?? 99) - (PARAMETER_STATUS_ORDER.get(right.status) ?? 99);
  if (statusDiff) {
    return statusDiff;
  }

  const leftDays = Number.isFinite(left.daysUntilDue) ? left.daysUntilDue : Number.POSITIVE_INFINITY;
  const rightDays = Number.isFinite(right.daysUntilDue) ? right.daysUntilDue : Number.POSITIVE_INFINITY;
  if (leftDays !== rightDays) {
    return leftDays - rightDays;
  }

  return left.name.localeCompare(right.name, 'zh-CN');
}

function countParameterStatuses(items) {
  const counts = {
    total: items.length,
    ok: 0,
    warning: 0,
    expired: 0,
    missing: 0,
    unknown: 0,
  };

  for (const item of items) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }

  return counts;
}

function buildSummaryCards(runs) {
  const total = runs.length;
  const completedRuns = runs.filter((run) => run.status === 'completed' || run.conclusion);
  const successCount = runs.filter((run) => SUCCESS_CONCLUSIONS.has(String(run.conclusion))).length;
  const failureCount = runs.filter((run) => FAILURE_CONCLUSIONS.has(String(run.conclusion))).length;
  const durations = runs.map((run) => run.duration).filter((value) => Number.isFinite(value));
  const averageDuration = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : null;
  const successRate = completedRuns.length
    ? Math.round((successCount / completedRuns.length) * 100)
    : 0;

  return [
    {
      label: '最近运行',
      value: `${total} 次`,
      hint: total ? `最近 ${total} 次 Action` : '暂无 Action 数据',
    },
    {
      label: '成功率',
      value: `${successRate}%`,
      hint: completedRuns.length ? `已完成 ${completedRuns.length} 次` : '暂无完成记录',
    },
    {
      label: '失败',
      value: `${failureCount} 次`,
      hint: failureCount ? '需要关注失败摘要' : '当前无失败记录',
    },
    {
      label: '平均耗时',
      value: formatDuration(averageDuration),
      hint: durations.length ? `统计 ${durations.length} 次完成 run` : '暂无耗时',
    },
  ];
}

function formatHistoryRange(pageIndex, pageSize, total) {
  if (!total) {
    return '0 / 共 0 次';
  }

  const start = pageIndex * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);
  return `${start}-${end} / 共 ${total} 次`;
}

function formatParameterValidityRange(pageIndex, pageSize, total) {
  if (!total) {
    return '0 / 共 0 个';
  }

  const start = pageIndex * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);
  return `${start}-${end} / 共 ${total} 个`;
}

function formatStatusLabel({ status, conclusion }) {
  const normalizedConclusion = normalizeText(conclusion);
  if (normalizedConclusion === 'success') {
    return '成功';
  }
  if (normalizedConclusion === 'failure') {
    return '失败';
  }
  if (normalizedConclusion === 'cancelled') {
    return '已取消';
  }
  if (normalizedConclusion === 'timed_out') {
    return '超时';
  }
  if (normalizedConclusion === 'skipped') {
    return '跳过';
  }
  if (normalizedConclusion === 'action_required' || normalizedConclusion === 'startup_failure') {
    return '需处理';
  }

  const normalizedStatus = normalizeText(status);
  if (normalizedStatus === 'in_progress') {
    return '运行中';
  }
  if (normalizedStatus === 'queued' || normalizedStatus === 'waiting') {
    return '排队';
  }
  return '未知';
}

function resolveTone({ status, conclusion }) {
  const normalizedConclusion = normalizeText(conclusion);
  if (SUCCESS_CONCLUSIONS.has(normalizedConclusion)) {
    return 'success';
  }
  if (FAILURE_CONCLUSIONS.has(normalizedConclusion)) {
    return 'failure';
  }
  const normalizedStatus = normalizeText(status);
  if (normalizedStatus === 'in_progress' || normalizedStatus === 'queued' || normalizedStatus === 'waiting') {
    return 'running';
  }
  return 'neutral';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return '—';
  }
  const totalSeconds = Math.max(0, Math.round(seconds));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) {
    return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatParameterStatusLabel(status) {
  if (status === 'ok') {
    return '正常';
  }
  if (status === 'warning') {
    return '即将到期';
  }
  if (status === 'expired') {
    return '已过期';
  }
  if (status === 'missing') {
    return '配置缺失';
  }
  return '未知有效期';
}

function formatParameterStatusTone(status) {
  if (status === 'ok') {
    return 'success';
  }
  if (status === 'warning') {
    return 'warning';
  }
  if (status === 'expired' || status === 'missing') {
    return 'failure';
  }
  return 'neutral';
}

function formatDueLabel(daysUntilDue) {
  if (!Number.isFinite(daysUntilDue)) {
    return '无到期数据';
  }
  if (daysUntilDue < 0) {
    return `逾期 ${Math.abs(daysUntilDue)} 天`;
  }
  if (daysUntilDue === 0) {
    return '今天到期';
  }
  return `剩余 ${daysUntilDue} 天`;
}

function formatDateLabel(value) {
  const date = normalizeDate(value);
  return date ? date.toISOString().slice(0, 10) : '—';
}

function formatRelativeTime(value, now) {
  const date = normalizeDate(value);
  if (!date) {
    return '—';
  }
  const diffSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (diffSeconds < 60) {
    return `${Math.max(1, diffSeconds)} seconds ago`;
  }
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function formatUpdatedTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

function firstLine(value) {
  return normalizeText(String(value ?? '').split(/\r?\n/u)[0]);
}

function shortenSha(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.slice(0, 7) : '';
}

function normalizeIso(value) {
  const date = normalizeDate(value);
  return date ? date.toISOString() : null;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizePositiveInteger(value) {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function normalizeNonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue) : null;
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) ? numberValue : null;
}

function normalizeParameterStatus(value) {
  const normalized = normalizeText(value);
  return PARAMETER_STATUS_ORDER.has(normalized) ? normalized : 'unknown';
}
