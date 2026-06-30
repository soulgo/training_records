import pg from 'pg';

import { buildTrainingSnapshotFromDaily } from '../../domain/training/training-domain.mjs';
import { resolveTrainingCoreConfig, resolveTrainingReadonlyConfig } from './config.mjs';
import {
  readArchiveTrainingSnapshotFromDatabaseClient,
  readArchiveTrainingSnapshotFromDatabaseWithClients,
  readTrainingSnapshotFromDatabaseClient,
  readTrainingSnapshotFromDatabaseWithClients,
} from './read-client.mjs';
import { getLastProcessedTelegramUpdateId as getLastUpdateIdFromAdapter } from '../../adapters/postgres/telegram-batch-repository.pg.mjs';

const { Client } = pg;

export async function readTrainingSnapshotFromDatabase(options = {}) {
  const config = resolveTrainingReadonlyConfig(options.env);
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
  const config = resolveTrainingReadonlyConfig(options.env);
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
    return await getLastUpdateIdFromAdapter(client);
  } finally {
    await client.end();
  }
}

export {
  readArchiveTrainingSnapshotFromDatabaseClient,
  readTrainingSnapshotFromDatabaseClient,
};
