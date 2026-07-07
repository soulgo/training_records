#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

import {
  formatParameterValiditySummaryMarkdown,
  runParameterValidityAudit,
} from '../src/app/use-cases/parameter-validity-monitor.use-case.mjs';
import { PostgresParameterValidityMonitorRepository } from '../src/adapters/postgres/parameter-validity-monitor-repository.pg.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const { Client } = pg;

export async function checkParameterValidity(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const args = parseArgs(options.argv ?? process.argv.slice(2));
  const environment = firstNonEmpty([
    args.environment,
    env.GITHUB_ACTION_MONITOR_ENVIRONMENT,
    env.GITHUB_REF_NAME,
    env.CF_PAGES_BRANCH,
    env.BRANCH,
    'dev',
  ]);
  const registryPath = path.resolve(
    options.rootDir ?? rootDir,
    args.registry ?? path.join('config', 'parameter-validity', `${environment}.json`),
  );
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const audit = runParameterValidityAudit({
    registry,
    environment,
    env,
    now: options.now ?? new Date(),
    runId: firstNonEmpty([args.runId, env.GITHUB_RUN_ID]),
    presenceByKey: options.presenceByKey,
    presenceByName: options.presenceByName,
    metadataByKey: options.metadataByKey,
  });

  if (args.writeMonitor) {
    await writeMonitorRows({
      audit,
      env,
      createClient: options.createClient,
      createRepository: options.createRepository,
      stdout,
      stderr,
    });
  }

  const markdown = formatParameterValiditySummaryMarkdown(audit);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `\n${markdown}`, 'utf8');
  }

  stdout.write(formatCompactSummary(audit));
  return audit;
}

async function writeMonitorRows({ audit, env, createClient, createRepository, stdout }) {
  const dbUrl = firstNonEmpty([
    env.PARAMETER_VALIDITY_MONITOR_DB_URL,
    env.GITHUB_ACTION_MONITOR_DB_URL,
    env.TRAINING_DB_URL,
  ]);
  if (!dbUrl) {
    stdout.write('[parameter-validity] database URL is not configured; skipped monitor write\n');
    return;
  }

  const clientFactory = createClient ?? ((config) => new Client(config));
  const repositoryFactory = createRepository ?? ((client) => new PostgresParameterValidityMonitorRepository(client));
  const client = clientFactory({
    connectionString: dbUrl,
    application_name: firstNonEmpty([
      env.PARAMETER_VALIDITY_MONITOR_DB_APP_NAME,
      env.GITHUB_ACTION_MONITOR_DB_APP_NAME,
      env.TRAINING_DB_APP_NAME,
      'parameter-validity-audit',
    ]),
    connectionTimeoutMillis: parsePositiveInteger(
      firstNonEmpty([
        env.PARAMETER_VALIDITY_MONITOR_DB_TIMEOUT_MS,
        env.GITHUB_ACTION_MONITOR_DB_TIMEOUT_MS,
        env.TRAINING_DB_TIMEOUT_MS,
      ]),
      5000,
    ),
  });

  try {
    await client.connect?.();
    const repository = repositoryFactory(client);
    await repository.writeParameterAudit({
      parameters: audit.parameters,
      checks: audit.checks,
    });
    stdout.write(`[parameter-validity] wrote ${audit.checks.length} checks to monitor schema\n`);
  } finally {
    await client.end?.().catch(() => {});
  }
}

function parseArgs(argv) {
  const args = {
    writeMonitor: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write-monitor') {
      args.writeMonitor = true;
    } else if (arg === '--environment') {
      args.environment = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--environment=')) {
      args.environment = arg.slice('--environment='.length);
    } else if (arg === '--registry') {
      args.registry = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--registry=')) {
      args.registry = arg.slice('--registry='.length);
    } else if (arg === '--run-id') {
      args.runId = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--run-id=')) {
      args.runId = arg.slice('--run-id='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function formatCompactSummary(audit) {
  const counts = audit.summary.counts;
  return [
    `[parameter-validity] environment=${audit.environment}`,
    `total=${counts.total}`,
    `expired=${counts.expired}`,
    `missing=${counts.missing}`,
    `warning=${counts.warning}`,
    `unknown=${counts.unknown}`,
    `ok=${counts.ok}`,
    '',
  ].join(' ');
}

function firstNonEmpty(values) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkParameterValidity().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[parameter-validity] ${message}\n`);
    process.exitCode = 1;
  });
}
