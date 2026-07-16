import pg from 'pg';

import { resolveTrainingReadonlyConfig } from './training-config.pg.mjs';

const { Client } = pg;

export async function loadTrainingAnalysisContext(options = {}) {
  const config = resolveTrainingReadonlyConfig(options.env);
  if (!config.enabled || !config.url) {
    throw new Error('readonly database URL is required for training analysis');
  }

  const asOf = normalizeAsOf(options.asOf);
  const createClient = options.createClient ?? ((clientConfig) => new Client(clientConfig));
  const client = createClient({
    connectionString: config.url,
    connectionTimeoutMillis: config.timeoutMs,
    application_name: config.appName,
  });

  try {
    await client.connect();
    const result = await client.query(ANALYSIS_CONTEXT_SQL, [asOf.toISOString()]);
    return result.rows[0]?.context_json ?? emptyContext(asOf);
  } finally {
    await client.end();
  }
}

function normalizeAsOf(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) {
    throw new Error('asOf must be a valid date');
  }
  return date;
}

function emptyContext(asOf) {
  return {
    source: 'database',
    generatedAt: asOf.toISOString(),
    traineeProfile: null,
    latest: { measurement: null, daily: null },
    daily: [],
    bodyFeedback: [],
  };
}

const ANALYSIS_CONTEXT_SQL = `
with params as (
  select
    $1::timestamptz as as_of,
    ($1::timestamptz at time zone 'Asia/Shanghai')::date as as_of_date,
    (($1::timestamptz at time zone 'Asia/Shanghai')::date - interval '27 days')::date as date_from
),
active_profile as (
  select jsonb_build_object(
    'traineeId', p.trainee_id,
    'timezone', p.timezone,
    'age', case
      when p.birth_date is null then null
      else extract(year from age((select as_of_date from params), p.birth_date))::int
    end,
    'sexAtBirth', p.sex_at_birth,
    'heightCm', p.height_cm,
    'experienceLevel', p.experience_level,
    'goalText', p.goal_text,
    'weeklyTrainingDaysTarget', p.weekly_training_days_target,
    'profile', p.profile_json,
    'profileVersion', p.profile_version
  ) as value
  from core.trainee_profile p
  where p.is_active = true
  order by p.updated_at desc, p.trainee_id
  limit 1
),
bounded_days as (
  select day.*
  from core.training_day day, params
  where day.archived_date between params.date_from and params.as_of_date
),
day_rows as (
  select jsonb_build_object(
    'date', to_char(day.archived_date, 'YYYY-MM-DD'),
    'measurement', measurement.latest,
    'measurements', coalesce(measurement.items, '[]'::jsonb),
    'activities', coalesce(activity.items, '[]'::jsonb),
    'workoutSummary', jsonb_build_object(
      'totalActivities', day.total_activities,
      'totalDurationSeconds', day.total_duration_seconds,
      'trainingCalories', day.training_calories,
      'workoutDurationMinutes', day.workout_duration_minutes,
      'activeHours', day.active_hours,
      'cyclingDistanceKm', day.cycling_distance_km,
      'countsByType', coalesce(activity_counts.value, '{}'::jsonb)
    ),
    'nutrition', jsonb_build_object(
      'totalCalories', day.intake_calories,
      'meals', coalesce(meal.items, '[]'::jsonb),
      'details', day.nutrition_details_json
    ),
    'sleepSummary', sleep.latest
  ) as value,
  day.archived_date
  from bounded_days day
  left join lateral (
    select
      (jsonb_agg(jsonb_build_object(
        'measuredAt', m.measured_at,
        'weightKg', m.weight_kg,
        'bodyFatPct', m.body_fat_pct,
        'skeletalMuscleKg', m.skeletal_muscle_kg,
        'bmi', m.bmi
      ) order by m.updated_at, m.measurement_key))->-1 as latest,
      jsonb_agg(jsonb_build_object(
        'measuredAt', m.measured_at,
        'weightKg', m.weight_kg,
        'bodyFatPct', m.body_fat_pct,
        'skeletalMuscleKg', m.skeletal_muscle_kg,
        'bmi', m.bmi
      ) order by m.updated_at, m.measurement_key) as items
    from core.measurement m
    where m.archived_date = day.archived_date
  ) measurement on true
  left join lateral (
    select
      jsonb_agg(jsonb_build_object(
        'type', a.activity_type,
        'calories', a.calories,
        'heartRate', a.heart_rate,
        'distanceKm', a.distance_km,
        'durationSeconds', a.duration_seconds
      ) order by a.activity_time nulls last, a.activity_key) as items
    from core.activity a
    where a.archived_date = day.archived_date
  ) activity on true
  left join lateral (
    select jsonb_object_agg(counted.activity_type, counted.count_value) as value
    from (
      select a.activity_type, count(*)::int as count_value
      from core.activity a
      where a.archived_date = day.archived_date
      group by a.activity_type
    ) counted
  ) activity_counts on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'name', m.meal_name,
      'calories', m.calories,
      'recommendedMin', m.recommended_min,
      'recommendedMax', m.recommended_max
    ) order by m.meal_key) as items
    from core.meal m
    where m.archived_date = day.archived_date
  ) meal on true
  left join lateral (
    select (jsonb_agg(jsonb_build_object(
      'totalSleepMinutes', s.total_sleep_minutes,
      'nightSleepMinutes', s.night_sleep_minutes,
      'sleepStartTime', s.bedtime,
      'sleepEndTime', s.wake_time,
      'deepSleepMinutes', s.deep_sleep_minutes,
      'lightSleepMinutes', s.light_sleep_minutes,
      'remSleepMinutes', s.rem_sleep_minutes,
      'sleepScore', s.sleep_score,
      'deepSleepRatioPct', s.deep_sleep_ratio_pct,
      'lightSleepRatioPct', s.light_sleep_ratio_pct,
      'remSleepRatioPct', s.rem_sleep_ratio_pct,
      'averageHeartRateBpm', s.average_heart_rate_bpm,
      'hrvMs', s.hrv_ms,
      'averageSpo2Pct', s.average_spo2_pct,
      'averageRespiratoryRate', s.average_respiratory_rate
    ) order by s.updated_at, s.sleep_key))->-1 as latest
    from core.sleep s
    where s.archived_date = day.archived_date
  ) sleep on true
),
feedback as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', to_char(to_timestamp(t.message_date_unix) at time zone 'Asia/Shanghai', 'YYYY-MM-DD'),
    'time', to_char(to_timestamp(t.message_date_unix) at time zone 'Asia/Shanghai', 'HH24:MI'),
    'body', t.body,
    'sourceChannel', t.source_channel,
    'sourceMessageId', t.source_message_id
  ) order by t.message_date_unix, t.updated_at), '[]'::jsonb) as value
  from core.thought t, params
  where t.thought_module = 'body_feedback'
    and t.status = 'active'
    and to_timestamp(t.message_date_unix)::date between params.date_from and params.as_of_date
)
select jsonb_build_object(
  'source', 'database',
  'generatedAt', to_char((select as_of from params), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'traineeProfile', (select value from active_profile),
  'latest', jsonb_build_object(
    'measurement', (select value->'measurement' from day_rows order by archived_date desc limit 1),
    'daily', (select value from day_rows order by archived_date desc limit 1)
  ),
  'daily', coalesce((select jsonb_agg(value order by archived_date) from day_rows), '[]'::jsonb),
  'bodyFeedback', (select value from feedback)
) as context_json
`;
