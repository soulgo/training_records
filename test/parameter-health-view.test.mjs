import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildActionMonitorViewModel } from '../src/site/action-monitor-view.mjs';
import { loadActionMonitorViewFromPostgres } from '../src/app/use-cases/generate-training-data.impl.mjs';

test('action monitor presents system parameter health instead of inferred validity', () => {
  const rows = [
    {
      parameterKey: 'dev.github.secret.AI_API_KEY', parameterName: 'AI_API_KEY', monitorEnvironment: 'dev',
      scope: 'github_actions_secret', category: 'ai', status: 'healthy', checkType: 'openai_models',
      latencyMs: 42, evidenceSource: 'active_probe:openai_models', checkedAt: '2026-07-10T00:00:00.000Z',
      lastHealthyAt: '2026-07-10T00:00:00.000Z', observedExpiresAt: '2026-08-01T00:00:00.000Z',
      daysUntilDue: 22, details: { expiryStatus: 'warning', dueKind: 'provider_expiry', dueAt: '2026-08-01T00:00:00.000Z' },
      message: 'AI Provider 鉴权成功',
    },
    {
      parameterKey: 'dev.github.secret.BAD_TOKEN', parameterName: 'BAD_TOKEN', monitorEnvironment: 'dev',
      scope: 'github_actions_secret', category: 'cloudflare', status: 'invalid', checkType: 'cloudflare_token_verify',
      latencyMs: 30, failureKind: 'authentication', evidenceSource: 'active_probe:cloudflare_token_verify',
      checkedAt: '2026-07-10T00:00:00.000Z', message: 'Provider 拒绝凭证', details: { expiryStatus: 'unknown' },
    },
    {
      parameterKey: 'dev.cloudflare.secret.WEBHOOK', parameterName: 'WEBHOOK', monitorEnvironment: 'dev',
      scope: 'cloudflare_worker_secret', category: 'telegram', status: 'present', checkType: 'presence',
      latencyMs: 0, evidenceSource: 'runtime_env_presence', checkedAt: '2026-07-10T00:00:00.000Z',
      message: '参数已注入；未执行外部鉴权', details: { expiryStatus: 'unknown' },
    },
  ];

  const view = buildActionMonitorViewModel([], {
    environment: 'dev',
    now: new Date('2026-07-10T01:00:00.000Z'),
    parameterHealthRows: rows,
  });

  assert.equal(view.parameterHealth.title, '系统参数健康');
  assert.equal(view.parameterValidity, undefined);
  assert.deepEqual(view.parameterHealth.items.map((item) => item.name), ['BAD_TOKEN', 'WEBHOOK', 'AI_API_KEY']);
  assert.equal(view.parameterHealth.items[0].statusLabel, '凭证无效');
  assert.equal(view.parameterHealth.items[0].tone, 'failure');
  assert.equal(view.parameterHealth.items[1].statusLabel, '仅确认已配置');
  assert.equal(view.parameterHealth.items[1].evidenceLabel, '仅运行时存在性');
  assert.equal(view.parameterHealth.items[2].statusLabel, '健康');
  assert.equal(view.parameterHealth.items[2].evidenceLabel, '真实 API 探测');
  assert.equal(view.parameterHealth.items[2].latencyLabel, '42 ms');
  assert.equal(view.parameterHealth.items[2].expiryLabel, '真实到期 2026-08-01 · 22 天');
  assert.ok(view.parameterHealth.summaryCards.some((card) => card.label === '健康' && card.value === '1 个'));
  assert.ok(view.parameterHealth.summaryCards.some((card) => card.label === '凭证无效' && card.value === '1 个'));
  assert.ok(view.parameterHealth.summaryCards.some((card) => card.label === '仅存在性' && card.value === '1 个'));
});


test('action monitor build falls back to current health registry without inventing probe success', async () => {
  const view = await loadActionMonitorViewFromPostgres({
    rootDir: new URL('..', import.meta.url),
    env: { GITHUB_REF_NAME: 'dev' },
    now: new Date('2026-07-10T00:00:00.000Z'),
    stderr: { write() {} },
  });

  assert.equal(view.parameterHealth.total, 18);
  assert.ok(view.parameterHealth.items.every((item) => ['unknown', 'unsupported'].includes(item.status)));
  assert.ok(view.parameterHealth.items.every((item) => item.status !== 'healthy'));
});


test('action monitor template and client expose parameter health evidence', async () => {
  const template = await readFile(new URL('../themes/cactus/layout/action-monitor.ejs', import.meta.url), 'utf8');
  const client = await readFile(new URL('../themes/cactus/source/js/action-monitor.js', import.meta.url), 'utf8');

  assert.match(template, /actionMonitorView\.parameterHealth/u);
  assert.match(template, /系统参数健康/u);
  assert.match(template, /data-parameter-health-open/u);
  assert.match(template, /探测方式/u);
  assert.match(template, /最近健康/u);
  assert.match(template, /真实到期信息/u);
  assert.match(client, /data-parameter-health-open/u);
  assert.doesNotMatch(template, /系统参数有效期/u);
});
