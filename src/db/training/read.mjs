import pg from 'pg';

import { buildTrainingSnapshotFromDaily } from '../../domain/training/training-domain.mjs';
import { resolveTrainingCoreConfig } from './config.mjs';
import {
  readArchiveTrainingSnapshotFromDatabaseClient,
  readArchiveTrainingSnapshotFromDatabaseWithClients,
  readTrainingSnapshotFromDatabaseClient,
  readTrainingSnapshotFromDatabaseWithClients,
} from './read-client.mjs';

const { Client } = pg;

export async function readTrainingSnapshotFromDatabase(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return buildTrainingSnapshotFromDaily([], options.now?.toISOString?.() ?? new Date().toISOString());
  }

  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));

  return readTrainingSnapshotFromDatabaseWithClients({
    createClient,
    config,
    now: options.now,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
  });
}

export async function readArchiveTrainingSnapshotFromDatabase(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return buildTrainingSnapshotFromDaily([], options.now?.toISOString?.() ?? new Date().toISOString());
  }

  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));

  return readArchiveTrainingSnapshotFromDatabaseWithClients({
    createClient,
    config,
    now: options.now,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
  });
}

export async function getLastProcessedTelegramUpdateId(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return 0;
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
    const result = await client.query(`
      select coalesce(max(update_id), 0) as last_processed_update_id
      from ingest.telegram_message
    `);
    return Number(result.rows[0]?.last_processed_update_id ?? 0);
  } finally {
    await client.end();
  }
}

export {
  readArchiveTrainingSnapshotFromDatabaseClient,
  readTrainingSnapshotFromDatabaseClient,
};
