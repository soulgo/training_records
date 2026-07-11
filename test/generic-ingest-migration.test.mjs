import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ingest schema keeps normalized recognition columns on telegram_recognition, not telegram_message', async () => {
  const sql = await readFile(new URL('../sql/training_records/ingest.sql', import.meta.url), 'utf8');
  const messageTable = extractCreateTable(sql, 'ingest', 'telegram_message');
  const recognitionTable = extractCreateTable(sql, 'ingest', 'telegram_recognition');

  for (const column of [
    'source_app',
    'data_type',
    'fields_json',
    'confidence',
    'pipeline_version',
    'ocr_json',
    'image_json',
    'cache_key',
  ]) {
    assert.doesNotMatch(messageTable, new RegExp(`"${column}"`, 'i'), `${column} does not belong to telegram_message`);
    assert.match(recognitionTable, new RegExp(`"${column}"`, 'i'), `${column} must belong to telegram_recognition`);
  }
});

test('phase 2 migration creates and backfills generic ingest tables without dropping legacy tables', async () => {
  const sql = await readFile(
    new URL('../sql/migration_phase2_generic_ingest.sql', import.meta.url),
    'utf8',
  );

  for (const table of ['source_batch', 'source_message', 'source_asset', 'recognition_run', 'pending_task']) {
    assert.match(sql, new RegExp(`create table if not exists ingest\\.${table}`, 'i'));
    assert.match(sql, new RegExp(`comment on table ingest\\.${table}`, 'i'));
  }
  assert.match(sql, /insert into ingest\.source_batch/i);
  assert.match(sql, /from ingest\.telegram_batch/i);
  assert.match(sql, /insert into ingest\.source_message/i);
  assert.match(sql, /from ingest\.telegram_message/i);
  assert.match(sql, /jsonb_array_elements_text[\s\S]+with ordinality/i);
  assert.match(sql, /insert into ingest\.recognition_run/i);
  assert.match(sql, /from ingest\.telegram_recognition/i);
  assert.match(sql, /insert into ingest\.pending_task/i);
  assert.match(sql, /from ingest\.telegram_pending_batch/i);
  assert.match(sql, /验收查询/);
  assert.match(sql, /回滚/);

  const executableSql = sql.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(executableSql, /drop table\s+(?:if exists\s+)?ingest\.telegram_/i);
});

test('canonical PostgreSQL schemas include the generic ingest tables', async () => {
  for (const relativePath of ['../sql/pgsql17.sql', '../sql/training_records/ingest.sql']) {
    const sql = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    for (const table of ['source_batch', 'source_message', 'source_asset', 'recognition_run', 'pending_task']) {
      assert.match(
        sql,
        new RegExp(`(?:create table if not exists ingest\\.${table}|CREATE TABLE "ingest"\\."${table}")`, 'i'),
        `${relativePath} must define ingest.${table}`,
      );
    }
  }
});

test('legacy ingest cleanup is guarded and drops old tables only after count checks', async () => {
  const sql = await readFile(
    new URL('../sql/cleanup_phase2_legacy_ingest.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /training_records\.allow_legacy_ingest_drop/i);
  assert.match(sql, /raise exception/i);
  assert.match(sql, /ingest\.source_batch/i);
  assert.match(sql, /ingest\.source_message/i);
  assert.match(sql, /ingest\.recognition_run/i);
  assert.match(sql, /ingest\.pending_task/i);
  assert.match(sql, /drop table if exists ingest\.telegram_recognition/i);
  assert.match(sql, /drop table if exists ingest\.telegram_message/i);
  assert.match(sql, /drop table if exists ingest\.telegram_pending_batch/i);
  assert.match(sql, /drop table if exists ingest\.telegram_batch/i);
  assert.match(sql, /不可逆|备份/);

  const executableSql = sql.replace(/^\s*--.*$/gm, '').trimStart();
  assert.match(executableSql, /^do\s+\$\$/i, 'cleanup file must enter the guarded block before any executable setup');
  assert.doesNotMatch(executableSql, /\\i\s+sql\/cleanup_phase2_legacy_ingest\.sql/i);
  assert.doesNotMatch(
    executableSql,
    /set\s+local\s+training_records\.allow_legacy_ingest_drop\s*=\s*'on'/i,
    'cleanup file must not enable its own destructive gate',
  );
});

function extractCreateTable(sql, schema, table) {
  const marker = `CREATE TABLE "${schema}"."${table}"`;
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, `missing ${schema}.${table}`);
  const end = sql.indexOf('\n;', start);
  assert.notEqual(end, -1, `unterminated ${schema}.${table}`);
  return sql.slice(start, end);
}
