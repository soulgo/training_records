import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildParameterValiditySummary,
  evaluateParameterValidity,
  runParameterValidityAudit,
  validateParameterRegistry,
} from '../src/app/use-cases/parameter-validity-monitor.use-case.mjs';
import { PostgresParameterValidityMonitorRepository } from '../src/adapters/postgres/parameter-validity-monitor-repository.pg.mjs';
import { buildActionMonitorViewModel } from '../src/site/action-monitor-view.mjs';

test('parameter validity evaluator classifies ok warning expired missing and unknown without secret values', () => {
  const now = new Date('2026-07-07T00:00:00.000Z');
  const baseParameter = {
    key: 'dev.github.secret.AI_API_KEY',
    name: 'AI_API_KEY',
    scope: 'github_actions_secret',
    category: 'ai',
    required: true,
    sensitive: true,
    validityMode: 'fixed_expires_at',
    warningDays: 30,
    criticalDays: 7,
    sourceDoc: 'docs/01_系统配置/dev.md',
  };

  assert.equal(evaluateParameterValidity({
    ...baseParameter,
    expiresAt: '2026-09-01',
  }, { now, presence: true }).status, 'ok');

  const warning = evaluateParameterValidity({
    ...baseParameter,
    expiresAt: '2026-07-20',
  }, { now, presence: true });
  assert.equal(warning.status, 'warning');
  assert.equal(warning.daysUntilDue, 13);
  assert.equal(warning.message, '距离到期或复核日期 13 天');
  assert.equal(warning.details.value, undefined);

  const expired = evaluateParameterValidity({
    ...baseParameter,
    expiresAt: '2026-07-01',
  }, { now, presence: true });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.daysUntilDue, -6);

  const missing = evaluateParameterValidity({
    ...baseParameter,
    expiresAt: '2026-09-01',
  }, { now, presence: false, evidenceSource: 'runtime_env' });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.daysUntilDue, 56);
  assert.equal(missing.evidenceSource, 'runtime_env');

  const unknown = evaluateParameterValidity({
    ...baseParameter,
    validityMode: 'review_after',
    expiresAt: undefined,
  }, { now, presence: true });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.daysUntilDue, null);
  assert.equal(unknown.message, '缺少有效期或复核时间元数据');
});

test('parameter validity audit validates registry and builds safe check rows', () => {
  const registry = {
    environment: 'dev',
    parameters: [
      {
        key: 'dev.github.secret.DEV_TRAINING_DB_URL',
        name: 'DEV_TRAINING_DB_URL',
        scope: 'github_actions_secret',
        category: 'database',
        required: true,
        sensitive: true,
        validityMode: 'fixed_expires_at',
        expiresAt: '2026-07-01',
        warningDays: 30,
        criticalDays: 7,
        sourceDoc: 'docs/01_系统配置/dev.md',
        sourceCode: ['.github/workflows/sync-dev.yml'],
      },
      {
        key: 'dev.github.secret.AI_API_KEY',
        name: 'AI_API_KEY',
        scope: 'github_actions_secret',
        category: 'ai',
        required: true,
        sensitive: true,
        validityMode: 'review_after',
        warningDays: 30,
        criticalDays: 7,
        sourceDoc: 'docs/01_系统配置/dev.md',
      },
    ],
  };

  assert.deepEqual(validateParameterRegistry(registry), registry);

  const audit = runParameterValidityAudit({
    registry,
    environment: 'dev',
    now: new Date('2026-07-07T00:00:00.000Z'),
    presenceByKey: new Map([
      ['dev.github.secret.DEV_TRAINING_DB_URL', true],
      ['dev.github.secret.AI_API_KEY', true],
    ]),
  });

  assert.deepEqual(audit.summary.counts, {
    total: 2,
    ok: 0,
    warning: 0,
    expired: 1,
    missing: 0,
    unknown: 1,
  });
  assert.equal(audit.checks[0].parameterKey, 'dev.github.secret.DEV_TRAINING_DB_URL');
  assert.equal(audit.checks[0].status, 'expired');
  assert.equal(audit.checks[0].details.value, undefined);
  assert.equal(audit.parameters[0].metadata.value, undefined);
});

test('postgres parameter validity repository writes audit rows and lists latest checks', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/from monitor\.system_config_parameters/i.test(sql)) {
        return {
          rows: [{
            parameter_key: 'dev.github.secret.AI_API_KEY',
            monitor_environment: 'dev',
            parameter_name: 'AI_API_KEY',
            scope: 'github_actions_secret',
            category: 'ai',
            required: true,
            sensitive: true,
            validity_mode: 'review_after',
            review_after_at: '2026-07-20T00:00:00.000Z',
            warning_days: 30,
            critical_days: 7,
            owner: 'ops',
            source_doc: 'docs/01_系统配置/dev.md',
            source_code_json: ['src/adapters/ai/openai-compatible.adapter.mjs'],
            metadata_json: { metadataReadStatus: 'unavailable' },
            check_id: '9',
            checked_at: '2026-07-07T00:00:00.000Z',
            status: 'warning',
            days_until_due: '13',
            evidence_source: 'registry',
            message: '距离到期或复核日期 13 天',
            details_json: { dueField: 'reviewAfterAt' },
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const repository = new PostgresParameterValidityMonitorRepository(client);

  await repository.writeParameterAudit({
    parameters: [{
      key: 'dev.github.secret.AI_API_KEY',
      environment: 'dev',
      name: 'AI_API_KEY',
      scope: 'github_actions_secret',
      category: 'ai',
      required: true,
      sensitive: true,
      validityMode: 'review_after',
      reviewAfterAt: '2026-07-20',
      warningDays: 30,
      criticalDays: 7,
      sourceDoc: 'docs/01_系统配置/dev.md',
      sourceCode: ['src/adapters/ai/openai-compatible.adapter.mjs'],
      metadata: { metadataReadStatus: 'unavailable' },
    }],
    checks: [{
      parameterKey: 'dev.github.secret.AI_API_KEY',
      environment: 'dev',
      runId: 123456789,
      checkedAt: '2026-07-07T00:00:00.000Z',
      status: 'warning',
      daysUntilDue: 13,
      evidenceSource: 'registry',
      message: '距离到期或复核日期 13 天',
      details: { dueField: 'reviewAfterAt' },
    }],
  });

  const rows = await repository.listLatestParameterChecks({ monitorEnvironment: 'dev', limit: 10 });

  assert.equal(queries[0].sql, 'begin');
  assert.ok(queries.some((query) => /insert into monitor\.system_config_parameters/i.test(query.sql)));
  assert.ok(queries.some((query) => /insert into monitor\.system_config_parameter_checks/i.test(query.sql)));
  assert.ok(queries.some((query) => query.sql === 'commit'));
  assert.match(queries.at(-1).sql, /distinct on \(parameter_key\)/i);
  assert.deepEqual(queries.at(-1).params, ['dev', 10]);
  assert.equal(rows[0].parameterKey, 'dev.github.secret.AI_API_KEY');
  assert.equal(rows[0].status, 'warning');
  assert.equal(rows[0].daysUntilDue, 13);
  assert.equal(rows[0].metadata.value, undefined);
});

test('action monitor view model includes sorted parameter validity summary', () => {
  const parameterRows = [
    {
      parameterKey: 'dev.github.secret.OK',
      parameterName: 'OK',
      scope: 'github_actions_secret',
      category: 'ai',
      status: 'ok',
      daysUntilDue: 80,
      checkedAt: '2026-07-07T00:00:00.000Z',
    },
    {
      parameterKey: 'dev.github.secret.EXPIRED',
      parameterName: 'EXPIRED',
      scope: 'github_actions_secret',
      category: 'database',
      status: 'expired',
      daysUntilDue: -1,
      checkedAt: '2026-07-07T00:00:00.000Z',
    },
    {
      parameterKey: 'dev.github.secret.UNKNOWN',
      parameterName: 'UNKNOWN',
      scope: 'cloudflare_worker_secret',
      category: 'github',
      status: 'unknown',
      daysUntilDue: null,
      checkedAt: '2026-07-07T00:00:00.000Z',
    },
    {
      parameterKey: 'dev.github.secret.WARNING',
      parameterName: 'WARNING',
      scope: 'github_actions_secret',
      category: 'telegram',
      status: 'warning',
      daysUntilDue: 5,
      checkedAt: '2026-07-07T00:00:00.000Z',
    },
  ];

  const view = buildActionMonitorViewModel([], {
    environment: 'dev',
    now: new Date('2026-07-07T00:00:00.000Z'),
    parameterValidityRows: parameterRows,
  });

  assert.deepEqual(
    view.parameterValidity.items.map((item) => item.name),
    ['EXPIRED', 'WARNING', 'UNKNOWN', 'OK'],
  );
  assert.ok(view.parameterValidity.summaryCards.some((card) => card.label === '已过期' && card.value === '1 个'));
  assert.ok(view.parameterValidity.summaryCards.some((card) => card.label === '即将到期' && card.value === '1 个'));
  assert.ok(view.parameterValidity.summaryCards.some((card) => card.label === '未知有效期' && card.value === '1 个'));
  assert.equal(view.parameterValidity.items[0].statusLabel, '已过期');
  assert.equal(view.parameterValidity.items[1].dueLabel, '剩余 5 天');
});

test('parameter validity registry files avoid values and cover first high-risk secrets', async () => {
  for (const environment of ['dev', 'main']) {
    const registry = JSON.parse(
      await readFile(new URL(`../config/parameter-validity/${environment}.json`, import.meta.url), 'utf8'),
    );
    const validated = validateParameterRegistry(registry);
    const keys = new Set(validated.parameters.map((parameter) => parameter.key));

    assert.equal(validated.environment, environment);
    assert.ok(validated.parameters.length >= 10);
    assert.ok(validated.parameters.every((parameter) => !Object.hasOwn(parameter, 'value')));
    assert.ok(validated.parameters.every((parameter) => parameter.sensitive === true));
    assert.ok(validated.parameters.every((parameter) => parameter.sourceDoc));

    if (environment === 'dev') {
      assert.ok(keys.has('dev.github.secret.DEV_TRAINING_DB_URL'));
      assert.ok(keys.has('dev.github.secret.AI_API_KEY'));
      assert.ok(keys.has('dev.cloudflare.secret.GITHUB_TOKEN'));
    } else {
      assert.ok(keys.has('main.github.secret.TRAINING_DB_URL'));
      assert.ok(keys.has('main.github.secret.AI_API_KEY'));
      assert.ok(keys.has('main.cloudflare.secret.GITHUB_TOKEN'));
    }
  }
});

test('parameter validity audit workflow writes summary, monitor rows and triggers page refresh', async () => {
  const workflow = await readFile(new URL('../.github/workflows/parameter-validity-audit.yml', import.meta.url), 'utf8');

  assert.match(workflow, /name:\s*Parameter Validity Audit/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /node tools\/check-parameter-validity\.mjs/);
  assert.match(workflow, /--write-monitor/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /actions\/workflows\/deploy-cloudflare-pages-dev\.yml\/dispatches/);
  assert.match(workflow, /actions\/workflows\/deploy-pages\.yml\/dispatches/);
  assert.match(workflow, /- name:\s*Report Action Status/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /continue-on-error:\s*true/);
});

test('parameter validity summary keeps status counts stable', () => {
  const summary = buildParameterValiditySummary([
    { status: 'expired' },
    { status: 'missing' },
    { status: 'warning' },
    { status: 'unknown' },
    { status: 'ok' },
  ]);

  assert.deepEqual(summary.counts, {
    total: 5,
    ok: 1,
    warning: 1,
    expired: 1,
    missing: 1,
    unknown: 1,
  });
});
