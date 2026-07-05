#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { PostgresGitHubActionMonitorRepository } from '../src/adapters/postgres/github-action-monitor-repository.pg.mjs';
import { reportGitHubActionRun } from '../src/app/use-cases/github-action-monitor.use-case.mjs';

const { Client } = pg;

export async function reportGitHubActionStatus(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const branch = firstNonEmpty([env.GITHUB_REF_NAME, env.BRANCH]);
  const explicitAllowedBranches = splitCsv(env.GITHUB_ACTION_MONITOR_ALLOWED_BRANCH);
  const allowedBranches = explicitAllowedBranches.length ? explicitAllowedBranches : (isMonitoredBranch(branch) ? [branch] : []);

  if (!allowedBranches.length) {
    stdout.write(`[github-action-monitor] branch ${branch || '(unknown)'} is not monitored; skipping local report\n`);
    return { ok: true, skipped: true, reason: 'branch_not_monitored' };
  }

  const dbUrl = firstNonEmpty([
    env.GITHUB_ACTION_MONITOR_DB_URL,
    env.TRAINING_DB_URL,
  ]);
  if (!dbUrl) {
    stdout.write('[github-action-monitor] database URL is not configured; skipping local report\n');
    return { ok: true, skipped: true, reason: 'missing_database_url' };
  }

  const token = firstNonEmpty([env.GITHUB_TOKEN, env.GH_TOKEN]);
  if (!token) {
    stdout.write('[github-action-monitor] GitHub token is not configured; skipping local report\n');
    return { ok: true, skipped: true, reason: 'missing_github_token' };
  }

  const { owner, repo } = resolveRepository(env);
  const runId = normalizeRunId(env.GITHUB_RUN_ID);
  const monitorEnvironment = firstNonEmpty([env.GITHUB_ACTION_MONITOR_ENVIRONMENT, branch, allowedBranches[0]]);
  const createClient = options.createClient ?? ((config) => new Client(config));
  const createRepository = options.createRepository ?? ((client) => new PostgresGitHubActionMonitorRepository(client));
  const reportRun = options.reportRun ?? reportGitHubActionRun;
  const client = createClient({
    connectionString: dbUrl,
    application_name: firstNonEmpty([
      env.GITHUB_ACTION_MONITOR_DB_APP_NAME,
      env.TRAINING_DB_APP_NAME,
      'github-action-monitor-report',
    ]),
    connectionTimeoutMillis: parsePositiveInteger(
      firstNonEmpty([env.GITHUB_ACTION_MONITOR_DB_TIMEOUT_MS, env.TRAINING_DB_TIMEOUT_MS]),
      5000,
    ),
  });

  try {
    await client.connect?.();
    const repository = createRepository(client);
    const result = await reportRun({
      runId,
      owner,
      repo,
      token,
      allowedBranches,
      monitorEnvironment,
      repository,
      fetchImpl: options.fetchImpl ?? fetch,
      logger: options.logger ?? console,
    });
    stdout.write(
      `[github-action-monitor] reported run ${runId}: jobs=${result.jobCount ?? 0} steps=${result.stepCount ?? 0} failures=${result.failureCount ?? 0}\n`,
    );
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[github-action-monitor] local report failed: ${message}\n`);
    throw error;
  } finally {
    await client.end?.().catch(() => {});
  }
}

function resolveRepository(env) {
  const repository = firstNonEmpty([env.GITHUB_REPOSITORY]);
  if (repository.includes('/')) {
    const [owner, repo] = repository.split('/');
    if (owner && repo) {
      return { owner, repo };
    }
  }
  return {
    owner: normalizeRequiredText(env.GITHUB_OWNER, 'GITHUB_OWNER'),
    repo: normalizeRequiredText(env.GITHUB_REPO, 'GITHUB_REPO'),
  };
}

function normalizeRunId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error('GITHUB_RUN_ID must be a positive integer');
  }
  const numberValue = Number(normalized);
  if (!Number.isSafeInteger(numberValue)) {
    throw new Error('GITHUB_RUN_ID is outside the safe integer range');
  }
  return numberValue;
}

function normalizeRequiredText(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function firstNonEmpty(values) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
}

function splitCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isMonitoredBranch(branch) {
  return branch === 'dev' || branch === 'main';
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reportGitHubActionStatus().catch(() => {
    process.exitCode = 1;
  });
}
