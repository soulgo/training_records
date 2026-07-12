export function resolveTrainingCoreConfig(env = process.env) {
  const enabled = String(env.TRAINING_DB_ENABLED ?? 'false').toLowerCase() === 'true';

  return {
    enabled,
    url: env.TRAINING_DB_URL?.trim() || '',
    timeoutMs: parsePositiveInteger(env.TRAINING_DB_TIMEOUT_MS, 5000),
    appName: env.TRAINING_DB_APP_NAME?.trim() || 'training-records-dashboard',
  };
}

export function resolveTrainingReadonlyConfig(env = process.env) {
  const config = resolveTrainingCoreConfig(env);
  return {
    ...config,
    url: env.TRAINING_DB_READONLY_URL?.trim() || config.url,
  };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
