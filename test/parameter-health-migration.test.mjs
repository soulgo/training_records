import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../sql/dev-sql/update-dev-sql/20260713_remove_system_parameter_monitoring.sql',
  import.meta.url,
);

test('environment monitor schemas omit retired parameter monitoring objects', async () => {
  for (const environment of ['dev-sql', 'main-sql']) {
    const sql = await readFile(new URL('../sql/' + environment + '/monitor.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(sql, /system_config_parameters/u);
    assert.doesNotMatch(sql, /system_config_parameter_checks/u);
  }
});

test('dev migration drops retired parameter monitoring objects in dependency order', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const checksTable = sql.indexOf('DROP TABLE IF EXISTS "monitor"."system_config_parameter_checks"');
  const parametersTable = sql.indexOf('DROP TABLE IF EXISTS "monitor"."system_config_parameters"');
  const checksSequence = sql.indexOf('DROP SEQUENCE IF EXISTS "monitor"."system_config_parameter_checks_check_id_seq"');

  assert.ok(checksTable >= 0, 'migration should drop the parameter check history first');
  assert.ok(parametersTable > checksTable, 'migration should drop the parameter registry after its history');
  assert.ok(checksSequence > parametersTable, 'migration should clean up an unowned legacy sequence last');
});
