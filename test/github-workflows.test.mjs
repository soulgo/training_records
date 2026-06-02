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
  assert.match(action, /path:\s*\|\s*\n\s*db\.json/);
  assert.match(
    action,
    /key:\s*hexo-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*hashFiles\('package-lock\.json', '_config\.yml', 'source\/\*\*', 'themes\/\*\*'\)\s*\}\}/,
  );
  assert.match(action, /- name: Sync archive and markdown to database/);
  assert.match(action, /run:\s*npm run sync:db/);
  assert.doesNotMatch(action, /run:\s*npm run backfill:core/);
  assert.doesNotMatch(action, /run:\s*npm run reconcile:markdown/);
  assert.doesNotMatch(action, /run:\s*npm run backfill:thoughts/);
  assert.match(action, /- name: Run tests/);
  assert.match(action, /- name: Build site data and static files/);
  assert.match(action, /- name: Verify generated site artifact/);
  assert.match(action, /test -s public\/index\.html/);
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
  assert.match(workflow, /run_tests:\s*'true'/);
  assert.match(workflow, /deploy:\s*'true'/);
});

test('ci-tests workflow runs npm run test:fast without deploying Pages', async () => {
  const workflow = await readWorkflow('.github/workflows/ci-tests.yml');

  assert.match(workflow, /name:\s*CI Tests/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /pull_request:/);
  for (const expectedPath of [
    '训练记录.md',
    '_config.yml',
    'source/**',
    'src/**',
    'test/**',
    'themes/**',
    'tools/**',
    'cloudflare/**',
    'docs/**',
    'prompts/**',
    'sql/**',
    '.github/actions/site-build/action.yml',
    '.github/workflows/deploy-pages.yml',
    '.github/workflows/telegram-sync.yml',
    '.github/workflows/telegram-sync-dev.yml',
    '.github/workflows/deploy-cloudflare-worker.yml',
    '.github/workflows/deploy-cloudflare-worker-dev.yml',
    '.github/workflows/deploy-cloudflare-pages-dev.yml',
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
  assert.match(workflow, /run:\s*npm run test:fast/);
  assert.doesNotMatch(workflow, /actions\/deploy-pages@v4/);
});

test('deploy-cloudflare-pages-dev workflow publishes dev branch to Cloudflare Pages preview', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-cloudflare-pages-dev.yml');

  assert.match(workflow, /name:\s*Deploy Cloudflare Pages \(Dev\)/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- dev/);
  assert.match(workflow, /group:\s*cloudflare-pages-dev/);
  assert.match(workflow, /TRAINING_DB_URL:\s*\$\{\{\s*secrets\.DEV_TRAINING_DB_URL\s*\}\}/);
  assert.match(workflow, /TRAINING_DB_APP_NAME:\s*\$\{\{\s*vars\.DEV_TRAINING_DB_APP_NAME\s*\}\}/);
  assert.match(workflow, /ref:\s*dev/);
  assert.match(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.match(workflow, /run_backfill:\s*'true'/);
  assert.match(workflow, /run_tests:\s*'true'/);
  assert.match(workflow, /deploy:\s*'false'/);
  assert.match(workflow, /rm -f public\/CNAME/);
  assert.match(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /apiToken:\s*\$\{\{\s*secrets\.CLOUDFLARE_PAGES_API_TOKEN\s*\}\}/);
  assert.match(workflow, /accountId:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/);
  assert.match(workflow, /pages deploy public/);
  assert.match(workflow, /--project-name \$\{\{\s*vars\.CLOUDFLARE_PAGES_DEV_PROJECT_NAME \|\| 'training-records-dev'\s*\}\}/);
  assert.match(workflow, /--branch dev/);
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
    'src/**',
    'themes/**',
    'tools/**',
    'prompts/**',
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
  assert.match(workflow, /- name: Run tests\s*\n\s*id: test\s*\n\s*if: github\.event_name != 'repository_dispatch' && steps\.detect\.outputs\.content_changed == 'true'/);
  assert.match(workflow, /run:\s*npm run test:fast/);
  assert.match(workflow, /- name: Build and deploy site snapshot\s*\n\s*id: site_build\s*\n\s*if: steps\.detect\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.match(workflow, /run_backfill:\s*'false'/);
  assert.match(workflow, /run_tests:\s*'false'/);
  assert.match(workflow, /deploy:\s*'true'/);
  assert.match(workflow, /TELEGRAM_SYNC_NOTIFY_STAGE: after_action/);
  assert.match(workflow, /TELEGRAM_SYNC_RESULT_PATH: \$\{\{ runner\.temp \}\}\/telegram-sync-result\.json/);
});

test('telegram-sync workflow keeps change detection and maintenance gating intact', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

  assert.match(workflow, /- name: Detect changes/);
  assert.match(workflow, /repo_changed=false/);
  assert.match(workflow, /content_changed=false/);
  assert.match(
    workflow,
    /- name: Sync archive and markdown to database\n\s+if: github\.event_name != 'repository_dispatch'\n\s+run:\s*npm run sync:db/,
  );
  assert.match(
    workflow,
    /- name: Export markdown from database snapshot\n\s+if: github\.event_name != 'repository_dispatch'/,
  );
  assert.doesNotMatch(workflow, /run:\s*npm run backfill:core/);
  assert.doesNotMatch(workflow, /run:\s*npm run reconcile:markdown/);
  assert.doesNotMatch(workflow, /run:\s*npm run backfill:thoughts/);
  assert.match(workflow, /- name: Commit sync results\s*\n\s*id: commit\s*\n\s*if: steps\.detect\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Rebase on latest main\s*\n\s*id: rebase\s*\n\s*if: steps\.detect\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Push changes\s*\n\s*id: push\s*\n\s*if: steps\.detect\.outputs\.repo_changed == 'true'/);
});

test('telegram-sync dev workflow only handles dev dispatches and writes dev branch', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync-dev.yml');

  assert.match(workflow, /name:\s*Telegram Sync \(Dev\)/);
  assert.match(workflow, /repository_dispatch:\s*\n\s+types:\s*\n\s+- telegram_update_dev/);
  assert.doesNotMatch(workflow, /-\s*telegram_update\s*(?:\n|$)/);
  assert.match(workflow, /- name: Checkout dev branch\s*\n\s+uses: actions\/checkout@v4\s*\n\s+with:\s*\n\s+ref:\s*dev/);
  assert.match(workflow, /TRAINING_DB_URL:\s*\$\{\{\s*secrets\.DEV_TRAINING_DB_URL\s*\}\}/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN:\s*\$\{\{\s*secrets\.DEV_TELEGRAM_BOT_TOKEN\s*\}\}/);
  assert.match(workflow, /git commit -m "chore\(dev\): sync Telegram updates"/);
  assert.match(workflow, /run:\s*git push origin HEAD:dev/);
});

test('telegram-sync dev workflow deploys Pages after bot-created changes', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync-dev.yml');

  assert.match(workflow, /- name: Build and deploy dev site snapshot\s*\n\s+id: site_build/);
  assert.match(workflow, /if: steps\.detect\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /run_backfill:\s*'true'/);
  assert.match(workflow, /run_tests:\s*'true'/);
  assert.match(workflow, /deploy:\s*'false'/);
  assert.match(workflow, /- name: Remove production custom domain file/);
  assert.match(workflow, /rm -f public\/CNAME/);
  assert.match(workflow, /- name: Deploy dev site to Cloudflare Pages/);
  assert.match(
    workflow,
    /command: pages deploy public --project-name \$\{\{\s*vars\.CLOUDFLARE_PAGES_DEV_PROJECT_NAME \|\| 'training-records-dev'\s*\}\} --branch dev/,
  );
});

test('dev Worker config dispatches to the dev Telegram workflow event', async () => {
  const config = await readFile(new URL('wrangler.dev.toml', rootDir), 'utf8');

  assert.match(config, /name\s*=\s*"telegram-sync-dispatch-dev"/);
  assert.match(config, /\[vars\]\s*\n(?:.*\n)*?GITHUB_DISPATCH_EVENT_TYPE\s*=\s*"telegram_update_dev"/);
});

test('package fast tests skip the slow thought module page render and exposes sync db', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', rootDir), 'utf8'));

  assert.match(packageJson.scripts['test:fast'], /thought module pages/);
  assert.equal(packageJson.scripts['sync:db'], 'node tools/sync-training-core.mjs');
});

test('telegram-sync workflow reports repository dispatch failures back to Telegram', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

  for (const [stepName, stepId] of [
    ['Install dependencies', 'install'],
    ['Sync Telegram updates', 'sync'],
    ['Detect changes', 'detect'],
    ['Run tests', 'test'],
    ['Commit sync results', 'commit'],
    ['Rebase on latest main', 'rebase'],
    ['Push changes', 'push'],
    ['Build and deploy site snapshot', 'site_build'],
  ]) {
    assert.match(
      workflow,
      new RegExp(`- name: ${escapeRegExp(stepName)}\\n\\s+id: ${stepId}`),
      `${stepName} should have stable id ${stepId}`,
    );
  }

  assert.match(workflow, /- name: Notify Telegram sync failure/);
  assert.match(workflow, /if: failure\(\) && github\.event_name == 'repository_dispatch'/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /- name: Notify Telegram sync success/);
  assert.match(workflow, /if: success\(\) && github\.event_name == 'repository_dispatch'/);
  assert.match(workflow, /node tools\/telegram-sync-notify\.mjs/);
  assert.match(workflow, /node tools\/telegram-action-monitor\.mjs/);
  assert.match(workflow, /STEP_INSTALL_OUTCOME: \$\{\{ steps\.install\.outcome \}\}/);
  assert.match(workflow, /STEP_SITE_BUILD_OUTCOME: \$\{\{ steps\.site_build\.outcome \}\}/);
}
);

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
