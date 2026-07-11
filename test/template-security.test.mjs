import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const templatePaths = [
  'themes/cactus/layout/dashboard.ejs',
  'themes/cactus/layout/monitor.ejs',
  'themes/cactus/layout/action-monitor.ejs',
];

test('JSON script templates escape HTML-significant code points before raw EJS output', async () => {
  for (const path of templatePaths) {
    const template = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(template, /\\u003c/);
    assert.match(template, /\\u003e/);
    assert.match(template, /\\u0026/);
    assert.doesNotMatch(
      template,
      /type="application\/json"><%-\s*JSON\.stringify\([^)]*\)\s*%>/,
      `${path} must not embed raw JSON.stringify output`,
    );
  }
});

test('dev workflow does not fall back to production AI, chat, or Feishu secrets', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-dev.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /DEV_(?:TELEGRAM_ALLOWED_CHAT_IDS|FEISHU_APP_ID|FEISHU_APP_SECRET|FEISHU_ALLOWED_CHAT_IDS)\s*\|\|/);
  assert.match(workflow, /AI_API_KEY:\s*\$\{\{ secrets\.DEV_AI_API_KEY \}\}/);
  assert.doesNotMatch(workflow, /AI_API_KEY:\s*\$\{\{ secrets\.AI_API_KEY \}\}/);
});
