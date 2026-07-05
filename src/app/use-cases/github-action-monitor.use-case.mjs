const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

export class GitHubActionMonitorError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'GitHubActionMonitorError';
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.cause = options.cause;
  }
}

export async function reportGitHubActionRun(options = {}) {
  const runId = normalizeRunId(options.runId);
  const owner = normalizeRequiredText(options.owner, 'owner');
  const repo = normalizeRequiredText(options.repo, 'repo');
  const token = normalizeRequiredText(options.token, 'token');
  const fetchImpl = options.fetchImpl ?? fetch;
  const repository = options.repository;
  if (!repository?.upsertActionRunSnapshot) {
    throw new GitHubActionMonitorError('missing_repository', 'GitHub action monitor repository is required');
  }

  const logger = options.logger ?? console;
  const apiBaseUrl = String(options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/u, '');
  const repositoryFullName = `${owner}/${repo}`;
  const allowedBranches = normalizeAllowedBranches(options.allowedBranches);
  const monitorEnvironment = normalizeMonitorEnvironment(options.monitorEnvironment, allowedBranches);
  logInfo(logger, 'github_action_report.received', { runId, repositoryFullName });

  const run = await getGitHubJson({
    url: `${apiBaseUrl}/repos/${owner}/${repo}/actions/runs/${runId}`,
    token,
    fetchImpl,
    logger,
    event: 'github_action_report.fetch_run',
    runId,
  });
  const runBranch = normalizeText(run.head_branch);
  if (!isAllowedBranch(runBranch, allowedBranches)) {
    logInfo(logger, 'github_action_report.skipped', {
      runId,
      repositoryFullName,
      branch: runBranch,
      reason: 'branch_not_allowed',
    });
    return {
      ok: true,
      skipped: true,
      reason: 'branch_not_allowed',
      runId,
      branch: runBranch,
      allowedBranches,
      jobCount: 0,
      stepCount: 0,
      failureCount: 0,
      conclusion: normalizeText(run.conclusion),
    };
  }
  const jobs = await listGitHubJobs({
    apiBaseUrl,
    owner,
    repo,
    runId,
    token,
    fetchImpl,
    logger,
  });
  const snapshot = buildActionRunSnapshot({ run, jobs, repositoryFullName, monitorEnvironment });

  await repository.upsertActionRunSnapshot(snapshot);
  logInfo(logger, 'github_action_report.db_written', {
    runId,
    repositoryFullName,
    jobCount: snapshot.jobs.length,
    stepCount: snapshot.steps.length,
    failureCount: snapshot.failures.length,
  });

  return {
    ok: true,
    runId,
    jobCount: snapshot.jobs.length,
    stepCount: snapshot.steps.length,
    failureCount: snapshot.failures.length,
    conclusion: snapshot.run.conclusion,
  };
}

export function buildActionRunSnapshot({ run, jobs, repositoryFullName, monitorEnvironment }) {
  const normalizedRun = normalizeRun(run, repositoryFullName, monitorEnvironment);
  const normalizedJobs = [];
  const normalizedSteps = [];
  const failures = [];

  for (const job of jobs ?? []) {
    const normalizedJob = normalizeJob(job, normalizedRun.runId);
    normalizedJobs.push(normalizedJob);
    if (isFailureConclusion(normalizedJob.conclusion)) {
      failures.push({
        failureKey: `github-action:${normalizedRun.runId}:job:${normalizedJob.jobId}`,
        runId: normalizedRun.runId,
        jobId: normalizedJob.jobId,
        stepNumber: null,
        failureLevel: 'job',
        monitorEnvironment: normalizedRun.monitorEnvironment,
        workflowName: normalizedRun.workflowName,
        jobName: normalizedJob.jobName,
        stepName: null,
        conclusion: normalizedJob.conclusion,
        errorSummary: `${normalizedJob.jobName}: ${normalizedJob.conclusion}`,
        context: { htmlUrl: normalizedJob.htmlUrl },
      });
    }

    for (const step of job.steps ?? []) {
      const normalizedStep = normalizeStep(step, normalizedRun.runId, normalizedJob.jobId);
      normalizedSteps.push(normalizedStep);
      if (isFailureConclusion(normalizedStep.conclusion)) {
        failures.push({
          failureKey: `github-action:${normalizedRun.runId}:job:${normalizedJob.jobId}:step:${normalizedStep.stepNumber}`,
          runId: normalizedRun.runId,
          jobId: normalizedJob.jobId,
          stepNumber: normalizedStep.stepNumber,
          failureLevel: 'step',
          monitorEnvironment: normalizedRun.monitorEnvironment,
          workflowName: normalizedRun.workflowName,
          jobName: normalizedJob.jobName,
          stepName: normalizedStep.stepName,
          conclusion: normalizedStep.conclusion,
          errorSummary: `${normalizedJob.jobName} / ${normalizedStep.stepName}: ${normalizedStep.conclusion}`,
          context: { htmlUrl: normalizedJob.htmlUrl },
        });
      }
    }
  }

  if (isFailureConclusion(normalizedRun.conclusion) && failures.length === 0) {
    failures.push({
      failureKey: `github-action:${normalizedRun.runId}:run`,
      runId: normalizedRun.runId,
      jobId: null,
      stepNumber: null,
      failureLevel: 'run',
      monitorEnvironment: normalizedRun.monitorEnvironment,
      workflowName: normalizedRun.workflowName,
      jobName: null,
      stepName: null,
      conclusion: normalizedRun.conclusion,
      errorSummary: `${normalizedRun.workflowName}: ${normalizedRun.conclusion}`,
      context: { htmlUrl: normalizedRun.htmlUrl },
    });
  }

  normalizedRun.errorSummary = buildErrorSummary(failures);

  return {
    run: normalizedRun,
    jobs: normalizedJobs,
    steps: normalizedSteps,
    failures,
  };
}

async function listGitHubJobs({ apiBaseUrl, owner, repo, runId, token, fetchImpl, logger }) {
  const jobs = [];
  let page = 1;
  while (page <= 20) {
    const payload = await getGitHubJson({
      url: `${apiBaseUrl}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      token,
      fetchImpl,
      logger,
      event: 'github_action_report.fetch_jobs',
      runId,
      page,
    });
    jobs.push(...(Array.isArray(payload.jobs) ? payload.jobs : []));
    if (!Array.isArray(payload.jobs) || payload.jobs.length < 100) {
      break;
    }
    page += 1;
  }
  return jobs;
}

async function getGitHubJson({ url, token, fetchImpl, logger, event, runId, page }) {
  logInfo(logger, event, { runId, page, url: redactQuery(url) });
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  } catch (error) {
    throw new GitHubActionMonitorError('github_api_network_error', 'GitHub API request failed', {
      statusCode: 502,
      cause: error,
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new GitHubActionMonitorError('github_api_auth_failed', `GitHub API returned HTTP ${response.status}`, {
      statusCode: 502,
    });
  }
  if (response.status === 404) {
    throw new GitHubActionMonitorError('github_run_not_found', `GitHub Action run ${runId} was not found`, {
      statusCode: 404,
    });
  }
  if (!response.ok) {
    throw new GitHubActionMonitorError('github_api_failed', `GitHub API returned HTTP ${response.status}`, {
      statusCode: 502,
    });
  }
  return response.json();
}

function normalizeRun(run, repositoryFullName, monitorEnvironment) {
  const runId = normalizeRunId(run?.id);
  const startTime = parseIsoTime(run.run_started_at ?? run.created_at);
  const endTime = run.status === 'completed' ? parseIsoTime(run.updated_at) : null;
  return {
    runId,
    repositoryFullName,
    monitorEnvironment,
    workflowId: normalizeNullableInteger(run.workflow_id),
    workflowName: normalizeText(run.name) ?? normalizeText(run.workflow_name) ?? 'Unknown workflow',
    workflowPath: normalizeText(run.path),
    runNumber: normalizeNullableInteger(run.run_number),
    runAttempt: normalizeNullableInteger(run.run_attempt),
    event: normalizeText(run.event),
    branch: normalizeText(run.head_branch),
    commitSha: normalizeText(run.head_sha),
    headCommitMessage: normalizeText(run.head_commit?.message),
    actorLogin: normalizeText(run.actor?.login),
    status: normalizeText(run.status) ?? 'unknown',
    conclusion: normalizeText(run.conclusion),
    startTime,
    endTime,
    duration: calculateDurationSeconds(startTime, endTime),
    htmlUrl: normalizeText(run.html_url),
    errorSummary: '',
    rawPayload: run,
  };
}

function normalizeJob(job, runId) {
  const startTime = parseIsoTime(job.started_at);
  const endTime = parseIsoTime(job.completed_at);
  return {
    jobId: normalizeRunId(job.id),
    runId,
    jobName: normalizeText(job.name) ?? 'Unknown job',
    status: normalizeText(job.status) ?? 'unknown',
    conclusion: normalizeText(job.conclusion),
    startTime,
    endTime,
    duration: calculateDurationSeconds(startTime, endTime),
    htmlUrl: normalizeText(job.html_url),
    runnerName: normalizeText(job.runner_name),
    runnerGroupName: normalizeText(job.runner_group_name),
    labels: Array.isArray(job.labels) ? job.labels.map(String) : [],
    rawPayload: job,
  };
}

function normalizeStep(step, runId, jobId) {
  const startTime = parseIsoTime(step.started_at);
  const endTime = parseIsoTime(step.completed_at);
  return {
    jobId,
    runId,
    stepNumber: normalizeNullableInteger(step.number) ?? 0,
    stepName: normalizeText(step.name) ?? 'Unknown step',
    status: normalizeText(step.status) ?? 'unknown',
    conclusion: normalizeText(step.conclusion),
    startTime,
    endTime,
    duration: calculateDurationSeconds(startTime, endTime),
    rawPayload: step,
  };
}

function buildErrorSummary(failures) {
  const stepFailures = failures.filter((failure) => failure.failureLevel === 'step');
  const source = stepFailures.length > 0 ? stepFailures : failures;
  const text = source.slice(0, 3).map((failure) => failure.errorSummary).join('; ');
  return text.length > 800 ? `${text.slice(0, 797)}...` : text;
}

function calculateDurationSeconds(startTime, endTime) {
  if (!startTime || !endTime) {
    return null;
  }
  const duration = Math.round((Date.parse(endTime) - Date.parse(startTime)) / 1000);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function parseIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeRunId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new GitHubActionMonitorError('invalid_run_id', 'run_id must be a positive integer', { statusCode: 400 });
  }
  const numberValue = Number(normalized);
  if (!Number.isSafeInteger(numberValue)) {
    throw new GitHubActionMonitorError('invalid_run_id', 'run_id is outside the safe integer range', { statusCode: 400 });
  }
  return numberValue;
}

function normalizeRequiredText(value, name) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new GitHubActionMonitorError(`missing_${name}`, `${name} is required`, { statusCode: 500 });
  }
  return normalized;
}

function normalizeAllowedBranches(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(values.map((item) => normalizeText(item)).filter(Boolean))];
}

function normalizeMonitorEnvironment(value, allowedBranches) {
  const normalized = normalizeText(value);
  if (normalized) {
    return normalized;
  }
  if (allowedBranches.length === 1 && ['dev', 'main'].includes(allowedBranches[0])) {
    return allowedBranches[0];
  }
  return 'unspecified';
}

function isAllowedBranch(branch, allowedBranches) {
  if (allowedBranches.length === 0) {
    return true;
  }
  return branch ? allowedBranches.includes(branch) : false;
}

function normalizeText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) ? numberValue : null;
}

function isFailureConclusion(value) {
  return FAILURE_CONCLUSIONS.has(String(value ?? '').trim().toLowerCase());
}

function logInfo(logger, event, fields = {}) {
  const payload = JSON.stringify({ level: 'INFO', event, ...compactObject(fields) });
  if (typeof logger?.log === 'function') {
    logger.log(`[github-action-monitor] ${payload}`);
  }
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== ''),
  );
}

function redactQuery(url) {
  return String(url).replace(/\?.*$/u, '');
}
