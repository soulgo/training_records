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

test('telegram-sync workflow validates changes and deploys Pages after sync commits', async () => {
  const workflow = await readWorkflow('.github/workflows/telegram-sync.yml');

  assert.match(workflow, /- name: Run tests/);
  assert.match(workflow, /pages:\s*write/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /repo_changed:\s*\$\{\{\s*steps\.changes\.outputs\.repo_changed\s*\}\}/);
  assert.match(workflow, /needs:\s*sync/);
  assert.match(workflow, /- name: Build site data and static files/);
  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
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

async function readWorkflow(relativePath) {
  return readFile(new URL(relativePath, rootDir), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
