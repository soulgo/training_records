import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rootDir = new URL('../', import.meta.url);

test('deploy-pages workflow runs on push to main instead of workflow_run fan-out', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-pages.yml');

  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*-\s*main/);
  assert.doesNotMatch(workflow, /workflow_run:/);
});

test('deploy-pages workflow limits automatic deploys to site-relevant paths', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-pages.yml');

  for (const expectedPath of [
    '训练记录.md',
    '_config.yml',
    'source/**',
    'themes/**',
    'tools/**',
    'package.json',
    'package-lock.json',
  ]) {
    assert.match(workflow, new RegExp(`-\\s*${escapeRegExp(expectedPath)}`));
  }
});

test('telegram-sync workflow keeps test validation but skips duplicate site builds', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

  assert.match(workflow, /- name: Run tests/);
  assert.doesNotMatch(workflow, /- name: Build site data and static files/);
});

async function readWorkflow(relativePath) {
  return readFile(new URL(relativePath, rootDir), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
