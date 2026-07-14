import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('environment monitor schemas omit retired parameter monitoring objects', async () => {
  for (const environment of ['dev-sql', 'main-sql']) {
    const sql = await readFile(new URL('../sql/' + environment + '/monitor.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(sql, /system_config_parameters/u);
    assert.doesNotMatch(sql, /system_config_parameter_checks/u);
  }
});
