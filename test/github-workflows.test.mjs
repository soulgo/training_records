import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';

const rootDir = new URL('../', import.meta.url);

test('shared site build action centralizes Hexo build cache and deploy steps', async () => {
  const action = await readWorkflow('.github/actions/site-build/action.yml');

  assert.match(action, /name:\s*Shared Site Build/);
  assert.match(action, /using:\s*composite/);
  for (const inputName of ['run_backfill', 'sync_db_mode', 'run_tests', 'deploy', 'install_dependencies']) {
    assert.match(action, new RegExp(`${inputName}:([\\s\\S]*?)required:\\s*false`));
  }
  assert.match(action, /actions\/setup-node@v4/);
  assert.match(action, /node-version:\s*22/);
  assert.match(action, /cache:\s*npm/);
  assert.match(action, /actions\/cache@v4/);
  assert.match(action, /- name: Install dependencies\s*\n\s*if: \$\{\{ inputs\.install_dependencies == 'true' \}\}/);
  assert.match(action, /path:\s*\|\s*\n\s*db\.json/);
  assert.match(
    action,
    /key:\s*hexo-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*hashFiles\('package-lock\.json', '_config\.yml', 'source\/\*\*', 'themes\/\*\*'\)\s*\}\}/,
  );
  assert.match(action, /- name: Sync safe database repairs/);
  assert.match(action, /- name: Detect safe database sync input changes/);
  assert.match(action, /sync_db_needed=false/);
  assert.match(action, /sync_db_reason=no_data_changes/);
  assert.match(action, /if: \$\{\{ inputs\.run_backfill == 'true' && \(inputs\.sync_db_mode == 'always' \|\| steps\.sync_db_changes\.outputs\.sync_db_needed == 'true'\) \}\}/);
  assert.match(action, /run:\s*npm run sync:db/);
  assert.match(action, /- name: Export database markdown for Hexo posts/);
  assert.match(action, /\$snapshot_source" != "database"/);
  assert.match(action, /\$strict_database_snapshot" != "true"/);
  assert.match(action, /npm run export:markdown/);
  assert.match(action, /echo "TRAINING_SNAPSHOT_SOURCE=markdown" >> "\$GITHUB_ENV"/);
  assert.match(action, /echo "TRAINING_SNAPSHOT_STRICT_DATABASE=false" >> "\$GITHUB_ENV"/);
  assert.ok(
    action.indexOf('- name: Sync safe database repairs') > action.indexOf('- name: Export database markdown for Hexo posts'),
    'safe database repairs should run after fresh database markdown export to avoid overwriting correct values with stale file data',
  );
  assert.ok(
    action.indexOf('- name: Run tests') > action.indexOf('- name: Export database markdown for Hexo posts'),
    'tests should run against the DB-derived markdown used by Hexo',
  );
  assert.ok(
    action.indexOf('- name: Build site data and static files') > action.indexOf('- name: Export database markdown for Hexo posts'),
    'Hexo should build after DB-derived thought posts are exported',
  );
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
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
  assert.doesNotMatch(workflow, /ref:\s*main/);
  assert.match(workflow, /- name: Build and deploy site/);
  assert.match(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.match(workflow, /run_backfill:\s*'true'/);
  assert.match(workflow, /sync_db_mode:\s*'auto'/);
  assert.match(workflow, /run_tests:\s*'true'/);
  assert.match(workflow, /deploy:\s*'true'/);
  assert.match(workflow, /strict_database_snapshot:/);
  assert.match(workflow, /strict_database_snapshot:[\s\S]*?default:\s*'true'/);
  assert.match(workflow, /target_thought_id:/);
  assert.match(workflow, /target_thought_module:/);
  assert.match(workflow, /target_thought_path:/);
  assert.match(workflow, /target_thought_expectation:/);
  assert.match(
    workflow,
    /TRAINING_SNAPSHOT_STRICT_DATABASE:\s*\$\{\{\s*github\.event_name == 'workflow_dispatch' && inputs\.strict_database_snapshot \|\| 'true'\s*\}\}/,
  );
  assert.match(workflow, /TRAINING_BUILD_ARCHIVE_WRITE:\s*false/);
  assert.match(workflow, /CLOUDFLARE_ZONE_ID:\s*\$\{\{\s*secrets\.CLOUDFLARE_ZONE_ID\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_PAGES_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_PAGES_API_TOKEN\s*\}\}/);
  assert.match(workflow, /- name: Purge Cloudflare cache/);
  assert.match(
    workflow,
    /if: \$\{\{ success\(\) && env\.CLOUDFLARE_ZONE_ID != '' && \(env\.CLOUDFLARE_API_TOKEN != '' \|\| env\.CLOUDFLARE_PAGES_API_TOKEN != ''\) \}\}/,
  );
  assert.match(workflow, /zones\/\$\{CLOUDFLARE_ZONE_ID\}\/purge_cache/);
  assert.match(workflow, /"purge_everything":true/);
  const purgeStep = workflow.slice(
    workflow.indexOf('- name: Purge Cloudflare cache'),
    workflow.indexOf('- name: Report skipped Cloudflare cache purge'),
  );
  assert.doesNotMatch(purgeStep, /curl -fsSL/);
  assert.match(workflow, /token_names=\(\)/);
  assert.match(workflow, /token_names\+=\("CLOUDFLARE_API_TOKEN"\)/);
  assert.match(workflow, /token_names\+=\("CLOUDFLARE_PAGES_API_TOKEN"\)/);
  assert.match(workflow, /Cloudflare cache purged with \$\{token_name\}/);
  assert.match(workflow, /Cloudflare cache purge retry/);
  assert.match(workflow, /::error title=Cloudflare cache purge failed::/);
  assert.match(purgeStep, /exit 1/);
  assert.match(workflow, /Zone -> Cache Purge -> Purge permission/);
  assert.match(workflow, /- name: Report skipped Cloudflare cache purge/);
  assert.match(
    workflow,
    /if: \$\{\{ success\(\) && \(env\.CLOUDFLARE_ZONE_ID == '' \|\| \(env\.CLOUDFLARE_API_TOKEN == '' && env\.CLOUDFLARE_PAGES_API_TOKEN == ''\)\) \}\}/,
  );
  assert.match(workflow, /::error title=Cloudflare cache purge skipped::/);
  assert.match(workflow, /target_thought_id:/);
  assert.match(workflow, /target_thought_module:/);
  assert.match(workflow, /target_thought_path:/);
  assert.match(workflow, /target_thought_expectation:/);
  assert.match(workflow, /- name: Verify deployed thought module page/);
  assert.match(workflow, /TARGET_THOUGHT_ID:\s*\$\{\{\s*inputs\.target_thought_id\s*\}\}/);
  assert.match(workflow, /TARGET_THOUGHT_EXPECTATION:\s*\$\{\{\s*inputs\.target_thought_expectation\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_PAGES_BASE_URL:\s*\$\{\{\s*vars\.CLOUDFLARE_PAGES_BASE_URL\s*\}\}/);
  assert.match(workflow, /expected="\$\{TARGET_THOUGHT_EXPECTATION:-present\}"/);
  assert.match(workflow, /\[\s*"\$expected"\s*!=\s*"absent"\s*\]/);
  assert.match(workflow, /curl -fsSL --retry 6 --retry-delay 10/);
  assert.match(workflow, /data-thought-id=\\?"\$\{TARGET_THOUGHT_ID\}\\?"/);
  assert.match(workflow, /verification_attempts=12/);
  assert.match(workflow, /for attempt in \$\(seq 1 "\$verification_attempts"\)/);
  assert.match(workflow, /Thought #\$\{TARGET_THOUGHT_ID\} not found on target URL \(attempt \$\{attempt\}\/\$\{verification_attempts\}\); waiting \$\{verification_delay_seconds\}s for Pages propagation/);
  assert.match(workflow, /sleep "\$verification_delay_seconds"/);
  assert.doesNotMatch(workflow, /waiting 20s for Pages propagation and retrying/);
  assert.doesNotMatch(workflow, /sleep 20/);
  assert.doesNotMatch(workflow, /grep -F "#\$\{TARGET_THOUGHT_ID\}"/);
  assert.match(workflow, /module_paths=\("\/thoughts\/" "\/misc\/" "\/body-feedback\/"\)/);
  assert.match(workflow, /Unexpected thought #\$\{TARGET_THOUGHT_ID\}/);
  assert.match(workflow, /::error title=Thought page verification failed::/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.ok(
    workflow.indexOf('- name: Purge Cloudflare cache') > workflow.indexOf('- name: Build and deploy site'),
    'Cloudflare cache should be purged only after the Pages deployment step finishes',
  );
});

test('ci-tests workflow runs npm run test:fast without deploying Pages', async () => {
  const workflow = await readWorkflow('.github/workflows/ci-tests.yml');

  assert.match(workflow, /name:\s*CI Tests/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*'23 18 \* \* \*'/);
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
	    '.github/workflows/sync.yml',
	    '.github/workflows/sync-dev.yml',
	    '.github/workflows/deploy-cloudflare-worker.yml',
	    '.github/workflows/deploy-cloudflare-worker-dev.yml',
	    '.github/workflows/deploy-cloudflare-pages-dev.yml',
    '.github/workflows/refresh-telegram-webhook.yml',
    '.github/workflows/markdown-backup.yml',
    '.github/workflows/ci-tests.yml',
    'package.json',
    'package-lock.json',
  ]) {
    assert.match(workflow, new RegExp(`-\\s*${escapeRegExp(expectedPath)}`));
  }
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.doesNotMatch(workflow, /ref:\s*main/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /cache:\s*npm/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /- name: Check protected derived data changes/);
  assert.match(workflow, /if: github\.event_name == 'pull_request' && github\.base_ref == 'main'/);
  assert.match(workflow, /run:\s*npm run check:derived-data-merge -- --base origin\/main/);
  assert.match(workflow, /run:\s*npm run test:fast/);
  assert.match(workflow, /full-test:/);
  assert.match(workflow, /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /run:\s*npm test/);
  assert.doesNotMatch(workflow, /actions\/deploy-pages@v4/);
});

test('deploy-cloudflare-pages-dev workflow publishes dev branch to Cloudflare Pages preview', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-cloudflare-pages-dev.yml');

  assert.match(workflow, /name:\s*Deploy Cloudflare Pages \(Dev\)/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /strict_database_snapshot:/);
  assert.match(workflow, /strict_database_snapshot:[\s\S]*?default:\s*'true'/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- dev/);
  assert.match(workflow, /group:\s*cloudflare-pages-dev/);
  assert.match(workflow, /TRAINING_DB_URL:\s*\$\{\{\s*secrets\.DEV_TRAINING_DB_URL\s*\}\}/);
  assert.match(workflow, /TRAINING_DB_APP_NAME:\s*\$\{\{\s*vars\.DEV_TRAINING_DB_APP_NAME\s*\}\}/);
  assert.match(
    workflow,
    /TRAINING_SNAPSHOT_STRICT_DATABASE:\s*\$\{\{\s*github\.event_name == 'workflow_dispatch' && inputs\.strict_database_snapshot \|\| 'true'\s*\}\}/,
  );
  assert.match(workflow, /TRAINING_BUILD_ARCHIVE_WRITE:\s*false/);
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
  assert.doesNotMatch(workflow, /ref:\s*dev/);
  assert.match(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.match(workflow, /run_backfill:\s*'true'/);
  assert.match(workflow, /sync_db_mode:\s*'auto'/);
  assert.match(workflow, /run_tests:\s*'true'/);
  assert.match(workflow, /deploy:\s*'false'/);
  assert.match(workflow, /rm -f public\/CNAME/);
  assert.doesNotMatch(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_PAGES_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_PAGES_API_TOKEN\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_PAGES_DEV_PROJECT_NAME:\s*\$\{\{\s*vars\.CLOUDFLARE_PAGES_DEV_PROJECT_NAME \|\| 'training-records-dev'\s*\}\}/);
  assert.match(workflow, /token_names=\(\)/);
  assert.match(workflow, /token_names\+=\("CLOUDFLARE_API_TOKEN"\)/);
  assert.match(workflow, /token_names\+=\("CLOUDFLARE_PAGES_API_TOKEN"\)/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN="\$\{token_value\}"/);
  assert.match(workflow, /npx --yes wrangler@3\.114\.14 --cwd public pages deploy \./);
  assert.match(workflow, /else\s*\n\s*last_status=\$\?/);
  assert.match(workflow, /Cloudflare Pages deploy retry/);
  assert.match(workflow, /All configured Cloudflare tokens failed/);
  assert.match(workflow, /- name: Verify deployed thought module page/);
  assert.match(workflow, /CLOUDFLARE_PAGES_DEV_BASE_URL:\s*\$\{\{\s*vars\.CLOUDFLARE_PAGES_DEV_BASE_URL\s*\}\}/);
  assert.match(workflow, /TARGET_THOUGHT_EXPECTATION:\s*\$\{\{\s*inputs\.target_thought_expectation\s*\}\}/);
  assert.match(workflow, /\[\s*"\$expected"\s*!=\s*"absent"\s*\]/);
  assert.match(workflow, /data-thought-id=\\?"\$\{TARGET_THOUGHT_ID\}\\?"/);
  assert.doesNotMatch(workflow, /grep -F "#\$\{TARGET_THOUGHT_ID\}"/);
  assert.match(workflow, /module_paths=\("\/thoughts\/" "\/misc\/" "\/body-feedback\/"\)/);
  assert.match(workflow, /Unexpected thought #\$\{TARGET_THOUGHT_ID\}/);
  assert.match(workflow, /::error title=Thought page verification failed::/);
  assert.doesNotMatch(workflow, /--config wrangler\.pages\.dev\.toml/);
  assert.match(workflow, /--project-name "\$\{CLOUDFLARE_PAGES_DEV_PROJECT_NAME\}"/);
  assert.match(workflow, /--branch dev/);
});

test('deploy-cloudflare-worker workflow refreshes Telegram webhook after deployment', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-cloudflare-worker.yml');

  assert.match(workflow, /name:\s*Deploy Cloudflare Worker/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /push:/);
  assert.match(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /command:\s*deploy/);
  assert.match(workflow, /- name: Configure Telegram Worker secrets/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/);
  assert.match(workflow, /printf '%s' "\$TELEGRAM_BOT_TOKEN" \| npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler\.toml/);
  assert.match(workflow, /printf '%s' "\$TELEGRAM_SECRET_TOKEN" \| npx wrangler secret put TELEGRAM_SECRET_TOKEN --config wrangler\.toml/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /- name: Refresh Telegram webhook/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN:\s*\$\{\{\s*secrets\.TELEGRAM_BOT_TOKEN\s*\}\}/);
  assert.match(workflow, /TELEGRAM_WEBHOOK_URL:\s*\$\{\{\s*vars\.TELEGRAM_WEBHOOK_URL\s*\}\}/);
  assert.match(workflow, /TELEGRAM_SECRET_TOKEN:\s*\$\{\{\s*secrets\.TELEGRAM_SECRET_TOKEN\s*\}\}/);
  assert.match(workflow, /run:\s*npm run telegram:webhook/);
});

test('old production split sync and Feishu deploy workflows have been removed', async () => {
  for (const workflowPath of [
    '.github/workflows/telegram-sync.yml',
    '.github/workflows/feishu-sync.yml',
    '.github/workflows/deploy-cloudflare-feishu-worker.yml',
  ]) {
    await assert.rejects(access(new URL(workflowPath, rootDir), constants.F_OK));
  }
});

test('deploy-cloudflare-worker-dev workflow deploys the unified dev worker and refreshes Telegram webhook', async () => {
  const workflow = await readWorkflow('.github/workflows/deploy-cloudflare-worker-dev.yml');

  assert.match(workflow, /name:\s*Deploy Cloudflare Worker \(Dev\)/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- dev/);
  for (const expectedPath of [
    'cloudflare/**',
    'wrangler.dev.toml',
    '.github/workflows/deploy-cloudflare-worker-dev.yml',
    '.github/workflows/sync-dev.yml',
  ]) {
    assert.match(workflow, new RegExp(`-\\s*${escapeRegExp(expectedPath)}`));
  }
  assert.match(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /command:\s*deploy --config wrangler\.dev\.toml/);
  assert.match(workflow, /- name: Refresh Dev Telegram webhook/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN:\s*\$\{\{\s*secrets\.DEV_TELEGRAM_BOT_TOKEN\s*\}\}/);
  assert.match(workflow, /TELEGRAM_WEBHOOK_URL:\s*\$\{\{\s*vars\.DEV_TELEGRAM_WEBHOOK_URL\s*\}\}/);
  assert.match(workflow, /TELEGRAM_SECRET_TOKEN:\s*\$\{\{\s*secrets\.DEV_TELEGRAM_SECRET_TOKEN\s*\}\}/);
});

test('feishu-sync workflows expose source ids and chat ids in dispatch summaries', async () => {
  for (const workflowPath of ['.github/workflows/sync.yml', '.github/workflows/sync-dev.yml']) {
    const workflow = await readWorkflow(workflowPath);

    assert.match(workflow, /- name: Write Feishu sync summary/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /batchId \| sourceId \| chatIds \| taskStatus/);
    assert.match(workflow, /aiCallLogStatus/);
    assert.match(workflow, /batch\.sourceId/);
    assert.match(workflow, /batch\.chatIds/);
  }
});

test('feishu-sync workflows report queued webhook dispatch failures back to Feishu', async () => {
  for (const workflowPath of ['.github/workflows/sync.yml', '.github/workflows/sync-dev.yml']) {
    const workflow = await readWorkflow(workflowPath);

    for (const [stepName, stepId] of [
      ['Install dependencies', 'install'],
      ['Sync updates', 'sync'],
      ['Detect changes', 'detect'],
      ['Commit sync results', 'commit'],
      ['Push changes', 'push'],
    ]) {
      assert.match(
        workflow,
        new RegExp(`- name: ${escapeRegExp(stepName)}\\n\\s+id: ${stepId}`),
        `${workflowPath} ${stepName} should have stable id ${stepId}`,
      );
    }

    assert.match(workflow, /- name: Notify Feishu sync failure/);
    assert.match(workflow, /if: failure\(\) && steps\.channel\.outputs\.is_webhook_dispatch == 'true'/);
    assert.match(workflow, /continue-on-error: true/);
    assert.match(workflow, /node tools\/feishu-action-monitor\.mjs/);
    assert.match(workflow, /STEP_INSTALL_OUTCOME: \$\{\{ steps\.install\.outcome \}\}/);
    assert.match(workflow, /STEP_SYNC_OUTCOME: \$\{\{ steps\.sync\.outcome \}\}/);
    assert.match(workflow, /STEP_DETECT_OUTCOME: \$\{\{ steps\.detect\.outcome \}\}/);
    assert.match(workflow, /STEP_COMMIT_OUTCOME: \$\{\{ steps\.commit\.outcome \}\}/);
    assert.match(workflow, /STEP_PUSH_OUTCOME: \$\{\{ steps\.push\.outcome \}\}/);
  }
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
    '.github/workflows/sync.yml',
    'package.json',
    'package-lock.json',
  ]) {
    assert.match(workflow, new RegExp(`-\\s*${escapeRegExp(expectedPath)}`));
  }
});

test('main sync workflow notifies after sync and waits for site deploy completion', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');

  assert.match(workflow, /git status --porcelain -- 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /db_content_changed=false/);
  assert.match(workflow, /db_content_changed=true/);
  assert.match(workflow, /git add 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /echo "commit_message=chore: sync Telegram updates"/);
  assert.match(workflow, /echo "commit_message=chore: sync Feishu updates"/);
  assert.match(workflow, /git commit -m "\$\{\{ steps\.channel\.outputs\.commit_message \}\}"/);
  assert.match(workflow, /- name: Run tests\s*\n\s*id: test\s*\n\s*if: steps\.channel\.outputs\.is_webhook_dispatch != 'true' && steps\.channel\.outputs\.channel == 'telegram' && steps\.detect\.outputs\.content_changed == 'true'/);
  assert.match(workflow, /run:\s*npm run test:fast/);
  assert.doesNotMatch(workflow, /- name: Build and deploy site snapshot/);
  assert.doesNotMatch(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.doesNotMatch(workflow, /id:\s*site_build/);
  assert.match(workflow, /- name: Write Telegram sync summary/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /stage \| ms/);
  assert.match(workflow, /batchId \| taskStatus \| persistenceStatus \| archivedDate \| dateSources \| warnings \| dateConfidence \| images \| aiAttemptKinds \| aiCallLogStatus \| pending \| failureDisposition \| failed messageIds/);
  assert.match(workflow, /TELEGRAM_SYNC_NOTIFY_STAGE: after_action/);
  assert.match(workflow, /TELEGRAM_SYNC_RESULT_PATH: \$\{\{ runner\.temp \}\}\/telegram-sync-result\.json/);
  assert.match(workflow, /AI_PROVIDER:\s*\$\{\{\s*vars\.AI_PROVIDER \|\| 'openai-compatible'\s*\}\}/);
  assert.match(workflow, /AI_TIMEOUT_MS:\s*\$\{\{\s*vars\.AI_TIMEOUT_MS\s*\}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE: inline/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_MODEL: \$\{\{ vars\.TELEGRAM_RECOGNITION_MODEL \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_API_KEY: \$\{\{ secrets\.TELEGRAM_RECOGNITION_FALLBACK_API_KEY \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_BASE_URL: \$\{\{ vars\.TELEGRAM_RECOGNITION_FALLBACK_BASE_URL \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_MODEL: \$\{\{ vars\.TELEGRAM_RECOGNITION_FALLBACK_MODEL \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS: \$\{\{ vars\.TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_CACHE_ENABLED: \$\{\{ vars\.TELEGRAM_RECOGNITION_CACHE_ENABLED \}\}/);
  assert.match(workflow, /- name: Trigger and wait for site deploy/);
  assert.match(workflow, /actions\/workflows\/deploy-pages\.yml\/dispatches/);
  assert.match(workflow, /steps\.detect\.outputs\.repo_changed == 'true' \|\| steps\.detect\.outputs\.db_content_changed == 'true'/);
  assert.match(workflow, /THOUGHT_CHECK_ID:\s*\$\{\{\s*steps\.detect\.outputs\.thought_check_id\s*\}\}/);
  assert.match(workflow, /THOUGHT_CHECK_EXPECTATION:\s*\$\{\{\s*steps\.detect\.outputs\.thought_check_expectation\s*\}\}/);
  assert.match(workflow, /target_thought_id/);
  assert.match(workflow, /target_thought_module/);
  assert.match(workflow, /target_thought_path/);
  assert.match(workflow, /target_thought_expectation/);
  const deployStep = workflow.slice(
    workflow.indexOf('- name: Trigger and wait for site deploy'),
    workflow.indexOf('- name: Notify Telegram sync failure'),
  );
  assert.doesNotMatch(deployStep, /continue-on-error:\s*true/);
  assert.match(deployStep, /dispatch_started_at=/);
  assert.match(deployStep, /actions\/workflows\/deploy-pages\.yml\/runs/);
  assert.match(deployStep, /Deploy workflow failed/);
  assert.match(deployStep, /GITHUB_STEP_SUMMARY/);
  assert.match(deployStep, /## Site deploy result/);
  assert.match(deployStep, /\| workflow \| runId \| status \| conclusion \| url \|/);
  assert.match(deployStep, /appendDeploySummary/);
  assert.match(deployStep, /Deploy workflow succeeded/);
  assert.ok(
    workflow.indexOf('- name: Notify Telegram sync result') > workflow.indexOf('- name: Push changes'),
    'Telegram notification should run after push and before any asynchronous site deployment workflow',
  );
  assert.ok(
    workflow.indexOf('- name: Trigger and wait for site deploy') > workflow.indexOf('- name: Notify Telegram sync result'),
    'Site deploy should be triggered only after Telegram has been notified',
  );
});

test('main sync workflow keeps change detection and maintenance gating intact', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');

  assert.match(workflow, /- name: Detect changes/);
  assert.match(workflow, /repo_changed=false/);
  assert.match(workflow, /content_changed=false/);
  assert.match(
    workflow,
    /- name: Sync safe database repairs\n\s+if: steps\.channel\.outputs\.is_webhook_dispatch != 'true' && steps\.channel\.outputs\.channel == 'telegram'\n\s+run:\s*npm run sync:db/,
  );
  assert.doesNotMatch(workflow, /- name: Export markdown from database snapshot/);
  assert.doesNotMatch(workflow, /run:\s*npm run backfill:core/);
  assert.doesNotMatch(workflow, /run:\s*npm run reconcile:markdown/);
  assert.doesNotMatch(workflow, /run:\s*npm run backfill:thoughts/);
  assert.match(workflow, /- name: Commit sync results\s*\n\s*id: commit\s*\n\s*if: steps\.detect\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Rebase on latest main\s*\n\s*id: rebase\s*\n\s*if: steps\.detect\.outputs\.repo_changed == 'true'/);
  assert.match(workflow, /- name: Push changes\s*\n\s*id: push\s*\n\s*if: steps\.detect\.outputs\.repo_changed == 'true'/);
});

test('telegram-sync workflows keep database-only detection without blocking on page rebuilds', async () => {
  const prodWorkflow = await readWorkflow('.github/workflows/sync.yml');
  const devWorkflow = await readWorkflow('.github/workflows/sync-dev.yml');

  for (const workflow of [prodWorkflow, devWorkflow]) {
    assert.match(workflow, /TELEGRAM_SYNC_RESULT_PATH/);
    assert.match(workflow, /AI_PROVIDER:\s*\$\{\{\s*vars\.AI_PROVIDER \|\| 'openai-compatible'\s*\}\}/);
    assert.match(workflow, /AI_TIMEOUT_MS:\s*\$\{\{\s*vars\.AI_TIMEOUT_MS\s*\}\}/);
    assert.match(workflow, /TELEGRAM_RECOGNITION_CACHE_ENABLED: \$\{\{ vars\.TELEGRAM_RECOGNITION_CACHE_ENABLED \}\}/);
    assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_API_KEY: \$\{\{ secrets\.TELEGRAM_RECOGNITION_FALLBACK_API_KEY \}\}/);
    assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_BASE_URL: \$\{\{ vars\.TELEGRAM_RECOGNITION_FALLBACK_BASE_URL \}\}/);
    assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_MODEL: \$\{\{ vars\.TELEGRAM_RECOGNITION_FALLBACK_MODEL \}\}/);
    assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS: \$\{\{ vars\.TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS \}\}/);
    assert.match(workflow, /db_content_changed=true/);
    assert.match(workflow, /readyStoredContentBatches/);
    assert.match(workflow, /- name: Write Telegram sync summary/);
    assert.match(workflow, /- name: Notify Telegram sync result/);
    assert.match(workflow, /if: success\(\) && steps\.channel\.outputs\.is_webhook_dispatch == 'true' && \(steps\.detect\.outputs\.repo_changed == 'true' \|\| steps\.detect\.outputs\.db_content_changed == 'true'\)/);
    assert.match(workflow, /strict_database_snapshot/);
    assert.doesNotMatch(workflow, /steps\.detect\.outputs\.db_content_changed == 'true'[\s\S]*uses:\s*\.\/\.github\/actions\/site-build/);
  }
});

test('telegram-sync workflows keep dev and main environment sources isolated', async () => {
  const main = await readWorkflowConfig('.github/workflows/sync.yml');
  const dev = await readWorkflowConfig('.github/workflows/sync-dev.yml');
  const mainSyncEnv = getWorkflowStep(main, 'sync', 'Sync updates').env;
  const devSyncEnv = getWorkflowStep(dev, 'sync', 'Sync updates').env;

  assert.equal(main.jobs.sync.env.TRAINING_DB_ENABLED, '${{ vars.TRAINING_DB_ENABLED }}');
  assert.equal(main.jobs.sync.env.TRAINING_DB_URL, '${{ secrets.TRAINING_DB_URL }}');
  assert.equal(main.jobs.sync.env.TRAINING_DB_APP_NAME, '${{ vars.TRAINING_DB_APP_NAME }}');
  assert.notEqual(main.jobs.sync.env.TRAINING_DB_URL, '${{ secrets.DEV_TRAINING_DB_URL }}');

  assert.equal(dev.jobs.sync.env.TRAINING_DB_ENABLED, 'true');
  assert.equal(dev.jobs.sync.env.TRAINING_DB_URL, '${{ secrets.DEV_TRAINING_DB_URL }}');
  assert.equal(dev.jobs.sync.env.TRAINING_DB_APP_NAME, '${{ vars.DEV_TRAINING_DB_APP_NAME }}');
  assert.notEqual(dev.jobs.sync.env.TRAINING_DB_URL, '${{ secrets.TRAINING_DB_URL }}');

  assert.equal(mainSyncEnv.TELEGRAM_BOT_TOKEN, '${{ secrets.TELEGRAM_BOT_TOKEN }}');
  assert.equal(devSyncEnv.TELEGRAM_BOT_TOKEN, '${{ secrets.DEV_TELEGRAM_BOT_TOKEN }}');
  assert.notEqual(devSyncEnv.TELEGRAM_BOT_TOKEN, mainSyncEnv.TELEGRAM_BOT_TOKEN);

  assert.equal(mainSyncEnv.FEISHU_APP_ID, '${{ secrets.FEISHU_APP_ID }}');
  assert.equal(mainSyncEnv.FEISHU_APP_SECRET, '${{ secrets.FEISHU_APP_SECRET }}');
  assert.equal(mainSyncEnv.FEISHU_ALLOWED_CHAT_IDS, '${{ vars.FEISHU_ALLOWED_CHAT_IDS }}');
  assert.equal(devSyncEnv.FEISHU_APP_ID, '${{ secrets.DEV_FEISHU_APP_ID || secrets.FEISHU_APP_ID }}');
  assert.equal(devSyncEnv.FEISHU_APP_SECRET, '${{ secrets.DEV_FEISHU_APP_SECRET || secrets.FEISHU_APP_SECRET }}');
  assert.equal(devSyncEnv.FEISHU_ALLOWED_CHAT_IDS, '${{ vars.DEV_FEISHU_ALLOWED_CHAT_IDS || vars.FEISHU_ALLOWED_CHAT_IDS }}');

  assert.equal(mainSyncEnv.COS_ENABLED, '${{ vars.COS_ENABLED }}');
  assert.equal(mainSyncEnv.COS_PROVIDER, "${{ vars.COS_PROVIDER || 'tencent_cos' }}");
  assert.equal(mainSyncEnv.COS_SECRET_ID, '${{ secrets.COS_SECRET_ID }}');
  assert.equal(mainSyncEnv.COS_SECRET_KEY, '${{ secrets.COS_SECRET_KEY }}');
  assert.equal(mainSyncEnv.COS_BUCKET, '${{ vars.COS_BUCKET }}');
  assert.equal(mainSyncEnv.COS_REGION, '${{ vars.COS_REGION }}');
  assert.equal(mainSyncEnv.COS_DOMAIN, '${{ vars.COS_DOMAIN }}');
  assert.equal(mainSyncEnv.COS_PATH_PREFIX, '${{ vars.COS_PATH_PREFIX }}');
  assert.equal(mainSyncEnv.SYNC_FAILURE_SUMMARY_PATH, '${{ runner.temp }}/sync-failure-summary.txt');

  assert.equal(devSyncEnv.COS_ENABLED, '${{ vars.DEV_COS_ENABLED }}');
  assert.equal(devSyncEnv.COS_PROVIDER, "${{ vars.DEV_COS_PROVIDER || 'tencent_cos' }}");
  assert.equal(devSyncEnv.COS_SECRET_ID, '${{ secrets.DEV_COS_SECRET_ID }}');
  assert.equal(devSyncEnv.COS_SECRET_KEY, '${{ secrets.DEV_COS_SECRET_KEY }}');
  assert.equal(devSyncEnv.COS_BUCKET, '${{ vars.DEV_COS_BUCKET }}');
  assert.equal(devSyncEnv.COS_REGION, '${{ vars.DEV_COS_REGION }}');
  assert.equal(devSyncEnv.COS_DOMAIN, '${{ vars.DEV_COS_DOMAIN }}');
  assert.equal(devSyncEnv.COS_PATH_PREFIX, '${{ vars.DEV_COS_PATH_PREFIX }}');
  assert.equal(devSyncEnv.SYNC_FAILURE_SUMMARY_PATH, '${{ runner.temp }}/sync-failure-summary.txt');
  assert.notEqual(devSyncEnv.COS_SECRET_ID, mainSyncEnv.COS_SECRET_ID);
  assert.notEqual(devSyncEnv.COS_BUCKET, mainSyncEnv.COS_BUCKET);

  // dev workflow 必须在启用 COS 时校验 dev bucket/domain 与 main 不同，防止污染生产图片
  const devSyncRun = getWorkflowStep(dev, 'sync', 'Sync updates').run;
  assert.match(devSyncRun, /COS_BUCKET.*=.*\$\{\{ vars\.COS_BUCKET \}\}/);
  assert.match(devSyncRun, /COS_DOMAIN.*=.*\$\{\{ vars\.COS_DOMAIN \}\}/);
  assert.match(devSyncRun, /dev COS bucket must differ from main COS bucket/);
  assert.match(devSyncRun, /dev COS domain must differ from main COS domain/);

  for (const workflow of [main, dev]) {
    const syncRun = getWorkflowStep(workflow, 'sync', 'Sync updates').run;
    const notifyFailureEnv = getWorkflowStep(workflow, 'sync', 'Notify Telegram sync failure').env;
    assert.match(syncRun, /sync-command\.log/);
    assert.match(syncRun, /SYNC_FAILURE_SUMMARY_PATH/);
    assert.match(syncRun, /grep -E/);
    assert.equal(notifyFailureEnv.SYNC_FAILURE_SUMMARY_PATH, '${{ runner.temp }}/sync-failure-summary.txt');
  }

  for (const envName of [
    'AI_API_KEY',
    'AI_PROVIDER',
    'AI_BASE_URL',
    'AI_MODEL',
    'AI_TIMEOUT_MS',
    'AI_CONCURRENCY',
    'TELEGRAM_RECOGNITION_MODEL',
    'TELEGRAM_RECOGNITION_FALLBACK_API_KEY',
    'TELEGRAM_RECOGNITION_FALLBACK_BASE_URL',
    'TELEGRAM_RECOGNITION_FALLBACK_MODEL',
    'TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS',
    'TELEGRAM_RECOGNITION_CACHE_ENABLED',
  ]) {
    assert.equal(devSyncEnv[envName], mainSyncEnv[envName], `${envName} should use the same repository-level source`);
  }
});

test('telegram-sync workflows treat stored thought batches as database content changes', async () => {
  const workflows = [
    await readWorkflow('.github/workflows/sync.yml'),
    await readWorkflow('.github/workflows/sync-dev.yml'),
  ];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-workflow-detect-'));
  const resultPath = path.join(tempRoot, 'telegram-sync-result.json');

  for (const kind of ['thought', 'thought_edit', 'thought_delete', 'thought_move']) {
    await writeFile(
      resultPath,
      JSON.stringify({
        batches: [
          {
            kind,
            status: 'ready',
            persistenceStatus: 'stored',
          },
        ],
      }),
      'utf8',
    );

    for (const workflow of workflows) {
      const detectionScript = extractDatabaseContentDetectionScript(workflow);
      const output = execFileSync(process.execPath, ['-e', detectionScript], {
        encoding: 'utf8',
        env: {
          ...process.env,
          SYNC_RESULT_PATH: resultPath,
          TELEGRAM_SYNC_RESULT_PATH: resultPath,
        },
      });

      assert.match(output, /db_content_changed=true/, `${kind} should trigger database content deploy`);
    }
  }
});

test('main sync workflow passes stored thought edit targets to async deploy verification', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-workflow-thought-check-'));
  const resultPath = path.join(tempRoot, 'feishu-sync-result.json');
  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'thought_edit',
          status: 'ready',
          persistenceStatus: 'stored',
          thoughtEdit: {
            targetMessageId: 590,
            thoughtModule: 'body_feedback',
          },
        },
      ],
    }),
    'utf8',
  );

  const detectionScript = extractDatabaseContentDetectionScript(workflow);
  const output = execFileSync(process.execPath, ['-e', detectionScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SYNC_RESULT_PATH: resultPath,
    },
  });

  assert.match(output, /db_content_changed=true/);
  assert.match(output, /thought_check_id=590/);
  assert.match(output, /thought_check_module=body_feedback/);
  assert.match(output, /thought_check_path=\/body-feedback\//);
});

test('main sync workflow uses persisted thought module when edit command preserves the existing module', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-workflow-thought-check-'));
  const resultPath = path.join(tempRoot, 'telegram-sync-result.json');
  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'thought_edit',
          status: 'ready',
          persistenceStatus: 'stored',
          persistedThoughtModule: 'misc',
          thoughtEdit: {
            targetMessageId: 592,
            thoughtModule: null,
          },
        },
      ],
    }),
    'utf8',
  );

  const detectionScript = extractDatabaseContentDetectionScript(workflow);
  const output = execFileSync(process.execPath, ['-e', detectionScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SYNC_RESULT_PATH: resultPath,
    },
  });

  assert.match(output, /db_content_changed=true/);
  assert.match(output, /thought_check_id=592/);
  assert.match(output, /thought_check_module=misc/);
  assert.match(output, /thought_check_path=\/misc\//);
  assert.match(output, /thought_check_expectation=present/);
});

test('main sync workflow sends deleted thought targets as absent deploy checks', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-workflow-thought-delete-check-'));
  const resultPath = path.join(tempRoot, 'telegram-sync-result.json');
  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'thought_delete',
          status: 'ready',
          persistenceStatus: 'stored',
          persistedThoughtModule: 'workout',
          thoughtDelete: {
            targetMessageId: 338182848231024,
            thoughtModule: null,
          },
        },
      ],
    }),
    'utf8',
  );

  const detectionScript = extractDatabaseContentDetectionScript(workflow);
  const output = execFileSync(process.execPath, ['-e', detectionScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SYNC_RESULT_PATH: resultPath,
    },
  });

  assert.match(output, /db_content_changed=true/);
  assert.match(output, /thought_check_id=338182848231024/);
  assert.match(output, /thought_check_module=workout/);
  assert.match(output, /thought_check_path=\/thoughts\//);
  assert.match(output, /thought_check_expectation=absent/);
});

test('telegram-sync workflow dispatch runs use unique concurrency groups while the worker queue controls ordering', async () => {
  const workflows = [
    ['.github/workflows/sync.yml', 'sync'],
    ['.github/workflows/sync-dev.yml', 'sync-dev'],
  ];

  for (const [workflowPath, groupName] of workflows) {
    const workflow = await readWorkflow(workflowPath);
    const expectedGroup = new RegExp(
      `group:\\s*\\$\\{\\{\\s*\\(github\\.event\\.inputs\\.queue_task_id \\|\\| github\\.event_name == 'repository_dispatch'\\) && format\\('${escapeRegExp(groupName)}-\\{0\\}', github\\.run_id\\) \\|\\| '${escapeRegExp(groupName)}'\\s*\\}\\}`,
    );

    assert.match(workflow, expectedGroup);
    assert.match(workflow, /cancel-in-progress:\s*false/);
    assert.doesNotMatch(
      workflow,
      new RegExp(`concurrency:\\s*\\n\\s*group:\\s*${escapeRegExp(groupName)}\\s*\\n\\s*cancel-in-progress:\\s*false`),
      `${workflowPath} must not put every repository_dispatch into one fixed pending queue`,
    );
  }
});

test('sync workflows accept queued workflow dispatch payloads and expose a webhook dispatch flag', async () => {
  for (const workflowPath of ['.github/workflows/sync.yml', '.github/workflows/sync-dev.yml']) {
    const workflow = await readWorkflow(workflowPath);

    assert.match(workflow, /dispatch_payload:\s*\n\s+description: Serialized webhook payload from the Cloudflare sync queue/);
    assert.match(workflow, /queue_task_id:\s*\n\s+description: Sync queue task id used to correlate workflow runs/);
    assert.match(workflow, /run-name:\s*\$\{\{ github\.event\.inputs\.queue_task_id && format\('Sync queue task \{0\}', github\.event\.inputs\.queue_task_id\) \|\| github\.event\.action \|\| github\.workflow \}\}/);
    assert.match(workflow, /IS_WEBHOOK_DISPATCH=true/);
    assert.match(workflow, /echo "is_webhook_dispatch=\$\{IS_WEBHOOK_DISPATCH\}" >> "\$GITHUB_OUTPUT"/);
    assert.match(workflow, /GITHUB_EVENT_PATH="\$RUNNER_TEMP\/queued-dispatch-event\.json"/);
    assert.match(workflow, /ORIGINAL_GITHUB_EVENT_PATH="\$GITHUB_EVENT_PATH"/);
    assert.match(workflow, /const workflowEvent = JSON\.parse\(fs\.readFileSync\(process\.env\.ORIGINAL_GITHUB_EVENT_PATH, 'utf8'\)\);/);
    assert.match(workflow, /const dispatchPayloadRaw = workflowEvent\.inputs\?\.dispatch_payload \?\? '';/);
    assert.match(workflow, /client_payload: payload\.client_payload \?\? payload/);
    assert.match(workflow, /echo "SYNC_DISPATCH_EVENT_PATH=\$GITHUB_EVENT_PATH" >> "\$GITHUB_ENV"/);
    assert.match(workflow, /steps\.channel\.outputs\.is_webhook_dispatch == 'true'/);
    assert.doesNotMatch(workflow, /DISPATCH_PAYLOAD:\s*\$\{\{\s*github\.event\.inputs\.dispatch_payload\s*\}\}/);
    assert.doesNotMatch(workflow, /SYNC_DISPATCH_PAYLOAD/);
    assert.doesNotMatch(workflow, /echo "\$DISPATCH_PAYLOAD" >> "\$GITHUB_ENV"/);
    assert.doesNotMatch(workflow, /echo "GITHUB_EVENT_PATH=\$GITHUB_EVENT_PATH" >> "\$GITHUB_ENV"/);
    assert.doesNotMatch(workflow, /\$\{\{\s*env\.SYNC_DISPATCH_PAYLOAD\s*\}\}/);
    assert.doesNotMatch(workflow, /if:\s*(?:always\(\) && |success\(\) && |failure\(\) && )?github\.event_name == 'repository_dispatch'/);
  }
});

test('sync workflow run scripts are valid bash after YAML parsing', async () => {
  for (const workflowPath of ['.github/workflows/sync.yml', '.github/workflows/sync-dev.yml']) {
    const scripts = await readWorkflowRunScripts(workflowPath);
    assert.ok(scripts.length >= 1, `${workflowPath} should contain run scripts`);

    for (const { jobName, stepName, script } of scripts) {
      assert.doesNotThrow(
        () => execFileSync('bash', ['-n'], {
          input: script,
          encoding: 'utf8',
          cwd: new URL('..', import.meta.url),
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
        `${workflowPath} ${jobName}/${stepName} should be valid bash`,
      );
    }
  }
});

test('thought deploy verification uses exact data-thought-id matches instead of id prefixes', async () => {
  for (const workflowPath of ['.github/workflows/deploy-pages.yml', '.github/workflows/deploy-cloudflare-pages-dev.yml']) {
    const workflow = await readWorkflow(workflowPath);

    assert.match(workflow, /data-thought-id=\\?"\$\{TARGET_THOUGHT_ID\}\\?"/);
    assert.doesNotMatch(workflow, /grep -F "#\$\{TARGET_THOUGHT_ID\}"/);
  }
});

test('Pages deployment uploads and deploys a single github-pages artifact path', async () => {
  const action = await readWorkflow('.github/actions/site-build/action.yml');
  const deployPages = await readWorkflow('.github/workflows/deploy-pages.yml');

  assert.equal(matchCount(action, /actions\/upload-pages-artifact@v3/g), 1);
  assert.equal(matchCount(action, /actions\/deploy-pages@v4/g), 1);
  assert.equal(matchCount(deployPages, /actions\/upload-pages-artifact@v3/g), 0);
  assert.equal(matchCount(deployPages, /actions\/deploy-pages@v4/g), 0);
  assert.match(deployPages, /uses:\s*\.\/\.github\/actions\/site-build/);
});

test('telegram-sync workflow summary normalizes partial failure task status from raw result files', async () => {
  const workflows = [
    await readWorkflow('.github/workflows/sync.yml'),
    await readWorkflow('.github/workflows/sync-dev.yml'),
  ];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-workflow-summary-'));
  const resultPath = path.join(tempRoot, 'telegram-sync-result.json');

  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'image',
          status: 'ready',
          batchId: 'album-partial-summary',
          archivedDate: '2026-06-13',
          dateConfidence: 'uncertain',
          dateSources: [
            { messageId: 6101, detectedDate: '2026-06-13', source: 'image' },
            { messageId: 6102, detectedDate: null, source: 'no_date' },
          ],
          warnings: ['detectedDate missing year | needs review'],
          persistenceStatus: 'stored',
          partialFailure: true,
          failureCategory: 'ai_service',
          failureReason: 'telegram_training_image returned invalid JSON',
          sourceImageCount: 2,
          recognizedImageCount: 1,
          failedImageCount: 1,
          aiCallLogStatus: 'written',
          messages: [
            { chatId: 42, messageId: 6101, updateId: 9101, mediaGroupId: 'album-partial-summary' },
            { chatId: 42, messageId: 6102, updateId: 9102, mediaGroupId: 'album-partial-summary' },
          ],
          recognitionErrors: [
            {
              messageId: 6102,
              error: 'telegram_training_image returned invalid JSON',
              failureCategory: 'ai_service',
            },
          ],
        },
      ],
    }),
    'utf8',
  );

  for (const workflow of workflows) {
    const summaryScript = extractTelegramSyncSummaryScript(workflow);
    const output = execFileSync(process.execPath, ['-e', summaryScript], {
      encoding: 'utf8',
      cwd: rootDir,
      env: {
        ...process.env,
        TELEGRAM_SYNC_RESULT_PATH: resultPath,
      },
    });

    assert.match(output, /archivedDate \| dateSources \| warnings \| dateConfidence \| images \| aiAttemptKinds \| aiCallLogStatus/);
    assert.match(output, /image:2026-06-13/);
    assert.match(output, /no_date:null/);
    assert.match(output, /detectedDate missing year \/ needs review/);
    assert.match(output, /\| album-partial-summary \| partialFailure \| stored \| 2026-06-13 \| image:2026-06-13; no_date:null \| detectedDate missing year \/ needs review \| uncertain \| 2\/1\/1 \|  \| written \|/);
    assert.match(output, /\| auto_retry \| 6102 \|/);
    assert.doesNotMatch(output, /\| album-partial-summary \| ready \| stored/);
  }
});

test('sync workflow summaries emit image storage stats when batches upload to COS', async () => {
  const workflows = [
    await readWorkflow('.github/workflows/sync.yml'),
    await readWorkflow('.github/workflows/sync-dev.yml'),
  ];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sync-workflow-image-storage-'));
  const resultPath = path.join(tempRoot, 'telegram-sync-result.json');

  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'thought',
          status: 'ready',
          batchId: 'thought-cos-1',
          archivedDate: '2026-06-13',
          persistenceStatus: 'stored',
          thoughtWriteStatus: 'images_written',
          messages: [{ chatId: 42, messageId: 700, updateId: 9200 }],
          thought: {
            storage: {
              imageUploadStats: {
                provider: 'tencent_cos',
                bucket: 'training-images-dev-1250000000',
                pathPrefix: 'dev',
                uploaded: 1,
                skipped: 0,
                failed: 0,
                totalUploadMs: 42,
                maxSingleUploadMs: 42,
                firstUrlHost: 'training-images-dev-1250000000.cos.ap-shanghai.myqcloud.com',
              },
            },
          },
        },
      ],
    }),
    'utf8',
  );

  for (const workflow of workflows) {
    const summaryScript = extractTelegramSyncSummaryScript(workflow);
    const output = execFileSync(process.execPath, ['-e', summaryScript], {
      encoding: 'utf8',
      cwd: rootDir,
      env: {
        ...process.env,
        TELEGRAM_SYNC_RESULT_PATH: resultPath,
      },
    });

    assert.match(output, /## Image storage/);
    assert.match(output, /\| tencent_cos \| training-images-dev-1250000000 \| dev \| 1 \| 0 \| 0 \| 42 \| 42 \| training-images-dev-1250000000\.cos\.ap-shanghai\.myqcloud\.com \|/);
  }
});

test('sync workflow summaries omit image storage section when no COS uploads occurred', async () => {
  const workflows = [
    await readWorkflow('.github/workflows/sync.yml'),
    await readWorkflow('.github/workflows/sync-dev.yml'),
  ];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sync-workflow-no-image-storage-'));
  const resultPath = path.join(tempRoot, 'telegram-sync-result.json');

  await writeFile(
    resultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'image',
          status: 'ready',
          batchId: 'album-no-cos',
          archivedDate: '2026-06-13',
          persistenceStatus: 'stored',
          messages: [{ chatId: 42, messageId: 701, updateId: 9201 }],
        },
      ],
    }),
    'utf8',
  );

  for (const workflow of workflows) {
    const summaryScript = extractTelegramSyncSummaryScript(workflow);
    const output = execFileSync(process.execPath, ['-e', summaryScript], {
      encoding: 'utf8',
      cwd: rootDir,
      env: {
        ...process.env,
        TELEGRAM_SYNC_RESULT_PATH: resultPath,
      },
    });

    assert.doesNotMatch(output, /## Image storage/);
  }
});

test('sync workflow summaries emit warnings for business-incomplete batches', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sync-workflow-business-warning-'));
  const telegramResultPath = path.join(tempRoot, 'telegram-sync-result.json');
  const feishuResultPath = path.join(tempRoot, 'feishu-sync-result.json');

  await writeFile(
    telegramResultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'image',
          status: 'ready',
          batchId: 'tg-pending-db',
          archivedDate: '2026-06-13',
          persistenceStatus: 'pending_replay',
          persistenceError: 'database unavailable',
          sourceImageCount: 1,
          recognizedImageCount: 1,
          failedImageCount: 0,
          messages: [{ chatId: 42, messageId: 6101 }],
        },
        {
          kind: 'image',
          status: 'ready',
          batchId: 'tg-partial-ai',
          archivedDate: '2026-06-13',
          persistenceStatus: 'stored',
          partialFailure: true,
          sourceImageCount: 2,
          recognizedImageCount: 1,
          failedImageCount: 1,
          recognitionErrors: [{ messageId: 6103, error: 'invalid JSON' }],
          messages: [{ chatId: 42, messageId: 6102 }, { chatId: 42, messageId: 6103 }],
        },
      ],
    }),
    'utf8',
  );

  await writeFile(
    feishuResultPath,
    JSON.stringify({
      batchResults: [
        {
          kind: 'image',
          status: 'skipped',
          batchId: 'fs-manual-date',
          sourceId: 'evt-1',
          chatIds: ['oc_1'],
          archivedDate: '2026-06-17',
          dateConfidence: 'missing',
          dateSources: [{ source: 'no_date', detectedDate: null }],
          warnings: ['no reliable image or filename date'],
          failureDisposition: 'manual_intervention',
          failureReason: 'no reliable image or filename date',
          sourceImageCount: 1,
          recognizedImageCount: 0,
          failedImageCount: 1,
          messages: [{ sourceMessageId: 'om_1' }],
        },
      ],
    }),
    'utf8',
  );

  for (const workflowPath of ['.github/workflows/sync.yml', '.github/workflows/sync-dev.yml']) {
    const telegramSummary = getWorkflowStep(
      await readWorkflowConfig(workflowPath),
      'sync',
      'Write Telegram sync summary',
    ).run;
    const telegramOutput = execFileSync(process.execPath, ['-e', extractNodeHereDocScript(telegramSummary)], {
      encoding: 'utf8',
      cwd: rootDir,
      env: {
        ...process.env,
        TELEGRAM_SYNC_RESULT_PATH: telegramResultPath,
      },
    });

    assert.match(telegramOutput, /::warning title=Telegram sync business incomplete::/);
    assert.match(telegramOutput, /tg-pending-db.*pending_replay/);
    assert.match(telegramOutput, /tg-partial-ai.*partialFailure/);

    const feishuSummary = getWorkflowStep(
      await readWorkflowConfig(workflowPath),
      'sync',
      'Write Feishu sync summary',
    ).run;
    const feishuOutput = execFileSync(process.execPath, ['-e', extractNodeHereDocScript(feishuSummary)], {
      encoding: 'utf8',
      cwd: rootDir,
      env: {
        ...process.env,
        FEISHU_SYNC_RESULT_PATH: feishuResultPath,
      },
    });

    assert.match(feishuOutput, /::warning title=Feishu sync business incomplete::/);
    assert.match(feishuOutput, /fs-manual-date.*manual_intervention/);
    assert.match(feishuOutput, /archivedDate \| dateSources \| warnings \| dateConfidence \| images/);
    assert.match(feishuOutput, /no_date:null/);
    assert.match(feishuOutput, /no reliable image or filename date/);
    assert.match(feishuOutput, /\| fs-manual-date \| [^|]+ \| [^|]* \| skipped \|  \| 2026-06-17 \| no_date:null \| no reliable image or filename date \| missing \| 1\/0\/1 \|/);
  }
});

test('markdown backup workflow exports database snapshots behind GitHub variable gates', async () => {
  const workflow = await readWorkflow('.github/workflows/markdown-backup.yml');

  assert.match(workflow, /name:\s*Markdown Backup/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*'37 19 \* \* \*'/);
  assert.match(workflow, /MARKDOWN_BACKUP_ENABLED:\s*\$\{\{\s*vars\.MARKDOWN_BACKUP_ENABLED \|\| 'false'\s*\}\}/);
  assert.match(workflow, /MARKDOWN_BACKUP_FREQUENCY:\s*\$\{\{\s*vars\.MARKDOWN_BACKUP_FREQUENCY \|\| 'weekly'\s*\}\}/);
  assert.match(workflow, /MARKDOWN_BACKUP_BRANCH:\s*\$\{\{\s*vars\.MARKDOWN_BACKUP_BRANCH \|\| 'main'\s*\}\}/);
  assert.match(workflow, /MARKDOWN_BACKUP_COMMIT:\s*\$\{\{\s*vars\.MARKDOWN_BACKUP_COMMIT \|\| 'true'\s*\}\}/);
  assert.match(workflow, /TRAINING_SNAPSHOT_SOURCE:\s*database/);
  assert.match(workflow, /TRAINING_SNAPSHOT_STRICT_DATABASE:\s*'true'/);
  assert.match(workflow, /if \[ "\$enabled" != "true" \]/);
  assert.match(workflow, /if \[ "\$frequency" = "daily" \]/);
  assert.match(workflow, /if \[ "\$frequency" = "weekly" \] && \[ "\$\(date -u \+%u\)" = "1" \]/);
  assert.match(workflow, /run:\s*npm run export:markdown/);
  assert.match(workflow, /git status --porcelain -- 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /backup_alert=changed_without_commit/);
  assert.match(workflow, /::warning title=Markdown backup changed without commit::/);
  assert.match(workflow, /Conclusion:/);
  const maintenanceGuide = await readFile(
    new URL('../docs/系统核心.md#日常维护', import.meta.url),
    'utf8',
  );
  assert.match(maintenanceGuide, /changed_without_commit/);
  assert.match(maintenanceGuide, /workflow_failed_before_alert_evaluation/);
  assert.match(workflow, /git commit -m "chore: backup markdown from database"/);
  assert.match(workflow, /git push origin HEAD:"\$MARKDOWN_BACKUP_BRANCH"/);
});

test('main sync workflow handles production dispatches and writes main branch', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');

  assert.match(workflow, /name:\s*Sync \(Main\)/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:/);
  assert.match(workflow, /dispatch_payload:/);
  assert.match(workflow, /queue_task_id:/);
  assert.match(workflow, /channel:/);
  assert.match(workflow, /type:\s*choice/);
  assert.match(workflow, /default:\s*telegram/);
  assert.match(workflow, /-\s*telegram/);
  assert.match(workflow, /-\s*feishu/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /repository_dispatch:\s*\n\s+types:\s*\n\s+- telegram_update\s*\n\s+- feishu_update/);
  assert.doesNotMatch(workflow, /-\s*telegram_update_dev\s*(?:\n|$)/);
  assert.doesNotMatch(workflow, /-\s*feishu_update_dev\s*(?:\n|$)/);
  assert.match(workflow, /- name: Checkout main branch\s*\n\s+uses: actions\/checkout@v4\s*\n\s+with:\s*\n\s+ref:\s*main/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*write\s*\n\s+actions:\s*write/);
  assert.match(workflow, /TRAINING_DB_URL:\s*\$\{\{\s*secrets\.TRAINING_DB_URL\s*\}\}/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN:\s*\$\{\{\s*secrets\.TELEGRAM_BOT_TOKEN\s*\}\}/);
  assert.match(workflow, /FEISHU_APP_ID:\s*\$\{\{\s*secrets\.FEISHU_APP_ID\s*\}\}/);
  assert.match(workflow, /FEISHU_ALLOWED_CHAT_IDS:\s*\$\{\{\s*vars\.FEISHU_ALLOWED_CHAT_IDS\s*\}\}/);
  assert.match(workflow, /export TRAINING_DB_APP_NAME=sync-main-feishu/);
  assert.match(workflow, /echo "commit_message=chore: sync Telegram updates"/);
  assert.match(workflow, /echo "commit_message=chore: sync Feishu updates"/);
  assert.match(workflow, /npm run \$\{\{ steps\.channel\.outputs\.sync_command \}\}/);
  assert.match(workflow, /git add 训练记录\.md source\/_posts source\/images/);
  assert.doesNotMatch(workflow, /git add -A/);
  assert.match(workflow, /run:\s*git push origin HEAD:main/);
});

test('telegram-sync dev workflow only handles dev dispatches and writes dev branch', async () => {
  const workflow = await readWorkflow('.github/workflows/sync-dev.yml');

  assert.match(workflow, /name:\s*Sync \(Dev\)/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:/);
  assert.match(workflow, /dispatch_payload:/);
  assert.match(workflow, /queue_task_id:/);
  assert.match(workflow, /channel:/);
  assert.match(workflow, /type:\s*choice/);
  assert.match(workflow, /default:\s*telegram/);
  assert.match(workflow, /-\s*telegram/);
  assert.match(workflow, /-\s*feishu/);
  assert.match(workflow, /repository_dispatch:\s*\n\s+types:\s*\n\s+- telegram_update_dev\s*\n\s+- feishu_update_dev/);
  assert.doesNotMatch(workflow, /-\s*telegram_update\s*(?:\n|$)/);
  assert.doesNotMatch(workflow, /-\s*feishu_update\s*(?:\n|$)/);
  assert.match(workflow, /- name: Checkout dev branch\s*\n\s+uses: actions\/checkout@v4\s*\n\s+with:\s*\n\s+ref:\s*dev/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*write\s*\n\s+actions:\s*write/);
  assert.match(workflow, /TRAINING_DB_URL:\s*\$\{\{\s*secrets\.DEV_TRAINING_DB_URL\s*\}\}/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN:\s*\$\{\{\s*secrets\.DEV_TELEGRAM_BOT_TOKEN\s*\}\}/);
  assert.match(workflow, /FEISHU_APP_ID:\s*\$\{\{\s*secrets\.DEV_FEISHU_APP_ID \|\| secrets\.FEISHU_APP_ID\s*\}\}/);
  assert.match(workflow, /FEISHU_ALLOWED_CHAT_IDS:\s*\$\{\{\s*vars\.DEV_FEISHU_ALLOWED_CHAT_IDS \|\| vars\.FEISHU_ALLOWED_CHAT_IDS\s*\}\}/);
  assert.match(workflow, /export TRAINING_DB_APP_NAME=sync-dev-feishu/);
  assert.match(workflow, /echo "commit_message=chore\(dev\): sync Telegram updates"/);
  assert.match(workflow, /echo "commit_message=chore\(dev\): sync Feishu updates"/);
  assert.match(workflow, /git add 训练记录\.md source\/_posts source\/images/);
  assert.doesNotMatch(workflow, /git add -A/);
  assert.match(workflow, /run:\s*git push origin HEAD:dev/);
});

test('telegram-sync dev workflow waits for the dev deploy workflow', async () => {
  const workflow = await readWorkflow('.github/workflows/sync-dev.yml');
  const deployWorkflow = await readWorkflow('.github/workflows/deploy-cloudflare-pages-dev.yml');

  assert.doesNotMatch(workflow, /- name: Build and deploy dev site snapshot/);
  assert.doesNotMatch(workflow, /- name: Remove production custom domain file/);
  assert.doesNotMatch(workflow, /- name: Deploy dev site to Cloudflare Pages/);
  assert.doesNotMatch(workflow, /STEP_PAGES_DEPLOY_OUTCOME/);
  assert.match(workflow, /- name: Trigger and wait for async dev site deploy/);
  assert.match(workflow, /actions\/workflows\/deploy-cloudflare-pages-dev\.yml\/dispatches/);
  assert.match(workflow, /AI_PROVIDER:\s*\$\{\{\s*vars\.AI_PROVIDER \|\| 'openai-compatible'\s*\}\}/);
  assert.match(workflow, /AI_TIMEOUT_MS:\s*\$\{\{\s*vars\.AI_TIMEOUT_MS\s*\}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE: inline/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_MODEL: \$\{\{ vars\.TELEGRAM_RECOGNITION_MODEL \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_API_KEY: \$\{\{ secrets\.TELEGRAM_RECOGNITION_FALLBACK_API_KEY \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_BASE_URL: \$\{\{ vars\.TELEGRAM_RECOGNITION_FALLBACK_BASE_URL \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_MODEL: \$\{\{ vars\.TELEGRAM_RECOGNITION_FALLBACK_MODEL \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS: \$\{\{ vars\.TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS \}\}/);
  assert.match(workflow, /TELEGRAM_RECOGNITION_CACHE_ENABLED: \$\{\{ vars\.TELEGRAM_RECOGNITION_CACHE_ENABLED \}\}/);
  assert.match(workflow, /dispatch_body="\$\(node <<'NODE'/);
  assert.match(workflow, /process\.stdout\.write\(JSON\.stringify\(\{ ref: 'dev', inputs \}\)\)/);
  assert.match(workflow, /target_thought_expectation/);
  assert.match(workflow, /- name: Trigger and wait for async dev site deploy\n\s+id: deploy/);
  assert.match(workflow, /-d "\$dispatch_body"/);
  const deployStep = workflow.slice(
    workflow.indexOf('- name: Trigger and wait for async dev site deploy'),
    workflow.indexOf('- name: Notify Telegram sync failure'),
  );
  assert.doesNotMatch(deployStep, /continue-on-error:\s*true/);
  assert.match(deployStep, /dispatch_started_at=/);
  assert.match(deployStep, /actions\/workflows\/deploy-cloudflare-pages-dev\.yml\/runs/);
  assert.match(deployStep, /Deploy workflow failed/);
  assert.match(deployStep, /GITHUB_STEP_SUMMARY/);
  assert.match(deployStep, /## Site deploy result/);
  assert.match(deployStep, /\| workflow \| runId \| status \| conclusion \| url \|/);
  assert.match(deployStep, /appendDeploySummary/);
  assert.match(deployStep, /Deploy workflow succeeded/);
  assert.match(workflow, /STEP_DEPLOY_OUTCOME: \$\{\{ steps\.deploy\.outcome \}\}/);
  assert.match(deployWorkflow, /push:\s*\n\s+branches:\s*\n\s+- dev/);
  assert.match(deployWorkflow, /workflow_dispatch:/);
  assert.match(deployWorkflow, /- name: Build dev site/);
  assert.match(deployWorkflow, /- name: Remove production custom domain file/);
  assert.match(deployWorkflow, /- name: Deploy to Cloudflare Pages/);
  assert.match(deployWorkflow, /token_names\+=\("CLOUDFLARE_API_TOKEN"\)/);
  assert.match(deployWorkflow, /token_names\+=\("CLOUDFLARE_PAGES_API_TOKEN"\)/);
  assert.match(
    deployWorkflow,
    /npx --yes wrangler@3\.114\.14 --cwd public pages deploy \. --project-name "\$\{CLOUDFLARE_PAGES_DEV_PROJECT_NAME\}" --branch dev/,
  );
  assert.doesNotMatch(deployWorkflow, /--config wrangler\.pages\.dev\.toml/);
});

test('dev Worker config dispatches to the dev Telegram workflow event', async () => {
  const config = (await readFile(new URL('wrangler.dev.toml', rootDir), 'utf8')).replace(/\r\n?/g, '\n');

  assert.match(config, /name\s*=\s*"sync-dispatch-dev"/);
  assert.match(config, /main\s*=\s*"cloudflare\/sync-dispatch-worker\.mjs"/);
  assert.match(config, /\[vars\]\s*\n(?:.*\n)*?GITHUB_DISPATCH_EVENT_TYPE_TELEGRAM\s*=\s*"telegram_update_dev"/);
  assert.match(config, /\[vars\]\s*\n(?:.*\n)*?GITHUB_DISPATCH_EVENT_TYPE_FEISHU\s*=\s*"feishu_update_dev"/);
});

test('package fast tests skip the slow thought module page render and exposes sync db', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', rootDir), 'utf8'));

  assert.match(packageJson.scripts['test:fast'], /thought module pages/);
  assert.equal(packageJson.scripts['sync:db'], 'node tools/training-maintenance.mjs sync');
});

test('main sync workflow reports queued webhook dispatch failures back to Telegram', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');

  for (const [stepName, stepId] of [
    ['Install dependencies', 'install'],
    ['Sync updates', 'sync'],
    ['Detect changes', 'detect'],
    ['Run tests', 'test'],
    ['Commit sync results', 'commit'],
    ['Rebase on latest main', 'rebase'],
    ['Push changes', 'push'],
    ['Trigger and wait for site deploy', 'deploy'],
  ]) {
    assert.match(
      workflow,
      new RegExp(`- name: ${escapeRegExp(stepName)}\\n\\s+id: ${stepId}`),
      `${stepName} should have stable id ${stepId}`,
    );
  }

  assert.match(workflow, /- name: Notify Telegram sync failure/);
  assert.match(workflow, /if: failure\(\) && steps\.channel\.outputs\.is_webhook_dispatch == 'true'/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /- name: Notify Telegram sync result/);
  assert.match(workflow, /if: success\(\) && steps\.channel\.outputs\.is_webhook_dispatch == 'true'/);
  assert.match(workflow, /node tools\/telegram-sync-notify\.mjs/);
  assert.match(workflow, /node tools\/telegram-action-monitor\.mjs/);
  assert.match(workflow, /STEP_INSTALL_OUTCOME: \$\{\{ steps\.install\.outcome \}\}/);
  assert.match(workflow, /STEP_DEPLOY_OUTCOME: \$\{\{ steps\.deploy\.outcome \}\}/);
  assert.match(workflow, /- name: Trigger and wait for site deploy/);
  const deployStep = workflow.slice(
    workflow.indexOf('- name: Trigger and wait for site deploy'),
    workflow.indexOf('- name: Notify Telegram sync failure'),
  );
  assert.doesNotMatch(deployStep, /continue-on-error:\s*true/);
  assert.doesNotMatch(workflow, /STEP_SITE_BUILD_OUTCOME/);
  assert.doesNotMatch(workflow, /STEP_PAGES_DEPLOY_OUTCOME/);
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

async function readWorkflowConfig(relativePath) {
  return parseYaml(await readWorkflow(relativePath));
}

function getWorkflowStep(workflow, jobName, stepName) {
  const step = workflow?.jobs?.[jobName]?.steps?.find((candidate) => candidate?.name === stepName);
  assert.ok(step, `missing ${jobName} step: ${stepName}`);
  return step;
}

async function readWorkflowRunScripts(relativePath) {
  const parsed = await readWorkflowConfig(relativePath);
  const scripts = [];
  for (const [jobName, job] of Object.entries(parsed?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run !== 'string') {
        continue;
      }
      scripts.push({
        jobName,
        stepName: step.name ?? '(unnamed step)',
        script: step.run,
      });
    }
  }
  return scripts;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchCount(value, pattern) {
  return Array.from(value.matchAll(pattern)).length;
}

function extractDatabaseContentDetectionScript(workflow) {
  const match = workflow.match(/node <<'NODE' >> "\$GITHUB_OUTPUT"\n([\s\S]*?readyStored[\s\S]*?)\n\s*NODE/);
  assert.ok(match, 'missing database content detection script');
  return match[1];
}

function extractTelegramSyncSummaryScript(workflow) {
  const match = workflow.match(/node <<'NODE' >> "\$GITHUB_STEP_SUMMARY"\n([\s\S]*?)\n\s*NODE/);
  assert.ok(match, 'missing Telegram sync summary script');
  return match[1];
}

function extractNodeHereDocScript(runScript) {
  const match = runScript.match(/node <<'NODE' >> "\$GITHUB_STEP_SUMMARY"\n([\s\S]*?)\n\s*NODE/);
  assert.ok(match, 'missing Node summary here-doc');
  return match[1];
}
