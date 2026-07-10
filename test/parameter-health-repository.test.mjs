import test from 'node:test';
import assert from 'node:assert/strict';

import { PostgresParameterHealthMonitorRepository } from '../src/adapters/postgres/parameter-health-monitor-repository.pg.mjs';

test('postgres health repository persists probe and health evidence columns', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  const repository = new PostgresParameterHealthMonitorRepository(client);
  await repository.writeParameterAudit({
    parameters: [{
      key: 'dev.github.secret.AI_API_KEY', environment: 'dev', name: 'AI_API_KEY',
      scope: 'github_actions_secret', category: 'ai', required: true, sensitive: true,
      healthProbeKey: 'ai_primary', healthCheckType: 'openai_models', validityMode: 'provider_metadata',
      warningDays: 30, criticalDays: 7, sourceDoc: 'docs/01_系统配置/dev.md', sourceCode: [], metadata: {},
    }],
    checks: [{
      parameterKey: 'dev.github.secret.AI_API_KEY', environment: 'dev', runId: 123,
      checkedAt: '2026-07-10T00:00:00.000Z', status: 'healthy', checkType: 'openai_models',
      latencyMs: 42, failureKind: null, observedExpiresAt: '2026-08-01T00:00:00.000Z',
      daysUntilDue: 22, evidenceSource: 'active_probe:openai_models', message: 'AI Provider 鉴权成功',
      details: { expiryStatus: 'warning' },
    }],
  });

  const upsert = queries.find((entry) => /insert into monitor\.system_config_parameters/iu.test(entry.sql));
  assert.match(upsert.sql, /health_probe_key/iu);
  assert.match(upsert.sql, /health_check_type/iu);
  assert.ok(upsert.params.includes('ai_primary'));
  assert.ok(upsert.params.includes('openai_models'));

  const insert = queries.find((entry) => /insert into monitor\.system_config_parameter_checks/iu.test(entry.sql));
  assert.match(insert.sql, /check_type/iu);
  assert.match(insert.sql, /latency_ms/iu);
  assert.match(insert.sql, /failure_kind/iu);
  assert.match(insert.sql, /observed_expires_at/iu);
  assert.ok(insert.params.includes(42));
  assert.doesNotMatch(JSON.stringify(queries), /super-secret/u);
});

test('postgres health repository maps latest health check with last healthy time', async () => {
  const client = {
    async query(sql) {
      assert.match(sql, /last_healthy_at/iu);
      return { rows: [{
        parameter_key: 'dev.github.secret.AI_API_KEY', monitor_environment: 'dev', parameter_name: 'AI_API_KEY',
        scope: 'github_actions_secret', category: 'ai', required: true, sensitive: true,
        health_probe_key: 'ai_primary', health_check_type: 'openai_models', validity_mode: 'provider_metadata',
        warning_days: 30, critical_days: 7, source_code_json: [], metadata_json: {},
        check_id: 7, checked_at: '2026-07-10T00:00:00.000Z', status: 'healthy',
        check_type: 'openai_models', latency_ms: 42, failure_kind: null,
        observed_expires_at: '2026-08-01T00:00:00.000Z', days_until_due: 22,
        evidence_source: 'active_probe:openai_models', message: 'ok', details_json: { expiryStatus: 'warning' },
        last_healthy_at: '2026-07-10T00:00:00.000Z',
      }] };
    },
  };
  const repository = new PostgresParameterHealthMonitorRepository(client);
  const [row] = await repository.listLatestParameterChecks({ monitorEnvironment: 'dev' });

  assert.equal(row.healthProbeKey, 'ai_primary');
  assert.equal(row.healthCheckType, 'openai_models');
  assert.equal(row.status, 'healthy');
  assert.equal(row.latencyMs, 42);
  assert.equal(row.failureKind, null);
  assert.equal(row.observedExpiresAt, '2026-08-01T00:00:00.000Z');
  assert.equal(row.lastHealthyAt, '2026-07-10T00:00:00.000Z');
});
