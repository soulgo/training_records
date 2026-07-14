import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillTrainingCoreFromArchive } from './backfill-training-core-from-archive.mjs';
import { backfillThoughtsToCore } from './backfill-thoughts-to-core.mjs';
import { reconcileTrainingMarkdownToCore } from './reconcile-training-markdown-to-core.mjs';
import { checkSleepDataConsistency, extractTargetDatesFromConsistencyResult } from './check-sleep-data-consistency.mjs';
import { resolveTrainingCoreConfig } from '../src/db/training/config.mjs';
import {
  backfillCoreSleepFromIngestBatchesClient,
  backfillCoreFromLatestArchiveSnapshotClient,
  importTrainingMarkdownToDatabase,
} from '../src/db/training/write.mjs';
import pg from 'pg';

const { Client } = pg;

export async function syncTrainingCore(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const phase = normalizeSyncPhase(options.phase);
  const result =
    phase === 'thoughts'
      ? {}
      : options.backfillTrainingCoreFromArchive ||
          options.backfillCoreSleepFromIngestBatchesClient ||
          options.reconcileTrainingMarkdownToCore
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
    ['ingest', options.backfillCoreSleepFromIngestBatchesClient ?? defaultInjectedIngestPhase],
    ['markdown', options.reconcileTrainingMarkdownToCore ?? reconcileTrainingMarkdownToCore],
  ];
  for (const [name, run] of phases.filter(
    ([name]) => phase === 'all' || name === phase || (phase === 'safe' && ['archive', 'ingest'].includes(name)),
  )) {
    result[name] = await runPhase(
      name,
      run,
      {
        rootDir: options.rootDir,
        env: options.env ?? process.env,
        createClient: options.createClient,
        processedAt: options.processedAt,
        dryRun: options.dryRun && name === 'markdown',
        stderr,
      },
      stderr,
    );
  }
  return result;
}

async function defaultInjectedIngestPhase() {
  return {
    status: 'unchanged',
    batchesBackfilled: 0,
    daysBackfilled: [],
  };
}

async function syncTrainingCoreDefault(options, stderr, phase) {
  const env = options.env ?? process.env;
  const config = resolveTrainingCoreConfig(env);
  if (options.dryRun && phase === 'markdown') {
    return {
      markdown: await runPhase(
        'markdown',
        () =>
          reconcileTrainingMarkdownToCore({
            rootDir: options.rootDir,
            env,
            processedAt: options.processedAt,
            stderr,
            dryRun: true,
          }),
        {},
        stderr,
      ),
    };
  }
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
    if (phase === 'safe' || phase === 'all' || phase === 'archive') {
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
    if (phase === 'safe' || phase === 'all' || phase === 'ingest') {
      result.ingest = await runPhase(
        'ingest',
        async () => {
          // 先执行睡眠数据一致性检查
          stderr.write('[sync-training-core:ingest] 检查睡眠数据一致性...\n');
          const consistencyResult = await checkSleepDataConsistency({
            env: options.env ?? process.env,
            createClient,
          });

          if (consistencyResult.status === 'skipped') {
            stderr.write(`[sync-training-core:ingest] 一致性检查已跳过: ${consistencyResult.reason}\n`);
            return {
              status: 'skipped',
              reason: consistencyResult.reason,
              batchesBackfilled: 0,
              daysBackfilled: [],
            };
          }

          stderr.write(`[sync-training-core:ingest] 发现 ${consistencyResult.inconsistentCount} 个不一致批次\n`);

          // 如果发现不一致，提取目标日期并执行修复
          let backfillResult;
          if (consistencyResult.inconsistentCount > 0) {
            const targetDates = extractTargetDatesFromConsistencyResult(consistencyResult);
            stderr.write(`[sync-training-core:ingest] 修复 ${targetDates.length} 个目标日期的睡眠数据...\n`);

            backfillResult = await backfillCoreSleepFromIngestBatchesClient(client, {
              processedAt,
              sourceChannel: options.sourceChannel ?? 'ingest_sleep_backfill',
              targetArchivedDates: targetDates,
            });

            stderr.write(`[sync-training-core:ingest] 睡眠数据修复完成: ${backfillResult.status}\n`);
          } else {
            // 没有不一致，执行常规回填（检查是否有新的睡眠数据）
            stderr.write('[sync-training-core:ingest] 一致性检查通过，执行常规睡眠回填...\n');
            backfillResult = await backfillCoreSleepFromIngestBatchesClient(client, {
              processedAt,
              sourceChannel: options.sourceChannel ?? 'ingest_sleep_backfill',
            });
          }

          return {
            ...backfillResult,
            consistencyCheck: {
              inconsistentCount: consistencyResult.inconsistentCount,
              missingBatchCount: consistencyResult.missingBatches?.length ?? 0,
              mismatchBatchCount: consistencyResult.partialMismatchBatches?.length ?? 0,
            },
          };
        },
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
            dryRun: options.dryRun,
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
  if (phase === 'safe') {
    return {
      archive: result.archive,
      ingest: result.ingest,
    };
  }
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
  if (statuses.some((status) => status === 'planned')) {
    return 'planned';
  }
  return 'skipped';
}

function normalizeSyncPhase(value) {
  const phase = String(value ?? 'safe').trim();
  return ['safe', 'all', 'archive', 'ingest', 'markdown', 'thoughts'].includes(phase) ? phase : 'safe';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await syncTrainingCore();
}
