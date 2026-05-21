import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rootDir = new URL('../', import.meta.url);

test('reusable build workflow centralizes Hexo build, cache, and deploy steps', async () => {
  const workflow = await readWorkflow('.github/workflows/_reusable-build.yml');

  assert.match(workflow, /on:\s*\n\s*workflow_call:/);
  for (const inputName of ['run_backfill', 'run_tests', 'deploy']) {
    assert.match(workflow, new RegExp(`${inputName}:\\s*\\n\\s*type:\\s*boolean`));
  }
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /cache:\s*npm/);
  assert.match(workflow, /actions\/cache@v4/);
  assert.match(workflow, /path:\s*\|\s*\n\s*\.hexo_cache/);
  assert.match(
    workflow,
    /key:\s*hexo-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*hashFiles\('训练记录\.md', 'source\/_posts\/\*\*', 'themes\/\*\*'\)\s*\}\}/,
  );
  assert.match(workflow, /- name: Backfill core from archive snapshot/);
  assert.match(workflow, /- name: Reconcile committed markdown back to core/);
  assert.match(workflow, /- name: Backfill thought markdown back to core/);
  assert.match(workflow, /- name: Run tests/);
  assert.match(workflow, /- name: Build site data and static files/);
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
});

test('deploy-pages workflow delegates build and deploy to the reusable workflow', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-pages.yml');

  assert.match(workflow, /jobs:\s*\n\s*build:\s*\n\s*uses:\s*\.\/\.github\/workflows\/_reusable-build\.yml/);
  assert.match(workflow, /run_backfill:\s*true/);
  assert.match(workflow, /run_tests:\s*true/);
  assert.match(workflow, /deploy:\s*true/);
  assert.match(workflow, /secrets:\s*inherit/);
});

test('deploy-pages workflow still triggers for site-relevant changes', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-pages.yml');

  for (const expectedPath of [
    '训练记录.md',
    '_config.yml',
    'source/**',
    'themes/**',
    'tools/**',
    '.github/workflows/deploy-pages.yml',
    '.github/workflows/telegram-sync.yml',
    '.github/workflows/_reusable-build.yml',
    'package.json',
    'package-lock.json',
  ]) {
    assert.match(workflow, new RegExp(`-\\s*${escapeRegExp(expectedPath)}`));
  }
});

test('telegram-sync workflow delegates deploy work after syncing repository changes', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

  assert.match(workflow, /git status --porcelain -- 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /git add 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /git commit -m "chore: sync Telegram updates"/);
  assert.match(workflow, /- name: Run tests\s*\n\s*if: github\.event_name != 'repository_dispatch' && steps\.changes\.outputs\.content_changed == 'true'/);
  assert.match(workflow, /run:\s*npm run test:fast/);
  assert.match(workflow, /- name: Deploy site snapshot\s*\n\s*if: needs\.sync\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/_reusable-build\.yml/);
  assert.match(workflow, /run_backfill:\s*false/);
  assert.match(workflow, /run_tests:\s*false/);
  assert.match(workflow, /deploy:\s*true/);
});

test('telegram-sync workflow keeps change detection and maintenance gating intact', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

  assert.match(workflow, /- name: Detect changes/);
  assert.match(workflow, /repo_changed=false/);
  assert.match(workflow, /content_changed=false/);
  for (const stepName of [
    'Backfill core from archive snapshot',
    'Reconcile committed markdown back to core',
    'Backfill thought markdown back to core',
    'Export markdown from database snapshot',
  ]) {
    assert.match(
      workflow,
      new RegExp(`- name: ${escapeRegExp(stepName)}\\n\\s+if: github\\.event_name != 'repository_dispatch'`),
    );
  }
  assert.match(workflow, /- name: Commit sync results\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Rebase on latest main\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Push changes\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
});

test('site workflows require Node 22 LTS', async () => {
  for (const workflowPath of ['.github/workflows/deploy-pages.yml', '.github/workflows/telegram-sync.yml']) {
    const workflow = await readWorkflow(workflowPath);
    for (const match of workflow.matchAll(/node-version:\s*(\d+)/g)) {
      if (match[1] !== '22') {
        throw new assert.AssertionError({
          message: `Expected ${workflowPath} to use node-version 22`,
          actual: match[1],
          expected: '22',
        });
      }
    }
    assert.match(workflow, /node-version:\s*22/);
  }
});

test('Hexo cache is enabled in the root config for reusable workflow caching to matter', async () => {
  const config = await readFile(new URL('_config.yml', rootDir), 'utf8');

  assert.match(config, /cache:\s*\n\s*enable:\s*true/);
});

async function readWorkflow(relativePath) {
  const workflow = await readFile(new URL(relativePath, rootDir), 'utf8');
  return workflow.replace(/\r\n?/g, '\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
