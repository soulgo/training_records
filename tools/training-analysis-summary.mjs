import { roundTo } from './training-domain.mjs';

export function buildTrainingAnalysisSummary(snapshot, now = new Date()) {
  const daily = [...(snapshot?.daily ?? [])].filter((day) => day?.date).sort((left, right) =>
    String(left.date).localeCompare(String(right.date)),
  );
  const latestDay = daily.at(-1) ?? null;
  const latestMeasurement = snapshot?.latest?.measurement ?? latestDay?.measurement ?? null;
  const recent7 = daily.slice(-7);
  const recent30 = daily.slice(-30);
  const measurements = daily
    .flatMap((day) => day.measurements ?? (day.measurement ? [day.measurement] : []))
    .filter(Boolean);
  const source = normalizeSnapshotSource(snapshot?.source);
  const coverage = buildCoverageSummary(daily, recent7, recent30);
  const recent7Load = summarizeWindow(recent7);
  const recent30Load = summarizeWindow(recent30);
  const recent7Recovery = summarizeRecoverySignal(recent7);
  const latestRecovery = summarizeRecoverySignal(daily.slice(-5));
  const bodyCompositionRisk = assessBodyCompositionRisk(measurements, recent7);
  const nutritionSignal = assessNutritionSignal(recent7, latestDay);
  const bodyFeedback = summarizeBodyFeedback(snapshot?.bodyFeedback ?? [], recent7, daily.slice(-5));

  return {
    generatedAt: toIsoString(now),
    dataSource: source,
    totalDays: daily.length,
    coverage,
    latestDate: latestDay?.date ?? null,
    latestMeasurement: normalizeMeasurement(latestMeasurement),
    recent7: recent7Load,
    recent30: recent30Load,
    measurementTrend7: summarizeMeasurementTrend(measurements.slice(-7)),
    measurementTrend30: summarizeMeasurementTrend(measurements.slice(-30)),
    trainingLoad: buildTrainingLoadSummary(recent7, recent30),
    strengthCardioBalance: buildStrengthCardioBalanceSummary(recent7, recent30),
    bodyCompositionRisk,
    nutritionSignal,
    bodyFeedback,
    recoverySignal: {
      recent7: recent7Recovery,
      latest5: latestRecovery,
      shouldRecover: recent7Recovery.shouldRecover || latestRecovery.shouldRecover,
    },
    latestDays: daily.slice(-5).map((day) => ({
      date: day.date,
      weightKg: day.measurement?.weightKg ?? null,
      bodyFatPct: day.measurement?.bodyFatPct ?? null,
      skeletalMuscleKg: day.measurement?.skeletalMuscleKg ?? null,
      trainingCalories: toNumberOrNull(day.workoutSummary?.trainingCalories),
      workoutDurationMinutes: resolveWorkoutDurationMinutes(day),
      activityTypes: Object.entries(day.workoutSummary?.countsByType ?? {})
        .filter(([, count]) => Number(count) > 0)
        .map(([type, count]) => `${type}x${count}`),
      intakeCalories: toNumberOrNull(day.nutrition?.totalCalories),
      sleepSummary: summarizeSleepForAnalysis(day.sleepSummary),
      workoutDetails: summarizeLatestActivityDetails(day.activities ?? []),
      bodyFeedback: bodyFeedback.byDate[day.date] ?? [],
      hasStrengthTraining: hasStrengthTraining(day),
      hasCardio: hasCardioTraining(day),
      hasHighIntensity: hasHighIntensityTraining(day),
      nutritionComplete: hasNutritionRecord(day),
    })),
  };
}

function summarizeSleepForAnalysis(sleep) {
  if (!sleep || sleep.totalSleepMinutes === null || sleep.totalSleepMinutes === undefined) {
    return null;
  }
  return {
    totalSleepMinutes: toNumberOrNull(sleep.totalSleepMinutes),
    nightSleepMinutes: toNumberOrNull(sleep.nightSleepMinutes),
    sleepStartTime: sleep.sleepStartTime ?? null,
    sleepEndTime: sleep.sleepEndTime ?? null,
    deepSleepMinutes: toNumberOrNull(sleep.deepSleepMinutes),
    lightSleepMinutes: toNumberOrNull(sleep.lightSleepMinutes),
    remSleepMinutes: toNumberOrNull(sleep.remSleepMinutes),
    deepSleepRatioPct: toNumberOrNull(sleep.deepSleepRatioPct),
    lightSleepRatioPct: toNumberOrNull(sleep.lightSleepRatioPct),
    remSleepRatioPct: toNumberOrNull(sleep.remSleepRatioPct),
    sleepScore: toNumberOrNull(sleep.sleepScore),
    deepSleepContinuityScore: toNumberOrNull(sleep.deepSleepContinuityScore),
    wakeCount: toNumberOrNull(sleep.wakeCount),
    breathingQualityScore: toNumberOrNull(sleep.breathingQualityScore),
    averageHeartRateBpm: toNumberOrNull(sleep.averageHeartRateBpm),
    hrvMs: toNumberOrNull(sleep.hrvMs),
    averageSpo2Pct: toNumberOrNull(sleep.averageSpo2Pct),
    averageRespiratoryRate: toNumberOrNull(sleep.averageRespiratoryRate),
    analysisText: sleep.analysisText ?? null,
    suggestionText: sleep.suggestionText ?? null,
  };
}

function summarizeWindow(days) {
  const trainedDays = days.filter((day) => (day.workoutSummary?.trainingCalories ?? 0) > 0).length;
  const totalTrainingCalories = sum(days.map((day) => day.workoutSummary?.trainingCalories));
  const totalWorkoutMinutes = sum(days.map(resolveWorkoutDurationMinutes));
  const totalCyclingKm = sum(days.map((day) => day.workoutSummary?.cyclingDistanceKm));
  const intakeValues = days.map((day) => day.nutrition?.totalCalories).filter(isFiniteNumber);
  const activityCounts = {};

  for (const day of days) {
    for (const [type, count] of Object.entries(day.workoutSummary?.countsByType ?? {})) {
      activityCounts[type] = (activityCounts[type] ?? 0) + Number(count || 0);
    }
  }

  return {
    days: days.length,
    trainedDays,
    totalTrainingCalories: roundTo(totalTrainingCalories, 1),
    avgTrainingCaloriesPerDay: average(days.map((day) => day.workoutSummary?.trainingCalories)),
    totalWorkoutMinutes: roundTo(totalWorkoutMinutes, 1),
    avgWorkoutMinutesPerTrainedDay: trainedDays ? roundTo(totalWorkoutMinutes / trainedDays, 1) : null,
    totalCyclingKm: roundTo(totalCyclingKm, 2),
    avgIntakeCalories: intakeValues.length ? roundTo(sum(intakeValues) / intakeValues.length, 1) : null,
    activityCounts,
  };
}

function buildCoverageSummary(daily, recent7, recent30) {
  return {
    totalDays: daily.length,
    recent7: buildWindowCoverage(recent7),
    recent30: buildWindowCoverage(recent30),
    latest5: buildWindowCoverage(daily.slice(-5)),
  };
}

function buildWindowCoverage(days) {
  return {
    days: days.length,
    workoutDays: days.filter((day) => hasWorkoutRecord(day)).length,
    measurementDays: days.filter((day) => Boolean(day.measurement)).length,
    nutritionDays: days.filter((day) => hasNutritionRecord(day)).length,
  };
}

function buildTrainingLoadSummary(recent7, recent30) {
  return {
    recent7: buildLoadMetrics(recent7),
    recent30: buildLoadMetrics(recent30),
  };
}

function buildLoadMetrics(days) {
  const activeDays = days.filter((day) => hasWorkoutRecord(day));
  const restStreakDays = getCurrentRestStreak(days);
  const workoutStreakDays = getCurrentWorkoutStreak(days);

  return {
    days: days.length,
    trainedDays: activeDays.length,
    totalWorkoutMinutes: roundTo(sum(days.map(resolveWorkoutDurationMinutes)), 1),
    avgWorkoutMinutesPerTrainedDay: activeDays.length
      ? roundTo(sum(activeDays.map(resolveWorkoutDurationMinutes)) / activeDays.length, 1)
      : null,
    totalTrainingCalories: roundTo(sum(days.map((day) => day.workoutSummary?.trainingCalories)), 1),
    avgTrainingCaloriesPerDay: average(days.map((day) => day.workoutSummary?.trainingCalories)),
    totalCyclingKm: roundTo(sum(days.map((day) => day.workoutSummary?.cyclingDistanceKm)), 2),
    activeHours: roundTo(sum(days.map((day) => day.workoutSummary?.activeHours)), 1),
    workoutStreakDays,
    restStreakDays,
  };
}

function buildStrengthCardioBalanceSummary(recent7, recent30) {
  return {
    recent7: buildBalanceMetrics(recent7),
    recent30: buildBalanceMetrics(recent30),
  };
}

function buildBalanceMetrics(days) {
  let strengthSessions = 0;
  let cardioSessions = 0;
  let hiitSessions = 0;
  let strengthDays = 0;
  let cardioDays = 0;
  let hiitDays = 0;
  let cyclingDays = 0;
  const activityTypes = {};

  for (const day of days) {
    let hasStrength = false;
    let hasCardio = false;
    let hasHiit = false;
    const typeEntries = Object.entries(day.workoutSummary?.countsByType ?? {});
    for (const [type, count] of typeEntries) {
      const normalizedType = String(type);
      const numericCount = Number(count || 0);
      if (numericCount <= 0) {
        continue;
      }
      activityTypes[normalizedType] = (activityTypes[normalizedType] ?? 0) + numericCount;
      if (normalizedType.includes('力量')) {
        strengthSessions += numericCount;
        hasStrength = true;
      }
      if (normalizedType.includes('骑行') || normalizedType.includes('有氧') || normalizedType.includes('燃脂')) {
        cardioSessions += numericCount;
        hasCardio = true;
      }
      if (normalizedType.includes('HIIT') || normalizedType.includes('间歇')) {
        hiitSessions += numericCount;
        hasHiit = true;
      }
    }
    if ((day.workoutSummary?.cyclingDistanceKm ?? 0) > 0) {
      cyclingDays += 1;
      hasCardio = true;
      if (!typeEntries.some(([type]) => /骑行|有氧|燃脂|跑|走/u.test(String(type)))) {
        cardioSessions += 1;
      }
    }
    if (hasStrength) {
      strengthDays += 1;
    }
    if (hasCardio) {
      cardioDays += 1;
    }
    if (hasHiit) {
      hiitDays += 1;
    }
  }

  return {
    days: days.length,
    strengthSessions,
    cardioSessions,
    hiitSessions,
    strengthDays,
    cardioDays,
    hiitDays,
    cyclingDays,
    activityTypes,
  };
}

function assessBodyCompositionRisk(measurements, recent7) {
  const latest = measurements.at(-1) ?? null;
  const previous = measurements.at(-2) ?? null;
  const delta = summarizeMeasurementTrend(recent7.flatMap((day) => day.measurements ?? (day.measurement ? [day.measurement] : [])));
  const weightDeltaKg = delta.weightDeltaKg;
  const bodyFatDeltaPct = delta.bodyFatDeltaPct;
  const skeletalMuscleDeltaKg = delta.skeletalMuscleDeltaKg;

  if (!latest || !previous) {
    return {
      status: 'insufficient_data',
      weightDeltaKg: null,
      bodyFatDeltaPct: null,
      skeletalMuscleDeltaKg: null,
      note: '暂无足够数据',
    };
  }

  if (
    isFiniteNumber(weightDeltaKg) &&
    weightDeltaKg < 0 &&
    isFiniteNumber(skeletalMuscleDeltaKg) &&
    skeletalMuscleDeltaKg < 0
  ) {
    return {
      status: 'muscle_loss_risk',
      weightDeltaKg,
      bodyFatDeltaPct,
      skeletalMuscleDeltaKg,
      note: '体重下降伴随骨骼肌下降，优先保肌',
    };
  }

  if (
    isFiniteNumber(bodyFatDeltaPct) &&
    bodyFatDeltaPct < 0 &&
    (!isFiniteNumber(skeletalMuscleDeltaKg) || skeletalMuscleDeltaKg >= 0)
  ) {
    return {
      status: 'fat_loss_good',
      weightDeltaKg,
      bodyFatDeltaPct,
      skeletalMuscleDeltaKg,
      note: '体脂下降且骨骼肌未明显流失',
    };
  }

  return {
    status: 'stalled',
    weightDeltaKg,
    bodyFatDeltaPct,
    skeletalMuscleDeltaKg,
    note: '变化不明显，继续看训练与饮食一致性',
  };
}

function assessNutritionSignal(recent7, latestDay) {
  const intakeValues = recent7.map((day) => day.nutrition?.totalCalories).filter(isFiniteNumber);
  const avgIntakeCalories = intakeValues.length ? roundTo(sum(intakeValues) / intakeValues.length, 1) : null;
  const nutritionDays = recent7.filter((day) => hasNutritionRecord(day)).length;
  const trainingDays = recent7.filter((day) => hasWorkoutRecord(day)).length;
  const highLoad = recent7.filter((day) => isHighLoadDay(day)).length;

  const lowIntakeRisk =
    isFiniteNumber(avgIntakeCalories) &&
    isFiniteNumber(latestDay?.measurement?.weightKg) &&
    avgIntakeCalories < latestDay.measurement.weightKg * 28;

  return {
    avgIntakeCalories,
    nutritionDays,
    lowIntakeRisk,
    highLoadLowIntakeRisk: highLoad >= 3 && lowIntakeRisk,
    note: lowIntakeRisk ? '训练量不低但摄入偏低，注意恢复与保肌' : '摄入暂无明显低于训练需求的信号',
    trainingDays,
  };
}

function summarizeRecoverySignal(days) {
  const trainingDays = days.filter((day) => hasWorkoutRecord(day)).length;
  const workoutStreakDays = getCurrentWorkoutStreak(days);
  const restStreakDays = getCurrentRestStreak(days);
  const latestDay = days.at(-1) ?? null;
  const recentHighLoadDays = days.filter((day) => isHighLoadDay(day)).length;

  return {
    trainingDays,
    workoutStreakDays,
    restStreakDays,
    recentHighLoadDays,
    lastDayWasTraining: hasWorkoutRecord(latestDay),
    shouldRecover: recentHighLoadDays >= 3 || workoutStreakDays >= 4,
  };
}

function summarizeLatestActivityDetails(activities) {
  return activities
    .slice(0, 3)
    .map((activity) => {
      const time = normalizeActivityTimeForAnalysis(activity.time ?? activity.activityTime ?? '');
      return [time, activity.type, activity.detail].filter(Boolean).join(' ');
    })
    .filter(Boolean);
}

function summarizeBodyFeedback(entries, recent7Days, latest5Days) {
  const normalizedEntries = (entries ?? [])
    .map(normalizeBodyFeedbackEntry)
    .filter((entry) => entry.date && entry.body)
    .sort((left, right) => compareBodyFeedbackEntries(left, right));
  const recent7Dates = new Set(recent7Days.map((day) => day.date));
  const latest5Dates = new Set(latest5Days.map((day) => day.date));
  const recent7 = normalizedEntries.filter((entry) => recent7Dates.has(entry.date));
  const latest = [...normalizedEntries]
    .sort((left, right) => compareBodyFeedbackEntries(right, left))
    .slice(0, 5);
  const byDate = {};

  for (const entry of normalizedEntries.filter((item) => latest5Dates.has(item.date))) {
    const dayEntries = byDate[entry.date] ?? [];
    dayEntries.push(entry);
    byDate[entry.date] = dayEntries.slice(-3);
  }

  return {
    total: normalizedEntries.length,
    recent7,
    latest,
    byDate,
    hasRecentDiscomfort: recent7.length > 0,
  };
}

function normalizeBodyFeedbackEntry(entry) {
  return {
    date: String(entry?.date ?? '').trim(),
    time: entry?.time ? String(entry.time).trim() : null,
    body: String(entry?.body ?? '').trim(),
    telegramMessageId: toNumberOrNull(entry?.telegramMessageId),
    markdownPath: entry?.markdownPath ?? null,
    source: entry?.source ?? null,
  };
}

function compareBodyFeedbackEntries(left, right) {
  return `${left.date} ${left.time ?? ''}`.localeCompare(`${right.date} ${right.time ?? ''}`);
}

function hasWorkoutRecord(day) {
  return Boolean(day?.workoutSummary) && (
    (day?.workoutSummary?.trainingCalories ?? 0) > 0 ||
    (day?.activities?.length ?? 0) > 0 ||
    (day?.workoutSummary?.workoutDurationMinutes ?? 0) > 0
  );
}

function hasNutritionRecord(day) {
  return Boolean(day?.nutrition) && (
    (day?.nutrition?.meals?.length ?? 0) > 0 ||
    day?.nutrition?.totalCalories !== null && day?.nutrition?.totalCalories !== undefined
  );
}

function hasStrengthTraining(day) {
  return Object.keys(day?.workoutSummary?.countsByType ?? {}).some((type) => String(type).includes('力量'));
}

function hasCardioTraining(day) {
  return (
    (day?.workoutSummary?.cyclingDistanceKm ?? 0) > 0 ||
    Object.keys(day?.workoutSummary?.countsByType ?? {}).some((type) =>
      /骑行|有氧|燃脂|跑|走|HIIT|间歇/u.test(String(type)),
    )
  );
}

function hasHighIntensityTraining(day) {
  return Object.keys(day?.workoutSummary?.countsByType ?? {}).some((type) =>
    /HIIT|间歇|冲刺/u.test(String(type)),
  );
}

function isHighLoadDay(day) {
  const workoutMinutes = resolveWorkoutDurationMinutes(day) ?? 0;
  const trainingCalories = day?.workoutSummary?.trainingCalories ?? 0;
  return workoutMinutes >= 60 || trainingCalories >= 350 || hasHighIntensityTraining(day);
}

function getCurrentWorkoutStreak(days) {
  let streak = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (!hasWorkoutRecord(days[index])) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function getCurrentRestStreak(days) {
  let streak = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (hasWorkoutRecord(days[index])) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function normalizeSnapshotSource(source) {
  const normalized = String(source ?? '').trim().toLowerCase();
  if (normalized === 'database' || normalized === 'markdown' || normalized === 'fallback_markdown') {
    return normalized;
  }
  return 'unknown';
}

function normalizeActivityTimeForAnalysis(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.match(/(\d{2}:\d{2})$/)?.[1] ?? trimmed;
}

function summarizeMeasurementTrend(measurements) {
  const first = measurements.find(Boolean) ?? null;
  const latest = measurements.at(-1) ?? null;
  if (!first || !latest) {
    return {
      count: measurements.length,
      weightDeltaKg: null,
      bodyFatDeltaPct: null,
      skeletalMuscleDeltaKg: null,
    };
  }

  return {
    count: measurements.length,
    fromDate: first.archivedDate ?? null,
    toDate: latest.archivedDate ?? null,
    weightDeltaKg: diff(latest.weightKg, first.weightKg),
    bodyFatDeltaPct: diff(latest.bodyFatPct, first.bodyFatPct),
    skeletalMuscleDeltaKg: diff(latest.skeletalMuscleKg, first.skeletalMuscleKg),
  };
}

function normalizeMeasurement(measurement) {
  if (!measurement) {
    return null;
  }
  return {
    archivedDate: measurement.archivedDate ?? null,
    measuredAt: measurement.measuredAt ?? null,
    weightKg: toNumberOrNull(measurement.weightKg),
    bodyFatPct: toNumberOrNull(measurement.bodyFatPct),
    skeletalMuscleKg: toNumberOrNull(measurement.skeletalMuscleKg),
    basalMetabolismKcal: toNumberOrNull(measurement.basalMetabolismKcal),
    visceralFatLevel: toNumberOrNull(measurement.visceralFatLevel),
  };
}

function resolveWorkoutDurationMinutes(day) {
  const explicit = day?.workoutSummary?.workoutDurationMinutes;
  if (isFiniteNumber(explicit)) {
    return Number(explicit);
  }
  const seconds = day?.workoutSummary?.totalDurationSeconds;
  return isFiniteNumber(seconds) ? roundTo(Number(seconds) / 60, 1) : null;
}

function average(values) {
  const numeric = values.filter(isFiniteNumber);
  return numeric.length ? roundTo(sum(numeric) / numeric.length, 1) : null;
}

function sum(values) {
  return values.filter(isFiniteNumber).reduce((total, value) => total + Number(value), 0);
}

function diff(next, previous) {
  if (!isFiniteNumber(next) || !isFiniteNumber(previous)) {
    return null;
  }
  return roundTo(Number(next) - Number(previous), 2);
}

function toNumberOrNull(value) {
  return isFiniteNumber(value) ? Number(value) : null;
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function toIsoString(value) {
  return typeof value?.toISOString === 'function' ? value.toISOString() : new Date().toISOString();
}
