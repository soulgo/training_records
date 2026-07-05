import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createGitHubActionReportHttpHandler } from '../src/app/use-cases/github-action-report-http.mjs';
import { reportGitHubActionRun } from '../src/app/use-cases/github-action-monitor.use-case.mjs';
import { PostgresGitHubActionMonitorRepository } from '../src/adapters/postgres/github-action-monitor-repository.pg.mjs';
import { buildActionMonitorViewModel } from '../src/site/action-monitor-view.mjs';

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

test('github action monitor finalizes an in-progress current run from the reporter job status', async () => {
  const snapshots = [];
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/repos/soulgo/training_records/actions/runs/123456789')) {
      return jsonResponse({
        id: 123456789,
        name: 'CI Tests',
        workflow_id: 98,
        path: '.github/workflows/ci-tests.yml',
        run_number: 327,
        run_attempt: 1,
        event: 'push',
        head_branch: 'dev',
        head_sha: '9d5faf7',
        head_commit: { message: 'fix: wire action monitor to branch database' },
        actor: { login: 'soulgo' },
        status: 'in_progress',
        conclusion: null,
        created_at: '2026-07-05T22:39:02Z',
        run_started_at: '2026-07-05T22:39:08Z',
        updated_at: '2026-07-05T22:39:20Z',
        html_url: 'https://github.com/soulgo/training_records/actions/runs/123456789',
      });
    }
    if (String(url).includes('/repos/soulgo/training_records/actions/runs/123456789/jobs')) {
      return jsonResponse({
        total_count: 1,
        jobs: [{
          id: 777,
          run_id: 123456789,
          name: 'test',
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-07-05T22:39:08Z',
          completed_at: null,
          html_url: 'https://github.com/soulgo/training_records/actions/runs/123456789/job/777',
          steps: [],
        }],
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
    currentRunConclusion: 'success',
    reportedAt: new Date('2026-07-05T22:39:26Z'),
    fetchImpl,
    repository: {
      async upsertActionRunSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
    },
  });

  assert.equal(result.conclusion, 'success');
  assert.equal(snapshots[0].run.status, 'completed');
  assert.equal(snapshots[0].run.conclusion, 'success');
  assert.equal(snapshots[0].run.endTime, '2026-07-05T22:39:26.000Z');
  assert.equal(snapshots[0].run.duration, 18);
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

test('postgres github action monitor repository retries snapshot writes without monitor environment column', async () => {
  const queries = [];
  let transactionAttempt = 0;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params, transactionAttempt });
      if (sql === 'begin') {
        transactionAttempt += 1;
      }
      if (transactionAttempt === 1 && /insert into monitor\.github_action_runs/i.test(sql)) {
        const error = new Error('column "monitor_environment" of relation "github_action_runs" does not exist');
        error.code = '42703';
        throw error;
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const repository = new PostgresGitHubActionMonitorRepository(client);

  await repository.upsertActionRunSnapshot({
    run: {
      runId: 123456789,
      repositoryFullName: 'soulgo/training_records',
      monitorEnvironment: 'dev',
      workflowName: 'CI Tests',
      branch: 'dev',
      status: 'completed',
      conclusion: 'success',
      rawPayload: { id: 123456789 },
    },
    failures: [{
      failureKey: 'github-action:123456789:run',
      runId: 123456789,
      failureLevel: 'run',
      monitorEnvironment: 'dev',
      workflowName: 'CI Tests',
      conclusion: 'failure',
      errorSummary: 'CI Tests: failure',
      context: { htmlUrl: 'https://github.com/soulgo/training_records/actions/runs/123456789' },
    }],
  });

  assert.deepEqual(
    queries.filter((query) => ['begin', 'rollback', 'commit'].includes(query.sql)).map((query) => query.sql),
    ['begin', 'rollback', 'begin', 'commit'],
  );
  const legacyQueries = queries.slice(queries.findLastIndex((query) => query.sql === 'begin') + 1);
  assert.ok(legacyQueries.some((query) => /insert into monitor\.github_action_runs/i.test(query.sql)));
  assert.ok(legacyQueries.some((query) => /insert into monitor\.github_action_failures/i.test(query.sql)));
  assert.ok(legacyQueries.every((query) => !/monitor_environment/i.test(query.sql)));
});

test('postgres github action monitor repository lists recent runs with job step and failure counts', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return {
        rows: [{
          run_id: '1003',
          workflow_name: 'Deploy Cloudflare Pages (Dev)',
          run_number: 280,
          branch: 'dev',
          conclusion: 'success',
          job_count: '1',
          step_count: '7',
          failure_count: '0',
        }],
      };
    },
  };
  const repository = new PostgresGitHubActionMonitorRepository(client);

  const rows = await repository.listRecentActionRuns({
    monitorEnvironment: 'dev',
    limit: 12,
  });

  assert.equal(rows[0].runId, 1003);
  assert.equal(rows[0].workflowName, 'Deploy Cloudflare Pages (Dev)');
  assert.equal(rows[0].jobCount, 1);
  assert.equal(rows[0].stepCount, 7);
  assert.equal(rows[0].failureCount, 0);
  assert.match(queries[0].sql, /from monitor\.github_action_runs/i);
  assert.match(queries[0].sql, /left join monitor\.github_action_jobs/i);
  assert.match(queries[0].sql, /left join monitor\.github_action_steps/i);
  assert.match(queries[0].sql, /left join monitor\.github_action_failures/i);
  assert.deepEqual(queries[0].params, ['dev', 12]);
});

test('postgres github action monitor repository falls back to branch scope when monitor environment column is missing', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (queries.length === 1) {
        const error = new Error('column r.monitor_environment does not exist');
        error.code = '42703';
        throw error;
      }
      return {
        rows: [{
          run_id: '1004',
          monitor_environment: params[0],
          workflow_name: 'Deploy Cloudflare Pages (Dev)',
          run_number: 281,
          branch: 'dev',
          conclusion: 'success',
          job_count: '1',
          step_count: '8',
          failure_count: '0',
        }],
      };
    },
  };
  const repository = new PostgresGitHubActionMonitorRepository(client);

  const rows = await repository.listRecentActionRuns({
    monitorEnvironment: 'dev',
    limit: 12,
  });

  assert.equal(rows[0].runId, 1004);
  assert.equal(rows[0].monitorEnvironment, 'dev');
  assert.equal(rows[0].branch, 'dev');
  assert.equal(rows[0].stepCount, 8);
  assert.match(queries[0].sql, /r\.monitor_environment/);
  assert.doesNotMatch(queries[1].sql, /r\.monitor_environment/);
  assert.match(queries[1].sql, /r\.branch = \$1/);
  assert.deepEqual(queries[1].params, ['dev', 12]);
});

test('action monitor view model formats recent dev runs for the standalone module', () => {
  const view = buildActionMonitorViewModel([
    {
      runId: 1003,
      monitorEnvironment: 'dev',
      workflowName: 'Deploy Cloudflare Pages (Dev)',
      runNumber: 280,
      branch: 'dev',
      commitSha: '18ba338e6ad31f2',
      headCommitMessage: 'chore: release 1.3.2 action monitor\n\nbody should stay out of card title',
      actorLogin: 'soulgo',
      status: 'completed',
      conclusion: 'success',
      startTime: '2026-07-05T06:24:18.000Z',
      endTime: '2026-07-05T06:30:00.000Z',
      duration: 342,
      htmlUrl: 'https://github.com/soulgo/training_records/actions/runs/1003',
      errorSummary: '',
      jobCount: 1,
      stepCount: 7,
      failureCount: 0,
    },
    {
      runId: 1002,
      monitorEnvironment: 'dev',
      workflowName: 'CI Tests',
      runNumber: 321,
      branch: 'dev',
      commitSha: '18ba338e6ad31f2',
      headCommitMessage: 'chore: release 1.3.2 action monitor',
      actorLogin: 'soulgo',
      status: 'completed',
      conclusion: 'failure',
      startTime: '2026-07-05T06:29:32.000Z',
      endTime: '2026-07-05T06:30:00.000Z',
      duration: 28,
      htmlUrl: 'https://github.com/soulgo/training_records/actions/runs/1002',
      errorSummary: 'test / Run tests: failure',
      jobCount: 1,
      stepCount: 7,
      failureCount: 1,
    },
  ], {
    now: new Date('2026-07-05T06:30:30.000Z'),
    environment: 'dev',
  });

  assert.equal(view.title, 'action 监控');
  assert.equal(view.environment, 'dev');
  assert.equal(view.runs.length, 2);
  assert.equal(view.runs[0].title, 'chore: release 1.3.2 action monitor');
  assert.equal(view.runs[0].commitShortSha, '18ba338');
  assert.equal(view.runs[0].statusLabel, '成功');
  assert.equal(view.runs[0].tone, 'success');
  assert.equal(view.runs[0].timeLabel, '6 minutes ago');
  assert.equal(view.runs[0].durationLabel, '5m 42s');
  assert.equal(view.runs[1].statusLabel, '失败');
  assert.equal(view.runs[1].errorSummary, 'test / Run tests: failure');
  assert.ok(view.summaryCards.some((card) => card.label === '成功率' && card.value === '50%'));
  assert.ok(view.summaryCards.some((card) => card.label === '失败' && card.value === '1 次'));
});

test('action monitor view model separates recent two-day runs from paginated history', () => {
  const view = buildActionMonitorViewModel([
    buildActionRunRow({
      runId: 2003,
      workflowName: 'Deploy Cloudflare Pages (Dev)',
      runNumber: 330,
      startTime: '2026-07-06T01:00:00.000Z',
    }),
    buildActionRunRow({
      runId: 2002,
      workflowName: 'CI Tests',
      runNumber: 329,
      startTime: '2026-07-04T12:00:00.000Z',
    }),
    buildActionRunRow({
      runId: 2001,
      workflowName: 'Markdown Backup',
      runNumber: 17,
      startTime: '2026-07-03T23:59:59.000Z',
    }),
  ], {
    now: new Date('2026-07-06T00:00:00.000Z'),
    environment: 'dev',
  });

  assert.equal(view.recentWindowLabel, '最近 2 天');
  assert.deepEqual(view.recentRuns.map((run) => run.runId), [2003, 2002]);
  assert.deepEqual(view.historyRuns.map((run) => run.runId), [2001]);
  assert.equal(view.historyPageSize, 6);
  assert.equal(view.historyTotal, 1);
  assert.equal(view.historyStatus, '1-1 / 共 1 次');
  assert.deepEqual(view.runs.map((run) => run.runId), [2003, 2002]);
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

function buildActionRunRow(overrides = {}) {
  return {
    runId: overrides.runId ?? 2000,
    monitorEnvironment: 'dev',
    workflowName: overrides.workflowName ?? 'CI Tests',
    runNumber: overrides.runNumber ?? 300,
    branch: 'dev',
    commitSha: '18ba338e6ad31f2',
    headCommitMessage: overrides.headCommitMessage ?? `chore: run ${overrides.runId ?? 2000}`,
    actorLogin: 'soulgo',
    status: 'completed',
    conclusion: overrides.conclusion ?? 'success',
    startTime: overrides.startTime,
    endTime: overrides.endTime ?? overrides.startTime,
    duration: overrides.duration ?? 60,
    htmlUrl: `https://github.com/soulgo/training_records/actions/runs/${overrides.runId ?? 2000}`,
    errorSummary: overrides.errorSummary ?? '',
    jobCount: 1,
    stepCount: 6,
    failureCount: overrides.failureCount ?? 0,
  };
}
