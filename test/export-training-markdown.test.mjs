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

test('exportDerivedTrainingMarkdown falls back to markdown when database snapshot lacks measurements', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];
  const stderrChunks = [];

  await writeFile(recordPath, '# 训练记录\n\n### 2026-04-06\n', 'utf8');

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
    buildTrainingSnapshot: async ({ source }) => {
      observedSources.push(source);
      if (source === 'database') {
        throw new Error('database snapshot is empty or missing measurements');
      }
      return {
        generatedAt: '2026-05-13T00:00:00.000Z',
        latest: {
          measurement: {
            archivedDate: '2026-04-06',
            measuredAt: '2026-04-06 07:00',
            weightKg: 72.4,
          },
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

  assert.deepEqual(observedSources, ['database', 'markdown']);
  assert.match(await readFile(recordPath, 'utf8'), /2026-04-06/);
  assert.match(stderrChunks.join(''), /falling back to markdown/i);
});

test('exportDerivedTrainingMarkdown falls back to markdown when database snapshot is unavailable', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];
  const stderrChunks = [];

  await writeFile(recordPath, '# 训练记录\n\n### 2026-05-14\n', 'utf8');

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
    buildTrainingSnapshot: async ({ source }) => {
      observedSources.push(source);
      if (source === 'database') {
        throw new Error('database snapshot unavailable: timeout expired');
      }
      return {
        generatedAt: '2026-05-14T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-14' },
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
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-05-14\n',
  });

  assert.deepEqual(observedSources, ['database', 'markdown']);
  assert.match(await readFile(recordPath, 'utf8'), /2026-05-14/);
  assert.match(stderrChunks.join(''), /timeout expired; falling back to markdown/i);
});

test('exportDerivedTrainingMarkdown does not hide incomplete database snapshots when database is not configured', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];

  await writeFile(recordPath, '# 训练记录\n\n### 2026-04-06\n', 'utf8');

  await assert.rejects(
    exportDerivedTrainingMarkdown({
      rootDir: tempRoot,
      source: 'database',
      env: {
        TRAINING_DB_ENABLED: 'false',
      },
      buildTrainingSnapshot: async ({ source }) => {
        observedSources.push(source);
        throw new Error('database snapshot is empty or missing measurements');
      },
    }),
    /database snapshot is empty or missing measurements/i,
  );

  assert.deepEqual(observedSources, ['database']);
});
