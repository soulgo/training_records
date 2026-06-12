import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runTrainingMaintenance } from '../tools/training-maintenance.mjs';

test('training maintenance inspect is read-only and reports database pending queue counts', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-maintenance-inspect-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, 'training-archive-failures.ndjson'),
    `${JSON.stringify({ error: 'database unavailable' })}\n`,
    'utf8',
  );

  let syncCalled = false;
  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    rootDir: tempRoot,
    syncTrainingCore: async () => {
      syncCalled = true;
      return { status: 'stored' };
    },
    readPendingBatches: async () => [
      { batchId: 'pending-1', failureCategory: 'database' },
      { batchId: 'pending-2', failureCategory: 'ai_service' },
    ],
    stdout: { write() {} },
  });

  assert.equal(syncCalled, false);
  assert.equal(result.mode, 'inspect');
  assert.equal(result.readonly, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.data.pendingDatabaseCount, 2);
  assert.equal(result.data.pendingDatabaseStatus, 'ok');
  assert.equal(result.data.pendingDatabaseError, null);
  assert.equal(result.data.archiveFailureCount, 1);
});

test('training maintenance sync delegates to syncTrainingCore', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync'],
    env: { TRAINING_DB_ENABLED: 'false' },
    syncTrainingCore: async (options) => {
      calls.push(options);
      return { status: 'unchanged', archive: { status: 'unchanged' } };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'safe');
  assert.equal(result.mode, 'sync');
  assert.equal(result.phase, 'safe');
  assert.equal(result.readonly, false);
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.result, { status: 'unchanged', archive: { status: 'unchanged' } });
});

test('training maintenance inspect reports unavailable database pending queue without file fallback', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-maintenance-inspect-db-'));

  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    rootDir: tempRoot,
    readPendingBatches: async () => {
      throw new Error('database unavailable');
    },
    stdout: { write() {} },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.data.pendingDatabaseCount, 0);
  assert.equal(result.data.pendingDatabaseStatus, 'unavailable');
  assert.match(result.data.pendingDatabaseError, /database unavailable/);
});

test('training maintenance inspect still reports archive failure log count', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-maintenance-inspect-archive-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, 'training-archive-failures.ndjson'),
    `${JSON.stringify({ error: 'database unavailable' })}\nnot-json\n`,
    'utf8',
  );

  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    rootDir: tempRoot,
    readPendingBatches: async () => [],
    stdout: { write() {} },
  });

  assert.equal(result.data.archiveFailureCount, 1);
  assert.equal(result.data.archiveFailureInvalidLines, 1);
});

test('training maintenance sync can explicitly run all database phases', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync', '--phase', 'all'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return {
        status: 'stored',
        archive: { status: 'unchanged' },
        ingest: { status: 'unchanged' },
        markdown: { status: 'stored', days: 1 },
        thoughts: { status: 'unchanged' },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'all');
  assert.equal(result.mode, 'sync');
  assert.equal(result.phase, 'all');
  assert.equal(result.status, 'stored');
  assert.equal(result.result.markdown.status, 'stored');
});

test('training maintenance sync can run one legacy database phase through the unified entrypoint', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync', '--phase', 'archive'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return { status: 'unchanged', archive: { status: 'unchanged' } };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'archive');
  assert.equal(result.mode, 'sync');
  assert.equal(result.phase, 'archive');
  assert.equal(result.status, 'unchanged');
});

test('training maintenance sync can run the ingest repair phase directly', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync', '--phase', 'ingest'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return { status: 'stored', ingest: { status: 'stored', batchesBackfilled: 1 } };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'ingest');
  assert.equal(result.mode, 'sync');
  assert.equal(result.phase, 'ingest');
  assert.equal(result.status, 'stored');
});

test('training maintenance export delegates markdown export through the unified entrypoint', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['export', 'markdown'],
    exportDerivedTrainingMarkdown: async (options) => {
      calls.push(options);
      return {
        outputPath: '训练记录.md',
        snapshot: { generatedAt: '2026-06-03T00:00:00.000Z' },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.mode, 'export');
  assert.equal(result.target, 'markdown');
  assert.equal(result.status, 'stored');
  assert.equal(result.result.outputPath, '训练记录.md');
});

test('training maintenance migrate requires dry-run or confirm before write-capable work', async () => {
  let syncCalled = false;
  const result = await runTrainingMaintenance({
    argv: ['migrate'],
    syncTrainingCore: async () => {
      syncCalled = true;
      return { status: 'stored' };
    },
    stdout: { write() {} },
  });

  assert.equal(syncCalled, false);
  assert.equal(result.mode, 'migrate');
  assert.equal(result.status, 'blocked');
  assert.equal(result.requiresConfirm, true);
});

test('training maintenance migrate supports dry-run without running sync', async () => {
  let syncCalled = false;
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--dry-run'],
    syncTrainingCore: async () => {
      syncCalled = true;
      return { status: 'stored' };
    },
    stdout: { write() {} },
  });

  assert.equal(syncCalled, false);
  assert.equal(result.mode, 'migrate');
  assert.equal(result.status, 'planned');
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.plan, ['sync committed archive, ingest repairs, and thoughts into core tables']);
});

test('training maintenance migrate runs only with explicit confirm', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--confirm'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return { status: 'stored' };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceChannel, 'maintenance_migrate');
  assert.equal(result.mode, 'migrate');
  assert.equal(result.status, 'stored');
  assert.equal(result.confirmed, true);
});

test('package exposes explicit maintenance command boundaries', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageJson.scripts['maintenance:inspect'], 'node tools/training-maintenance.mjs inspect');
  assert.equal(packageJson.scripts['maintenance:sync'], 'node tools/training-maintenance.mjs sync');
  assert.equal(packageJson.scripts['maintenance:migrate'], 'node tools/training-maintenance.mjs migrate');
  assert.equal(packageJson.scripts['backfill:core'], 'node tools/training-maintenance.mjs sync --phase archive');
  assert.equal(packageJson.scripts['backfill:thoughts'], 'node tools/training-maintenance.mjs sync --phase thoughts');
  assert.equal(packageJson.scripts['import:markdown'], 'node tools/training-maintenance.mjs sync --phase markdown');
  assert.equal(packageJson.scripts['reconcile:markdown'], 'node tools/training-maintenance.mjs sync --phase markdown');
  assert.equal(packageJson.scripts['export:markdown'], 'node tools/training-maintenance.mjs export markdown');
});

test('training maintenance import markdown remains an explicit legacy phase', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync', '--phase', 'markdown'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return { status: 'stored', markdown: { status: 'stored', days: 1 } };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'markdown');
  assert.equal(result.phase, 'markdown');
  assert.equal(result.status, 'stored');
});

test('v8 maintenance guide documents inspect sync and migrate commands', async () => {
  const guide = await readFile(
    new URL('../docs/优化重构/部署与同步优化_v8/maintenance_scripts.md', import.meta.url),
    'utf8',
  );

  assert.match(guide, /npm run maintenance:inspect/);
  assert.match(guide, /npm run maintenance:sync/);
  assert.match(guide, /--phase archive/);
  assert.match(guide, /--phase markdown/);
  assert.match(guide, /tools\/training-maintenance\.mjs export markdown/);
  assert.match(guide, /npm run maintenance:migrate -- --dry-run/);
  assert.match(guide, /npm run maintenance:migrate -- --confirm/);
});

test('v8 overview links the maintenance guide and current CI/test controls', async () => {
  const overview = await readFile(
    new URL('../docs/优化重构/部署与同步优化_v8/re_optimization_v8.md', import.meta.url),
    'utf8',
  );
  const deploy = await readFile(
    new URL('../docs/优化重构/部署与同步优化_v8/deploy_and_build.md', import.meta.url),
    'utf8',
  );
  const telegram = await readFile(
    new URL('../docs/优化重构/部署与同步优化_v8/telegram_sync_refactor.md', import.meta.url),
    'utf8',
  );

  assert.match(overview, /maintenance_scripts\.md/);
  assert.match(deploy, /sync_db_mode/);
  assert.match(deploy, /full-test/);
  assert.match(telegram, /taskStatus/);
  assert.match(telegram, /failureDisposition/);
});

test('v8 overview documents the local document index and historical replacements', async () => {
  const overview = await readFile(
    new URL('../docs/优化重构/部署与同步优化_v8/re_optimization_v8.md', import.meta.url),
    'utf8',
  );

  assert.match(overview, /deploy_and_build\.md/);
  assert.match(overview, /telegram_sync_refactor\.md/);
  assert.match(overview, /maintenance_scripts\.md/);
  assert.match(overview, /checklist\.md/);
  assert.match(overview, /构建性能优化_v7/);
  assert.match(overview, /图片识别优化_v6/);
  assert.match(overview, /系统优化重构_v5/);
  assert.match(overview, /历史参考/);
});
