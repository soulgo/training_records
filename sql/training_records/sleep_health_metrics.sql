-- Huawei sleep report structured health metrics.
-- Run manually against each target database before deploying the matching code.

alter table core.sleep
add column if not exists sleep_score numeric(6,2) null,
add column if not exists sleep_score_percentile numeric(6,2) null,
add column if not exists deep_sleep_ratio_pct numeric(6,2) null,
add column if not exists light_sleep_ratio_pct numeric(6,2) null,
add column if not exists rem_sleep_ratio_pct numeric(6,2) null,
add column if not exists deep_sleep_continuity_score numeric(6,2) null,
add column if not exists wake_count integer null,
add column if not exists breathing_quality_score numeric(6,2) null,
add column if not exists average_heart_rate_bpm numeric(6,2) null,
add column if not exists hrv_ms numeric(8,2) null,
add column if not exists average_spo2_pct numeric(6,2) null,
add column if not exists average_respiratory_rate numeric(6,2) null,
add column if not exists analysis_text text null,
add column if not exists suggestion_text text null;

alter table archive.training_sleep
add column if not exists sleep_score numeric(6,2) null,
add column if not exists sleep_score_percentile numeric(6,2) null,
add column if not exists deep_sleep_ratio_pct numeric(6,2) null,
add column if not exists light_sleep_ratio_pct numeric(6,2) null,
add column if not exists rem_sleep_ratio_pct numeric(6,2) null,
add column if not exists deep_sleep_continuity_score numeric(6,2) null,
add column if not exists wake_count integer null,
add column if not exists breathing_quality_score numeric(6,2) null,
add column if not exists average_heart_rate_bpm numeric(6,2) null,
add column if not exists hrv_ms numeric(8,2) null,
add column if not exists average_spo2_pct numeric(6,2) null,
add column if not exists average_respiratory_rate numeric(6,2) null,
add column if not exists analysis_text text null,
add column if not exists suggestion_text text null;

alter table core.training_day
add column if not exists sleep_total_minutes integer null,
add column if not exists night_sleep_minutes integer null,
add column if not exists nap_minutes integer null,
add column if not exists sleep_start_time text null,
add column if not exists sleep_end_time text null,
add column if not exists deep_sleep_minutes integer null,
add column if not exists light_sleep_minutes integer null,
add column if not exists rem_sleep_minutes integer null,
add column if not exists awake_minutes integer null,
add column if not exists sleep_score numeric(6,2) null,
add column if not exists deep_sleep_ratio_pct numeric(6,2) null,
add column if not exists light_sleep_ratio_pct numeric(6,2) null,
add column if not exists rem_sleep_ratio_pct numeric(6,2) null;

alter table archive.training_day
add column if not exists sleep_score numeric(6,2) null,
add column if not exists deep_sleep_ratio_pct numeric(6,2) null,
add column if not exists light_sleep_ratio_pct numeric(6,2) null,
add column if not exists rem_sleep_ratio_pct numeric(6,2) null;

comment on column core.sleep.sleep_score is 'Huawei sleep score';
comment on column core.sleep.sleep_score_percentile is 'Percent of users exceeded by the sleep score';
comment on column core.sleep.deep_sleep_ratio_pct is 'Deep sleep percentage';
comment on column core.sleep.light_sleep_ratio_pct is 'Light sleep percentage';
comment on column core.sleep.rem_sleep_ratio_pct is 'REM sleep percentage';
comment on column core.sleep.deep_sleep_continuity_score is 'Deep sleep continuity score';
comment on column core.sleep.wake_count is 'Wake count during sleep';
comment on column core.sleep.breathing_quality_score is 'Sleep breathing quality score';
comment on column core.sleep.average_heart_rate_bpm is 'Average sleeping heart rate';
comment on column core.sleep.hrv_ms is 'Average sleeping HRV in milliseconds';
comment on column core.sleep.average_spo2_pct is 'Average sleeping blood oxygen percentage';
comment on column core.sleep.average_respiratory_rate is 'Average sleeping respiratory rate';
comment on column core.sleep.analysis_text is 'Sleep report analysis text';
comment on column core.sleep.suggestion_text is 'Sleep report suggestion text';
