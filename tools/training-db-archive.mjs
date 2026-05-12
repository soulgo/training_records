import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';

const { Client } = pg;

export function resolveTrainingArchiveRuntimeContext(options = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const runtimeEnv = env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local';
  const actorName =
    runtimeEnv === 'github-actions' ? env.GITHUB_ACTOR ?? null : resolveLocalActorName();
  const explicitTrigger = argv.find((arg) => arg.startsWith('--trigger='))?.slice('--trigger='.length);
  const triggerName =
    explicitTrigger ??
    (runtimeEnv === 'github-actions' ? 'github-actions-build' : 'local-build-data');

  return {
    triggerName,
    runtimeEnv,
    actorName,
  };
}

export function resolveTrainingArchiveConfig(env = process.env) {
  const enabled = String(env.TRAINING_DB_ENABLED ?? 'false').toLowerCase() === 'true';

  return {
    enabled,
    url: env.TRAINING_DB_URL?.trim() || '',
    timeoutMs: parsePositiveInteger(env.TRAINING_DB_TIMEOUT_MS, 3000),
    appName: env.TRAINING_DB_APP_NAME?.trim() || 'training-records-dashboard',
    logPath: env.TRAINING_DB_LOG_PATH?.trim() || 'runtime/training-db-sync.ndjson',
  };
}

export async function persistTrainingArchive(options) {
  const config = resolveTrainingArchiveConfig(options.env);
  if (!config.enabled) {
    return {
      status: 'skipped',
      reason: 'disabled',
    };
  }
  if (!config.url) {
    return {
      status: 'skipped',
      reason: 'missing_url',
    };
  }

  const runtimeContext =
    options.runtimeContext ?? resolveTrainingArchiveRuntimeContext({ env: options.env });
  const runId = randomUUID();
  const sourceHash = createHash('sha256').update(options.markdownRaw, 'utf8').digest('hex');
  const dailyCount = options.parsed.daily.length;
  const latestArchivedDate =
    options.parsed.latest?.daily?.date ?? options.parsed.daily.at(-1)?.date ?? null;
  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));

  const client = createClient(config);
  let transactionStarted = false;

  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    await client.query(
      `
        insert into archive.training_parse_snapshot (
          source_hash,
          payload_version,
          payload_json,
          daily_count,
          latest_archived_date,
          parsed_generated_at,
          first_seen_at,
          last_seen_at
        )
        values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
        on conflict (source_hash) do update set
          payload_version = excluded.payload_version,
          payload_json = excluded.payload_json,
          daily_count = excluded.daily_count,
          latest_archived_date = excluded.latest_archived_date,
          parsed_generated_at = excluded.parsed_generated_at,
          last_seen_at = excluded.last_seen_at
      `,
      [
        sourceHash,
        1,
        JSON.stringify(options.parsed),
        dailyCount,
        latestArchivedDate,
        options.parsed.generatedAt,
        options.runFinishedAt.toISOString(),
        options.runFinishedAt.toISOString(),
      ],
    );

    await client.query(
      `
        insert into archive.training_parse_run (
          run_id,
          source_hash,
          trigger_name,
          actor_name,
          runtime_env,
          run_started_at,
          run_finished_at,
          daily_count,
          latest_archived_date,
          main_output_written,
          db_sync_status
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        runId,
        sourceHash,
        runtimeContext.triggerName,
        runtimeContext.actorName,
        runtimeContext.runtimeEnv,
        options.runStartedAt.toISOString(),
        options.runFinishedAt.toISOString(),
        dailyCount,
        latestArchivedDate,
        true,
        'success',
      ],
    );

    await client.query('COMMIT');
    transactionStarted = false;

    return {
      status: 'synced',
      runId,
      sourceHash,
      dailyCount,
      latestArchivedDate,
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    await client.end();
  }
}

export async function appendTrainingArchiveFailureLog(options) {
  const config = resolveTrainingArchiveConfig(options.env);
  const rootDir = options.rootDir ?? process.cwd();
  const logPath = path.join(rootDir, config.logPath);

  await mkdir(path.dirname(logPath), { recursive: true });

  const latestArchivedDate =
    options.parsed?.latest?.daily?.date ?? options.parsed?.daily?.at(-1)?.date ?? null;
  const payload = {
    loggedAt: new Date().toISOString(),
    triggerName: options.runtimeContext?.triggerName ?? null,
    runtimeEnv: options.runtimeContext?.runtimeEnv ?? null,
    actorName: options.runtimeContext?.actorName ?? null,
    runStartedAt: options.runStartedAt?.toISOString?.() ?? null,
    runFinishedAt: options.runFinishedAt?.toISOString?.() ?? null,
    dailyCount: options.parsed?.daily?.length ?? null,
    latestArchivedDate,
    error: options.error instanceof Error ? options.error.message : String(options.error),
  };

  await appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveLocalActorName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? null;
  }
}
