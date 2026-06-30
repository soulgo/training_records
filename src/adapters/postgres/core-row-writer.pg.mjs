import { createHash } from 'node:crypto';

export async function insertCoreMeasurements(client, days, options, processedAtIso) {
  const rows = days
    .filter((day) => day.measurement)
    .map((day) => {
      const measurement = day.measurement;
      const sourceChannel = options.sourceChannel ?? 'telegram';
      return {
        measurementKey: createHash('md5')
          .update([sourceChannel, day.date, measurement.measuredAt ?? '', measurement.weightKg ?? ''].join('|'))
          .digest('hex'),
        archivedDate: day.date,
        sourceChannel,
        sourceBatchId: options.batchId ?? `${options.batchIdPrefix ?? 'core-day'}-${day.date}`,
        measuredAt: measurement.measuredAt ?? null,
        bodyScore: measurement.bodyScore != null ? Math.round(Number(measurement.bodyScore)) : null,
        weightKg: measurement.weightKg ?? null,
        bmi: measurement.bmi ?? null,
        bodyFatPct: measurement.bodyFatPct ?? null,
        skeletalMuscleKg: measurement.skeletalMuscleKg ?? null,
        visceralFatLevel: measurement.visceralFatLevel ?? null,
        basalMetabolismKcal: measurement.basalMetabolismKcal != null ? Math.round(Number(measurement.basalMetabolismKcal)) : null,
        bodyWaterPct: measurement.bodyWaterPct ?? null,
        proteinPct: measurement.proteinPct ?? null,
        boneMassKg: measurement.boneMassKg ?? null,
        fatFreeMassKg: measurement.fatFreeMassKg ?? null,
        bodyAge: measurement.bodyAge != null ? Math.round(Number(measurement.bodyAge)) : null,
        bodyType: measurement.bodyType ?? null,
        updatedAt: processedAtIso,
      };
    });
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `
      insert into core.measurement (
        measurement_key,
        archived_date,
        source_channel,
        source_batch_id,
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
        body_type,
        updated_at
      )
      select *
      from unnest(
        $1::text[],
        $2::date[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::integer[],
        $7::numeric[],
        $8::numeric[],
        $9::numeric[],
        $10::numeric[],
        $11::numeric[],
        $12::integer[],
        $13::numeric[],
        $14::numeric[],
        $15::numeric[],
        $16::numeric[],
        $17::integer[],
        $18::text[],
        $19::timestamptz[]
      )
      on conflict (measurement_key) do update set
        source_channel = excluded.source_channel,
        source_batch_id = excluded.source_batch_id,
        measured_at = excluded.measured_at,
        body_score = excluded.body_score,
        weight_kg = excluded.weight_kg,
        bmi = excluded.bmi,
        body_fat_pct = excluded.body_fat_pct,
        skeletal_muscle_kg = excluded.skeletal_muscle_kg,
        visceral_fat_level = excluded.visceral_fat_level,
        basal_metabolism_kcal = excluded.basal_metabolism_kcal,
        body_water_pct = excluded.body_water_pct,
        protein_pct = excluded.protein_pct,
        bone_mass_kg = excluded.bone_mass_kg,
        fat_free_mass_kg = excluded.fat_free_mass_kg,
        body_age = excluded.body_age,
        body_type = excluded.body_type,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.measurementKey),
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceChannel),
      rows.map((row) => row.sourceBatchId),
      rows.map((row) => row.measuredAt),
      rows.map((row) => row.bodyScore),
      rows.map((row) => row.weightKg),
      rows.map((row) => row.bmi),
      rows.map((row) => row.bodyFatPct),
      rows.map((row) => row.skeletalMuscleKg),
      rows.map((row) => row.visceralFatLevel),
      rows.map((row) => row.basalMetabolismKcal),
      rows.map((row) => row.bodyWaterPct),
      rows.map((row) => row.proteinPct),
      rows.map((row) => row.boneMassKg),
      rows.map((row) => row.fatFreeMassKg),
      rows.map((row) => row.bodyAge),
      rows.map((row) => row.bodyType),
      rows.map((row) => row.updatedAt),
    ],
  );
}

export async function insertCoreActivities(client, days, options, processedAtIso) {
  const rows = days.flatMap((day) =>
    (day.activities ?? []).map((activity) => {
      const sourceChannel = options.sourceChannel ?? 'telegram';
      return {
        activityKey: createHash('md5')
          .update([sourceChannel, day.date, activity.time ?? '', activity.type ?? '', activity.detail ?? ''].join('|'))
          .digest('hex'),
        archivedDate: day.date,
        sourceChannel,
        sourceBatchId: options.batchId ?? `${options.batchIdPrefix ?? 'core-day'}-${day.date}`,
        activityTime: activity.time ?? null,
        activityType: activity.type ?? '未知活动',
        rawType: activity.rawType ?? activity.type ?? null,
        detail: activity.detail ?? null,
        calories: activity.calories != null ? Math.round(Number(activity.calories)) : null,
        heartRate: activity.heartRate != null ? Math.round(Number(activity.heartRate)) : null,
        distanceKm: activity.distanceKm ?? null,
        avgSpeedKmh: activity.avgSpeedKmh ?? null,
        durationText: activity.durationText ?? null,
        durationSeconds: activity.durationSeconds != null ? Math.round(Number(activity.durationSeconds)) : null,
        updatedAt: processedAtIso,
      };
    }),
  );
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `
      insert into core.activity (
        activity_key,
        archived_date,
        source_channel,
        source_batch_id,
        activity_time,
        activity_type,
        raw_type,
        detail,
        calories,
        heart_rate,
        distance_km,
        avg_speed_kmh,
        duration_text,
        duration_seconds,
        updated_at
      )
      select *
      from unnest(
        $1::text[],
        $2::date[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::text[],
        $7::text[],
        $8::text[],
        $9::integer[],
        $10::integer[],
        $11::numeric[],
        $12::numeric[],
        $13::text[],
        $14::integer[],
        $15::timestamptz[]
      )
      on conflict (activity_key) do update set
        source_channel = excluded.source_channel,
        source_batch_id = excluded.source_batch_id,
        activity_time = excluded.activity_time,
        activity_type = excluded.activity_type,
        raw_type = excluded.raw_type,
        detail = excluded.detail,
        calories = excluded.calories,
        heart_rate = excluded.heart_rate,
        distance_km = excluded.distance_km,
        avg_speed_kmh = excluded.avg_speed_kmh,
        duration_text = excluded.duration_text,
        duration_seconds = excluded.duration_seconds,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.activityKey),
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceChannel),
      rows.map((row) => row.sourceBatchId),
      rows.map((row) => row.activityTime),
      rows.map((row) => row.activityType),
      rows.map((row) => row.rawType),
      rows.map((row) => row.detail),
      rows.map((row) => row.calories),
      rows.map((row) => row.heartRate),
      rows.map((row) => row.distanceKm),
      rows.map((row) => row.avgSpeedKmh),
      rows.map((row) => row.durationText),
      rows.map((row) => row.durationSeconds),
      rows.map((row) => row.updatedAt),
    ],
  );
}

export async function insertCoreMeals(client, days, options, processedAtIso) {
  const rows = days.flatMap((day) =>
    (day.nutrition?.meals ?? []).map((meal) => {
      const sourceChannel = options.sourceChannel ?? 'telegram';
      return {
        mealKey: createHash('md5')
          .update([sourceChannel, day.date, meal.name ?? '', meal.calories ?? ''].join('|'))
          .digest('hex'),
        archivedDate: day.date,
        sourceChannel,
        sourceBatchId: options.batchId ?? `${options.batchIdPrefix ?? 'core-day'}-${day.date}`,
        mealName: meal.name ?? '未命名餐次',
        calories: meal.calories != null ? Math.round(Number(meal.calories)) : null,
        recommendedMin: meal.recommendedMin != null ? Math.round(Number(meal.recommendedMin)) : null,
        recommendedMax: meal.recommendedMax != null ? Math.round(Number(meal.recommendedMax)) : null,
        updatedAt: processedAtIso,
      };
    }),
  );
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `
      insert into core.meal (
        meal_key,
        archived_date,
        source_channel,
        source_batch_id,
        meal_name,
        calories,
        recommended_min,
        recommended_max,
        updated_at
      )
      select *
      from unnest(
        $1::text[],
        $2::date[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::integer[],
        $7::integer[],
        $8::integer[],
        $9::timestamptz[]
      )
      on conflict (meal_key) do update set
        source_channel = excluded.source_channel,
        source_batch_id = excluded.source_batch_id,
        meal_name = excluded.meal_name,
        calories = excluded.calories,
        recommended_min = excluded.recommended_min,
        recommended_max = excluded.recommended_max,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.mealKey),
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceChannel),
      rows.map((row) => row.sourceBatchId),
      rows.map((row) => row.mealName),
      rows.map((row) => row.calories),
      rows.map((row) => row.recommendedMin),
      rows.map((row) => row.recommendedMax),
      rows.map((row) => row.updatedAt),
    ],
  );
}

export async function insertCoreSleep(client, days, options, processedAtIso) {
  const rows = buildSleepRows(days, options, processedAtIso);
  if (rows.length === 0) {
    return;
  }

  await deleteCoreSleepRowsByIdentity(client, rows);

  await client.query(
    `
      insert into core.sleep (
        sleep_key,
        archived_date,
        source_channel,
        source_batch_id,
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
        updated_at
      )
      select *
      from unnest(
        $1::text[],
        $2::date[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::text[],
        $7::text[],
        $8::integer[],
        $9::integer[],
        $10::integer[],
        $11::integer[],
        $12::integer[],
        $13::integer[],
        $14::integer[],
        $15::text[],
        $16::text[],
        $17::integer[],
        $18::integer[],
        $19::numeric[],
        $20::numeric[],
        $21::numeric[],
        $22::integer[],
        $23::integer[],
        $24::integer[],
        $25::integer[],
        $26::integer[],
        $27::numeric[],
        $28::numeric[],
        $29::text[],
        $30::text[],
        $31::timestamptz[]
      )
      on conflict (sleep_key) do update set
        source_channel = excluded.source_channel,
        source_batch_id = excluded.source_batch_id,
        sleep_type = excluded.sleep_type,
        bedtime = excluded.bedtime,
        wake_time = excluded.wake_time,
        night_sleep_minutes = excluded.night_sleep_minutes,
        total_sleep_minutes = excluded.total_sleep_minutes,
        nap_minutes = excluded.nap_minutes,
        deep_sleep_minutes = excluded.deep_sleep_minutes,
        light_sleep_minutes = excluded.light_sleep_minutes,
        rem_sleep_minutes = excluded.rem_sleep_minutes,
        awake_minutes = excluded.awake_minutes,
        sleep_stage_text = excluded.sleep_stage_text,
        sleep_stage_detail = excluded.sleep_stage_detail,
        sleep_score = excluded.sleep_score,
        sleep_score_percentile = excluded.sleep_score_percentile,
        deep_sleep_ratio_pct = excluded.deep_sleep_ratio_pct,
        light_sleep_ratio_pct = excluded.light_sleep_ratio_pct,
        rem_sleep_ratio_pct = excluded.rem_sleep_ratio_pct,
        deep_sleep_continuity_score = excluded.deep_sleep_continuity_score,
        wake_count = excluded.wake_count,
        breathing_quality_score = excluded.breathing_quality_score,
        average_heart_rate_bpm = excluded.average_heart_rate_bpm,
        hrv_ms = excluded.hrv_ms,
        average_spo2_pct = excluded.average_spo2_pct,
        average_respiratory_rate = excluded.average_respiratory_rate,
        analysis_text = excluded.analysis_text,
        suggestion_text = excluded.suggestion_text,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.sleepKey),
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceChannel),
      rows.map((row) => row.sourceBatchId),
      rows.map((row) => row.sleepType),
      rows.map((row) => row.bedtime),
      rows.map((row) => row.wakeTime),
      rows.map((row) => row.nightSleepMinutes),
      rows.map((row) => row.totalSleepMinutes),
      rows.map((row) => row.napMinutes),
      rows.map((row) => row.deepSleepMinutes),
      rows.map((row) => row.lightSleepMinutes),
      rows.map((row) => row.remSleepMinutes),
      rows.map((row) => row.awakeMinutes),
      rows.map((row) => row.sleepStageText),
      rows.map((row) => row.sleepStageDetail),
      rows.map((row) => row.sleepScore),
      rows.map((row) => row.sleepScorePercentile),
      rows.map((row) => row.deepSleepRatioPct),
      rows.map((row) => row.lightSleepRatioPct),
      rows.map((row) => row.remSleepRatioPct),
      rows.map((row) => row.deepSleepContinuityScore),
      rows.map((row) => row.wakeCount),
      rows.map((row) => row.breathingQualityScore),
      rows.map((row) => row.averageHeartRateBpm),
      rows.map((row) => row.hrvMs),
      rows.map((row) => row.averageSpo2Pct),
      rows.map((row) => row.averageRespiratoryRate),
      rows.map((row) => row.analysisText),
      rows.map((row) => row.suggestionText),
      rows.map((row) => row.updatedAt),
    ],
  );
}

async function deleteCoreSleepRowsByIdentity(client, rows) {
  await client.query(
    `
      delete from core.sleep existing
      using (
        select *
        from unnest(
          $1::date[],
          $2::text[],
          $3::text[],
          $4::text[]
        ) as incoming(archived_date, sleep_type, bedtime, wake_time)
      ) incoming
      where existing.archived_date = incoming.archived_date
        and coalesce(existing.sleep_type, '夜间睡眠') = coalesce(incoming.sleep_type, '夜间睡眠')
        and coalesce(existing.bedtime, '') = coalesce(incoming.bedtime, '')
        and coalesce(existing.wake_time, '') = coalesce(incoming.wake_time, '')
    `,
    [
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sleepType),
      rows.map((row) => row.bedtime),
      rows.map((row) => row.wakeTime),
    ],
  );
}

export async function insertArchiveSleep(client, days, options, processedAtIso) {
  const rows = buildSleepRows(days, options, processedAtIso).map((row) => ({
    ...row,
    sourceHash: options.sourceHash ?? null,
    sleepHash: createHash('md5')
      .update([row.archivedDate, row.sleepType, row.bedtime ?? '', row.wakeTime ?? '', row.totalSleepMinutes ?? ''].join('|'))
      .digest('hex'),
  }));
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `
      insert into archive.training_sleep (
        sleep_hash,
        archived_date,
        source_hash,
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
        updated_at
      )
      select *
      from unnest(
        $1::text[],
        $2::date[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::text[],
        $7::integer[],
        $8::integer[],
        $9::integer[],
        $10::integer[],
        $11::integer[],
        $12::integer[],
        $13::integer[],
        $14::text[],
        $15::text[],
        $16::integer[],
        $17::integer[],
        $18::numeric[],
        $19::numeric[],
        $20::numeric[],
        $21::integer[],
        $22::integer[],
        $23::integer[],
        $24::integer[],
        $25::integer[],
        $26::numeric[],
        $27::numeric[],
        $28::text[],
        $29::text[],
        $30::timestamptz[]
      )
      on conflict (sleep_hash) do update set
        archived_date = excluded.archived_date,
        source_hash = excluded.source_hash,
        sleep_type = excluded.sleep_type,
        bedtime = excluded.bedtime,
        wake_time = excluded.wake_time,
        night_sleep_minutes = excluded.night_sleep_minutes,
        total_sleep_minutes = excluded.total_sleep_minutes,
        nap_minutes = excluded.nap_minutes,
        deep_sleep_minutes = excluded.deep_sleep_minutes,
        light_sleep_minutes = excluded.light_sleep_minutes,
        rem_sleep_minutes = excluded.rem_sleep_minutes,
        awake_minutes = excluded.awake_minutes,
        sleep_stage_text = excluded.sleep_stage_text,
        sleep_stage_detail = excluded.sleep_stage_detail,
        sleep_score = excluded.sleep_score,
        sleep_score_percentile = excluded.sleep_score_percentile,
        deep_sleep_ratio_pct = excluded.deep_sleep_ratio_pct,
        light_sleep_ratio_pct = excluded.light_sleep_ratio_pct,
        rem_sleep_ratio_pct = excluded.rem_sleep_ratio_pct,
        deep_sleep_continuity_score = excluded.deep_sleep_continuity_score,
        wake_count = excluded.wake_count,
        breathing_quality_score = excluded.breathing_quality_score,
        average_heart_rate_bpm = excluded.average_heart_rate_bpm,
        hrv_ms = excluded.hrv_ms,
        average_spo2_pct = excluded.average_spo2_pct,
        average_respiratory_rate = excluded.average_respiratory_rate,
        analysis_text = excluded.analysis_text,
        suggestion_text = excluded.suggestion_text,
        updated_at = excluded.updated_at
    `,
    [
      rows.map((row) => row.sleepHash),
      rows.map((row) => row.archivedDate),
      rows.map((row) => row.sourceHash),
      rows.map((row) => row.sleepType),
      rows.map((row) => row.bedtime),
      rows.map((row) => row.wakeTime),
      rows.map((row) => row.nightSleepMinutes),
      rows.map((row) => row.totalSleepMinutes),
      rows.map((row) => row.napMinutes),
      rows.map((row) => row.deepSleepMinutes),
      rows.map((row) => row.lightSleepMinutes),
      rows.map((row) => row.remSleepMinutes),
      rows.map((row) => row.awakeMinutes),
      rows.map((row) => row.sleepStageText),
      rows.map((row) => row.sleepStageDetail),
      rows.map((row) => row.sleepScore),
      rows.map((row) => row.sleepScorePercentile),
      rows.map((row) => row.deepSleepRatioPct),
      rows.map((row) => row.lightSleepRatioPct),
      rows.map((row) => row.remSleepRatioPct),
      rows.map((row) => row.deepSleepContinuityScore),
      rows.map((row) => row.wakeCount),
      rows.map((row) => row.breathingQualityScore),
      rows.map((row) => row.averageHeartRateBpm),
      rows.map((row) => row.hrvMs),
      rows.map((row) => row.averageSpo2Pct),
      rows.map((row) => row.averageRespiratoryRate),
      rows.map((row) => row.analysisText),
      rows.map((row) => row.suggestionText),
      rows.map((row) => row.updatedAt),
    ],
  );
}

function toInt(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
}

function buildSleepRows(days, options, processedAtIso) {
  return days.flatMap((day) =>
    (day.sleep ?? []).map((sleep) => {
      const bedtime = sleep.bedtime ?? sleep.sleepStartTime ?? null;
      const wakeTime = sleep.wakeTime ?? sleep.sleepEndTime ?? null;
      const sleepType = sleep.sleepType ?? '夜间睡眠';
      const sourceChannel = options.sourceChannel ?? 'telegram';
      return {
        sleepKey: createHash('md5')
          .update([day.date, sleepType, bedtime ?? '', wakeTime ?? ''].join('|'))
          .digest('hex'),
        archivedDate: day.date,
        sourceChannel,
        sourceBatchId: options.batchId ?? `${options.batchIdPrefix ?? 'core-day'}-${day.date}`,
        sleepType,
        bedtime,
        wakeTime,
        nightSleepMinutes: toInt(sleep.nightSleepMinutes),
        totalSleepMinutes: toInt(sleep.totalSleepMinutes),
        napMinutes: toInt(sleep.napMinutes),
        deepSleepMinutes: toInt(sleep.deepSleepMinutes),
        lightSleepMinutes: toInt(sleep.lightSleepMinutes),
        remSleepMinutes: toInt(sleep.remSleepMinutes),
        awakeMinutes: toInt(sleep.awakeMinutes),
        sleepStageText: sleep.sleepStageText ?? null,
        sleepStageDetail: Array.isArray(sleep.sleepStageDetail)
          ? JSON.stringify(sleep.sleepStageDetail)
          : sleep.sleepStageDetail ?? null,
        sleepScore: toInt(sleep.sleepScore),
        sleepScorePercentile: toInt(sleep.sleepScorePercentile),
        deepSleepRatioPct: sleep.deepSleepRatioPct ?? null,
        lightSleepRatioPct: sleep.lightSleepRatioPct ?? null,
        remSleepRatioPct: sleep.remSleepRatioPct ?? null,
        deepSleepContinuityScore: toInt(sleep.deepSleepContinuityScore),
        wakeCount: toInt(sleep.wakeCount),
        breathingQualityScore: toInt(sleep.breathingQualityScore),
        averageHeartRateBpm: toInt(sleep.averageHeartRateBpm),
        hrvMs: toInt(sleep.hrvMs),
        averageSpo2Pct: sleep.averageSpo2Pct ?? null,
        averageRespiratoryRate: sleep.averageRespiratoryRate ?? null,
        analysisText: sleep.analysisText ?? null,
        suggestionText: sleep.suggestionText ?? null,
        updatedAt: processedAtIso,
      };
    }),
  );
}
