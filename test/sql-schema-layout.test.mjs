import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const sqlRoot = new URL('../sql/', import.meta.url);

test('sql directory keeps only environment schema directories', async () => {
  const entries = await readdir(sqlRoot, { withFileTypes: true });
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    ['dev-sql', 'main-sql'],
  );
  assert.ok(entries.every((entry) => entry.isDirectory()));
});

test('main alignment SQL covers every structural delta required by the dev baseline', async () => {
  const sql = await readFile(new URL('../sql/main-sql/align_to_dev.sql', import.meta.url), 'utf8');

  for (const table of ['source_batch', 'source_message', 'source_asset', 'recognition_run', 'pending_task']) {
    assert.match(sql, new RegExp(`create table if not exists ingest\\.${table}`, 'iu'));
  }
  for (const column of [
    'source_app', 'data_type', 'fields_json', 'confidence', 'pipeline_version', 'ocr_json', 'image_json', 'cache_key',
  ]) {
    assert.match(sql, new RegExp(`add column if not exists ${column}`, 'iu'));
  }
  for (const column of [
    'sleep_total_minutes', 'night_sleep_minutes', 'nap_minutes', 'sleep_start_time', 'sleep_end_time',
    'deep_sleep_minutes', 'light_sleep_minutes', 'rem_sleep_minutes', 'awake_minutes',
  ]) {
    assert.match(sql, new RegExp(`add column if not exists ${column}`, 'iu'));
  }
  assert.match(sql, /training_sleep_source_hash_fkey/iu);
  assert.match(sql, /insert into ingest\.source_batch/iu);
  assert.match(sql, /insert into ingest\.source_message/iu);
  assert.match(sql, /insert into ingest\.source_asset/iu);
  assert.match(sql, /insert into ingest\.recognition_run/iu);
  assert.match(sql, /insert into ingest\.pending_task/iu);
  assert.doesNotMatch(sql.replace(/^\s*--.*$/gmu, ''), /drop table/iu);
});
