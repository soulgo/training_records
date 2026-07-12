import test from 'node:test';
import assert from 'node:assert/strict';

import { runParameterHealthProbe, runParameterHealthProbes } from '../src/app/use-cases/parameter-health-probes.mjs';

const SECRET = 'super-secret-token-value';

function assertSecretSafe(value) {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(SECRET, 'u'));
}

test('telegram health probe reports healthy without exposing the bot token', async () => {
  const result = await runParameterHealthProbe({
    key: 'telegram_bot',
    type: 'telegram_get_me',
    env: { token: 'HEALTH_TELEGRAM_TOKEN' },
  }, {
    env: { HEALTH_TELEGRAM_TOKEN: SECRET },
    now: new Date('2026-07-10T00:00:00.000Z'),
    fetchImpl: async (url) => {
      assert.match(String(url), /getMe$/u);
      return new Response(JSON.stringify({ ok: true, result: { id: 123 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(result.status, 'healthy');
  assert.equal(result.checkType, 'telegram_get_me');
  assert.equal(result.failureKind, null);
  assert.equal(result.evidenceSource, 'active_probe:telegram_get_me');
  assertSecretSafe(result);
});

test('active HTTP probe distinguishes invalid credentials from provider outages', async () => {
  const invalid = await runParameterHealthProbe({
    key: 'cloudflare_token',
    type: 'cloudflare_token_verify',
    env: { token: 'HEALTH_CLOUDFLARE_TOKEN' },
  }, {
    env: { HEALTH_CLOUDFLARE_TOKEN: SECRET },
    fetchImpl: async () => new Response(JSON.stringify({ success: false }), { status: 403 }),
  });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.failureKind, 'authentication');

  const unreachable = await runParameterHealthProbe({
    key: 'cloudflare_token',
    type: 'cloudflare_token_verify',
    env: { token: 'HEALTH_CLOUDFLARE_TOKEN' },
  }, {
    env: { HEALTH_CLOUDFLARE_TOKEN: SECRET },
    fetchImpl: async () => {
      throw new TypeError('network failed while using ' + SECRET);
    },
  });
  assert.equal(unreachable.status, 'unreachable');
  assert.equal(unreachable.failureKind, 'network');
  assertSecretSafe(unreachable);
});

test('presence and unsupported probes stay honest about their evidence strength', async () => {
  const present = await runParameterHealthProbe({
    key: 'webhook_secret',
    type: 'presence',
    env: { value: 'HEALTH_WEBHOOK_SECRET' },
  }, { env: { HEALTH_WEBHOOK_SECRET: SECRET } });
  assert.equal(present.status, 'present');
  assert.equal(present.evidenceSource, 'runtime_env_presence');
  assertSecretSafe(present);

  const unsupported = await runParameterHealthProbe({
    key: 'worker_github_token',
    type: 'unsupported',
  });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.failureKind, 'no_safe_probe');
});


test('postgres health probe runs a read-only query and closes its client', async () => {
  const calls = [];
  const result = await runParameterHealthProbe({
    key: 'database_primary',
    type: 'postgres_connect',
    env: { url: 'HEALTH_DATABASE_URL' },
  }, {
    env: { HEALTH_DATABASE_URL: 'postgres://sensitive-connection-string' },
    createPgClient(config) {
      assert.equal(config.connectionString, 'postgres://sensitive-connection-string');
      return {
        async connect() { calls.push('connect'); },
        async query(sql) { calls.push(sql); return { rows: [{ ok: 1 }] }; },
        async end() { calls.push('end'); },
      };
    },
  });

  assert.equal(result.status, 'healthy');
  assert.equal(result.checkType, 'postgres_connect');
  assert.deepEqual(calls, ['connect', 'select 1 as ok', 'end']);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-connection-string/u);
});

test('AI and Feishu probes authenticate through their non-destructive endpoints', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method });
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, tenant_access_token: 'do-not-store-me' }), { status: 200 });
  };

  const ai = await runParameterHealthProbe({
    key: 'ai_primary',
    type: 'openai_models',
    env: { token: 'HEALTH_AI_KEY', baseUrl: 'HEALTH_AI_BASE_URL' },
  }, {
    env: { HEALTH_AI_KEY: SECRET, HEALTH_AI_BASE_URL: 'https://provider.example/v1' },
    fetchImpl,
  });
  assert.equal(ai.status, 'healthy');
  assertSecretSafe(ai);

  const feishu = await runParameterHealthProbe({
    key: 'feishu_credentials',
    type: 'feishu_tenant_token',
    env: { appId: 'HEALTH_FEISHU_APP_ID', appSecret: 'HEALTH_FEISHU_APP_SECRET' },
  }, {
    env: { HEALTH_FEISHU_APP_ID: 'cli_test', HEALTH_FEISHU_APP_SECRET: SECRET },
    fetchImpl,
  });
  assert.equal(feishu.status, 'healthy');
  assertSecretSafe(feishu);
  assert.deepEqual(requests.map((entry) => entry.method), ['GET', 'POST']);
});

test('COS probe checks bucket access with paired credentials', async () => {
  const result = await runParameterHealthProbe({
    key: 'cos_credentials',
    type: 'cos_head_bucket',
    env: {
      secretId: 'HEALTH_COS_SECRET_ID',
      secretKey: 'HEALTH_COS_SECRET_KEY',
      bucket: 'HEALTH_COS_BUCKET',
      region: 'HEALTH_COS_REGION',
    },
  }, {
    env: {
      HEALTH_COS_SECRET_ID: 'secret-id',
      HEALTH_COS_SECRET_KEY: SECRET,
      HEALTH_COS_BUCKET: 'bucket-123',
      HEALTH_COS_REGION: 'ap-test',
    },
    createCosClient(config) {
      assert.equal(config.SecretKey, SECRET);
      return {
        headBucket(params, callback) {
          assert.deepEqual(params, { Bucket: 'bucket-123', Region: 'ap-test' });
          callback(null, { statusCode: 200 });
        },
      };
    },
  });

  assert.equal(result.status, 'healthy');
  assert.equal(result.checkType, 'cos_head_bucket');
  assertSecretSafe(result);
});


test('registry probe runner executes each probe once and returns a keyed result map', async () => {
  const calls = [];
  const results = await runParameterHealthProbes({
    probes: [
      { key: 'one', type: 'presence', env: { value: 'ONE' } },
      { key: 'two', type: 'unsupported' },
    ],
  }, {
    async runProbe(probe) {
      calls.push(probe.key);
      return { probeKey: probe.key, status: probe.type === 'unsupported' ? 'unsupported' : 'present' };
    },
  });

  assert.deepEqual(calls.sort(), ['one', 'two']);
  assert.equal(results.get('one').status, 'present');
  assert.equal(results.get('two').status, 'unsupported');
});
