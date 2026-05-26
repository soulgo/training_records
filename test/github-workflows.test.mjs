import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const rootDir = new URL('../', import.meta.url);

test('shared site build action centralizes Hexo build cache and deploy steps', async () => {
  const action = await readWorkflow('.github/actions/site-build/action.yml');

  assert.match(action, /name:\s*Shared Site Build/);
  assert.match(action, /using:\s*composite/);
  for (const inputName of ['run_backfill', 'run_tests', 'deploy']) {
    assert.match(action, new RegExp(`${inputName}:([\\s\\S]*?)required:\\s*false`));
  }
  assert.match(action, /actions\/setup-node@v4/);
  assert.match(action, /node-version:\s*22/);
  assert.match(action, /cache:\s*npm/);
  assert.match(action, /actions\/cache@v4/);
  assert.match(action, /path:\s*\|\s*\n\s*\.hexo_cache/);
  assert.match(
    action,
    /key:\s*hexo-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*hashFiles\('训练记录\.md', 'source\/_posts\/\*\*', 'themes\/\*\*'\)\s*\}\}/,
  );
  assert.match(action, /- name: Backfill core from archive snapshot/);
  assert.match(action, /- name: Reconcile committed markdown back to core/);
  assert.match(action, /- name: Backfill thought markdown back to core/);
  assert.match(action, /- name: Run tests/);
  assert.match(action, /- name: Build site data and static files/);
  assert.match(action, /actions\/configure-pages@v5/);
  assert.match(action, /actions\/upload-pages-artifact@v3/);
  assert.match(action, /actions\/deploy-pages@v4/);
});

test('deploy-pages workflow uses the shared site build action', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-pages.yml');

  assert.match(workflow, /- name: Checkout/);
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /- name: Build and deploy site/);
  assert.match(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.match(workflow, /run_backfill:\s*'true'/);
  assert.match(workflow, /run_tests:\s*'false'/);
  assert.match(workflow, /deploy:\s*'true'/);
});

test('ci-tests workflow runs npm test without deploying Pages', async () => {
  const workflow = await readWorkflow('.github/workflows/ci-tests.yml');

  assert.match(workflow, /name:\s*CI Tests/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /pull_request:/);
  for (const expectedPath of [
    '训练记录.md',
    '_config.yml',
    'source/**',
    'test/**',
    'themes/**',
    'tools/**',
    '.github/actions/site-build/action.yml',
    '.github/workflows/deploy-pages.yml',
    '.github/workflows/telegram-sync.yml',
    '.github/workflows/deploy-cloudflare-worker.yml',
    '.github/workflows/refresh-telegram-webhook.yml',
    '.github/workflows/ci-tests.yml',
    'package.json',
    'package-lock.json',
  ]) {
    assert.match(workflow, new RegExp(`-\\s*${escapeRegExp(expectedPath)}`));
  }
  assert.match(workflow, /actions\/checkout@v4/);
  assert.doesNotMatch(workflow, /ref:\s*main/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /cache:\s*npm/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm test/);
  assert.doesNotMatch(workflow, /actions\/deploy-pages@v4/);
});

test('deploy-cloudflare-worker workflow refreshes Telegram webhook after deployment', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-cloudflare-worker.yml');

  assert.match(workflow, /name:\s*Deploy Cloudflare Worker/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /command:\s*deploy/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /- name: Refresh Telegram webhook/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN:\s*\$\{\{\s*secrets\.TELEGRAM_BOT_TOKEN\s*\}\}/);
  assert.match(workflow, /TELEGRAM_WEBHOOK_URL:\s*\$\{\{\s*vars\.TELEGRAM_WEBHOOK_URL\s*\}\}/);
  assert.match(workflow, /TELEGRAM_SECRET_TOKEN:\s*\$\{\{\s*secrets\.TELEGRAM_SECRET_TOKEN\s*\}\}/);
  assert.match(workflow, /run:\s*npm run telegram:webhook/);
});

test('refresh-telegram-webhook workflow supports manual and scheduled webhook refresh', async () => {
  const workflow = await readWorkflow('.github/workflows/refresh-telegram-webhook.yml');

  assert.match(workflow, /name:\s*Refresh Telegram Webhook/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*'17 \*\/6 \* \* \*'/);
  assert.match(workflow, /group:\s*telegram-webhook/);
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /- name: Set Telegram webhook/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN:\s*\$\{\{\s*secrets\.TELEGRAM_BOT_TOKEN\s*\}\}/);
  assert.match(workflow, /TELEGRAM_WEBHOOK_URL:\s*\$\{\{\s*vars\.TELEGRAM_WEBHOOK_URL\s*\}\}/);
  assert.match(workflow, /TELEGRAM_SECRET_TOKEN:\s*\$\{\{\s*secrets\.TELEGRAM_SECRET_TOKEN\s*\}\}/);
  assert.match(workflow, /run:\s*npm run telegram:webhook/);
});

test('deploy-pages workflow still triggers for site-relevant changes', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-pages.yml');

  for (const expectedPath of [
    '训练记录.md',
    '_config.yml',
    'source/**',
    'themes/**',
    'tools/**',
    '.github/actions/site-build/action.yml',
    '.github/workflows/deploy-pages.yml',
    '.github/workflows/telegram-sync.yml',
    'package.json',
    'package-lock.json',
  ]) {
    assert.match(workflow, new RegExp(`-\\s*${escapeRegExp(expectedPath)}`));
  }
});

test('telegram-sync workflow uses the shared site build action after pushing repo changes', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

  assert.match(workflow, /git status --porcelain -- 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /git add 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /git commit -m "chore: sync Telegram updates"/);
  assert.match(workflow, /- name: Run tests\s*\n\s*if: github\.event_name != 'repository_dispatch' && steps\.changes\.outputs\.content_changed == 'true'/);
  assert.match(workflow, /run:\s*npm run test:fast/);
  assert.match(workflow, /- name: Build and deploy site snapshot\s*\n\s*if: steps\.changes\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.match(workflow, /run_backfill:\s*'false'/);
  assert.match(workflow, /run_tests:\s*'false'/);
  assert.match(workflow, /deploy:\s*'true'/);
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

test('reusable workflow file has been removed so only real workflows appear in Actions', async () => {
  const reusableWorkflowPath = new URL('.github/workflows/_reusable-build.yml', rootDir);
  await assert.rejects(access(reusableWorkflowPath, constants.F_OK));
});

test('Hexo cache is enabled in the root config for shared workflow caching to matter', async () => {
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
