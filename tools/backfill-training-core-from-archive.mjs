import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillCoreFromLatestArchiveSnapshot } from './training-db-core.mjs';

export async function backfillTrainingCoreFromArchive(options = {}) {
  return backfillCoreFromLatestArchiveSnapshot({
    env: options.env ?? process.env,
    createClient: options.createClient,
    processedAt: options.processedAt,
    sourceChannel: options.sourceChannel,
    batchId: options.batchId,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await backfillTrainingCoreFromArchive();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
