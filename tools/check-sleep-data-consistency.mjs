import pg from 'pg';
import { resolveTrainingCoreConfig } from '../src/db/training/config.mjs';

const { Client } = pg;

/**
 * 检查 ingest 和 core 之间的睡眠数据一致性
 *
 * 查找以下不一致情况：
 * 1. ingest.source_batch 中有睡眠数据，但 core.sleep 中缺失
 * 2. 归档日期匹配但 source_batch_id 不匹配的情况
 */
export async function checkSleepDataConsistency(options = {}) {
  const config = resolveTrainingCoreConfig(options.env ?? process.env);

  if (!config.enabled || !config.url) {
    return {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
      inconsistentCount: 0,
      batches: [],
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

    // 查找 ingest 中有睡眠数据但 core 中完全缺失的批次
    const missingBatchesResult = await client.query(`
      select
        b.batch_id,
        b.source_channel,
        b.archived_date,
        b.status,
        b.processed_at,
        (b.payload_json->'sleep'->'totalSleepMinutes')::integer as total_sleep_minutes,
        (b.payload_json->'sleep'->'records')::jsonb as sleep_records
      from ingest.source_batch b
      where b.status = 'ready'
        and b.archived_date is not null
        and b.payload_json->'sleep' is not null
        and (
          b.payload_json->'sleep'->>'totalSleepMinutes' is not null
          or jsonb_array_length(b.payload_json->'sleep'->'records') > 0
        )
        and not exists (
          select 1
          from core.sleep s
          where s.archived_date = b.archived_date
            and s.source_batch_id = b.batch_id
        )
      order by b.archived_date desc, b.processed_at desc
      limit ${options.limit ?? 100}
    `);

    // 查找归档日期有睡眠数据但批次不匹配的情况（可能是部分回填失败）
    const partialMismatchResult = await client.query(`
      select
        b.batch_id,
        b.source_channel,
        b.archived_date,
        b.status,
        count(distinct s.source_batch_id) as existing_batch_count,
        array_agg(distinct s.source_batch_id) as existing_batch_ids
      from ingest.source_batch b
      left join core.sleep s on s.archived_date = b.archived_date
      where b.status = 'ready'
        and b.archived_date is not null
        and b.payload_json->'sleep' is not null
        and (
          b.payload_json->'sleep'->>'totalSleepMinutes' is not null
          or jsonb_array_length(b.payload_json->'sleep'->'records') > 0
        )
        and s.source_batch_id is not null
        and s.source_batch_id != b.batch_id
      group by b.batch_id, b.source_channel, b.archived_date, b.status
      order by b.archived_date desc
      limit ${options.limit ?? 50}
    `);

    const inconsistentBatches = missingBatchesResult.rows.map((row) => ({
      batchId: row.batch_id,
      sourceChannel: row.source_channel,
      archivedDate: row.archived_date,
      status: row.status,
      processedAt: row.processed_at,
      totalSleepMinutes: row.total_sleep_minutes,
      sleepRecordCount: row.sleep_records ? row.sleep_records.length : 0,
      issueType: 'missing_in_core',
    }));

    const partialMismatchBatches = partialMismatchResult.rows.map((row) => ({
      batchId: row.batch_id,
      sourceChannel: row.source_channel,
      archivedDate: row.archived_date,
      status: row.status,
      existingBatchCount: row.existing_batch_count,
      existingBatchIds: row.existing_batch_ids,
      issueType: 'batch_id_mismatch',
    }));

    return {
      status: 'checked',
      inconsistentCount: inconsistentBatches.length + partialMismatchBatches.length,
      missingBatches: inconsistentBatches,
      partialMismatchBatches,
      batches: [...inconsistentBatches, ...partialMismatchBatches],
    };
  } catch (error) {
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * 从一致性检查结果中提取需要修复的目标日期
 */
export function extractTargetDatesFromConsistencyResult(consistencyResult) {
  if (!consistencyResult || !consistencyResult.batches) {
    return [];
  }

  const targetDates = new Set();

  for (const batch of consistencyResult.batches) {
    if (batch.archivedDate) {
      targetDates.add(batch.archivedDate);
    }
  }

  return [...targetDates].sort();
}

/**
 * 命令行入口
 */
export async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1], 10) : 100;

  console.log('检查睡眠数据一致性...\n');

  try {
    const result = await checkSleepDataConsistency({
      env: process.env,
      limit,
    });

    if (result.status === 'skipped') {
      console.log(`检查已跳过: ${result.reason}`);
      process.exit(0);
    }

    console.log(`✓ 一致性检查完成`);
    console.log(`  - 发现不一致批次: ${result.inconsistentCount}`);
    console.log(`  - 完全缺失: ${result.missingBatches?.length ?? 0}`);
    console.log(`  - 批次ID不匹配: ${result.partialMismatchBatches?.length ?? 0}`);

    if (result.inconsistentCount > 0) {
      console.log('\n不一致批次详情:');

      if (result.missingBatches && result.missingBatches.length > 0) {
        console.log('\n完全缺失的批次（ingest有数据但core缺失）:');
        for (const batch of result.missingBatches.slice(0, verbose ? undefined : 10)) {
          console.log(`  - ${batch.batchId}`);
          console.log(`    归档日期: ${batch.archivedDate}`);
          console.log(`    来源: ${batch.sourceChannel}`);
          console.log(`    总睡眠分钟数: ${batch.totalSleepMinutes ?? 'N/A'}`);
          console.log(`    睡眠记录数: ${batch.sleepRecordCount}`);
          console.log(`    处理时间: ${batch.processedAt}`);
        }
        if (!verbose && result.missingBatches.length > 10) {
          console.log(`  ... 还有 ${result.missingBatches.length - 10} 个批次（使用 --verbose 查看全部）`);
        }
      }

      if (result.partialMismatchBatches && result.partialMismatchBatches.length > 0) {
        console.log('\n批次ID不匹配的情况:');
        for (const batch of result.partialMismatchBatches.slice(0, verbose ? undefined : 10)) {
          console.log(`  - ${batch.batchId}`);
          console.log(`    归档日期: ${batch.archivedDate}`);
          console.log(`    已存在的批次ID: ${batch.existingBatchIds?.join(', ')}`);
        }
        if (!verbose && result.partialMismatchBatches.length > 10) {
          console.log(`  ... 还有 ${result.partialMismatchBatches.length - 10} 个批次（使用 --verbose 查看全部）`);
        }
      }

      const targetDates = extractTargetDatesFromConsistencyResult(result);
      console.log(`\n需要修复的目标日期 (共 ${targetDates.length} 天):`);
      console.log(`  ${targetDates.join(', ')}`);

      console.log('\n修复建议:');
      console.log('  运行以下命令修复数据一致性:');
      console.log('  npm run sync:db');
      console.log('\n  或手动执行睡眠回填:');
      console.log('  npm run backfill:sleep');

      process.exit(1);
    } else {
      console.log('\n✓ 睡眠数据一致性检查通过，无需修复');
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
