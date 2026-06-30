export function resolveTrainingCoreConfig(env = process.env) {
  const enabled = String(env.TRAINING_DB_ENABLED ?? 'false').toLowerCase() === 'true';

  return {
    enabled,
    url: env.TRAINING_DB_URL?.trim() || '',
    timeoutMs: parsePositiveInteger(env.TRAINING_DB_TIMEOUT_MS, 5000),
    appName: env.TRAINING_DB_APP_NAME?.trim() || 'training-records-dashboard',
    schemaPreflightEnabled: normalizeBooleanFlag(env.TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED),
  };
}

export function resolveTrainingReadonlyConfig(env = process.env) {
  const config = resolveTrainingCoreConfig(env);
  return {
    ...config,
    url: env.TRAINING_DB_READONLY_URL?.trim() || config.url,
  };
}

export function resolveTrainingMigrationConfig(env = process.env) {
  const config = resolveTrainingCoreConfig(env);
  const migrationUrl = env.TRAINING_DB_MIGRATION_URL?.trim() || '';
  return {
    ...config,
    enabled: Boolean(migrationUrl),
    url: migrationUrl,
    appName: env.TRAINING_DB_MIGRATION_APP_NAME?.trim() || `${config.appName}-migration`,
  };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBooleanFlag(value) {
  return String(value ?? 'false').toLowerCase() === 'true';
}
