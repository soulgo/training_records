import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillCoreFromLatestArchiveSnapshot } from '../src/db/training/write.mjs';

export async function backfillTrainingCoreFromArchive(options = {}) {
  const stderr = options.stderr ?? process.stderr;
  const backfill =
    options.backfillCoreFromLatestArchiveSnapshot ?? backfillCoreFromLatestArchiveSnapshot;

  try {
    return await backfill({
      env: options.env ?? process.env,
      createClient: options.createClient,
      processedAt: options.processedAt,
      sourceChannel: options.sourceChannel,
      batchId: options.batchId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[backfill-training-core-from-archive] ${message}\n`);
    return {
      status: 'deferred',
      error: message,
    };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await backfillTrainingCoreFromArchive();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
