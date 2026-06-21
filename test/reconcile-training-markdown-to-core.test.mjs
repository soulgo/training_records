import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { reconcileTrainingMarkdownToCore } from '../tools/reconcile-training-markdown-to-core.mjs';

test('reconcileTrainingMarkdownToCore imports markdown into database when available', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'reconcile-training-markdown-'));
  const markdownPath = path.join(tempRoot, '训练记录.md');
  const importedMarkdown = [];

  await writeFile(markdownPath, '# 训练记录\n\n### 2026-04-06\n', 'utf8');

  const result = await reconcileTrainingMarkdownToCore({
    rootDir: tempRoot,
    importTrainingMarkdownToDatabase: async ({ markdown }) => {
      importedMarkdown.push(markdown);
      return {
        status: 'stored',
        days: 1,
      };
    },
    stderr: { write() {} },
  });

  assert.deepEqual(importedMarkdown, ['# 训练记录\n\n### 2026-04-06\n']);
  assert.deepEqual(result, {
    status: 'stored',
    days: 1,
  });
});

test('reconcileTrainingMarkdownToCore dry-run reports affected days without importing', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'reconcile-training-markdown-dry-run-'));
  const markdownPath = path.join(tempRoot, '训练记录.md');
  let importCalled = false;

  await writeFile(
    markdownPath,
    '# 训练记录\n\n### 2026-04-06\n\n#### 当日运动截图记录\n\n### 2026-04-07\n\n#### 2026-04-07 睡眠截图记录\n',
    'utf8',
  );

  const result = await reconcileTrainingMarkdownToCore({
    rootDir: tempRoot,
    dryRun: true,
    importTrainingMarkdownToDatabase: async () => {
      importCalled = true;
      return { status: 'stored', days: 2 };
    },
    stderr: { write() {} },
  });

  assert.equal(importCalled, false);
  assert.deepEqual(result, {
    status: 'planned',
    dryRun: true,
    readonly: true,
    affectedDays: ['2026-04-06', '2026-04-07'],
    days: 2,
  });
});

test('reconcileTrainingMarkdownToCore defers instead of throwing when database is unavailable', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'reconcile-training-markdown-'));
  const markdownPath = path.join(tempRoot, '训练记录.md');
  const stderrChunks = [];

  await writeFile(markdownPath, '# 训练记录\n\n### 2026-04-06\n', 'utf8');

  const result = await reconcileTrainingMarkdownToCore({
    rootDir: tempRoot,
    importTrainingMarkdownToDatabase: async () => {
      throw new Error('database unavailable');
    },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
  });

  assert.deepEqual(result, {
    status: 'deferred',
    error: 'database unavailable',
  });
  assert.match(stderrChunks.join(''), /database unavailable/);
});
