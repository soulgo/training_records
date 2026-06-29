import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('action sync summary renders trace AI database image storage and warning sections', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'action-sync-summary-'));
  const resultPath = path.join(tempRoot, 'telegram-result.json');
  await writeFile(
    resultPath,
    JSON.stringify({
      timingsMs: { fetchUpdates: 7, persist: 12, total: 30 },
      batchResults: [
        {
          kind: 'image',
          batchId: 'single-727',
          status: 'ready',
          archivedDate: '2026-06-28',
          persistenceStatus: 'stored',
          messages: [{ messageId: 727, chatId: 6314355239, updateId: 520905856 }],
          recognitions: [
            {
              messageId: 727,
              provider: 'openai-compatible',
              model: 'gpt-vision-fast',
              promptVersion: '2026-06-20',
              aiAttemptKind: 'normal',
              aiUsage: { totalTokens: 1234 },
            },
          ],
          syncStages: { ai_schema: { status: 'succeeded', durationMs: 4567 } },
          persistenceResult: {
            status: 'stored',
            transactionId: 'dbtx_1234567890abcdef',
            sourceChannel: 'telegram',
            rowCounts: { ingestBatch: 1, ingestMessage: 1, ingestRecognition: 1, coreMeasurement: 1 },
            pendingStatus: null,
            rollbackStatus: null,
            durationMs: 89,
            slowQueries: [{ operation: 'persist.batch', table: 'core.measurement', durationMs: 1500, thresholdMs: 1000 }],
          },
          imageUploadStats: {
            provider: 'tencent_cos',
            bucket: 'private-training-bucket',
            pathPrefix: 'thoughts/2026/06',
            uploaded: 1,
            skipped: 2,
            failed: 0,
            totalUploadMs: 33,
            maxSingleUploadMs: 22,
            firstUrlHost: 'cdn.example.com',
          },
        },
      ],
    }),
    'utf8',
  );

  const output = execFileSync(
    process.execPath,
    [
      'tools/action-sync-summary.mjs',
      '--channel',
      'telegram',
      '--result-path',
      resultPath,
      '--trace-id',
      'tr_1234567890abcdef',
      '--queue-task-id',
      'telegram:520905856:telegram_update:8dbfe3e65db19d85',
      '--workflow',
      'Sync (Main)',
      '--run-id',
      '28307557280',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  assert.match(output, /## Telegram sync result/);
  assert.match(output, /Run context/);
  assert.match(output, /tr_1234567890abcdef/);
  assert.match(output, /Business result/);
  assert.match(output, /single-727/);
  assert.match(output, /AI/);
  assert.match(output, /openai-compatible/);
  assert.match(output, /gpt-vision-fast/);
  assert.match(output, /2026-06-20/);
  assert.match(output, /1234/);
  assert.match(output, /Database/);
  assert.match(output, /dbtx_1234567890abcdef/);
  assert.match(output, /coreMeasurement=1/);
  assert.match(output, /slow=1/);
  assert.match(output, /Image storage/);
  assert.match(output, /cdn\.example\.com/);
  assert.doesNotMatch(output, /6314355239|private-training-bucket|thoughts\/2026\/06/);
});

test('action sync summary logs one structured completion event to stderr', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'action-sync-summary-log-'));
  const resultPath = path.join(tempRoot, 'telegram-result.json');
  await writeFile(resultPath, JSON.stringify({ batchResults: [] }), 'utf8');

  let stderr = '';
  execFileSync(
    process.execPath,
    [
      'tools/action-sync-summary.mjs',
      '--channel',
      'telegram',
      '--result-path',
      resultPath,
      '--trace-id',
      'tr_aaaaaaaaaaaaaaaa',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).toString();
  try {
    execFileSync(
      process.execPath,
      [
        'tools/action-sync-summary.mjs',
        '--channel',
        'telegram',
        '--result-path',
        resultPath,
        '--trace-id',
        'tr_aaaaaaaaaaaaaaaa',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    stderr = error.stderr?.toString?.() ?? '';
  }

  if (!stderr) {
    const child = execFileSync(
      process.execPath,
      [
        '-e',
        `
        import { spawnSync } from 'node:child_process';
        const run = spawnSync(process.execPath, ['tools/action-sync-summary.mjs', '--channel', 'telegram', '--result-path', ${JSON.stringify(resultPath)}, '--trace-id', 'tr_aaaaaaaaaaaaaaaa'], { encoding: 'utf8' });
        process.stdout.write(run.stderr);
        `,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    stderr = child;
  }

  assert.match(stderr, /^\[action-log\] /);
  const event = JSON.parse(stderr.replace(/^\[action-log\] /, ''));
  assert.equal(event.level, 'INFO');
  assert.equal(event.domain, 'ACTION');
  assert.equal(event.event, 'sync.summary.completed');
  assert.equal(event.traceId, 'tr_aaaaaaaaaaaaaaaa');
});

test('action sync summary redacts Feishu oc ids from source fields', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'action-sync-summary-feishu-'));
  const resultPath = path.join(tempRoot, 'feishu-result.json');
  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'thought',
          status: 'ready',
          batchId: 'feishu:oc_47126c2d831c7a201c30c801ad77ef71:om_1',
          sourceId: 'oc_47126c2d831c7a201c30c801ad77ef71',
          chatIds: ['oc_47126c2d831c7a201c30c801ad77ef71'],
          messages: [
            {
              sourceChannel: 'feishu',
              sourceChatId: 'oc_47126c2d831c7a201c30c801ad77ef71',
              sourceMessageId: 'om_1',
            },
          ],
          persistenceStatus: 'stored',
        },
      ],
    }),
    'utf8',
  );

  const output = execFileSync(
    process.execPath,
    [
      'tools/action-sync-summary.mjs',
      '--channel',
      'feishu',
      '--result-path',
      resultPath,
      '--trace-id',
      'tr_bbbbbbbbbbbbbbbb',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  assert.match(output, /## Feishu sync result/);
  assert.doesNotMatch(output, /oc_47126c2d831c7a201c30c801ad77ef71/);
  assert.match(output, /sha256:[a-f0-9]{16}/);
});

test('action sync summary reports missing result file without failing the workflow summary step', () => {
  const output = execFileSync(
    process.execPath,
    [
      'tools/action-sync-summary.mjs',
      '--channel',
      'telegram',
      '--result-path',
      '/tmp/does-not-exist-action-sync-summary.json',
      '--trace-id',
      'tr_cccccccccccccccc',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  assert.match(output, /Result file was not written/);
});
