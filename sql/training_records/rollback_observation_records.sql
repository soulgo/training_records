-- purpose: Roll back only the additive Observation v4 persistence contract.

drop index concurrently if exists ingest.idx_extracted_record_review;
drop index concurrently if exists ingest.idx_extracted_record_date_type;

begin;

alter table core.sleep drop constraint if exists ck_core_sleep_ranges;
alter table core.meal drop constraint if exists ck_core_meal_ranges;
alter table core.activity drop constraint if exists ck_core_activity_nonnegative;
alter table core.measurement drop constraint if exists ck_core_measurement_physical_ranges;

drop table if exists ingest.extracted_record;

alter table ingest.recognition_run
  drop column if exists date_candidates_json;

alter table ingest.source_batch
  drop constraint if exists ck_source_batch_date_resolution_status;

alter table ingest.source_batch
  drop column if exists date_resolution_status;

commit;
