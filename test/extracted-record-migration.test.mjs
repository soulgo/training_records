import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../sql/training_records/migrations/002_observation_records.sql', import.meta.url);
const rollbackUrl = new URL('../sql/training_records/rollback_observation_records.sql', import.meta.url);
const canonicalIngestUrl = new URL('../sql/training_records/ingest.sql', import.meta.url);
const canonicalCoreUrl = new URL('../sql/training_records/core.sql', import.meta.url);

test('observation migration creates the record-level date audit contract', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /^-- id: 002_observation_records/mu);
  assert.match(sql, /alter table ingest\.source_batch[\s\S]*date_resolution_status/iu);
  assert.match(sql, /alter table ingest\.recognition_run[\s\S]*date_candidates_json/iu);
  assert.match(sql, /create table if not exists ingest\.extracted_record/iu);
  assert.match(sql, /record_id text primary key/iu);
  assert.match(sql, /references ingest\.recognition_run\s*\(\s*recognition_id\s*\) on delete cascade/iu);
  assert.match(sql, /unique\s*\(\s*recognition_id\s*,\s*record_ordinal\s*\)/iu);
  assert.match(sql, /status in \('accepted', 'needs_review', 'rejected'\)/iu);
  assert.match(sql, /date_confidence >= 0 and date_confidence <= 1/iu);
  assert.match(sql, /ck_core_measurement_physical_ranges/iu);
  assert.match(sql, /ck_core_activity_nonnegative/iu);
  assert.match(sql, /ck_core_meal_ranges/iu);
  assert.match(sql, /ck_core_sleep_ranges/iu);
  assert.match(sql, /commit\s*;[\s\S]*create index concurrently/iu);
  assert.match(sql, /where status = 'accepted'/iu);
  assert.match(sql, /where status = 'needs_review'/iu);
});

test('observation rollback removes only the additive observation contract', async () => {
  const sql = await readFile(rollbackUrl, 'utf8');

  assert.match(sql, /drop table if exists ingest\.extracted_record/iu);
  assert.match(sql, /drop column if exists date_candidates_json/iu);
  assert.match(sql, /drop column if exists date_resolution_status/iu);
  assert.doesNotMatch(sql, /drop table[^;]+(?:source_batch|recognition_run)/iu);
});

test('canonical ingest schema includes the latest observation contract', async () => {
  const sql = await readFile(canonicalIngestUrl, 'utf8');
  const coreSql = await readFile(canonicalCoreUrl, 'utf8');

  assert.match(sql, /create table "ingest"\."extracted_record"/iu);
  assert.match(sql, /"date_candidates_json" jsonb not null default '\[\]'::jsonb/iu);
  assert.match(sql, /"date_resolution_status" text[\s\S]*default 'single_date'::text/iu);
  assert.match(sql, /idx_extracted_record_date_type/iu);
  assert.match(sql, /extracted_record_recognition_fkey/iu);
  assert.match(coreSql, /ck_core_measurement_physical_ranges/iu);
  assert.match(coreSql, /ck_core_activity_nonnegative/iu);
  assert.match(coreSql, /ck_core_meal_ranges/iu);
  assert.match(coreSql, /ck_core_sleep_ranges/iu);
});
