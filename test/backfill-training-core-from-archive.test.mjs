import test from 'node:test';
import assert from 'node:assert/strict';

import { backfillTrainingCoreFromArchive } from '../tools/backfill-training-core-from-archive.mjs';

test('backfillTrainingCoreFromArchive defers instead of throwing when database is unavailable', async () => {
  const stderrChunks = [];

  const result = await backfillTrainingCoreFromArchive({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    backfillCoreFromLatestArchiveSnapshot: async () => {
      throw new Error('timeout expired');
    },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
  });

  assert.deepEqual(result, {
    status: 'deferred',
    error: 'timeout expired',
  });
  assert.match(stderrChunks.join(''), /timeout expired/);
});
