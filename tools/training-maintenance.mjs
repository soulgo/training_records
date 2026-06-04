import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportDerivedTrainingMarkdown as exportDerivedTrainingMarkdownDefault } from './export-training-markdown.mjs';
import { syncTrainingCore as syncTrainingCoreDefault } from './sync-training-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..');
const migrationPlan = ['sync committed archive, ingest repairs, markdown, and thoughts into core tables'];

export async function runTrainingMaintenance(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const command = argv[0] ?? 'inspect';
  const flags = new Set(argv.slice(1));
  const rootDir = options.rootDir ?? defaultRootDir;
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const syncTrainingCore = options.syncTrainingCore ?? syncTrainingCoreDefault;
  const exportDerivedTrainingMarkdown =
    options.exportDerivedTrainingMarkdown ?? exportDerivedTrainingMarkdownDefault;

  let payload;
  if (command === 'inspect') {
    payload = await inspectMaintenanceState({ rootDir, env });
  } else if (command === 'sync') {
    payload = await runSyncMaintenance({ rootDir, env, stderr, flags, syncTrainingCore });
  } else if (command === 'export') {
    payload = await runExportMaintenance({
      rootDir,
      env,
      stderr,
      target: argv[1],
      exportDerivedTrainingMarkdown,
    });
  } else if (command === 'migrate') {
    payload = await runMigrateMaintenance({
      rootDir,
      env,
      stderr,
      flags,
      syncTrainingCore,
    });
  } else {
    payload = {
      status: 'failed',
      mode: command,
      error: `unknown maintenance command: ${command}`,
      commands: ['inspect', 'sync', 'export', 'migrate'],
    };
  }

  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

async function inspectMaintenanceState({ rootDir, env }) {
  const runtimeDir = path.join(rootDir, 'runtime');
  const pendingFallback = await readNdjsonSummary(
    path.join(runtimeDir, 'telegram-sync-pending.ndjson'),
  );
  const archiveFailures = await readNdjsonSummary(
    path.join(runtimeDir, 'training-archive-failures.ndjson'),
  );

  return {
    status: 'ok',
    mode: 'inspect',
    readonly: true,
    data: {
      pendingFallbackCount: pendingFallback.validCount,
      pendingFallbackInvalidLines: pendingFallback.invalidLines,
      archiveFailureCount: archiveFailures.validCount,
      archiveFailureInvalidLines: archiveFailures.invalidLines,
      database: {
        enabled: normalizeBooleanFlag(env.TRAINING_DB_ENABLED),
        hasUrl: Boolean(String(env.TRAINING_DB_URL ?? '').trim()),
      },
    },
  };
}

async function runSyncMaintenance({ rootDir, env, stderr, flags, syncTrainingCore }) {
  const phase = resolvePhaseFlag(flags);
  const result = await syncTrainingCore({
    rootDir,
    env,
    stderr,
    stdout: { write() {} },
    phase,
  });

  return {
    status: result.status,
    mode: 'sync',
    phase,
    readonly: false,
    result,
  };
}

async function runExportMaintenance({ rootDir, env, stderr, target, exportDerivedTrainingMarkdown }) {
  if (target !== 'markdown') {
    return {
      status: 'failed',
      mode: 'export',
      target: target ?? null,
      readonly: false,
      error: 'export requires target: markdown',
    };
  }

  const result = await exportDerivedTrainingMarkdown({
    rootDir,
    env,
    stderr,
  });

  return {
    status: 'stored',
    mode: 'export',
    target,
    readonly: false,
    result,
  };
}

async function runMigrateMaintenance({ rootDir, env, stderr, flags, syncTrainingCore }) {
  const dryRun = flags.has('--dry-run');
  const confirmed = flags.has('--confirm');

  if (dryRun) {
    return {
      status: 'planned',
      mode: 'migrate',
      readonly: true,
      dryRun: true,
      requiresConfirm: true,
      plan: migrationPlan,
    };
  }

  if (!confirmed) {
    return {
      status: 'blocked',
      mode: 'migrate',
      readonly: false,
      requiresConfirm: true,
      plan: migrationPlan,
      error: 'migrate requires --dry-run or --confirm',
    };
  }

  const result = await syncTrainingCore({
    rootDir,
    env,
    stderr,
    stdout: { write() {} },
    sourceChannel: 'maintenance_migrate',
  });

  return {
    status: result.status,
    mode: 'migrate',
    readonly: false,
    confirmed: true,
    plan: migrationPlan,
    result,
  };
}

async function readNdjsonSummary(filePath) {
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { validCount: 0, invalidLines: 0 };
    }
    throw error;
  }

  let validCount = 0;
  let invalidLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      JSON.parse(line);
      validCount += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { validCount, invalidLines };
}

function normalizeBooleanFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function resolvePhaseFlag(flags) {
  const values = [...flags];
  const equalsFlag = values.find((value) => value.startsWith('--phase='));
  if (equalsFlag) {
    return normalizeSyncPhase(equalsFlag.slice('--phase='.length));
  }

  const phaseIndex = values.indexOf('--phase');
  if (phaseIndex >= 0) {
    return normalizeSyncPhase(values[phaseIndex + 1]);
  }

  return 'all';
}

function normalizeSyncPhase(value) {
  const phase = String(value ?? 'all').trim();
  return ['all', 'archive', 'ingest', 'markdown', 'thoughts'].includes(phase) ? phase : 'all';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runTrainingMaintenance();
  if (result.status === 'failed') {
    process.exitCode = 1;
  } else if (result.status === 'blocked') {
    process.exitCode = 2;
  }
}
