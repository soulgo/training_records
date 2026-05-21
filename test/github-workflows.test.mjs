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
    '.github/workflows/deploy-pages.yml',
    '.github/workflows/telegram-sync.yml',
    'package.json',
    'package-lock.json',
  ]) {
    assert.match(workflow, new RegExp(`-\\s*${escapeRegExp(expectedPath)}`));
  }
});

test('deploy-pages workflow reconciles committed markdown before building the site', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-pages.yml');

  assert.match(workflow, /- name: Reconcile committed markdown back to core/);
  assert.match(workflow, /run:\s*npm run reconcile:markdown/);
  assert.match(workflow, /TRAINING_DB_ENABLED:\s*\$\{\{\s*vars\.TRAINING_DB_ENABLED\s*\}\}/);
  assert.match(workflow, /TRAINING_DB_URL:\s*\$\{\{\s*secrets\.TRAINING_DB_URL\s*\}\}/);
});

test('deploy-pages workflow backfills telegram thought markdown before tests', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-pages.yml');

  assert.match(workflow, /- name: Backfill thought markdown back to core/);
  assert.match(workflow, /run:\s*npm run backfill:thoughts/);
});

test('telegram-sync workflow deploys Pages for repository_dispatch when repo changes exist', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

  assert.match(workflow, /git status --porcelain -- 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /git add 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /git commit -m "chore: sync Telegram updates"/);
  assert.match(workflow, /- name: Run tests\s*\n\s*if: github\.event_name != 'repository_dispatch' && steps\.changes\.outputs\.content_changed == 'true'/);
  assert.match(workflow, /run:\s*npm run test:fast/);
  assert.match(workflow, /- name: Build site data and static files\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Setup Pages\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.doesNotMatch(workflow, /needs:\s*sync/);
});

test('telegram-sync workflow keeps the repository_dispatch fast path gated by detected changes', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

  assert.match(workflow, /- name: Detect changes/);
  assert.match(workflow, /repo_changed=false/);
  assert.match(workflow, /content_changed=false/);
  assert.match(workflow, /- name: Run tests\s*\n\s*if: github\.event_name != 'repository_dispatch' && steps\.changes\.outputs\.content_changed == 'true'/);
  assert.match(workflow, /- name: Commit sync results\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Rebase on latest main\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Push changes\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Build site data and static files\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
});

test('telegram-sync workflow skips full database maintenance on webhook dispatches', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

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
});

test('cloudflare worker workflow deploys wrangler config changes to Cloudflare', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-cloudflare-worker.yml');

  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*-\s*main/);
  for (const expectedPath of [
    'wrangler.toml',
    'cloudflare/**',
    '.github/workflows/deploy-cloudflare-worker.yml',
  ]) {
    assert.match(workflow, new RegExp(`-\\s*${escapeRegExp(expectedPath)}`));
  }
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /apiToken:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  assert.match(workflow, /accountId:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/);
  assert.match(workflow, /command:\s*deploy/);
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

async function readWorkflow(relativePath) {
  const workflow = await readFile(new URL(relativePath, rootDir), 'utf8');
  return workflow.replace(/\r\n?/g, '\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
