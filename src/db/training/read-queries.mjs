export const TRAINING_DAY_QUERY = `
  select
    archived_date,
    total_activities,
    total_duration_seconds,
    training_calories,
    workout_duration_minutes,
    active_hours,
    cycling_distance_km,
    intake_calories,
    nutrition_details_json
  from core.training_day
  order by archived_date asc
`;

export const TRAINING_MEASUREMENT_QUERY = `
  select
    archived_date,
    measured_at,
    body_score,
    weight_kg,
    bmi,
    body_fat_pct,
    skeletal_muscle_kg,
    visceral_fat_level,
    basal_metabolism_kcal,
    body_water_pct,
    protein_pct,
    bone_mass_kg,
    fat_free_mass_kg,
    body_age,
    body_type
  from core.measurement
  order by archived_date asc, measured_at asc nulls last
`;

export const TRAINING_ACTIVITY_QUERY = `
  select
    archived_date,
    activity_time,
    activity_type,
    raw_type,
    detail,
    calories,
    heart_rate,
    distance_km,
    avg_speed_kmh,
    duration_text,
    duration_seconds
  from core.activity
  order by archived_date asc, activity_time asc nulls last
`;

export const TRAINING_MEAL_QUERY = `
  select
    archived_date,
    meal_name,
    calories,
    recommended_min,
    recommended_max
  from core.meal
  order by archived_date asc, meal_name asc
`;

export const TRAINING_SLEEP_QUERY = `
  select
    archived_date,
    sleep_type,
    bedtime,
    wake_time,
    night_sleep_minutes,
    total_sleep_minutes,
    nap_minutes,
    deep_sleep_minutes,
    light_sleep_minutes,
    rem_sleep_minutes,
    awake_minutes,
    sleep_stage_text,
    sleep_stage_detail,
    sleep_score,
    sleep_score_percentile,
    deep_sleep_ratio_pct,
    light_sleep_ratio_pct,
    rem_sleep_ratio_pct,
    deep_sleep_continuity_score,
    wake_count,
    breathing_quality_score,
    average_heart_rate_bpm,
    hrv_ms,
    average_spo2_pct,
    average_respiratory_rate,
    analysis_text,
    suggestion_text
  from (
    select
      archived_date,
      sleep_type,
      bedtime,
      wake_time,
      night_sleep_minutes,
      total_sleep_minutes,
      nap_minutes,
      deep_sleep_minutes,
      light_sleep_minutes,
      rem_sleep_minutes,
      awake_minutes,
      sleep_stage_text,
      sleep_stage_detail,
      sleep_score,
      sleep_score_percentile,
      deep_sleep_ratio_pct,
      light_sleep_ratio_pct,
      rem_sleep_ratio_pct,
      deep_sleep_continuity_score,
      wake_count,
      breathing_quality_score,
      average_heart_rate_bpm,
      hrv_ms,
      average_spo2_pct,
      average_respiratory_rate,
      analysis_text,
      suggestion_text,
      1 as source_priority
    from core.sleep

    union all

    select
      archived_date,
      sleep_type,
      bedtime,
      wake_time,
      night_sleep_minutes,
      total_sleep_minutes,
      nap_minutes,
      deep_sleep_minutes,
      light_sleep_minutes,
      rem_sleep_minutes,
      awake_minutes,
      sleep_stage_text,
      sleep_stage_detail::text as sleep_stage_detail,
      sleep_score,
      sleep_score_percentile,
      deep_sleep_ratio_pct,
      light_sleep_ratio_pct,
      rem_sleep_ratio_pct,
      deep_sleep_continuity_score,
      wake_count,
      breathing_quality_score,
      average_heart_rate_bpm,
      hrv_ms,
      average_spo2_pct,
      average_respiratory_rate,
      analysis_text,
      suggestion_text,
      2 as source_priority
    from archive.training_sleep
    where not exists (
      select 1
      from core.sleep core_sleep
      where core_sleep.archived_date = archive.training_sleep.archived_date
        and coalesce(core_sleep.bedtime, '') = coalesce(archive.training_sleep.bedtime, '')
        and coalesce(core_sleep.wake_time, '') = coalesce(archive.training_sleep.wake_time, '')
        and coalesce(core_sleep.total_sleep_minutes, -1) = coalesce(archive.training_sleep.total_sleep_minutes, -1)
        and coalesce(core_sleep.sleep_type, '') = coalesce(archive.training_sleep.sleep_type, '')
    )
  ) sleep_rows
  order by archived_date asc, source_priority asc, bedtime asc nulls last
`;

export const BODY_FEEDBACK_QUERY = `
  select
    telegram_message_id,
    telegram_chat_id,
    body,
    command,
    thought_module,
    tags_json,
    message_date_unix,
    markdown_path,
    image_refs_json,
    updated_at
  from core.thought
  where status = 'active'
  order by coalesce(message_date_unix, extract(epoch from updated_at)) asc,
    telegram_message_id asc
`;

export const ARCHIVE_TRAINING_DAY_QUERY = `
  select
    archived_date,
    total_activities,
    total_duration_seconds,
    training_calories,
    workout_duration_minutes,
    active_hours,
    cycling_distance_km,
    intake_calories
  from archive.training_day
  order by archived_date asc
`;

export const ARCHIVE_TRAINING_MEASUREMENT_QUERY = `
  select
    archived_date,
    measured_at,
    body_score,
    weight_kg,
    bmi,
    body_fat_pct,
    skeletal_muscle_kg,
    visceral_fat_level,
    basal_metabolism_kcal,
    body_water_pct,
    protein_pct,
    bone_mass_kg,
    fat_free_mass_kg,
    body_age,
    body_type
  from archive.training_measurement
  order by archived_date asc, measured_at asc nulls last
`;

export const ARCHIVE_TRAINING_ACTIVITY_QUERY = `
  select
    archived_date,
    activity_time,
    activity_type,
    raw_type,
    detail,
    calories,
    heart_rate,
    distance_km,
    avg_speed_kmh,
    duration_text,
    duration_seconds
  from archive.training_activity
  order by archived_date asc, activity_time asc nulls last
`;

export const ARCHIVE_TRAINING_MEAL_QUERY = `
  select
    archived_date,
    meal_name,
    calories,
    recommended_min,
    recommended_max
  from archive.training_meal
  order by archived_date asc, meal_name asc
`;

export const ARCHIVE_TRAINING_SLEEP_QUERY = `
  select
    archived_date,
    sleep_type,
    bedtime,
    wake_time,
    night_sleep_minutes,
    total_sleep_minutes,
    nap_minutes,
    deep_sleep_minutes,
    light_sleep_minutes,
    rem_sleep_minutes,
    awake_minutes,
    sleep_stage_text,
    sleep_stage_detail,
    sleep_score,
    sleep_score_percentile,
    deep_sleep_ratio_pct,
    light_sleep_ratio_pct,
    rem_sleep_ratio_pct,
    deep_sleep_continuity_score,
    wake_count,
    breathing_quality_score,
    average_heart_rate_bpm,
    hrv_ms,
    average_spo2_pct,
    average_respiratory_rate,
    analysis_text,
    suggestion_text
  from archive.training_sleep
  order by archived_date asc, bedtime asc nulls last
`;
