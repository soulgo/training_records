import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillTrainingCoreFromArchive } from './backfill-training-core-from-archive.mjs';
import { backfillThoughtsToCore } from './backfill-thoughts-to-core.mjs';
import { reconcileTrainingMarkdownToCore } from './reconcile-training-markdown-to-core.mjs';
import { checkSleepDataConsistency, extractTargetDatesFromConsistencyResult } from './check-sleep-data-consistency.mjs';
import { checkCoreDataConsistency, extractBatchIdsFromConsistencyResult } from './check-core-data-consistency.mjs';
import { resolveTrainingCoreConfig } from '../src/adapters/postgres/training-config.pg.mjs';
import {
  backfillCoreSleepFromIngestBatchesClient,
  backfillCoreFromLatestArchiveSnapshotClient,
  importTrainingMarkdownToDatabase,
} from '../src/db/training/write.mjs';
import { persistTelegramImageBatchIncremental } from '../src/adapters/postgres/incremental-write.pg.mjs';
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
          // 执行全面数据一致性检查（包括 activities/measurements/meals/sleep）
          stderr.write('[sync-training-core:ingest] 检查所有数据类型一致性...\n');
          const consistencyResult = await checkCoreDataConsistency({
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

          stderr.write(`[sync-training-core:ingest] 发现 ${consistencyResult.totalInconsistentCount} 个不一致批次\n`);
          stderr.write(`[sync-training-core:ingest]   - Activities: ${consistencyResult.inconsistentBatches.activities.length}\n`);
          stderr.write(`[sync-training-core:ingest]   - Measurements: ${consistencyResult.inconsistentBatches.measurements.length}\n`);
          stderr.write(`[sync-training-core:ingest]   - Meals: ${consistencyResult.inconsistentBatches.meals.length}\n`);
          stderr.write(`[sync-training-core:ingest]   - Sleep: ${consistencyResult.inconsistentBatches.sleep.length}\n`);

          // 如果发现不一致，执行修复
          if (consistencyResult.totalInconsistentCount > 0) {
            const batchIds = extractBatchIdsFromConsistencyResult(consistencyResult);
            stderr.write(`[sync-training-core:ingest] 修复 ${batchIds.length} 个批次的数据不一致...\n`);

            let repairedCount = 0;
            for (const batchId of batchIds) {
              try {
                await repairBatchIncremental(client, batchId, processedAt);
                repairedCount++;
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                stderr.write(`[sync-training-core:ingest] 修复批次 ${batchId} 失败: ${errorMessage}\n`);
              }
            }

            stderr.write(`[sync-training-core:ingest] 数据修复完成，成功修复 ${repairedCount}/${batchIds.length} 个批次\n`);

            return {
              status: 'stored',
              repairedBatchCount: repairedCount,
              consistencyCheck: {
                totalInconsistentCount: consistencyResult.totalInconsistentCount,
                activitiesFixed: consistencyResult.inconsistentBatches.activities.length,
                measurementsFixed: consistencyResult.inconsistentBatches.measurements.length,
                mealsFixed: consistencyResult.inconsistentBatches.meals.length,
                sleepFixed: consistencyResult.inconsistentBatches.sleep.length,
              },
            };
          }

          // 没有不一致，执行常规睡眠回填
          stderr.write('[sync-training-core:ingest] 一致性检查通过，执行常规睡眠回填...\n');
          const backfillResult = await backfillCoreSleepFromIngestBatchesClient(client, {
            processedAt,
            sourceChannel: options.sourceChannel ?? 'ingest_backfill',
          });

          return {
            ...backfillResult,
            consistencyCheck: {
              totalInconsistentCount: 0,
              activitiesFixed: 0,
              measurementsFixed: 0,
              mealsFixed: 0,
              sleepFixed: 0,
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

/**
 * 修复单个批次的增量数据
 * 从 ingest.source_batch 读取原始识别结果，重新执行增量写入到 core 表
 */
async function repairBatchIncremental(client, batchId, processedAt) {
  const batchResult = await client.query(
    `select batch_id, source_channel, archived_date, payload_json
     from ingest.source_batch
     where batch_id = $1`,
    [batchId]
  );

  if (batchResult.rows.length === 0) {
    return;
  }

  const batch = batchResult.rows[0];
  const payload = batch.payload_json;

  // 重新执行增量写入
  await persistTelegramImageBatchIncremental(
    client,
    {
      batchId: batch.batch_id,
      sourceChannel: batch.source_channel,
      archivedDate: batch.archived_date,
      measurement: payload.measurement,
      activities: payload.activities,
      nutrition: payload.nutrition,
      sleep: payload.sleep,
      workoutDailySummary: payload.workoutDailySummary,
    },
    processedAt,
    { sourceChannel: batch.source_channel }
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await syncTrainingCore();
}
