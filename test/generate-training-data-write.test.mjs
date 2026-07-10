import test from 'node:test';
import assert from 'node:assert/strict';

import { writeJsonFileWithRetry } from '../src/app/use-cases/generate-training-data.impl.mjs';

test('writeJsonFileWithRetry retries transient Windows file write errors', async () => {
  const writes = [];
  let attempts = 0;

  await writeJsonFileWithRetry('source/_data/dashboardView.json', { ok: true }, {
    delayMs: 0,
    async writeFileImpl(filePath, content, encoding) {
      attempts += 1;
      writes.push({ filePath, content, encoding });
      if (attempts === 1) {
        const error = new Error('unknown error, open file');
        error.code = 'UNKNOWN';
        throw error;
      }
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(writes.at(-1), {
    filePath: 'source/_data/dashboardView.json',
    content: '{\n  "ok": true\n}\n',
    encoding: 'utf8',
  });
});
