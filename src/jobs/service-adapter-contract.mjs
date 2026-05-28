// Stable adapter/job boundary contract for future service or queue migration.
// This file intentionally contains only the interface shape documentation helpers.

export function createJobExecutionContext(options = {}) {
  return {
    jobName: options.jobName ?? 'unknown-job',
    runId: options.runId ?? null,
    startedAt: options.startedAt ?? new Date(),
    env: options.env ?? process.env,
    adapter: options.adapter ?? null,
  };
}

export function normalizeJobResult(result) {
  return {
    ok: Boolean(result?.ok ?? true),
    jobName: result?.jobName ?? null,
    changed: Boolean(result?.changed ?? false),
    detail: result?.detail ?? null,
  };
}
