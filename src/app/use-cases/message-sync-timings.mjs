export function createSyncTimings() {
  return {
    startedAt: nowMs(),
    timingsMs: {},
  };
}

export async function measureSyncStage(timings, stage, run) {
  const startedAt = nowMs();
  try {
    return await run();
  } finally {
    addTiming(timings, stage, elapsedMs(startedAt));
  }
}

export function measureSyncStageSync(timings, stage, run) {
  const startedAt = nowMs();
  try {
    return run();
  } finally {
    addTiming(timings, stage, elapsedMs(startedAt));
  }
}

export function addTiming(timings, stage, durationMs) {
  if (!timings?.timingsMs || !stage) {
    return;
  }
  timings.timingsMs[stage] = Math.round((timings.timingsMs[stage] ?? 0) + durationMs);
}

export function finalizeSyncTimings(timings, result) {
  timings.timingsMs.total = elapsedMs(timings.startedAt);
  result.timingsMs = timings.timingsMs;
}

export function elapsedMs(startedAt) {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

export function nowMs() {
  return Number(globalThis.performance?.now?.() ?? Date.now());
}

export function logSyncTimings(timingsMs) {
  if (!timingsMs || Object.keys(timingsMs).length === 0) {
    return;
  }
  process.stderr.write(`[telegram-sync] timings ${JSON.stringify(timingsMs)}\n`);
}

export function withPendingStatus(summary, pendingStatus) {
  if (!summary) {
    return null;
  }
  return {
    ...summary,
    pendingStatus,
  };
}
