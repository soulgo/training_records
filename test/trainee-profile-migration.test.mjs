import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../sql/migration_trainee_profile.sql', import.meta.url);

test('trainee profile migration creates a minimal validated profile contract', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /^--\s*purpose:/imu);
  assert.match(sql, /begin\s*;/iu);
  assert.match(sql, /create table if not exists core\.trainee_profile/iu);
  assert.match(sql, /trainee_id\s+text\s+primary key/iu);
  assert.match(sql, /timezone\s+text\s+not null/iu);
  assert.match(sql, /birth_date\s+date/iu);
  assert.match(sql, /sex_at_birth\s+text/iu);
  assert.match(sql, /height_cm\s+numeric\s*\(\s*5\s*,\s*2\s*\)/iu);
  assert.match(sql, /experience_level\s+text/iu);
  assert.match(sql, /goal_text\s+text\s+not null/iu);
  assert.match(sql, /weekly_training_days_target\s+smallint/iu);
  assert.match(sql, /profile_json\s+jsonb\s+not null/iu);
  assert.match(sql, /profile_version\s+integer\s+not null/iu);
  assert.match(sql, /is_active\s+boolean\s+not null/iu);
  assert.match(sql, /check\s*\(\s*sex_at_birth is null or sex_at_birth in/iu);
  assert.match(sql, /check\s*\(\s*height_cm is null or height_cm between 80 and 250\s*\)/iu);
  assert.match(sql, /check\s*\(\s*jsonb_typeof\(profile_json\) = 'object'/iu);
  assert.match(sql, /insert into core\.trainee_profile/iu);
  assert.match(sql, /'default'/u);
  assert.match(sql, /on conflict \(trainee_id\) do nothing/iu);
  assert.match(sql, /grant select, insert, update on core\.trainee_profile to training_app/iu);
  assert.match(sql, /grant select on core\.trainee_profile to training_readonly/iu);
  assert.match(sql, /grant select, insert, update, delete on core\.trainee_profile to training_maintenance/iu);
  assert.match(sql, /commit\s*;/iu);

  assert.doesNotMatch(sql, /create\s+database/iu);
  assert.doesNotMatch(sql, /\bage\s+(?:integer|smallint|numeric)/iu);
  assert.doesNotMatch(sql, /\bweight_(?:kg|target)/iu);
  assert.doesNotMatch(sql, /\bresting_heart_rate/iu);
});

test('trainee profile migration documents read-only acceptance queries', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const documentedQueries = sql.replace(/^--\s?/gmu, '');

  assert.match(documentedQueries, /select to_regclass\('core\.trainee_profile'\)/iu);
  assert.match(documentedQueries, /from core\.trainee_profile\s+where trainee_id = 'default'/iu);
  assert.match(documentedQueries, /from information_schema\.table_privileges/iu);
});
