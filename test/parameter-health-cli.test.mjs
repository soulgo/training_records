import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { checkParameterHealth } from '../tools/check-parameter-health.mjs';

test('parameter health CLI runs probes, writes monitor rows, and emits a secret-safe summary', async () => {
  const secret = 'cli-super-secret';
  const output = [];
  const written = [];
  const registry = {
    environment: 'dev',
    probes: [{ key: 'token', type: 'presence', env: { value: 'HEALTH_TOKEN' } }],
    parameters: [{
      key: 'dev.github.secret.TOKEN', name: 'TOKEN', scope: 'github_actions_secret', category: 'github',
      required: true, sensitive: true, healthProbeKey: 'token', validityMode: 'provider_metadata',
      warningDays: 30, criticalDays: 7, sourceDoc: 'docs/01_系统配置/dev.md',
    }],
  };
  const client = { async connect() {}, async end() {} };

  const audit = await checkParameterHealth({
    registry,
    argv: ['--environment', 'dev', '--write-monitor', '--run-id', '123'],
    env: { HEALTH_TOKEN: secret, PARAMETER_HEALTH_MONITOR_DB_URL: 'postgres://monitor' },
    now: new Date('2026-07-10T00:00:00.000Z'),
    stdout: { write(value) { output.push(value); } },
    stderr: { write() {} },
    async runProbes() {
      return new Map([['token', {
        probeKey: 'token', checkType: 'presence', status: 'present', latencyMs: 0,
        evidenceSource: 'runtime_env_presence', failureKind: null,
        message: '参数已注入；未执行外部鉴权', details: {},
      }]]);
    },
    createClient() { return client; },
    createRepository(receivedClient) {
      assert.equal(receivedClient, client);
      return { async writeParameterAudit(value) { written.push(value); } };
    },
  });

  assert.equal(audit.checks[0].status, 'present');
  assert.equal(written.length, 1);
  assert.equal(written[0].parameters[0].healthCheckType, 'presence');
  assert.match(output.join(''), /\[parameter-health\].*present=1/u);
  assert.doesNotMatch(output.join(''), new RegExp(secret, 'u'));
});

test('parameter health CLI defaults registry to config/parameter-health for the selected environment', async () => {
  const output = [];
  let receivedRegistry = null;

  const audit = await checkParameterHealth({
    argv: ['--environment', 'dev'],
    env: {},
    now: new Date('2026-07-10T00:00:00.000Z'),
    stdout: { write(value) { output.push(value); } },
    stderr: { write() {} },
    async runProbes(registry) {
      receivedRegistry = registry;
      return new Map();
    },
  });

  assert.equal(receivedRegistry?.environment, 'dev');
  assert.ok(receivedRegistry?.parameters.length > 0);
  assert.equal(audit.environment, 'dev');
  assert.equal(audit.summary.counts.total, receivedRegistry.parameters.length);
  assert.match(output.join(''), /\[parameter-health\].*environment=dev/u);
});

test('parameter health workflow injects probe inputs without printing secret values', async () => {
  const workflow = await readFile(new URL('../.github/workflows/parameter-health-audit.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name:\s*Parameter Health Audit/u);
  assert.match(workflow, /node tools\/check-parameter-health\.mjs/u);
  assert.match(workflow, /PARAMETER_HEALTH_DB_PRIMARY_URL:/u);
  assert.match(workflow, /secrets\.DEV_TRAINING_DB_URL/u);
  assert.match(workflow, /secrets\.TRAINING_DB_URL/u);
  assert.match(workflow, /PARAMETER_HEALTH_TELEGRAM_BOT_TOKEN:/u);
  assert.match(workflow, /PARAMETER_HEALTH_FEISHU_APP_SECRET:/u);
  assert.match(workflow, /PARAMETER_HEALTH_COS_SECRET_KEY:/u);
  assert.match(workflow, /PARAMETER_HEALTH_CLOUDFLARE_API_TOKEN:/u);
  assert.match(workflow, /--write-monitor/u);
  assert.doesNotMatch(workflow, /echo\s+"?\$\{?PARAMETER_HEALTH_/u);
});
