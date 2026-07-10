import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

import { PostgresParameterHealthMonitorRepository } from '../src/adapters/postgres/parameter-health-monitor-repository.pg.mjs';
import { runParameterHealthAudit, formatParameterHealthSummaryMarkdown } from '../src/app/use-cases/parameter-health-monitor.use-case.mjs';
import { runParameterHealthProbes } from '../src/app/use-cases/parameter-health-probes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const { Client } = pg;

export async function checkParameterHealth(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const args = parseArgs(options.argv ?? process.argv.slice(2));
  const environment = firstNonEmpty([
    args.environment,
    env.PARAMETER_HEALTH_ENVIRONMENT,
    env.GITHUB_ACTION_MONITOR_ENVIRONMENT,
    env.GITHUB_REF_NAME,
    env.CF_PAGES_BRANCH,
    env.BRANCH,
    'dev',
  ]);
  const registryPath = path.resolve(
    options.rootDir ?? rootDir,
    args.registry ?? path.join('config', 'parameter-health', `${environment}.json`),
  );
  const registry = options.registry ?? JSON.parse(await readFile(registryPath, 'utf8'));
  const runProbes = options.runProbes ?? runParameterHealthProbes;
  const probeResultsByKey = await runProbes(registry, {
    env,
    now: options.now,
    fetchImpl: options.fetchImpl,
    createPgClient: options.createPgClient,
    createCosClient: options.createCosClient,
  });
  const audit = runParameterHealthAudit({
    registry,
    environment,
    now: options.now ?? new Date(),
    runId: firstNonEmpty([args.runId, env.GITHUB_RUN_ID]),
    probeResultsByKey,
  });

  if (args.writeMonitor) {
    await writeMonitorRows({
      audit,
      env,
      createClient: options.createClient,
      createRepository: options.createRepository,
      stdout,
    });
  }

  const markdown = formatParameterHealthSummaryMarkdown(audit);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `\n${markdown}`, 'utf8');
  }

  stdout.write(formatCompactSummary(audit));
  return audit;
}

async function writeMonitorRows({ audit, env, createClient, createRepository, stdout }) {
  const dbUrl = firstNonEmpty([
    env.PARAMETER_HEALTH_MONITOR_DB_URL,
    env.PARAMETER_VALIDITY_MONITOR_DB_URL,
    env.GITHUB_ACTION_MONITOR_DB_URL,
    env.TRAINING_DB_URL,
  ]);
  if (!dbUrl) {
    stdout.write('[parameter-health] database URL is not configured; skipped monitor write\n');
    return;
  }

  const clientFactory = createClient ?? ((config) => new Client(config));
  const repositoryFactory = createRepository ?? ((client) => new PostgresParameterHealthMonitorRepository(client));
  const client = clientFactory({
    connectionString: dbUrl,
    application_name: firstNonEmpty([
      env.PARAMETER_HEALTH_MONITOR_DB_APP_NAME,
      env.PARAMETER_VALIDITY_MONITOR_DB_APP_NAME,
      env.GITHUB_ACTION_MONITOR_DB_APP_NAME,
      env.TRAINING_DB_APP_NAME,
      'parameter-health-audit',
    ]),
    connectionTimeoutMillis: parsePositiveInteger(firstNonEmpty([
      env.PARAMETER_HEALTH_MONITOR_DB_TIMEOUT_MS,
      env.PARAMETER_VALIDITY_MONITOR_DB_TIMEOUT_MS,
      env.GITHUB_ACTION_MONITOR_DB_TIMEOUT_MS,
      env.TRAINING_DB_TIMEOUT_MS,
    ]), 5000),
  });

  try {
    await client.connect?.();
    const repository = repositoryFactory(client);
    await repository.writeParameterAudit({ parameters: audit.parameters, checks: audit.checks });
    stdout.write(`[parameter-health] wrote ${audit.checks.length} checks to monitor schema\n`);
  } finally {
    await client.end?.().catch(() => {});
  }
}

function parseArgs(argv) {
  const args = { writeMonitor: false };
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
    `[parameter-health] environment=${audit.environment}`,
    `total=${counts.total}`,
    `healthy=${counts.healthy}`,
    `present=${counts.present}`,
    `invalid=${counts.invalid}`,
    `missing=${counts.missing}`,
    `not_configured=${counts.notConfigured}`,
    `unreachable=${counts.unreachable}`,
    `unsupported=${counts.unsupported}`,
    `unknown=${counts.unknown}`,
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
  checkParameterHealth().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[parameter-health] ${message}\n`);
    process.exitCode = 1;
  });
}
