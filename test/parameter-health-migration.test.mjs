import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('environment monitor schemas expose the same parameter monitoring tables', async () => {
  for (const environment of ['dev-sql', 'main-sql']) {
    const sql = await readFile(new URL(`../sql/${environment}/monitor.sql`, import.meta.url), 'utf8');
    assert.match(sql, /CREATE TABLE "monitor"\."system_config_parameters"/u);
    assert.match(sql, /CREATE TABLE "monitor"\."system_config_parameter_checks"/u);
    assert.match(sql, /system_config_parameter_checks_parameter_key_fkey/u);
  }
});
