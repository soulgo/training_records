# Training Records Migrations

These migrations are explicit DDL entry points for schema changes that must not run from the daily `TRAINING_DB_URL` application account.

`npm run maintenance:migrate -- --dry-run` lists migration files. When `TRAINING_DB_MIGRATION_URL` is configured, the dry-run also reads `maintenance.schema_migration` and reports whether each migration is already `applied` or still `pending`.

`npm run maintenance:migrate -- --confirm` creates `maintenance.schema_migration` if needed, skips already recorded migrations, executes pending SQL with the migration account, and records the SQL checksum after a successful run. If an already recorded migration has a different checksum from the current SQL file, confirm mode blocks instead of reusing the same migration id for changed SQL.

## 001_runtime_schema_preflight_backfill

### Purpose

Move the historical runtime schema preflight from `src/adapters/postgres/schema-preflight.pg.mjs` into an auditable migration.

### Pre-check SQL

```sql
select current_user;

select table_schema, table_name, column_name
from information_schema.columns
where table_schema in ('core', 'ingest')
  and (
    (table_name = 'sleep' and column_name in (
      'total_sleep_minutes',
      'sleep_score',
      'sleep_score_percentile',
      'deep_sleep_continuity_score',
      'wake_count',
      'breathing_quality_score',
      'average_heart_rate_bpm',
      'hrv_ms',
      'average_spo2_pct',
      'average_respiratory_rate',
      'analysis_text',
      'suggestion_text'
    ))
    or (table_name = 'training_day' and column_name in (
      'sleep_total_minutes',
      'night_sleep_minutes',
      'nap_minutes',
      'sleep_start_time',
      'sleep_end_time',
      'deep_sleep_minutes',
      'light_sleep_minutes',
      'rem_sleep_minutes',
      'awake_minutes'
    ))
    or (table_name in ('thought', 'telegram_message', 'telegram_recognition')
      and column_name in ('source_channel', 'source_chat_id', 'source_message_id'))
  )
order by table_schema, table_name, column_name;

select schemaname, tablename, indexname
from pg_indexes
where schemaname in ('core', 'ingest')
  and indexname in (
    'ux_core_thought_identity',
    'ux_ingest_telegram_message_source_identity',
    'ux_ingest_telegram_recognition_source_identity'
  )
order by schemaname, tablename, indexname;

select to_regclass('ingest.ai_call_log') as ai_call_log_table;
```

### Execute SQL

Run `001_runtime_schema_preflight_backfill.sql` with `TRAINING_DB_MIGRATION_URL` or a schema owner/migrator account. Do not run it through the application account used by normal sync/export jobs.

### Rollback Strategy

Prefer restore-from-backup for production. The migration adds columns, indexes, comments, defaults, not-null constraints, backfilled source identity values, and `ingest.ai_call_log`; dropping them can lose audit data. For local/dev rollback, use a fresh database restore or adapt `sql/training_records/rollback_core_code_optimization_01.sql` after confirming no production data depends on the added fields.

### Acceptance SQL

```sql
select count(*) as thought_missing_identity
from core.thought
where source_channel is null
   or source_chat_id is null
   or source_message_id is null;

select count(*) as message_missing_identity
from ingest.telegram_message
where source_channel is null
   or source_chat_id is null
   or source_message_id is null;

select count(*) as recognition_missing_identity
from ingest.telegram_recognition
where source_channel is null
   or source_chat_id is null
   or source_message_id is null;

select to_regclass('ingest.ai_call_log') as ai_call_log_table;
select to_regclass('core.ux_core_thought_identity') as thought_identity_index;
select to_regclass('ingest.ux_ingest_telegram_message_source_identity') as message_identity_index;
select to_regclass('ingest.ux_ingest_telegram_recognition_source_identity') as recognition_identity_index;
```

## 002_observation_records

### Purpose

Add record-level Observation v4 storage, date-resolution audit fields, and review-queue indexes without changing existing recognition or core rows.

### Execute and Rollback

Run `002_observation_records.sql` through the maintenance migration command. Its partial indexes are created concurrently after the DDL transaction commits. For dev rollback, run `../rollback_observation_records.sql`; it removes only this migration's additive table, columns, constraint, and indexes.

### Acceptance SQL

```sql
select to_regclass('ingest.extracted_record') as extracted_record_table;

select column_name, data_type
from information_schema.columns
where table_schema = 'ingest'
  and (
    (table_name = 'source_batch' and column_name = 'date_resolution_status')
    or (table_name = 'recognition_run' and column_name = 'date_candidates_json')
  )
order by table_name, column_name;

select indexname
from pg_indexes
where schemaname = 'ingest'
  and indexname in ('idx_extracted_record_date_type', 'idx_extracted_record_review')
order by indexname;
```
