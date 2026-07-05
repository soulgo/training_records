import test from 'node:test';
import assert from 'node:assert/strict';

import { reportGitHubActionStatus } from '../tools/report-github-action-status.mjs';

test('local github action status reporter delegates current dev run to the monitor use case', async () => {
  const calls = [];
  const logs = [];

  const result = await reportGitHubActionStatus({
    env: {
      GITHUB_RUN_ID: '123456789',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_REF_NAME: 'dev',
      GITHUB_TOKEN: 'github-token',
      TRAINING_DB_URL: 'postgres://dev-db',
      TRAINING_DB_APP_NAME: 'training-records-dev',
    },
    stdout: { write: (message) => logs.push(String(message)) },
    stderr: { write() {} },
    reportRun: async (input) => {
      calls.push(input);
      return { ok: true, runId: input.runId, jobCount: 1, stepCount: 2, failureCount: 0 };
    },
    createRepository: (client) => ({ client, upsertActionRunSnapshot() {} }),
    createClient: (config) => ({
      config,
      async connect() {},
      async end() {},
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, 123456789);
  assert.equal(calls[0].owner, 'soulgo');
  assert.equal(calls[0].repo, 'training_records');
  assert.equal(calls[0].token, 'github-token');
  assert.deepEqual(calls[0].allowedBranches, ['dev']);
  assert.equal(calls[0].monitorEnvironment, 'dev');
  assert.equal(calls[0].repository.client.config.connectionString, 'postgres://dev-db');
  assert.equal(calls[0].repository.client.config.application_name, 'training-records-dev');
  assert.ok(logs.some((line) => line.includes('reported run 123456789')));
});

test('local github action status reporter skips when database configuration is absent', async () => {
  let reportCalled = false;
  const logs = [];

  const result = await reportGitHubActionStatus({
    env: {
      GITHUB_RUN_ID: '123456789',
      GITHUB_REPOSITORY: 'soulgo/training_records',
      GITHUB_REF_NAME: 'dev',
      GITHUB_TOKEN: 'github-token',
    },
    stdout: { write: (message) => logs.push(String(message)) },
    stderr: { write() {} },
    reportRun: async () => {
      reportCalled = true;
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'missing_database_url');
  assert.equal(reportCalled, false);
  assert.ok(logs.some((line) => line.includes('database URL is not configured')));
});
