import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('sync business result rejects unrecovered image recognition failures', async () => {
  const statusModule = await import('../src/app/use-cases/message-sync/status.mjs');
  const result = statusModule.evaluateSyncBusinessResult({
    batches: [
      {
        kind: 'image',
        batchId: 'album-1',
        status: 'skipped',
        failureCategory: 'ai_service',
        sourceImageCount: 4,
        recognizedImageCount: 0,
        failedImageCount: 4,
        recognitionPendingStatus: 'queued',
      },
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    failures: [
      {
        batchId: 'album-1',
        failureCategory: 'ai_service',
        failedImageCount: 4,
      },
    ],
  });
});

test('sync business result accepts fully recognized image batches', async () => {
  const statusModule = await import('../src/app/use-cases/message-sync/status.mjs');
  const result = statusModule.evaluateSyncBusinessResult({
    batches: [
      {
        kind: 'image',
        batchId: 'album-2',
        status: 'ready',
        persistenceStatus: 'stored',
        sourceImageCount: 2,
        recognizedImageCount: 2,
        failedImageCount: 0,
        recognitionErrors: [],
      },
    ],
  });

  assert.deepEqual(result, { ok: true, failures: [] });
});

test('sync business gate exits nonzero with a safe failure summary', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sync-business-result-'));
  const resultPath = path.join(tempRoot, 'result.json');
  await writeFile(
    resultPath,
    JSON.stringify({
      batches: [
        {
          kind: 'image',
          batchId: 'album-3',
          status: 'skipped',
          failureCategory: 'ai_service',
          failedImageCount: 2,
          failureReason: 'sensitive upstream response must not be printed',
        },
      ],
    }),
    'utf8',
  );
  const gateModule = await import('../tools/assert-sync-business-result.mjs');
  let stderr = '';

  const result = await gateModule.main([resultPath], {
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(result.exitCode, 1);
  assert.match(stderr, /album-3:ai_service:2/);
  assert.doesNotMatch(stderr, /sensitive upstream response/);
});
