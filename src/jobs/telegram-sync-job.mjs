import { runTelegramSync, buildTelegramSyncReport } from '../../tools/telegram-sync.mjs';

// Job layer orchestration for Telegram sync.
// Keep process orchestration here so tools/ can remain a CLI compatibility layer.

export async function runTelegramSyncJob(options = {}) {
  return runTelegramSync(options);
}

export function buildTelegramSyncJobReport(result) {
  return buildTelegramSyncReport(result);
}
