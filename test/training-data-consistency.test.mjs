import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  checkTrainingDataConsistency,
  checkTrainingDataConsistencyClient,
} from '../src/db/training/consistency-check.mjs';

test('checkTrainingDataConsistency skips when database is disabled', async () => {
  const result = await checkTrainingDataConsistency({
    env: { TRAINING_DB_ENABLED: 'false' },
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'disabled');
});

test('checkTrainingDataConsistencyClient reports failed row count checks', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/core_count/i.test(sql)) {
        return { rows: [{ core_count: 10, archive_count: 10 }] };
      }
      if (/from core\.sleep s/i.test(sql)) {
        return { rows: [{ count: 1 }] };
      }
      if (/information_schema\.columns/i.test(sql)) {
        return {
          rows: [
            'sleep_total_minutes',
            'night_sleep_minutes',
            'nap_minutes',
            'sleep_start_time',
            'sleep_end_time',
            'deep_sleep_minutes',
            'light_sleep_minutes',
            'rem_sleep_minutes',
            'awake_minutes',
          ].map((column_name) => ({ column_name })),
        };
      }
      return { rows: [{ count: 0 }] };
    },
  };

  const checks = await checkTrainingDataConsistencyClient(client);

  assert.ok(queries.some((sql) => /archive\.training_day/i.test(sql)));
  assert.equal(checks.find((check) => check.name === 'core.sleep has no orphaned records').status, 'failed');
  assert.equal(checks.at(-1).status, 'ok');
});

test('core schema defines training_day sleep summary columns', async () => {
  const sql = await readFile(new URL('../sql/training_records/core.sql', import.meta.url), 'utf8');

  assert.match(sql, /CREATE TABLE "core"\."training_day"[\s\S]*"sleep_total_minutes" int4/i);
  assert.match(sql, /CREATE TABLE "core"\."training_day"[\s\S]*"night_sleep_minutes" int4/i);
  assert.match(sql, /CREATE TABLE "core"\."training_day"[\s\S]*"nap_minutes" int4/i);
  assert.match(sql, /CREATE TABLE "core"\."training_day"[\s\S]*"sleep_start_time" text/i);
  assert.match(sql, /CREATE TABLE "core"\."training_day"[\s\S]*"sleep_end_time" text/i);
});
