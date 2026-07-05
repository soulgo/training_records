const DEFAULT_LIMIT = 50;
const DEFAULT_HISTORY_PAGE_SIZE = 6;
const RECENT_WINDOW_DAYS = 2;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SUCCESS_CONCLUSIONS = new Set(['success']);
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

export function buildActionMonitorViewModel(rows = [], options = {}) {
  const now = normalizeDate(options.now) ?? new Date();
  const environment = normalizeText(options.environment) ?? 'dev';
  const limit = normalizePositiveInteger(options.limit) ?? DEFAULT_LIMIT;
  const recentWindowDays = normalizePositiveInteger(options.recentWindowDays) ?? RECENT_WINDOW_DAYS;
  const historyPageSize = normalizePositiveInteger(options.historyPageSize) ?? DEFAULT_HISTORY_PAGE_SIZE;
  const recentCutoffTime = now.getTime() - recentWindowDays * ONE_DAY_MS;
  const normalizedRuns = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeRun(row, { now }))
    .filter(Boolean)
    .slice(0, limit);
  const recentRuns = normalizedRuns.filter((run) => getRunTime(run)?.getTime() >= recentCutoffTime);
  const historyRuns = normalizedRuns.filter((run) => {
    const runTime = getRunTime(run);
    return !runTime || runTime.getTime() < recentCutoffTime;
  });

  return {
    title: 'Action 监控',
    environment,
    generatedAt: now.toISOString(),
    updatedTime: formatUpdatedTime(now),
    summaryCards: buildSummaryCards(normalizedRuns),
    recentWindowLabel: `最近 ${recentWindowDays} 天`,
    historyTitle: '更早 Action',
    historyPageSize,
    historyTotal: historyRuns.length,
    historyStatus: formatHistoryRange(0, historyPageSize, historyRuns.length),
    recentRuns,
    historyRuns,
    runs: recentRuns,
    allRuns: normalizedRuns,
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

function getRunTime(run) {
  return normalizeDate(run.startTime ?? run.endTime);
}

function formatHistoryRange(pageIndex, pageSize, total) {
  if (!total) {
    return '0 / 共 0 次';
  }

  const start = pageIndex * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);
  return `${start}-${end} / 共 ${total} 次`;
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
