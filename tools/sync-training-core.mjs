import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillTrainingCoreFromArchive } from './backfill-training-core-from-archive.mjs';
import { backfillThoughtsToCore } from './backfill-thoughts-to-core.mjs';
import { reconcileTrainingMarkdownToCore } from './reconcile-training-markdown-to-core.mjs';
import {
  backfillCoreSleepFromIngestBatchesClient,
  backfillCoreFromLatestArchiveSnapshotClient,
  importTrainingMarkdownToDatabase,
  resolveTrainingCoreConfig,
} from './training-db-core.mjs';
import pg from 'pg';

const { Client } = pg;

export async function syncTrainingCore(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const phase = normalizeSyncPhase(options.phase);
  const result =
    phase === 'thoughts'
      ? {}
      : options.backfillTrainingCoreFromArchive || options.reconcileTrainingMarkdownToCore
        ? await syncTrainingCoreWithInjectedPhases(options, stderr, phase)
        : await syncTrainingCoreDefault(options, stderr, phase);

  if ((phase === 'all' || phase === 'thoughts') && !result.thoughts) {
    result.thoughts = await runPhase(
      'thoughts',
      options.backfillThoughtsToCore ?? backfillThoughtsToCore,
      {
        rootDir: options.rootDir,
        env: options.env ?? process.env,
        createClient: options.createClient,
        processedAt: options.processedAt,
        stderr,
      },
      stderr,
    );
  }

  const payload = {
    status: summarizeStatus(result),
    ...result,
  };
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

async function syncTrainingCoreWithInjectedPhases(options, stderr, phase) {
  const result = {};
  const phases = [
    ['archive', options.backfillTrainingCoreFromArchive ?? backfillTrainingCoreFromArchive],
    ['markdown', options.reconcileTrainingMarkdownToCore ?? reconcileTrainingMarkdownToCore],
  ];
  for (const [name, run] of phases.filter(([name]) => phase === 'all' || name === phase)) {
    result[name] = await runPhase(
      name,
      run,
      {
        rootDir: options.rootDir,
        env: options.env ?? process.env,
        createClient: options.createClient,
        processedAt: options.processedAt,
        stderr,
      },
      stderr,
    );
  }
  return result;
}

async function syncTrainingCoreDefault(options, stderr, phase) {
  const env = options.env ?? process.env;
  const config = resolveTrainingCoreConfig(env);
  if (!config.enabled || !config.url) {
    const skipped = {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
    };
    return buildPhasedResult(phase, {
      archive: { ...skipped, daysBackfilled: 0 },
      ingest: { ...skipped, batchesBackfilled: 0, daysBackfilled: [] },
      markdown: skipped,
    });
  }

  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));
  const client = createClient(config);
  const processedAt = options.processedAt ?? new Date();

  try {
    await client.connect();
    const result = {};
    if (phase === 'all' || phase === 'archive') {
      result.archive = await runPhase(
        'archive',
        () =>
          backfillCoreFromLatestArchiveSnapshotClient(client, {
            processedAt,
            sourceChannel: options.sourceChannel,
            batchId: options.batchId,
          }),
        {},
        stderr,
      );
    }
    if (phase === 'all' || phase === 'ingest') {
      result.ingest = await runPhase(
        'ingest',
        () =>
          backfillCoreSleepFromIngestBatchesClient(client, {
            processedAt,
            sourceChannel: options.sourceChannel,
          }),
        {},
        stderr,
      );
    }
    if (phase === 'all' || phase === 'markdown') {
      result.markdown = await runPhase(
        'markdown',
        () =>
          reconcileTrainingMarkdownToCore({
            rootDir: options.rootDir,
            env,
            processedAt,
            stderr,
            importTrainingMarkdownToDatabase: ({ markdown }) =>
              importTrainingMarkdownToDatabase({
                markdown,
                env,
                processedAt,
                createClient() {
                  return {
                    async connect() {},
                    async query(sql, params) {
                      return client.query(sql, params);
                    },
                    async end() {},
                  };
                },
              }),
          }),
        {},
        stderr,
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[sync-training-core] ${message}\n`);
    return buildPhasedResult(phase, {
      archive: {
        status: 'deferred',
        error: message,
      },
      ingest: {
        status: 'deferred',
        error: message,
      },
      markdown: {
        status: 'deferred',
        error: message,
      },
    });
  } finally {
    try {
      await client.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`[sync-training-core] ${message}\n`);
    }
  }
}

function buildPhasedResult(phase, result) {
  if (phase === 'all') {
    return result;
  }
  if (phase === 'archive') {
    return { archive: result.archive };
  }
  if (phase === 'ingest') {
    return { ingest: result.ingest };
  }
  if (phase === 'markdown') {
    return { markdown: result.markdown };
  }
  return {};
}

async function runPhase(name, run, options, stderr) {
  try {
    return await run(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[sync-training-core:${name}] ${message}\n`);
    return {
      status: 'deferred',
      error: message,
    };
  }
}

function summarizeStatus(result) {
  const statuses = Object.values(result).map((entry) => entry?.status ?? 'deferred');
  if (statuses.every((status) => status === 'deferred')) {
    return 'deferred';
  }
  if (statuses.some((status) => status === 'deferred')) {
    return 'partial';
  }
  if (statuses.some((status) => status === 'stored')) {
    return 'stored';
  }
  if (statuses.some((status) => status === 'unchanged')) {
    return 'unchanged';
  }
  return 'skipped';
}

function normalizeSyncPhase(value) {
  const phase = String(value ?? 'all').trim();
  return ['all', 'archive', 'ingest', 'markdown', 'thoughts'].includes(phase) ? phase : 'all';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await syncTrainingCore();
}
