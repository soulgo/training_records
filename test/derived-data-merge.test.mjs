import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { checkDerivedDataMerge } from '../tools/check-derived-data-merge.mjs';
import { mergeDevToMain } from '../tools/merge-dev-to-main.mjs';
import { isDerivedDataPath } from '../tools/lib/derived-data-paths.mjs';

const execFileAsync = promisify(execFile);

test('derived data path helper protects generated training and Telegram backup paths', () => {
  assert.equal(isDerivedDataPath('训练记录.md'), true);
  assert.equal(isDerivedDataPath('source/_posts/2026-05-14-telegram-thought-501.md'), true);
  assert.equal(isDerivedDataPath('source/images/thoughts/2026/05/image.jpg'), true);
  assert.equal(isDerivedDataPath('source/_posts/2026-05-09-post-workout-glute-pain.md'), false);
  assert.equal(isDerivedDataPath('docs/训练系统/Telegram使用说明.md'), false);
});

test('mergeDevToMain keeps main derived data while merging code, docs, and regular posts', async () => {
  const repo = await createRepo('derived-merge-');
  await writeText(repo, '训练记录.md', 'main training\n');
  await writeText(repo, 'source/_posts/2026-05-10-telegram-thought-100.md', 'main thought\n');
  await writeText(repo, 'source/images/thoughts/2026/05/main.jpg', 'main image\n');
  await writeText(repo, 'source/_posts/2026-05-09-post-workout-glute-pain.md', 'main regular post\n');
  await writeText(repo, 'src/app.mjs', 'export const value = "main";\n');
  await writeText(repo, 'docs/guide.md', 'main docs\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'main data']);
  const mainBeforeMerge = await gitText(repo, ['rev-parse', 'HEAD']);

  await git(repo, ['checkout', '-b', 'dev']);
  await writeText(repo, '训练记录.md', 'dev training should not merge\n');
  await writeText(repo, 'source/_posts/2026-05-10-telegram-thought-100.md', 'dev thought should not merge\n');
  await writeText(repo, 'source/_posts/2026-05-11-telegram-thought-101.md', 'dev new thought should not merge\n');
  await writeText(repo, 'source/images/thoughts/2026/05/main.jpg', 'dev image should not merge\n');
  await writeText(repo, 'source/images/thoughts/2026/05/dev.jpg', 'dev new image should not merge\n');
  await writeText(repo, 'source/_posts/2026-05-09-post-workout-glute-pain.md', 'dev regular post\n');
  await writeText(repo, 'src/app.mjs', 'export const value = "dev";\n');
  await writeText(repo, 'docs/guide.md', 'dev docs\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'dev code and data']);

  await git(repo, ['checkout', 'main']);
  const result = await mergeDevToMain({
    cwd: repo,
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.equal(result.committed, true);
  assert.equal(result.mainCommit, mainBeforeMerge);
  assert.deepEqual(result.protectedPaths, [
    'source/_posts/2026-05-10-telegram-thought-100.md',
    'source/_posts/2026-05-11-telegram-thought-101.md',
    'source/images/thoughts/2026/05/dev.jpg',
    'source/images/thoughts/2026/05/main.jpg',
    '训练记录.md',
  ]);
  assert.equal(await readText(repo, '训练记录.md'), 'main training\n');
  assert.equal(await readText(repo, 'source/_posts/2026-05-10-telegram-thought-100.md'), 'main thought\n');
  await assert.rejects(readFile(path.join(repo, 'source/_posts/2026-05-11-telegram-thought-101.md'), 'utf8'), /ENOENT/u);
  assert.equal(await readText(repo, 'source/images/thoughts/2026/05/main.jpg'), 'main image\n');
  await assert.rejects(readFile(path.join(repo, 'source/images/thoughts/2026/05/dev.jpg'), 'utf8'), /ENOENT/u);
  assert.equal(await readText(repo, 'source/_posts/2026-05-09-post-workout-glute-pain.md'), 'dev regular post\n');
  assert.equal(await readText(repo, 'src/app.mjs'), 'export const value = "dev";\n');
  assert.equal(await readText(repo, 'docs/guide.md'), 'dev docs\n');
});

test('mergeDevToMain still records a merge commit when dev only changes derived data', async () => {
  const repo = await createRepo('derived-only-');
  await writeText(repo, '训练记录.md', 'main training\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'main data']);
  const mainBeforeMerge = await gitText(repo, ['rev-parse', 'HEAD']);

  await git(repo, ['checkout', '-b', 'dev']);
  await writeText(repo, '训练记录.md', 'dev training\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'dev data']);

  await git(repo, ['checkout', 'main']);
  const result = await mergeDevToMain({
    cwd: repo,
    stdout: { write() {} },
    stderr: { write() {} },
  });
  const head = await gitText(repo, ['rev-parse', 'HEAD']);
  const parents = await gitText(repo, ['show', '--no-patch', '--format=%P', 'HEAD']);

  assert.equal(result.committed, true);
  assert.notEqual(head, mainBeforeMerge);
  assert.equal(parents.split(' ').length, 2);
  assert.equal(await readText(repo, '训练记录.md'), 'main training\n');
});

test('mergeDevToMain resolves derived data conflicts by keeping main data', async () => {
  const repo = await createRepo('derived-conflict-');
  await writeText(repo, '训练记录.md', 'base training\n');
  await writeText(repo, 'src/app.mjs', 'export const value = "base";\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);

  await git(repo, ['checkout', '-b', 'dev']);
  await writeText(repo, '训练记录.md', 'dev training\n');
  await writeText(repo, 'src/app.mjs', 'export const value = "dev";\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'dev changes']);

  await git(repo, ['checkout', 'main']);
  await writeText(repo, '训练记录.md', 'main training\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'main data update']);

  const result = await mergeDevToMain({
    cwd: repo,
    stdout: { write() {} },
    stderr: { write() {} },
  });
  const status = await gitText(repo, ['status', '--porcelain']);

  assert.equal(result.committed, true);
  assert.equal(result.status, 'merged_after_data_conflicts');
  assert.equal(await readText(repo, '训练记录.md'), 'main training\n');
  assert.equal(await readText(repo, 'src/app.mjs'), 'export const value = "dev";\n');
  assert.equal(status, '');
});

test('mergeDevToMain returns up to date when dev is already merged', async () => {
  const repo = await createRepo('derived-up-to-date-');
  await writeText(repo, 'src/app.mjs', 'export const value = "main";\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'main']);
  await git(repo, ['checkout', '-b', 'dev']);
  await git(repo, ['checkout', 'main']);

  const result = await mergeDevToMain({
    cwd: repo,
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.equal(result.status, 'up_to_date');
  assert.equal(result.committed, false);
  assert.equal(await gitText(repo, ['show', '--no-patch', '--format=%s', 'HEAD']), 'main');
});

test('checkDerivedDataMerge fails on protected data changes and allows code docs and regular posts', async () => {
  const repo = await createRepo('derived-check-');
  await writeText(repo, '训练记录.md', 'main training\n');
  await writeText(repo, 'src/app.mjs', 'export const value = "main";\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);

  await git(repo, ['checkout', '-b', 'feature-ok']);
  await writeText(repo, 'src/app.mjs', 'export const value = "feature";\n');
  await writeText(repo, 'docs/guide.md', 'feature docs\n');
  await writeText(repo, 'source/_posts/2026-05-09-post-workout-glute-pain.md', 'feature post\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'safe changes']);
  const ok = await checkDerivedDataMerge({
    cwd: repo,
    argv: ['--base', 'main', '--head', 'HEAD'],
    stdout: { write() {} },
    stderr: { write() {} },
  });
  assert.equal(ok.ok, true);

  await git(repo, ['checkout', 'main']);
  await git(repo, ['checkout', '-b', 'feature-data']);
  await writeText(repo, '训练记录.md', 'feature training\n');
  await writeText(repo, 'source/_posts/2026-05-12-telegram-thought-102.md', 'feature thought\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'data changes']);
  const blocked = await checkDerivedDataMerge({
    cwd: repo,
    argv: ['--base', 'main', '--head', 'HEAD'],
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.derivedPaths, [
    'source/_posts/2026-05-12-telegram-thought-102.md',
    '训练记录.md',
  ]);
});

async function createRepo(prefix) {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  return repo;
}

async function writeText(repo, relativePath, content) {
  const filePath = path.join(repo, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function readText(repo, relativePath) {
  return readFile(path.join(repo, relativePath), 'utf8');
}

async function git(repo, args) {
  return execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repo,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function gitText(repo, args) {
  const { stdout } = await git(repo, args);
  return stdout.trim();
}
