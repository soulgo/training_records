-- id: 002_observation_records
-- purpose: Add record-level observation, semantic review, and date-resolution audit storage.
-- execute with: TRAINING_DB_MIGRATION_URL or a schema owner/migrator account.

begin;

alter table ingest.source_batch
  add column if not exists date_resolution_status text not null default 'single_date';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ck_source_batch_date_resolution_status'
      and conrelid = 'ingest.source_batch'::regclass
  ) then
    alter table ingest.source_batch
      add constraint ck_source_batch_date_resolution_status
      check (date_resolution_status in ('single_date', 'multi_date', 'needs_review', 'not_applicable'))
      not valid;
  end if;
end $$;

alter table ingest.recognition_run
  add column if not exists date_candidates_json jsonb not null default '[]'::jsonb;

create table if not exists ingest.extracted_record (
  record_id text primary key,
  recognition_id text not null
    references ingest.recognition_run (recognition_id) on delete cascade,
  record_ordinal integer not null,
  record_type text not null,
  observed_at_text text,
  occurred_at timestamptz,
  archived_date date,
  date_resolution text not null,
  date_confidence numeric(5, 4),
  fields_json jsonb not null default '{}'::jsonb,
  evidence_json jsonb not null default '{}'::jsonb,
  status text not null default 'accepted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_extracted_record_run_ordinal unique (recognition_id, record_ordinal),
  constraint ck_extracted_record_type check (
    record_type in ('measurement', 'activity', 'workout_summary', 'meal', 'nutrition_summary', 'sleep')
  ),
  constraint ck_extracted_record_date_resolution check (
    date_resolution in (
      'exact_image', 'derived_message_year', 'derived_batch_anchor',
      'derived_sleep_start', 'filename_fallback', 'unresolved'
    )
  ),
  constraint ck_extracted_record_status check (
    status in ('accepted', 'needs_review', 'rejected')
  ),
  constraint ck_extracted_record_date_confidence check (
    date_confidence is null or (date_confidence >= 0 and date_confidence <= 1)
  )
);

grant select, insert, update on ingest.extracted_record to training_app;
grant select on ingest.extracted_record to training_readonly;
grant select, insert, update, delete on ingest.extracted_record to training_maintenance;

alter table core.measurement
  add constraint ck_core_measurement_physical_ranges check (
    (weight_kg is null or weight_kg between 20 and 300)
    and (bmi is null or bmi between 8 and 80)
    and (body_fat_pct is null or body_fat_pct between 2 and 75)
    and (body_water_pct is null or body_water_pct between 20 and 85)
    and (protein_pct is null or protein_pct between 5 and 35)
    and (bone_mass_kg is null or bone_mass_kg between 0.5 and 8)
    and (basal_metabolism_kcal is null or basal_metabolism_kcal between 500 and 3500)
    and (fat_free_mass_kg is null or weight_kg is null or fat_free_mass_kg <= weight_kg)
  ) not valid;

alter table core.activity
  add constraint ck_core_activity_nonnegative check (
    (calories is null or calories >= 0)
    and (distance_km is null or distance_km >= 0)
    and (duration_seconds is null or duration_seconds >= 0)
    and (heart_rate is null or heart_rate between 25 and 250)
  ) not valid;

alter table core.meal
  add constraint ck_core_meal_ranges check (
    (calories is null or calories >= 0)
    and (recommended_min is null or recommended_min >= 0)
    and (recommended_max is null or recommended_max >= 0)
    and (recommended_min is null or recommended_max is null or recommended_min <= recommended_max)
  ) not valid;

alter table core.sleep
  add constraint ck_core_sleep_ranges check (
    (total_sleep_minutes is null or total_sleep_minutes between 0 and 1440)
    and (night_sleep_minutes is null or night_sleep_minutes between 0 and 960)
    and (nap_minutes is null or nap_minutes between 0 and 480)
    and (deep_sleep_ratio_pct is null or deep_sleep_ratio_pct between 0 and 100)
    and (light_sleep_ratio_pct is null or light_sleep_ratio_pct between 0 and 100)
    and (rem_sleep_ratio_pct is null or rem_sleep_ratio_pct between 0 and 100)
    and (average_spo2_pct is null or average_spo2_pct between 50 and 100)
  ) not valid;

commit;

-- migrate:non-transactional
create index concurrently if not exists idx_extracted_record_date_type
  on ingest.extracted_record (archived_date desc, record_type)
  where status = 'accepted';

-- migrate:non-transactional
create index concurrently if not exists idx_extracted_record_review
  on ingest.extracted_record (updated_at asc)
  where status = 'needs_review';
