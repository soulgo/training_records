import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  assert.ok(
    action.indexOf('- name: Export database markdown for Hexo posts') > action.indexOf('- name: Sync safe database repairs'),
    'database markdown export should run after safe database repairs',
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
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.doesNotMatch(workflow, /ref:\s*main/);
  assert.match(workflow, /- name: Build and deploy site/);
  assert.match(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.match(workflow, /run_backfill:\s*'true'/);
  assert.match(workflow, /sync_db_mode:\s*'auto'/);
  assert.match(workflow, /run_tests:\s*'true'/);
  assert.match(workflow, /deploy:\s*'true'/);
  assert.match(workflow, /strict_database_snapshot:/);
  assert.match(workflow, /TRAINING_SNAPSHOT_STRICT_DATABASE:/);
  assert.match(workflow, /TRAINING_BUILD_ARCHIVE_WRITE:\s*false/);
  assert.match(workflow, /CLOUDFLARE_ZONE_ID:\s*\$\{\{\s*secrets\.CLOUDFLARE_ZONE_ID\s*\}\}/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
  assert.match(workflow, /- name: Purge Cloudflare cache/);
  assert.match(
    workflow,
    /if: \$\{\{ success\(\) && env\.CLOUDFLARE_ZONE_ID != '' && env\.CLOUDFLARE_API_TOKEN != '' \}\}/,
  );
  assert.match(workflow, /zones\/\$\{CLOUDFLARE_ZONE_ID\}\/purge_cache/);
  assert.match(workflow, /"purge_everything":true/);
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
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- dev/);
  assert.match(workflow, /group:\s*cloudflare-pages-dev/);
  assert.match(workflow, /TRAINING_DB_URL:\s*\$\{\{\s*secrets\.DEV_TRAINING_DB_URL\s*\}\}/);
  assert.match(workflow, /TRAINING_DB_APP_NAME:\s*\$\{\{\s*vars\.DEV_TRAINING_DB_APP_NAME\s*\}\}/);
  assert.match(workflow, /TRAINING_SNAPSHOT_STRICT_DATABASE:/);
  assert.match(workflow, /TRAINING_BUILD_ARCHIVE_WRITE:\s*false/);
  assert.match(workflow, /ref:\s*dev/);
  assert.match(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.match(workflow, /run_backfill:\s*'true'/);
  assert.match(workflow, /sync_db_mode:\s*'auto'/);
  assert.match(workflow, /run_tests:\s*'true'/);
  assert.match(workflow, /deploy:\s*'false'/);
  assert.match(workflow, /rm -f public\/CNAME/);
  assert.match(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /apiToken:\s*\$\{\{\s*secrets\.CLOUDFLARE_PAGES_API_TOKEN\s*\}\}/);
  assert.match(workflow, /accountId:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/);
  assert.match(workflow, /--cwd public pages deploy \./);
  assert.doesNotMatch(workflow, /--config wrangler\.pages\.dev\.toml/);
  assert.match(workflow, /--project-name \$\{\{\s*vars\.CLOUDFLARE_PAGES_DEV_PROJECT_NAME \|\| 'training-records-dev'\s*\}\}/);
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
  assert.doesNotMatch(workflow, /push:/);
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
    assert.match(workflow, /batch\.sourceId/);
    assert.match(workflow, /batch\.chatIds/);
  }
});

test('feishu-sync workflows report repository dispatch failures back to Feishu', async () => {
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
    assert.match(workflow, /if: failure\(\) && github\.event_name == 'repository_dispatch'/);
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

test('main sync workflow notifies after sync and dispatches async site deploys', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');

  assert.match(workflow, /git status --porcelain -- 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /db_content_changed=false/);
  assert.match(workflow, /db_content_changed=true/);
  assert.match(workflow, /git add 训练记录\.md source\/_posts source\/images/);
  assert.match(workflow, /echo "commit_message=chore: sync Telegram updates"/);
  assert.match(workflow, /echo "commit_message=chore: sync Feishu updates"/);
  assert.match(workflow, /git commit -m "\$\{\{ steps\.channel\.outputs\.commit_message \}\}"/);
  assert.match(workflow, /- name: Run tests\s*\n\s*id: test\s*\n\s*if: github\.event_name != 'repository_dispatch' && steps\.channel\.outputs\.channel == 'telegram' && steps\.detect\.outputs\.content_changed == 'true'/);
  assert.match(workflow, /run:\s*npm run test:fast/);
  assert.doesNotMatch(workflow, /- name: Build and deploy site snapshot/);
  assert.doesNotMatch(workflow, /uses:\s*\.\/\.github\/actions\/site-build/);
  assert.doesNotMatch(workflow, /id:\s*site_build/);
  assert.match(workflow, /- name: Write Telegram sync summary/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /stage \| ms/);
  assert.match(workflow, /batchId \| taskStatus \| persistenceStatus \| archivedDate \| images \| pending \| failureDisposition \| failed messageIds/);
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
  assert.match(workflow, /- name: Trigger async site deploy/);
  assert.match(workflow, /actions\/workflows\/deploy-pages\.yml\/dispatches/);
  assert.match(workflow, /steps\.detect\.outputs\.repo_changed == 'true' \|\| steps\.detect\.outputs\.db_content_changed == 'true'/);
  assert.match(workflow, /-d '\{"ref":"main","inputs":\{"strict_database_snapshot":"true"\}\}'/);
  assert.ok(
    workflow.indexOf('- name: Notify Telegram sync result') > workflow.indexOf('- name: Push changes'),
    'Telegram notification should run after push and before any asynchronous site deployment workflow',
  );
  assert.ok(
    workflow.indexOf('- name: Trigger async site deploy') > workflow.indexOf('- name: Notify Telegram sync result'),
    'Async deploy should be triggered only after Telegram has been notified',
  );
});

test('main sync workflow keeps change detection and maintenance gating intact', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');

  assert.match(workflow, /- name: Detect changes/);
  assert.match(workflow, /repo_changed=false/);
  assert.match(workflow, /content_changed=false/);
  assert.match(
    workflow,
    /- name: Sync safe database repairs\n\s+if: github\.event_name != 'repository_dispatch' && steps\.channel\.outputs\.channel == 'telegram'\n\s+run:\s*npm run sync:db/,
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
    assert.match(workflow, /if: success\(\) && github\.event_name == 'repository_dispatch' && \(steps\.detect\.outputs\.repo_changed == 'true' \|\| steps\.detect\.outputs\.db_content_changed == 'true'\)/);
    assert.match(workflow, /strict_database_snapshot/);
    assert.doesNotMatch(workflow, /steps\.detect\.outputs\.db_content_changed == 'true'[\s\S]*uses:\s*\.\/\.github\/actions\/site-build/);
  }
});

test('telegram-sync workflows treat stored thought batches as database content changes', async () => {
  const workflows = [
    await readWorkflow('.github/workflows/sync.yml'),
    await readWorkflow('.github/workflows/sync-dev.yml'),
  ];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-workflow-detect-'));
  const resultPath = path.join(tempRoot, 'telegram-sync-result.json');

  await writeFile(
    resultPath,
    JSON.stringify({
      batches: [
        {
          kind: 'thought',
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

    assert.match(output, /db_content_changed=true/);
  }
});

test('telegram-sync repository dispatch runs use unique concurrency groups for consecutive image batches', async () => {
  const workflows = [
    ['.github/workflows/sync.yml', 'sync'],
    ['.github/workflows/sync-dev.yml', 'sync-dev'],
  ];

  for (const [workflowPath, groupName] of workflows) {
    const workflow = await readWorkflow(workflowPath);
    const expectedGroup = new RegExp(
      `group:\\s*\\$\\{\\{\\s*github\\.event_name == 'repository_dispatch' && format\\('${escapeRegExp(groupName)}-\\{0\\}', github\\.run_id\\) \\|\\| '${escapeRegExp(groupName)}'\\s*\\}\\}`,
    );

    assert.match(workflow, expectedGroup);
    assert.match(workflow, /cancel-in-progress:\s*false/);
    assert.doesNotMatch(
      workflow,
      new RegExp(`concurrency:\\s*\\n\\s*group:\\s*${escapeRegExp(groupName)}\\s*\\n\\s*cancel-in-progress:\\s*false`),
      `${workflowPath} must not put every Telegram dispatch into one fixed pending queue`,
    );
  }
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
          persistenceStatus: 'stored',
          partialFailure: true,
          failureCategory: 'ai_service',
          failureReason: 'telegram_training_image returned invalid JSON',
          sourceImageCount: 2,
          recognizedImageCount: 1,
          failedImageCount: 1,
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

    assert.match(output, /\| album-partial-summary \| partialFailure \| stored \| 2026-06-13 \| 2\/1\/1 \|/);
    assert.match(output, /\| auto_retry \| 6102 \|/);
    assert.doesNotMatch(output, /\| album-partial-summary \| ready \| stored/);
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
  assert.match(workflow, /git commit -m "chore: backup markdown from database"/);
  assert.match(workflow, /git push origin HEAD:"\$MARKDOWN_BACKUP_BRANCH"/);
});

test('main sync workflow handles production dispatches and writes main branch', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');

  assert.match(workflow, /name:\s*Sync \(Main\)/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+channel:/);
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
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+channel:/);
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

test('telegram-sync dev workflow leaves Pages deployment to the dev deploy workflow', async () => {
  const workflow = await readWorkflow('.github/workflows/sync-dev.yml');
  const deployWorkflow = await readWorkflow('.github/workflows/deploy-cloudflare-pages-dev.yml');

  assert.doesNotMatch(workflow, /- name: Build and deploy dev site snapshot/);
  assert.doesNotMatch(workflow, /- name: Remove production custom domain file/);
  assert.doesNotMatch(workflow, /- name: Deploy dev site to Cloudflare Pages/);
  assert.doesNotMatch(workflow, /STEP_PAGES_DEPLOY_OUTCOME/);
  assert.match(workflow, /- name: Trigger async dev site deploy/);
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
  assert.match(workflow, /-d '\{"ref":"dev","inputs":\{"strict_database_snapshot":"true"\}\}'/);
  assert.match(deployWorkflow, /push:\s*\n\s+branches:\s*\n\s+- dev/);
  assert.match(deployWorkflow, /workflow_dispatch:/);
  assert.match(deployWorkflow, /- name: Build dev site/);
  assert.match(deployWorkflow, /- name: Remove production custom domain file/);
  assert.match(deployWorkflow, /- name: Deploy to Cloudflare Pages/);
  assert.match(
    deployWorkflow,
    /command: --cwd public pages deploy \. --project-name \$\{\{\s*vars\.CLOUDFLARE_PAGES_DEV_PROJECT_NAME \|\| 'training-records-dev'\s*\}\} --branch dev/,
  );
  assert.doesNotMatch(deployWorkflow, /--config wrangler\.pages\.dev\.toml/);
});

test('dev Worker config dispatches to the dev Telegram workflow event', async () => {
  const config = await readFile(new URL('wrangler.dev.toml', rootDir), 'utf8');

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

test('main sync workflow reports repository dispatch failures back to Telegram', async () => {
  const workflow = await readWorkflow('.github/workflows/sync.yml');

  for (const [stepName, stepId] of [
    ['Install dependencies', 'install'],
    ['Sync updates', 'sync'],
    ['Detect changes', 'detect'],
    ['Run tests', 'test'],
    ['Commit sync results', 'commit'],
    ['Rebase on latest main', 'rebase'],
    ['Push changes', 'push'],
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
  assert.match(workflow, /- name: Notify Telegram sync result/);
  assert.match(workflow, /if: success\(\) && github\.event_name == 'repository_dispatch'/);
  assert.match(workflow, /node tools\/telegram-sync-notify\.mjs/);
  assert.match(workflow, /node tools\/telegram-action-monitor\.mjs/);
  assert.match(workflow, /STEP_INSTALL_OUTCOME: \$\{\{ steps\.install\.outcome \}\}/);
  assert.match(workflow, /- name: Trigger async site deploy/);
  assert.match(workflow, /continue-on-error: true/);
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
