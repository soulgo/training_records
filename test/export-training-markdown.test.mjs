import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { exportDerivedTrainingMarkdown } from '../tools/export-training-markdown.mjs';

test('exportDerivedTrainingMarkdown prefers markdown when telegram fallback batches are pending', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];

  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, 'telegram-sync-pending.ndjson'),
    `${JSON.stringify({ batch: { batchId: 'pending-1' } })}\n`,
    'utf8',
  );
  await writeFile(recordPath, '# 训练记录\n\n### 2026-04-06\n', 'utf8');

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    buildTrainingSnapshot: async ({ source }) => {
      observedSources.push(source);
      return {
        generatedAt: '2026-05-13T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-04-06' },
        },
        daily: [],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      };
    },
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-04-06\n',
  });

  assert.deepEqual(observedSources, ['markdown']);
  assert.match(await readFile(recordPath, 'utf8'), /2026-04-06/);
});

test('exportDerivedTrainingMarkdown uses database when no telegram fallback batches are pending', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const observedSources = [];

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    buildTrainingSnapshot: async ({ source }) => {
      observedSources.push(source);
      return {
        generatedAt: '2026-05-13T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-12' },
        },
        daily: [],
        charts: {
          weightKg: [],
          bodyFatPct: [],
          skeletalMuscleKg: [],
          basalMetabolism: [],
          visceralFatLevel: [],
          intakeCalories: [],
          trainingCalories: [],
          cyclingDistanceKm: [],
        },
      };
    },
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-05-12\n',
  });

  assert.deepEqual(observedSources, ['database']);
});
