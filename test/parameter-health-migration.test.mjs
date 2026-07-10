import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('manual parameter health migration is idempotent and invalidates legacy validity-only statuses', async () => {
  const sql = await readFile(new URL('../sql/training_records/migrate_parameter_health_monitor.sql', import.meta.url), 'utf8');

  assert.match(sql, /begin;/iu);
  assert.match(sql, /add column if not exists health_probe_key/iu);
  assert.match(sql, /add column if not exists health_check_type/iu);
  assert.match(sql, /add column if not exists check_type/iu);
  assert.match(sql, /add column if not exists latency_ms/iu);
  assert.match(sql, /add column if not exists failure_kind/iu);
  assert.match(sql, /add column if not exists observed_expires_at/iu);
  assert.match(sql, /status\s*=\s*'unknown'/iu);
  assert.match(sql, /legacy_status/iu);
  assert.match(sql, /status in \('healthy', 'present', 'invalid', 'missing', 'not_configured', 'unreachable', 'unsupported', 'unknown'\)/iu);
  assert.match(sql, /where status = 'healthy'/iu);
  assert.match(sql, /commit;/iu);
  assert.doesNotMatch(sql, /drop table|truncate/iu);
});

test('canonical monitor schema creates parameter health columns directly', async () => {
  const sql = await readFile(new URL('../sql/training_records/monitor.sql', import.meta.url), 'utf8');

  assert.match(sql, /"health_probe_key" text/iu);
  assert.match(sql, /"health_check_type" text/iu);
  assert.match(sql, /"check_type" text/iu);
  assert.match(sql, /"latency_ms" int4/iu);
  assert.match(sql, /"failure_kind" text/iu);
  assert.match(sql, /"observed_expires_at" timestamptz/iu);
  assert.match(sql, /'healthy'::text,\s*'present'::text,\s*'invalid'::text,\s*'missing'::text,\s*'not_configured'::text,\s*'unreachable'::text,\s*'unsupported'::text,\s*'unknown'::text/iu);
  assert.match(sql, /idx_system_config_parameter_checks_last_healthy/iu);
  assert.doesNotMatch(sql, /检查状态：ok、warning、expired/iu);
});
