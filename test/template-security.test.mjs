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

test('dev workflow shares the repository AI configuration with main', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-dev.yml', import.meta.url), 'utf8');

  for (const mapping of [
    'AI_API_KEY: ${{ secrets.AI_API_KEY }}',
    "AI_PROVIDER: ${{ vars.AI_PROVIDER || 'openai-compatible' }}",
    'AI_BASE_URL: ${{ secrets.AI_BASE_URL }}',
    'AI_MODEL: ${{ vars.AI_MODEL }}',
    'AI_TIMEOUT_MS: ${{ vars.AI_TIMEOUT_MS }}',
    'AI_CONCURRENCY: ${{ vars.AI_CONCURRENCY }}',
    'AI_OCR_ENABLED: ${{ vars.AI_OCR_ENABLED }}',
    'AI_OCR_FAILURE_MODE: ${{ vars.AI_OCR_FAILURE_MODE }}',
    'TELEGRAM_RECOGNITION_MODEL: ${{ vars.TELEGRAM_RECOGNITION_MODEL }}',
    'TELEGRAM_RECOGNITION_FALLBACK_API_KEY: ${{ secrets.TELEGRAM_RECOGNITION_FALLBACK_API_KEY }}',
    'TELEGRAM_RECOGNITION_FALLBACK_BASE_URL: ${{ secrets.TELEGRAM_RECOGNITION_FALLBACK_BASE_URL }}',
    'TELEGRAM_RECOGNITION_FALLBACK_MODEL: ${{ vars.TELEGRAM_RECOGNITION_FALLBACK_MODEL }}',
    'TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS: ${{ vars.TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS }}',
    'TELEGRAM_RECOGNITION_CACHE_ENABLED: ${{ vars.TELEGRAM_RECOGNITION_CACHE_ENABLED }}',
    'TRAINING_ANALYSIS_GOAL: ${{ vars.TRAINING_ANALYSIS_GOAL }}',
  ]) {
    assert.match(workflow, new RegExp(mapping.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(
    workflow,
    /(?:secrets|vars)\.DEV_(?:AI_|TELEGRAM_RECOGNITION_|TRAINING_ANALYSIS_GOAL)/,
  );
});

test('dev workflow keeps chat and Feishu credentials isolated from main', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sync-dev.yml', import.meta.url), 'utf8');

  assert.match(workflow, /TELEGRAM_ALLOWED_CHAT_IDS:\s*\$\{\{ vars\.DEV_TELEGRAM_ALLOWED_CHAT_IDS \}\}/);
  assert.match(workflow, /FEISHU_APP_ID:\s*\$\{\{ secrets\.DEV_FEISHU_APP_ID \}\}/);
  assert.match(workflow, /FEISHU_APP_SECRET:\s*\$\{\{ secrets\.DEV_FEISHU_APP_SECRET \}\}/);
  assert.match(workflow, /FEISHU_ALLOWED_CHAT_IDS:\s*\$\{\{ secrets\.DEV_FEISHU_ALLOWED_CHAT_IDS \}\}/);
  assert.doesNotMatch(
    workflow,
    /DEV_(?:TELEGRAM_ALLOWED_CHAT_IDS|FEISHU_APP_ID|FEISHU_APP_SECRET|FEISHU_ALLOWED_CHAT_IDS)\s*\|\|/,
  );
});
