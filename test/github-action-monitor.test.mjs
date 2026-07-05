import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createGitHubActionReportHttpHandler } from '../src/app/use-cases/github-action-report-http.mjs';
import { reportGitHubActionRun } from '../src/app/use-cases/github-action-monitor.use-case.mjs';
import { PostgresGitHubActionMonitorRepository } from '../src/adapters/postgres/github-action-monitor-repository.pg.mjs';

test('github action monitor fetches run jobs steps and stores failure summary idempotently', async () => {
  const calls = [];
  const snapshots = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/repos/soulgo/training_records/actions/runs/123456789')) {
      return jsonResponse({
        id: 123456789,
        name: 'Sync (Dev)',
        workflow_id: 98,
        path: '.github/workflows/sync-dev.yml',
        run_number: 42,
        run_attempt: 1,
        event: 'workflow_dispatch',
        head_branch: 'dev',
        head_sha: 'abc123',
        head_commit: { message: 'chore: sync dev' },
        actor: { login: 'github-actions[bot]' },
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-07-05T10:00:00Z',
        run_started_at: '2026-07-05T10:00:10Z',
        updated_at: '2026-07-05T10:03:10Z',
        html_url: 'https://github.com/soulgo/training_records/actions/runs/123456789',
      });
    }
    if (String(url).includes('/repos/soulgo/training_records/actions/runs/123456789/jobs')) {
      return jsonResponse({
        total_count: 1,
        jobs: [
          {
            id: 777,
            run_id: 123456789,
            name: 'sync',
            status: 'completed',
            conclusion: 'failure',
            started_at: '2026-07-05T10:00:30Z',
            completed_at: '2026-07-05T10:03:00Z',
            html_url: 'https://github.com/soulgo/training_records/actions/runs/123456789/job/777',
            runner_name: 'GitHub Actions 1',
            runner_group_name: 'GitHub Actions',
            labels: ['ubuntu-latest'],
            steps: [
              {
                name: 'Checkout',
                number: 1,
                status: 'completed',
                conclusion: 'success',
                started_at: '2026-07-05T10:00:30Z',
                completed_at: '2026-07-05T10:00:35Z',
              },
              {
                name: 'Run tests',
                number: 2,
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-07-05T10:01:00Z',
                completed_at: '2026-07-05T10:02:30Z',
              },
            ],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await reportGitHubActionRun({
    runId: '123456789',
    owner: 'soulgo',
    repo: 'training_records',
    token: 'github-token',
    monitorEnvironment: 'dev',
    fetchImpl,
    logger: { log: (message) => logs.push(String(message)) },
    repository: {
      async upsertActionRunSnapshot(snapshot) {
        snapshots.push(snapshot);
        return { runInserted: false };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.runId, 123456789);
  assert.equal(result.jobCount, 1);
  assert.equal(result.stepCount, 2);
  assert.equal(result.failureCount, 2);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].run.workflowName, 'Sync (Dev)');
  assert.equal(snapshots[0].run.monitorEnvironment, 'dev');
  assert.equal(snapshots[0].run.branch, 'dev');
  assert.equal(snapshots[0].run.duration, 180);
  assert.equal(snapshots[0].run.errorSummary, 'sync / Run tests: failure');
  assert.equal(snapshots[0].jobs[0].duration, 150);
  assert.equal(snapshots[0].steps[1].duration, 90);
  assert.deepEqual(
    snapshots[0].failures.map((failure) => failure.failureKey),
    ['github-action:123456789:job:777', 'github-action:123456789:job:777:step:2'],
  );
  assert.match(calls[0].init.headers.authorization, /^Bearer /);
  assert.ok(logs.some((line) => line.includes('github_action_report.received')));
  assert.ok(logs.some((line) => line.includes('github_action_report.db_written')));
});

test('github action monitor skips runs outside the configured branch scope before writing database rows', async () => {
  const calls = [];
  let writeCount = 0;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/repos/soulgo/training_records/actions/runs/123456789')) {
      return jsonResponse({
        id: 123456789,
        name: 'Sync (Dev)',
        workflow_id: 98,
        path: '.github/workflows/sync-dev.yml',
        event: 'workflow_dispatch',
        head_branch: 'dev',
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-05T10:00:00Z',
        run_started_at: '2026-07-05T10:00:10Z',
        updated_at: '2026-07-05T10:03:10Z',
        html_url: 'https://github.com/soulgo/training_records/actions/runs/123456789',
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await reportGitHubActionRun({
    runId: 123456789,
    owner: 'soulgo',
    repo: 'training_records',
    token: 'github-token',
    allowedBranches: ['main'],
    fetchImpl,
    repository: {
      async upsertActionRunSnapshot() {
        writeCount += 1;
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'branch_not_allowed');
  assert.equal(result.branch, 'dev');
  assert.equal(writeCount, 0);
  assert.equal(calls.length, 1);
});

test('github action report HTTP handler validates POST body and delegates run_id', async () => {
  const reported = [];
  const handler = createGitHubActionReportHttpHandler({
    reportRun: async ({ runId }) => {
      reported.push(runId);
      return { ok: true, runId, jobCount: 1, stepCount: 2, failureCount: 0 };
    },
  });

  const response = await handler(new Request('https://example.com/api/github/actions/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: 123456789 }),
  }));

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    run_id: 123456789,
    job_count: 1,
    step_count: 2,
    failure_count: 0,
  });
  assert.deepEqual(reported, [123456789]);

  const invalid = await handler(new Request('https://example.com/api/github/actions/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: 'abc' }),
  }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_run_id');

  const methodNotAllowed = await handler(new Request('https://example.com/api/github/actions/report'));
  assert.equal(methodNotAllowed.status, 405);
});

test('github action report HTTP handler returns skipped branch results without treating them as failures', async () => {
  const handler = createGitHubActionReportHttpHandler({
    reportRun: async ({ runId }) => ({
      ok: true,
      skipped: true,
      reason: 'branch_not_allowed',
      runId,
      branch: 'main',
      allowedBranches: ['dev'],
      jobCount: 0,
      stepCount: 0,
      failureCount: 0,
    }),
  });

  const response = await handler(new Request('https://example.com/api/github/actions/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: 123456789 }),
  }));

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    skipped: true,
    reason: 'branch_not_allowed',
    run_id: 123456789,
    branch: 'main',
    allowed_branches: ['dev'],
    job_count: 0,
    step_count: 0,
    failure_count: 0,
  });
});

test('postgres github action monitor repository upserts run snapshot in one transaction', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
  const repository = new PostgresGitHubActionMonitorRepository(client);

  await repository.upsertActionRunSnapshot({
    run: {
      runId: 123456789,
      repositoryFullName: 'soulgo/training_records',
      monitorEnvironment: 'dev',
      workflowId: 98,
      workflowName: 'Sync (Dev)',
      workflowPath: '.github/workflows/sync-dev.yml',
      runNumber: 42,
      runAttempt: 1,
      event: 'workflow_dispatch',
      branch: 'dev',
      commitSha: 'abc123',
      headCommitMessage: 'chore: sync dev',
      actorLogin: 'github-actions[bot]',
      status: 'completed',
      conclusion: 'failure',
      startTime: '2026-07-05T10:00:10.000Z',
      endTime: '2026-07-05T10:03:10.000Z',
      duration: 180,
      htmlUrl: 'https://github.com/soulgo/training_records/actions/runs/123456789',
      errorSummary: 'sync / Run tests: failure',
      rawPayload: { id: 123456789 },
    },
    jobs: [{
      jobId: 777,
      runId: 123456789,
      jobName: 'sync',
      status: 'completed',
      conclusion: 'failure',
      duration: 150,
      rawPayload: { id: 777 },
    }],
    steps: [{
      jobId: 777,
      runId: 123456789,
      stepNumber: 2,
      stepName: 'Run tests',
      status: 'completed',
      conclusion: 'failure',
      duration: 90,
      rawPayload: { number: 2 },
    }],
    failures: [{
      failureKey: 'github-action:123456789:job:777:step:2',
      runId: 123456789,
      jobId: 777,
      stepNumber: 2,
      failureLevel: 'step',
      workflowName: 'Sync (Dev)',
      jobName: 'sync',
      stepName: 'Run tests',
      conclusion: 'failure',
      errorSummary: 'sync / Run tests: failure',
      context: { htmlUrl: 'https://github.com/soulgo/training_records/actions/runs/123456789' },
    }],
  });

  assert.equal(queries[0].sql, 'begin');
  assert.equal(queries.at(-1).sql, 'commit');
  assert.ok(queries.some((query) => /insert into monitor\.github_action_runs/i.test(query.sql)));
  assert.ok(queries.some((query) => /insert into monitor\.github_action_jobs/i.test(query.sql)));
  assert.ok(queries.some((query) => /insert into monitor\.github_action_steps/i.test(query.sql)));
  assert.ok(queries.some((query) => /delete from monitor\.github_action_failures/i.test(query.sql)));
  assert.ok(queries.some((query) => /insert into monitor\.github_action_failures/i.test(query.sql)));
});

test('github action monitor SQL documents dev and main environment separation', async () => {
  const sql = await readFile(new URL('../docs/03_历史重构记录/后续规划_未实现/action 日志监控/03_github_action_monitor.sql', import.meta.url), 'utf8');

  assert.match(sql, /monitor_environment text NOT NULL/);
  assert.match(sql, /COMMENT ON COLUMN monitor\.github_action_runs\.monitor_environment IS '监控环境：dev 或 main'/);
  assert.match(sql, /GITHUB_ACTION_MONITOR_ENVIRONMENT=dev/);
  assert.match(sql, /GITHUB_ACTION_MONITOR_ALLOWED_BRANCH=dev/);
  assert.match(sql, /GITHUB_ACTION_MONITOR_ENVIRONMENT=main/);
  assert.match(sql, /GITHUB_ACTION_MONITOR_ALLOWED_BRANCH=main/);
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
