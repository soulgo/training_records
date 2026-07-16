import pg from 'pg';
import { resolveTrainingCoreConfig } from '../src/adapters/postgres/training-config.pg.mjs';
import { checkSleepDataConsistency } from './check-sleep-data-consistency.mjs';

const { Client } = pg;

/**
 * 检查 ingest 和 core 之间所有数据类型的一致性
 *
 * 查找以下不一致情况：
 * 1. ingest.source_batch 中有 activities 数据，但 core.activity 中缺失
 * 2. ingest.source_batch 中有 measurement 数据，但 core.measurement 中缺失
 * 3. ingest.source_batch 中有 meals 数据，但 core.meal 中缺失
 * 4. ingest.source_batch 中有 sleep 数据，但 core.sleep 中缺失
 */
export async function checkCoreDataConsistency(options = {}) {
  const config = resolveTrainingCoreConfig(options.env ?? process.env);

  if (!config.enabled || !config.url) {
    return {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
      totalInconsistentCount: 0,
      inconsistentBatches: {
        activities: [],
        measurements: [],
        meals: [],
        sleep: [],
      },
    };
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

  try {
    await client.connect();

    const limit = options.limit ?? 100;

    // 检查 activities 一致性
    const missingActivitiesResult = await client.query(`
      select
        b.batch_id,
        b.source_channel,
        b.archived_date,
        b.status,
        b.processed_at,
        jsonb_array_length(b.payload_json->'activities') as activity_count
      from ingest.source_batch b
      where b.status = 'ready'
        and b.archived_date is not null
        and b.payload_json->'activities' is not null
        and jsonb_array_length(b.payload_json->'activities') > 0
        and not exists (
          select 1
          from core.activity a
          where a.archived_date = b.archived_date
            and a.source_batch_id = b.batch_id
        )
      order by b.archived_date desc, b.processed_at desc
      limit ${limit}
    `);

    // 检查 measurements 一致性
    const missingMeasurementsResult = await client.query(`
      select
        b.batch_id,
        b.source_channel,
        b.archived_date,
        b.status,
        b.processed_at
      from ingest.source_batch b
      where b.status = 'ready'
        and b.archived_date is not null
        and b.payload_json->'measurement' is not null
        and not exists (
          select 1
          from core.measurement m
          where m.archived_date = b.archived_date
            and m.source_batch_id = b.batch_id
        )
      order by b.archived_date desc, b.processed_at desc
      limit ${limit}
    `);

    // 检查 meals 一致性
    const missingMealsResult = await client.query(`
      select
        b.batch_id,
        b.source_channel,
        b.archived_date,
        b.status,
        b.processed_at,
        jsonb_array_length(b.payload_json->'nutrition'->'meals') as meal_count
      from ingest.source_batch b
      where b.status = 'ready'
        and b.archived_date is not null
        and b.payload_json->'nutrition'->'meals' is not null
        and jsonb_array_length(b.payload_json->'nutrition'->'meals') > 0
        and not exists (
          select 1
          from core.meal m
          where m.archived_date = b.archived_date
            and m.source_batch_id = b.batch_id
        )
      order by b.archived_date desc, b.processed_at desc
      limit ${limit}
    `);

    // 重用睡眠数据一致性检查
    const sleepResult = await checkSleepDataConsistency({
      env: options.env,
      createClient: options.createClient,
      limit,
    });

    const inconsistentActivities = missingActivitiesResult.rows.map((row) => ({
      batchId: row.batch_id,
      sourceChannel: row.source_channel,
      archivedDate: row.archived_date,
      status: row.status,
      processedAt: row.processed_at,
      activityCount: row.activity_count,
      issueType: 'missing_in_core',
      dataType: 'activities',
    }));

    const inconsistentMeasurements = missingMeasurementsResult.rows.map((row) => ({
      batchId: row.batch_id,
      sourceChannel: row.source_channel,
      archivedDate: row.archived_date,
      status: row.status,
      processedAt: row.processed_at,
      issueType: 'missing_in_core',
      dataType: 'measurement',
    }));

    const inconsistentMeals = missingMealsResult.rows.map((row) => ({
      batchId: row.batch_id,
      sourceChannel: row.source_channel,
      archivedDate: row.archived_date,
      status: row.status,
      processedAt: row.processed_at,
      mealCount: row.meal_count,
      issueType: 'missing_in_core',
      dataType: 'meals',
    }));

    return {
      status: 'checked',
      inconsistentBatches: {
        activities: inconsistentActivities,
        measurements: inconsistentMeasurements,
        meals: inconsistentMeals,
        sleep: sleepResult.batches ?? [],
      },
      totalInconsistentCount:
        inconsistentActivities.length +
        inconsistentMeasurements.length +
        inconsistentMeals.length +
        (sleepResult.inconsistentCount ?? 0),
    };
  } catch (error) {
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * 从一致性检查结果中提取需要修复的批次ID
 */
export function extractBatchIdsFromConsistencyResult(consistencyResult) {
  if (!consistencyResult || !consistencyResult.inconsistentBatches) {
    return [];
  }

  const batchIds = new Set();

  for (const batch of consistencyResult.inconsistentBatches.activities ?? []) {
    if (batch.batchId) {
      batchIds.add(batch.batchId);
    }
  }

  for (const batch of consistencyResult.inconsistentBatches.measurements ?? []) {
    if (batch.batchId) {
      batchIds.add(batch.batchId);
    }
  }

  for (const batch of consistencyResult.inconsistentBatches.meals ?? []) {
    if (batch.batchId) {
      batchIds.add(batch.batchId);
    }
  }

  for (const batch of consistencyResult.inconsistentBatches.sleep ?? []) {
    if (batch.batchId) {
      batchIds.add(batch.batchId);
    }
  }

  return [...batchIds].sort();
}

/**
 * 命令行入口
 */
export async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1], 10) : 100;

  console.log('检查所有数据类型一致性...\n');

  try {
    const result = await checkCoreDataConsistency({
      env: process.env,
      limit,
    });

    if (result.status === 'skipped') {
      console.log(`检查已跳过: ${result.reason}`);
      process.exit(0);
    }

    console.log(`✓ 一致性检查完成`);
    console.log(`  - 发现不一致批次: ${result.totalInconsistentCount}`);
    console.log(`  - Activities 缺失: ${result.inconsistentBatches.activities.length}`);
    console.log(`  - Measurements 缺失: ${result.inconsistentBatches.measurements.length}`);
    console.log(`  - Meals 缺失: ${result.inconsistentBatches.meals.length}`);
    console.log(`  - Sleep 缺失: ${result.inconsistentBatches.sleep.length}`);

    if (result.totalInconsistentCount > 0) {
      console.log('\n不一致批次详情:');

      if (result.inconsistentBatches.activities.length > 0) {
        console.log('\nActivities 缺失的批次:');
        for (const batch of result.inconsistentBatches.activities.slice(0, verbose ? undefined : 10)) {
          console.log(`  - ${batch.batchId}`);
          console.log(`    归档日期: ${batch.archivedDate}`);
          console.log(`    来源: ${batch.sourceChannel}`);
          console.log(`    活动数量: ${batch.activityCount}`);
          console.log(`    处理时间: ${batch.processedAt}`);
        }
        if (!verbose && result.inconsistentBatches.activities.length > 10) {
          console.log(`  ... 还有 ${result.inconsistentBatches.activities.length - 10} 个批次（使用 --verbose 查看全部）`);
        }
      }

      if (result.inconsistentBatches.measurements.length > 0) {
        console.log('\nMeasurements 缺失的批次:');
        for (const batch of result.inconsistentBatches.measurements.slice(0, verbose ? undefined : 10)) {
          console.log(`  - ${batch.batchId}`);
          console.log(`    归档日期: ${batch.archivedDate}`);
          console.log(`    来源: ${batch.sourceChannel}`);
          console.log(`    处理时间: ${batch.processedAt}`);
        }
        if (!verbose && result.inconsistentBatches.measurements.length > 10) {
          console.log(`  ... 还有 ${result.inconsistentBatches.measurements.length - 10} 个批次（使用 --verbose 查看全部）`);
        }
      }

      if (result.inconsistentBatches.meals.length > 0) {
        console.log('\nMeals 缺失的批次:');
        for (const batch of result.inconsistentBatches.meals.slice(0, verbose ? undefined : 10)) {
          console.log(`  - ${batch.batchId}`);
          console.log(`    归档日期: ${batch.archivedDate}`);
          console.log(`    来源: ${batch.sourceChannel}`);
          console.log(`    餐次数量: ${batch.mealCount}`);
          console.log(`    处理时间: ${batch.processedAt}`);
        }
        if (!verbose && result.inconsistentBatches.meals.length > 10) {
          console.log(`  ... 还有 ${result.inconsistentBatches.meals.length - 10} 个批次（使用 --verbose 查看全部）`);
        }
      }

      if (result.inconsistentBatches.sleep.length > 0) {
        console.log('\nSleep 缺失的批次:');
        for (const batch of result.inconsistentBatches.sleep.slice(0, verbose ? undefined : 10)) {
          console.log(`  - ${batch.batchId}`);
          console.log(`    归档日期: ${batch.archivedDate}`);
          console.log(`    来源: ${batch.sourceChannel}`);
          if (batch.totalSleepMinutes) {
            console.log(`    总睡眠分钟数: ${batch.totalSleepMinutes}`);
          }
          if (batch.sleepRecordCount) {
            console.log(`    睡眠记录数: ${batch.sleepRecordCount}`);
          }
          if (batch.processedAt) {
            console.log(`    处理时间: ${batch.processedAt}`);
          }
        }
        if (!verbose && result.inconsistentBatches.sleep.length > 10) {
          console.log(`  ... 还有 ${result.inconsistentBatches.sleep.length - 10} 个批次（使用 --verbose 查看全部）`);
        }
      }

      const batchIds = extractBatchIdsFromConsistencyResult(result);
      console.log(`\n需要修复的批次 (共 ${batchIds.length} 个):`);
      console.log(`  ${batchIds.slice(0, 20).join(', ')}${batchIds.length > 20 ? '...' : ''}`);

      console.log('\n修复建议:');
      console.log('  运行以下命令修复数据一致性:');
      console.log('  npm run sync:db');

      process.exit(1);
    } else {
      console.log('\n✓ 所有数据类型一致性检查通过，无需修复');
      process.exit(0);
    }
  } catch (error) {
    console.error('\n✗ 一致性检查失败:');
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    if (verbose && error instanceof Error && error.stack) {
      console.error('\n堆栈信息:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
