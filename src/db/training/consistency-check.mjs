import pg from 'pg';

import { resolveTrainingReadonlyConfig } from '../../adapters/postgres/training-config.pg.mjs';

const { Client } = pg;

export async function checkTrainingDataConsistency(options = {}) {
  const config = resolveTrainingReadonlyConfig(options.env);
  if (!config.enabled || !config.url) {
    return {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
      checks: [],
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
    const checks = await checkTrainingDataConsistencyClient(client);
    return {
      status: checks.every((check) => check.status === 'ok') ? 'ok' : 'failed',
      checks,
    };
  } finally {
    await client.end();
  }
}

export async function checkTrainingDataConsistencyClient(client) {
  const checks = [];

  checks.push(await compareCoreAndArchiveTrainingDayCounts(client));
  checks.push(await countRows(client, {
    name: 'core.sleep has no orphaned records',
    sql: `
      select count(*)::int as count
      from core.sleep s
      left join core.training_day d on d.archived_date = s.archived_date
      where d.archived_date is null
    `,
  }));
  checks.push(await countRows(client, {
    name: "ready ingest.source_batch rows have core.training_day",
    sql: `
      select count(*)::int as count
      from ingest.source_batch b
      left join core.training_day d on d.archived_date = b.archived_date
      where b.status = 'ready'
        and b.archived_date is not null
        and d.archived_date is null
    `,
  }));
  checks.push(await countRows(client, {
    name: 'core.measurement numeric fields are in expected ranges',
    sql: `
      select count(*)::int as count
      from core.measurement
      where weight_kg < 0
        or weight_kg > 400
        or body_fat_pct < 0
        or body_fat_pct > 80
        or skeletal_muscle_kg < 0
        or basal_metabolism_kcal < 0
        or basal_metabolism_kcal > 10000
    `,
  }));
  checks.push(await countRows(client, {
    name: 'core.activity activity_type is in expected range',
    sql: `
      select count(*)::int as count
      from core.activity
      where activity_type is null
        or btrim(activity_type) = ''
        or activity_type not in (
          '户外骑行',
          '力量训练',
          '燃脂训练',
          '骑行',
          '跑步',
          '步行',
          'outdoor_cycling',
          'traditional_strength_training',
          'mixed_cardio',
          '自由训练'
        )
    `,
  }));
  checks.push(await countRows(client, {
    name: 'core.sleep bedtime is before wake_time when both are present',
    sql: `
      select count(*)::int as count
      from core.sleep
      where bedtime is not null
        and wake_time is not null
        and bedtime >= wake_time
    `,
  }));
  checks.push(await checkCoreTrainingDaySleepSummaryColumns(client));

  return checks;
}

async function checkCoreTrainingDaySleepSummaryColumns(client) {
  const expectedColumns = [
    'sleep_total_minutes',
    'night_sleep_minutes',
    'nap_minutes',
    'sleep_start_time',
    'sleep_end_time',
    'deep_sleep_minutes',
    'light_sleep_minutes',
    'rem_sleep_minutes',
    'awake_minutes',
  ];
  const result = await client.query(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'core'
        and table_name = 'training_day'
        and column_name = any($1::text[])
    `,
    [expectedColumns],
  );
  const present = new Set(result.rows.map((row) => row.column_name));
  const missing = expectedColumns.filter((column) => !present.has(column));
  return {
    name: 'core.training_day sleep summary fields exist',
    status: missing.length === 0 ? 'ok' : 'failed',
    missing,
    details: missing.length === 0 ? 'schema decision: sleep summary is stored on core.training_day and refreshed from core.sleep' : null,
  };
}

async function compareCoreAndArchiveTrainingDayCounts(client) {
  const result = await client.query(`
    select
      (select count(*)::int from core.training_day) as core_count,
      (select count(distinct archived_date)::int from archive.training_day) as archive_count
  `);
  const row = result.rows[0] ?? {};
  const coreCount = Number(row.core_count ?? 0);
  const archiveCount = Number(row.archive_count ?? 0);
  return {
    name: 'core.training_day and archive.training_day counts are aligned',
    status: coreCount === archiveCount ? 'ok' : 'warning',
    coreCount,
    archiveCount,
    details: coreCount === archiveCount ? null : 'count differs; verify expected archive/core scope differences',
  };
}

async function countRows(client, { name, sql }) {
  const result = await client.query(sql);
  const count = Number(result.rows[0]?.count ?? 0);
  return {
    name,
    status: count === 0 ? 'ok' : 'failed',
    count,
  };
}
