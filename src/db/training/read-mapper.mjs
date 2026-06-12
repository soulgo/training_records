import {
  buildTrainingSnapshotFromDaily,
  normalizeActivityType,
  toNullableNumber,
} from '../../domain/training/training-domain.mjs';

export function buildTrainingSnapshotFromRows({
  dayRows,
  measurementRows,
  activityRows,
  mealRows,
  sleepRows = [],
  bodyFeedbackRows = [],
  now,
  dateFrom,
  dateTo,
}) {
  const filteredDayRows = filterRowsByDateWindow(dayRows, 'archived_date', dateFrom, dateTo);
  const filteredMeasurementRows = filterRowsByDateWindow(measurementRows, 'archived_date', dateFrom, dateTo);
  const filteredActivityRows = filterRowsByDateWindow(activityRows, 'archived_date', dateFrom, dateTo);
  const filteredMealRows = filterRowsByDateWindow(mealRows, 'archived_date', dateFrom, dateTo);
  const filteredSleepRows = filterRowsByDateWindow(sleepRows, 'archived_date', dateFrom, dateTo);
  const filteredBodyFeedbackRows = filterFeedbackRowsByDateWindow(bodyFeedbackRows, dateFrom, dateTo);
  const measurementsByDate = groupByDate(filteredMeasurementRows, 'archived_date');
  const activitiesByDate = groupByDate(filteredActivityRows, 'archived_date');
  const mealsByDate = groupByDate(filteredMealRows, 'archived_date');
  const sleepByDate = groupByDate(filteredSleepRows, 'archived_date');
  const sleepSummaryByDate = new Map(
    filteredDayRows.map((row) => [
      normalizeDateKey(row.archived_date),
      {
        totalSleepMinutes: toNullableNumber(row.sleep_total_minutes),
        nightSleepMinutes: toNullableNumber(row.night_sleep_minutes),
        napMinutes: toNullableNumber(row.nap_minutes),
        bedtime: row.sleep_start_time ?? null,
        wakeTime: row.sleep_end_time ?? null,
        deepSleepMinutes: toNullableNumber(row.deep_sleep_minutes),
        lightSleepMinutes: toNullableNumber(row.light_sleep_minutes),
        remSleepMinutes: toNullableNumber(row.rem_sleep_minutes),
        awakeMinutes: toNullableNumber(row.awake_minutes),
        sleepScore: toNullableNumber(row.sleep_score),
        deepSleepRatioPct: toNullableNumber(row.deep_sleep_ratio_pct),
        lightSleepRatioPct: toNullableNumber(row.light_sleep_ratio_pct),
        remSleepRatioPct: toNullableNumber(row.rem_sleep_ratio_pct),
      },
    ]),
  );

  const daily = filteredDayRows.map((row) => {
    const archivedDate = normalizeDateKey(row.archived_date);
    const measurements = (measurementsByDate.get(archivedDate) ?? []).map((measurement) => ({
      archivedDate,
      measuredAt: measurement.measured_at,
      bodyScore: toNullableNumber(measurement.body_score),
      weightKg: toNullableNumber(measurement.weight_kg),
      bmi: toNullableNumber(measurement.bmi),
      bodyFatPct: toNullableNumber(measurement.body_fat_pct),
      skeletalMuscleKg: toNullableNumber(measurement.skeletal_muscle_kg),
      visceralFatLevel: toNullableNumber(measurement.visceral_fat_level),
      basalMetabolismKcal: toNullableNumber(measurement.basal_metabolism_kcal),
      bodyWaterPct: toNullableNumber(measurement.body_water_pct),
      proteinPct: toNullableNumber(measurement.protein_pct),
      boneMassKg: toNullableNumber(measurement.bone_mass_kg),
      fatFreeMassKg: toNullableNumber(measurement.fat_free_mass_kg),
      bodyAge: toNullableNumber(measurement.body_age),
      bodyType: measurement.body_type ?? null,
    }));
    const activities = (activitiesByDate.get(archivedDate) ?? []).map((activity) => ({
      time: activity.activity_time,
      type: normalizeActivityType(activity.activity_type),
      rawType: activity.raw_type ?? activity.activity_type,
      detail: activity.detail,
      durationText: activity.duration_text,
      durationSeconds: toNullableNumber(activity.duration_seconds) ?? 0,
      calories: toNullableNumber(activity.calories),
      heartRate: toNullableNumber(activity.heart_rate),
      distanceKm: toNullableNumber(activity.distance_km),
      avgSpeedKmh: toNullableNumber(activity.avg_speed_kmh),
    }));
    const meals = (mealsByDate.get(archivedDate) ?? []).map((meal) => ({
      name: meal.meal_name,
      calories: toNullableNumber(meal.calories),
      recommendedMin: toNullableNumber(meal.recommended_min),
      recommendedMax: toNullableNumber(meal.recommended_max),
    }));
    const sleep = summarizeSleepRecords([
      ...(sleepByDate.get(archivedDate) ?? []).map(normalizeSleepRow),
      ...extractSleepRecords(row),
      sleepSummaryByDate.get(archivedDate) ?? null,
    ]);

    return {
      date: archivedDate,
      measurement: measurements.at(-1) ?? null,
      measurements,
      activities,
      sleep: sleep.records,
      sleepSummary: sleep,
      workoutSummary: {
        totalActivities: Number(row.total_activities ?? activities.length),
        totalDurationSeconds: Number(row.total_duration_seconds ?? 0),
        trainingCalories: toNullableNumber(row.training_calories) ?? 0,
        workoutDurationMinutes: toNullableNumber(row.workout_duration_minutes),
        activeHours: toNullableNumber(row.active_hours),
        cyclingDistanceKm: toNullableNumber(row.cycling_distance_km) ?? 0,
        countsByType: countActivitiesByType(activities),
      },
      nutrition: {
        meals,
        totalCalories: toNullableNumber(row.intake_calories),
        details: Array.isArray(row.nutrition_details_json) ? row.nutrition_details_json : [],
      },
    };
  });

  const thoughts = filteredBodyFeedbackRows.map(normalizeThoughtRow);
  return {
    ...buildTrainingSnapshotFromDaily(
      daily,
      now?.toISOString?.() ?? new Date().toISOString(),
    ),
    thoughts,
    bodyFeedback: thoughts.filter((entry) => entry.thoughtModule === 'body_feedback'),
  };
}

function filterRowsByDateWindow(rows, key, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) {
    return rows;
  }

  return rows.filter((row) => {
    const archivedDate = normalizeDateKey(row[key]);
    if (dateFrom && archivedDate < dateFrom) {
      return false;
    }
    if (dateTo && archivedDate > dateTo) {
      return false;
    }
    return true;
  });
}

function groupByDate(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = normalizeDateKey(row[key]);
    const items = map.get(value) ?? [];
    items.push(row);
    map.set(value, items);
  }
  return map;
}

function normalizeDateKey(value) {
  if (value instanceof Date) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }

  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : String(value ?? '');
}

function countActivitiesByType(activities) {
  const countsByType = {};
  for (const activity of activities ?? []) {
    countsByType[activity.type] = (countsByType[activity.type] ?? 0) + 1;
  }
  return countsByType;
}

function extractSleepRecords(row) {
  const sleep = {
    sleepType: '夜间睡眠',
    bedtime: row.sleep_start_time ?? null,
    wakeTime: row.sleep_end_time ?? null,
    nightSleepMinutes: toNullableNumber(row.night_sleep_minutes),
    totalSleepMinutes: toNullableNumber(row.sleep_total_minutes),
    napMinutes: toNullableNumber(row.nap_minutes),
    deepSleepMinutes: toNullableNumber(row.deep_sleep_minutes),
    lightSleepMinutes: toNullableNumber(row.light_sleep_minutes),
    remSleepMinutes: toNullableNumber(row.rem_sleep_minutes),
    awakeMinutes: toNullableNumber(row.awake_minutes),
    sleepStageText: null,
    sleepStageDetail: null,
    sleepScore: toNullableNumber(row.sleep_score),
    deepSleepRatioPct: toNullableNumber(row.deep_sleep_ratio_pct),
    lightSleepRatioPct: toNullableNumber(row.light_sleep_ratio_pct),
    remSleepRatioPct: toNullableNumber(row.rem_sleep_ratio_pct),
  };
  return hasAnySleepValue(sleep) ? [sleep] : [];
}

function normalizeSleepRow(row) {
  return {
    sleepType: row.sleep_type ?? '夜间睡眠',
    bedtime: row.bedtime ?? null,
    wakeTime: row.wake_time ?? null,
    nightSleepMinutes: toNullableNumber(row.night_sleep_minutes),
    totalSleepMinutes: toNullableNumber(row.total_sleep_minutes),
    napMinutes: toNullableNumber(row.nap_minutes),
    deepSleepMinutes: toNullableNumber(row.deep_sleep_minutes),
    lightSleepMinutes: toNullableNumber(row.light_sleep_minutes),
    remSleepMinutes: toNullableNumber(row.rem_sleep_minutes),
    awakeMinutes: toNullableNumber(row.awake_minutes),
    sleepStageText: row.sleep_stage_text ?? null,
    sleepStageDetail: row.sleep_stage_detail ?? null,
    sleepScore: toNullableNumber(row.sleep_score),
    sleepScorePercentile: toNullableNumber(row.sleep_score_percentile),
    deepSleepRatioPct: toNullableNumber(row.deep_sleep_ratio_pct),
    lightSleepRatioPct: toNullableNumber(row.light_sleep_ratio_pct),
    remSleepRatioPct: toNullableNumber(row.rem_sleep_ratio_pct),
    deepSleepContinuityScore: toNullableNumber(row.deep_sleep_continuity_score),
    wakeCount: toNullableNumber(row.wake_count),
    breathingQualityScore: toNullableNumber(row.breathing_quality_score),
    averageHeartRateBpm: toNullableNumber(row.average_heart_rate_bpm),
    hrvMs: toNullableNumber(row.hrv_ms),
    averageSpo2Pct: toNullableNumber(row.average_spo2_pct),
    averageRespiratoryRate: toNullableNumber(row.average_respiratory_rate),
    analysisText: row.analysis_text ?? null,
    suggestionText: row.suggestion_text ?? null,
  };
}

function summarizeSleepRecords(records) {
  const filtered = (records ?? []).filter(hasAnySleepValue);
  if (filtered.length === 0) {
    return {
      records: [],
      totalSleepMinutes: null,
      nightSleepMinutes: null,
      napMinutes: null,
      sleepStartTime: null,
      sleepEndTime: null,
      deepSleepMinutes: null,
      lightSleepMinutes: null,
      remSleepMinutes: null,
      awakeMinutes: null,
      sleepScore: null,
      sleepScorePercentile: null,
      deepSleepRatioPct: null,
      lightSleepRatioPct: null,
      remSleepRatioPct: null,
      deepSleepContinuityScore: null,
      wakeCount: null,
      breathingQualityScore: null,
      averageHeartRateBpm: null,
      hrvMs: null,
      averageSpo2Pct: null,
      averageRespiratoryRate: null,
      analysisText: null,
      suggestionText: null,
    };
  }

  const latest = filtered.at(-1);
  return {
    records: filtered,
    totalSleepMinutes: latest.totalSleepMinutes ?? null,
    nightSleepMinutes: latest.nightSleepMinutes ?? null,
    napMinutes: latest.napMinutes ?? null,
    sleepStartTime: latest.bedtime ?? null,
    sleepEndTime: latest.wakeTime ?? null,
    deepSleepMinutes: latest.deepSleepMinutes ?? null,
    lightSleepMinutes: latest.lightSleepMinutes ?? null,
    remSleepMinutes: latest.remSleepMinutes ?? null,
    awakeMinutes: latest.awakeMinutes ?? null,
    sleepScore: latest.sleepScore ?? null,
    sleepScorePercentile: latest.sleepScorePercentile ?? null,
    deepSleepRatioPct: latest.deepSleepRatioPct ?? null,
    lightSleepRatioPct: latest.lightSleepRatioPct ?? null,
    remSleepRatioPct: latest.remSleepRatioPct ?? null,
    deepSleepContinuityScore: latest.deepSleepContinuityScore ?? null,
    wakeCount: latest.wakeCount ?? null,
    breathingQualityScore: latest.breathingQualityScore ?? null,
    averageHeartRateBpm: latest.averageHeartRateBpm ?? null,
    hrvMs: latest.hrvMs ?? null,
    averageSpo2Pct: latest.averageSpo2Pct ?? null,
    averageRespiratoryRate: latest.averageRespiratoryRate ?? null,
    analysisText: latest.analysisText ?? null,
    suggestionText: latest.suggestionText ?? null,
  };
}

function hasAnySleepValue(sleep) {
  return [
    sleep?.totalSleepMinutes,
    sleep?.nightSleepMinutes,
    sleep?.napMinutes,
    sleep?.bedtime,
    sleep?.wakeTime,
    sleep?.deepSleepMinutes,
    sleep?.lightSleepMinutes,
    sleep?.remSleepMinutes,
    sleep?.awakeMinutes,
    sleep?.sleepStageText,
    sleep?.sleepStageDetail,
    sleep?.sleepScore,
    sleep?.sleepScorePercentile,
    sleep?.deepSleepRatioPct,
    sleep?.lightSleepRatioPct,
    sleep?.remSleepRatioPct,
    sleep?.deepSleepContinuityScore,
    sleep?.wakeCount,
    sleep?.breathingQualityScore,
    sleep?.averageHeartRateBpm,
    sleep?.hrvMs,
    sleep?.averageSpo2Pct,
    sleep?.averageRespiratoryRate,
    sleep?.analysisText,
    sleep?.suggestionText,
  ].some((value) => value !== null && value !== undefined && value !== '');
}

function filterFeedbackRowsByDateWindow(rows, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) {
    return rows;
  }

  return rows.filter((row) => {
    const archivedDate = normalizeBodyFeedbackRow(row).date;
    if (dateFrom && archivedDate < dateFrom) {
      return false;
    }
    if (dateTo && archivedDate > dateTo) {
      return false;
    }
    return true;
  });
}

function normalizeBodyFeedbackRow(row) {
  return normalizeThoughtRow(row);
}

function normalizeThoughtRow(row) {
  const dateParts = normalizeBodyFeedbackDateParts(row.message_date_unix, row.updated_at);
  return {
    date: dateParts.date,
    time: dateParts.time,
    body: String(row.body ?? '').trim(),
    command: row.command ?? '/thought',
    thoughtModule: row.thought_module ?? 'workout',
    tags: Array.isArray(row.tags_json) ? row.tags_json : [],
    telegramMessageId: toNullableNumber(row.telegram_message_id),
    telegramChatId: toNullableNumber(row.telegram_chat_id),
    markdownPath: row.markdown_path ?? null,
    imageRefs: Array.isArray(row.image_refs_json) ? row.image_refs_json : [],
    source: 'database',
  };
}

function normalizeBodyFeedbackDateParts(messageDateUnix, updatedAt) {
  const fromUnix = toNullableNumber(messageDateUnix);
  if (fromUnix !== null) {
    return formatDatePartsInShanghai(new Date(fromUnix * 1000));
  }

  const fallback = new Date(updatedAt ?? '');
  if (!Number.isNaN(fallback.getTime())) {
    return formatDatePartsInShanghai(fallback);
  }

  return {
    date: '',
    time: null,
  };
}

function formatDatePartsInShanghai(date) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
