import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildParameterHealthSummary,
  runParameterHealthAudit,
  validateParameterHealthRegistry,
} from '../src/app/use-cases/parameter-health-monitor.use-case.mjs';

function buildRegistry() {
  return {
    environment: 'dev',
    probes: [
      { key: 'ai_primary', type: 'openai_models', env: { token: 'HEALTH_AI_KEY', baseUrl: 'HEALTH_AI_BASE_URL' } },
      { key: 'webhook_secret', type: 'presence', env: { value: 'HEALTH_WEBHOOK_SECRET' } },
      { key: 'worker_token', type: 'unsupported' },
      { key: 'optional_database', type: 'postgres_connect', env: { url: 'HEALTH_OPTIONAL_DB_URL' } },
    ],
    parameters: [
      {
        key: 'dev.github.secret.AI_API_KEY', name: 'AI_API_KEY', scope: 'github_actions_secret', category: 'ai',
        required: true, sensitive: true, healthProbeKey: 'ai_primary', validityMode: 'provider_metadata',
        warningDays: 30, criticalDays: 7, sourceDoc: 'docs/01_系统配置/dev.md',
      },
      {
        key: 'dev.github.secret.WEBHOOK_SECRET', name: 'WEBHOOK_SECRET', scope: 'github_actions_secret', category: 'telegram',
        required: true, sensitive: true, healthProbeKey: 'webhook_secret', validityMode: 'provider_metadata',
        warningDays: 30, criticalDays: 7, sourceDoc: 'docs/01_系统配置/dev.md',
      },
      {
        key: 'dev.cloudflare.secret.GITHUB_TOKEN', name: 'GITHUB_TOKEN', scope: 'cloudflare_worker_secret', category: 'github',
        required: true, sensitive: true, healthProbeKey: 'worker_token', validityMode: 'provider_metadata',
        warningDays: 30, criticalDays: 7, sourceDoc: 'docs/01_系统配置/dev.md',
      },
      {
        key: 'dev.github.secret.OPTIONAL_DB_URL', name: 'OPTIONAL_DB_URL', scope: 'github_actions_secret', category: 'database',
        required: false, sensitive: true, healthProbeKey: 'optional_database', validityMode: 'provider_metadata',
        warningDays: 30, criticalDays: 7, sourceDoc: 'docs/01_系统配置/dev.md',
      },
    ],
  };
}

test('health registry validates probe references and rejects unknown probes', () => {
  const registry = buildRegistry();
  assert.equal(validateParameterHealthRegistry(registry), registry);

  const invalid = structuredClone(registry);
  invalid.parameters[0].healthProbeKey = 'missing_probe';
  assert.throws(() => validateParameterHealthRegistry(invalid), /unknown health probe/u);
});

test('health audit separates runtime health from optional expiry evidence', () => {
  const registry = buildRegistry();
  const audit = runParameterHealthAudit({
    registry,
    now: new Date('2026-07-10T00:00:00.000Z'),
    runId: 123,
    probeResultsByKey: new Map([
      ['ai_primary', {
        probeKey: 'ai_primary', checkType: 'openai_models', status: 'healthy', latencyMs: 42,
        failureKind: null, evidenceSource: 'active_probe:openai_models', message: 'AI Provider 鉴权成功',
        observedExpiresAt: '2026-08-01T00:00:00.000Z', details: { httpStatus: 200 },
      }],
      ['webhook_secret', {
        probeKey: 'webhook_secret', checkType: 'presence', status: 'present', latencyMs: 0,
        failureKind: null, evidenceSource: 'runtime_env_presence', message: '参数已注入；未执行外部鉴权', details: {},
      }],
      ['worker_token', {
        probeKey: 'worker_token', checkType: 'unsupported', status: 'unsupported', latencyMs: 0,
        failureKind: 'no_safe_probe', evidenceSource: 'registry', message: '当前没有安全且可靠的自动探测方式', details: {},
      }],
      ['optional_database', {
        probeKey: 'optional_database', checkType: 'postgres_connect', status: 'missing', latencyMs: 0,
        failureKind: 'credential_missing', evidenceSource: 'runtime_env_presence', message: '探测所需凭证未注入', details: {},
      }],
    ]),
  });

  assert.deepEqual(audit.summary.counts, {
    total: 4,
    healthy: 1,
    present: 1,
    invalid: 0,
    missing: 0,
    notConfigured: 1,
    unreachable: 0,
    unsupported: 1,
    unknown: 0,
  });
  assert.deepEqual(audit.summary.expiryCounts, { known: 1, warning: 1, expired: 0, unknown: 3 });

  const aiCheck = audit.checks.find((check) => check.parameterKey.endsWith('AI_API_KEY'));
  assert.equal(aiCheck.status, 'healthy');
  assert.equal(aiCheck.checkType, 'openai_models');
  assert.equal(aiCheck.latencyMs, 42);
  assert.equal(aiCheck.observedExpiresAt, '2026-08-01T00:00:00.000Z');
  assert.equal(aiCheck.details.expiryStatus, 'warning');

  const optionalCheck = audit.checks.find((check) => check.parameterKey.endsWith('OPTIONAL_DB_URL'));
  assert.equal(optionalCheck.status, 'not_configured');
  assert.equal(optionalCheck.failureKind, 'credential_missing');
  assert.doesNotMatch(JSON.stringify(audit), /super-secret|tenant_access_token|postgres:\/\//u);
});

test('health summary keeps every operational state explicit', () => {
  const summary = buildParameterHealthSummary([
    { status: 'healthy' }, { status: 'present' }, { status: 'invalid' }, { status: 'missing' },
    { status: 'not_configured' }, { status: 'unreachable' }, { status: 'unsupported' }, { status: 'unknown' },
  ]);
  assert.deepEqual(summary.counts, {
    total: 8, healthy: 1, present: 1, invalid: 1, missing: 1,
    notConfigured: 1, unreachable: 1, unsupported: 1, unknown: 1,
  });
});


test('dev and main registries map every parameter to an explicit health probe', async () => {
  const expectedProbeTypes = new Set([
    'postgres_connect', 'openai_models', 'telegram_get_me', 'feishu_tenant_token',
    'cos_head_bucket', 'cloudflare_token_verify', 'presence', 'unsupported',
  ]);

  for (const environment of ['dev', 'main']) {
    const registry = JSON.parse(await readFile(
      new URL(`../config/parameter-health/${environment}.json`, import.meta.url),
      'utf8',
    ));
    validateParameterHealthRegistry(registry);
    assert.equal(registry.parameters.length, 18);
    assert.ok(registry.parameters.every((parameter) => parameter.healthProbeKey));
    assert.ok(registry.parameters.every((parameter) => !Object.hasOwn(parameter, 'value')));
    assert.deepEqual(new Set(registry.probes.map((probe) => probe.type)), expectedProbeTypes);
  }
});
