import { GitHubActionMonitorError, reportGitHubActionRun } from './github-action-monitor.use-case.mjs';

export function createGitHubActionReportHttpHandler(options = {}) {
  const reportRun = options.reportRun ?? ((input) => reportGitHubActionRun({
    ...input,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    repository: options.repository,
    fetchImpl: options.fetchImpl,
    logger: options.logger,
    apiBaseUrl: options.apiBaseUrl,
    allowedBranches: options.allowedBranches,
    monitorEnvironment: options.monitorEnvironment,
  }));

  return async function handleGitHubActionReport(request) {
    if (request.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { ok: false, error: 'invalid_json' });
    }

    try {
      const runId = normalizeRunId(body?.run_id);
      const result = await reportRun({ runId });
      return jsonResponse(202, {
        ok: true,
        skipped: result.skipped || undefined,
        reason: result.reason || undefined,
        run_id: result.runId,
        branch: result.branch || undefined,
        allowed_branches: result.allowedBranches?.length ? result.allowedBranches : undefined,
        job_count: result.jobCount,
        step_count: result.stepCount,
        failure_count: result.failureCount,
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return jsonResponse(normalized.statusCode, {
        ok: false,
        error: normalized.code,
        message: normalized.message,
      });
    }
  };
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

function normalizeError(error) {
  if (error instanceof GitHubActionMonitorError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
    };
  }
  return {
    code: 'github_action_report_failed',
    message: 'GitHub action report failed',
    statusCode: 500,
  };
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(compactObject(payload), null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entryValue]) => entryValue !== undefined),
  );
}
