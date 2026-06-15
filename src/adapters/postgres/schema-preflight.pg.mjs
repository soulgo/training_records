/**
 * Lightweight schema preflight — idempotent ALTER TABLE … ADD COLUMN IF NOT EXISTS.
 * Runs once per process to patch columns that were added after the initial CREATE TABLE.
 */

let executed = false;

export async function ensureCoreSchema(client) {
  if (executed) return;

  await client.query(`
    alter table core.sleep add column if not exists total_sleep_minutes integer null;
    alter table core.sleep add column if not exists sleep_score integer null;
    alter table core.sleep add column if not exists sleep_score_percentile integer null;
    alter table core.sleep add column if not exists deep_sleep_continuity_score integer null;
    alter table core.sleep add column if not exists wake_count integer null;
    alter table core.sleep add column if not exists breathing_quality_score integer null;
    alter table core.sleep add column if not exists average_heart_rate_bpm integer null;
    alter table core.sleep add column if not exists hrv_ms integer null;
    alter table core.sleep add column if not exists average_spo2_pct numeric(10, 2) null;
    alter table core.sleep add column if not exists average_respiratory_rate numeric(10, 2) null;
    alter table core.sleep add column if not exists analysis_text text null;
    alter table core.sleep add column if not exists suggestion_text text null;

    alter table core.training_day add column if not exists sleep_total_minutes integer null;
    alter table core.training_day add column if not exists night_sleep_minutes integer null;
    alter table core.training_day add column if not exists nap_minutes integer null;
    alter table core.training_day add column if not exists sleep_start_time text null;
    alter table core.training_day add column if not exists sleep_end_time text null;
    alter table core.training_day add column if not exists deep_sleep_minutes integer null;
    alter table core.training_day add column if not exists light_sleep_minutes integer null;
    alter table core.training_day add column if not exists rem_sleep_minutes integer null;
    alter table core.training_day add column if not exists awake_minutes integer null;
  `);
  executed = true;
}
