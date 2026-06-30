import { formatNumber } from '../shared/format.mjs';

const defaultOptions = {
  chartWindowDays: 30,
  weightGoalKg: 65,
  bodyFatStandardMaxPct: 20,
  sleepTargetMinutes: 420,
  calorieRecommendedMax: null,
};

export function buildMonitorViewModel(snapshot, options = {}) {
  const settings = { ...defaultOptions, ...options };
  const dashboard = snapshot || { daily: [], charts: {}, latest: {} };
  const daily = normalizeDailyEntries(dashboard.daily);
  const latestDay = findLatestDay(dashboard, daily);
  const latestMeasurement = findLatestMeasurement(dashboard, daily, latestDay);
  const latestDataDate = findLatestDataDate({ latestMeasurement, latestDay, daily });
  const previousDay = findPreviousDay(daily, latestDay?.date);
  const previousMeasurement = findPreviousMeasurement(daily, latestMeasurement?.archivedDate);
  const chartStartDate = latestDataDate ? addDays(latestDataDate, -(settings.chartWindowDays - 1)) : null;
  const latestSleep = latestDay?.sleepSummary || findLatestSleepSummary(daily);
  const previousSleep = previousDay?.sleepSummary || findPreviousSleepSummary(daily, latestDay?.date);
  const latestWorkout = latestDay?.workoutSummary || {};
  const latestNutrition = latestDay?.nutrition || {};
  const calorieRecommendedMax = resolveCalorieRecommendedMax(latestNutrition, settings.calorieRecommendedMax);
  const resolvedSettings = {
    ...settings,
    calorieRecommendedMax,
  };

  if (!latestMeasurement && !latestDay) {
    return {
      title: '健身监控总览',
      generatedAt: dashboard.generatedAt ?? null,
      updatedTime: formatTimeLabel(dashboard.generatedAt),
      latestDataDate: null,
      summaryCards: [],
      trendCards: buildTrendCards(),
      continuityStats: [],
      continuityText: '暂无连续性数据',
      bodyCompositionStats: [],
      recoveryStats: [],
      trainingStructure: buildEmptyTrainingStructure(),
      nutritionStats: [],
      rollingStats: [],
      dataQuality: buildEmptyDataQuality(),
      alerts: ['暂无可展示的监控数据'],
      chartPayload: {
        windowDays: settings.chartWindowDays,
        charts: {},
      },
    };
  }

  const continuityStats = buildContinuityStats(daily, resolvedSettings);
  const dataQuality = buildDataQuality(daily, latestDay);
  const alerts = buildAlerts({
    latestMeasurement,
    latestSleep,
    latestWorkout,
    latestNutrition,
    settings: resolvedSettings,
    dataQuality,
  });

  return {
    title: '健身监控总览',
    generatedAt: dashboard.generatedAt ?? null,
    updatedTime: formatTimeLabel(dashboard.generatedAt),
    latestDataDate,
    summaryCards: buildSummaryCards({
      latestMeasurement,
      previousMeasurement,
      latestSleep,
      previousSleep,
      latestWorkout,
      latestNutrition,
      settings: resolvedSettings,
    }),
    trendCards: buildTrendCards(),
    continuityStats,
    continuityText: continuityStats.map((item) => `${item.label} ${item.value}`).join(' · ') || '暂无连续性数据',
    bodyCompositionStats: buildBodyCompositionStats(latestMeasurement, previousMeasurement),
    recoveryStats: buildRecoveryStats(latestSleep, previousSleep),
    trainingStructure: buildTrainingStructure(daily, latestWorkout),
    nutritionStats: buildNutritionStats(latestNutrition, resolvedSettings),
    rollingStats: buildRollingStats(daily),
    dataQuality,
    alerts,
    chartPayload: {
      windowDays: settings.chartWindowDays,
      charts: buildMonitorCharts({ dashboard, daily, chartStartDate }),
    },
  };
}

function buildSummaryCards({
  latestMeasurement,
  previousMeasurement,
  latestSleep,
  previousSleep,
  latestWorkout,
  latestNutrition,
  settings,
}) {
  const weightKg = latestMeasurement?.weightKg;
  const bodyFatPct = latestMeasurement?.bodyFatPct;
  const sleepScore = latestSleep?.sleepScore;
  const intakeCalories = latestNutrition?.totalCalories;
  const calorieOverage = calculateCalorieOverage(intakeCalories, settings.calorieRecommendedMax);

  return [
    {
      id: 'weight',
      title: '体重',
      value: `${formatNumber(weightKg, 1)} kg`,
      progressPct: calculateWeightProgress(weightKg, settings.weightGoalKg),
      progressLabel: buildWeightProgressLabel(weightKg, settings.weightGoalKg),
      secondary: settings.weightGoalKg ? `目标 ${formatNumber(settings.weightGoalKg, 0)} kg` : '目标待设置',
      tone: 'teal',
    },
    {
      id: 'bodyFat',
      title: '体脂率',
      value: `${formatNumber(bodyFatPct, 1)}%`,
      progressPct: calculateBodyFatProgress(bodyFatPct, settings.bodyFatStandardMaxPct),
      progressLabel: bodyFatPct && bodyFatPct <= settings.bodyFatStandardMaxPct ? '标准' : '待改善',
      secondary: formatSignedDelta(bodyFatPct, previousMeasurement?.bodyFatPct, {
        label: '较上次',
        unit: '%',
        digits: 1,
      }),
      tone: 'amber',
    },
    {
      id: 'sleep',
      title: '睡眠',
      value: sleepScore !== null && sleepScore !== undefined
        ? `${formatNumber(sleepScore, 0)} 分`
        : `${formatNumber((latestSleep?.totalSleepMinutes ?? latestSleep?.nightSleepMinutes) / 60, 1)} h`,
      progressPct: calculateSleepProgress(latestSleep, settings.sleepTargetMinutes),
      progressLabel: buildSleepStatus(latestSleep, settings.sleepTargetMinutes),
      secondary: sleepScore !== null && sleepScore !== undefined
        ? formatSignedDelta(sleepScore, previousSleep?.sleepScore, { label: '较昨日', unit: '分', digits: 0 })
        : `目标 ${formatNumber(settings.sleepTargetMinutes / 60, 1)} h`,
      tone: 'blue',
    },
    {
      id: 'calorieBalance',
      title: '热量平衡',
      value: calorieOverage === null
        ? `${formatNumber((intakeCalories ?? 0) - (latestWorkout?.trainingCalories ?? 0), 0)} kcal`
        : `${calorieOverage > 0 ? '+' : ''}${formatNumber(calorieOverage, 0)} kcal`,
      progressPct: calculateCalorieProgress(calorieOverage, settings.calorieRecommendedMax),
      progressLabel: buildCalorieProgressLabel(intakeCalories, latestWorkout?.trainingCalories),
      secondary: buildCalorieSecondary(calorieOverage),
      tone: calorieOverage > 0 ? 'rose' : 'green',
    },
  ];
}

function buildTrendCards() {
  return [
    {
      chartId: 'monitor-calorie-chart',
      title: '热量摄入 vs 消耗',
      subtitle: '饮食摄入和训练消耗对照',
    },
    {
      chartId: 'monitor-body-chart',
      title: '体重 & 体脂率变化',
      subtitle: '体脂秤核心指标',
    },
    {
      chartId: 'monitor-composition-chart',
      title: '身体成分趋势',
      subtitle: '骨骼肌、基础代谢与内脏脂肪',
    },
    {
      chartId: 'monitor-sleep-chart',
      title: '睡眠时长 & 评分',
      subtitle: '恢复质量趋势',
    },
    {
      chartId: 'monitor-recovery-chart',
      title: '恢复监控',
      subtitle: '深睡、REM、HRV 与血氧',
    },
    {
      chartId: 'monitor-workout-chart',
      title: '锻炼时长 & 心率',
      subtitle: '训练负荷趋势',
    },
  ];
}

function buildMonitorCharts({ dashboard, daily, chartStartDate }) {
  const charts = dashboard.charts || {};
  return {
    intakeCalories: filterChartPoints(charts.intakeCalories, chartStartDate),
    trainingCalories: filterChartPoints(charts.trainingCalories, chartStartDate),
    weightKg: filterChartPoints(charts.weightKg, chartStartDate),
    bodyFatPct: filterChartPoints(charts.bodyFatPct, chartStartDate),
    skeletalMuscleKg: buildMeasurementChart(charts.skeletalMuscleKg, daily, chartStartDate, (measurement) => measurement?.skeletalMuscleKg),
    basalMetabolism: buildMeasurementChart(charts.basalMetabolism, daily, chartStartDate, (measurement) => measurement?.basalMetabolismKcal),
    visceralFatLevel: buildMeasurementChart(charts.visceralFatLevel, daily, chartStartDate, (measurement) => measurement?.visceralFatLevel),
    sleepTotalMinutes: buildDailyChart(daily, chartStartDate, (day) =>
      day.sleepSummary?.totalSleepMinutes ?? day.sleepSummary?.nightSleepMinutes),
    sleepScore: buildDailyChart(daily, chartStartDate, (day) => day.sleepSummary?.sleepScore),
    deepSleepMinutes: buildDailyChart(daily, chartStartDate, (day) => day.sleepSummary?.deepSleepMinutes),
    remSleepMinutes: buildDailyChart(daily, chartStartDate, (day) => day.sleepSummary?.remSleepMinutes),
    hrvMs: buildDailyChart(daily, chartStartDate, (day) => day.sleepSummary?.hrvMs),
    averageSpo2Pct: buildDailyChart(daily, chartStartDate, (day) => day.sleepSummary?.averageSpo2Pct),
    workoutDurationMinutes: buildDailyChart(daily, chartStartDate, (day) =>
      day.workoutSummary?.workoutDurationMinutes ?? minutesFromSeconds(day.workoutSummary?.totalDurationSeconds)),
    averageHeartRateBpm: buildDailyChart(daily, chartStartDate, (day) =>
      day.workoutSummary?.averageHeartRateBpm ?? calculateAverageHeartRate(day.activities)),
    cyclingDistanceKm: buildDailyChart(daily, chartStartDate, (day) => day.workoutSummary?.cyclingDistanceKm),
    activeHours: buildDailyChart(daily, chartStartDate, (day) => day.workoutSummary?.activeHours),
  };
}

function buildContinuityStats(daily, settings) {
  const workoutDays = countTrailingStreak(daily, (day) => (day.workoutSummary?.trainingCalories ?? 0) > 0);
  const sleepDays = countLatestPassingStreak(daily, (day) => {
    const totalMinutes = day.sleepSummary?.totalSleepMinutes ?? day.sleepSummary?.nightSleepMinutes;
    return Number(totalMinutes ?? 0) >= settings.sleepTargetMinutes;
  });

  return [
    { id: 'workout', label: '连续锻炼', value: `${workoutDays} 天` },
    { id: 'sleep', label: '睡眠达标连续', value: `${sleepDays} 天` },
  ];
}

function buildBodyCompositionStats(latestMeasurement, previousMeasurement) {
  return [
    buildMetricStat('bmi', 'BMI', formatNumber(latestMeasurement?.bmi, 1), formatSignedDelta(latestMeasurement?.bmi, previousMeasurement?.bmi, { label: '较上次', unit: '', digits: 1 })),
    buildMetricStat('skeletalMuscle', '骨骼肌量', `${formatNumber(latestMeasurement?.skeletalMuscleKg, 1)} kg`, formatSignedDelta(latestMeasurement?.skeletalMuscleKg, previousMeasurement?.skeletalMuscleKg, { label: '较上次', unit: ' kg', digits: 1 })),
    buildMetricStat('basalMetabolism', '基础代谢', `${formatNumber(latestMeasurement?.basalMetabolismKcal, 0)} kcal`, formatSignedDelta(latestMeasurement?.basalMetabolismKcal, previousMeasurement?.basalMetabolismKcal, { label: '较上次', unit: ' kcal', digits: 0 })),
    buildMetricStat('visceralFat', '内脏脂肪等级', formatNumber(latestMeasurement?.visceralFatLevel, 1), formatSignedDelta(latestMeasurement?.visceralFatLevel, previousMeasurement?.visceralFatLevel, { label: '较上次', unit: '', digits: 1 })),
    buildMetricStat('bodyWater', '水分率', `${formatNumber(latestMeasurement?.bodyWaterPct, 1)}%`, formatSignedDelta(latestMeasurement?.bodyWaterPct, previousMeasurement?.bodyWaterPct, { label: '较上次', unit: '%', digits: 1 })),
    buildMetricStat('protein', '蛋白质率', `${formatNumber(latestMeasurement?.proteinPct, 1)}%`, formatSignedDelta(latestMeasurement?.proteinPct, previousMeasurement?.proteinPct, { label: '较上次', unit: '%', digits: 1 })),
  ];
}

function buildRecoveryStats(latestSleep, previousSleep) {
  return [
    buildMetricStat('deepSleep', '深睡', `${formatNumber(latestSleep?.deepSleepMinutes, 0)} 分`, buildRatioHint(latestSleep?.deepSleepMinutes, latestSleep?.totalSleepMinutes ?? latestSleep?.nightSleepMinutes)),
    buildMetricStat('remSleep', 'REM', `${formatNumber(latestSleep?.remSleepMinutes, 0)} 分`, buildRatioHint(latestSleep?.remSleepMinutes, latestSleep?.totalSleepMinutes ?? latestSleep?.nightSleepMinutes)),
    buildMetricStat('awake', '清醒', `${formatNumber(latestSleep?.awakeMinutes, 0)} 分`, formatSignedDelta(latestSleep?.awakeMinutes, previousSleep?.awakeMinutes, { label: '较昨日', unit: ' 分', digits: 0 })),
    buildMetricStat('hrv', 'HRV', `${formatNumber(latestSleep?.hrvMs, 0)} ms`, formatSignedDelta(latestSleep?.hrvMs, previousSleep?.hrvMs, { label: '较昨日', unit: ' ms', digits: 0 })),
    buildMetricStat('spo2', '平均血氧', `${formatNumber(latestSleep?.averageSpo2Pct, 0)}%`, formatSignedDelta(latestSleep?.averageSpo2Pct, previousSleep?.averageSpo2Pct, { label: '较昨日', unit: '%', digits: 0 })),
    buildMetricStat('respiratory', '呼吸率', `${formatNumber(latestSleep?.averageRespiratoryRate, 0)} 次/分`, formatSignedDelta(latestSleep?.averageRespiratoryRate, previousSleep?.averageRespiratoryRate, { label: '较昨日', unit: '', digits: 0 })),
  ];
}

function buildTrainingStructure(daily, latestWorkout) {
  const recentDays = lastDays(daily, 30);
  const typeTotals = new Map();
  for (const day of recentDays) {
    for (const [type, count] of Object.entries(day.workoutSummary?.countsByType || {})) {
      typeTotals.set(type, (typeTotals.get(type) ?? 0) + Number(count || 0));
    }
  }

  const typeBreakdown = [...typeTotals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  return {
    stats: [
      buildMetricStat('activities', '今日活动', `${formatNumber(latestWorkout?.totalActivities, 0)} 次`, '训练记录活动数'),
      buildMetricStat('duration', '锻炼时长', `${formatNumber(latestWorkout?.workoutDurationMinutes ?? minutesFromSeconds(latestWorkout?.totalDurationSeconds), 0)} 分`, '当日训练负荷'),
      buildMetricStat('cycling', '骑行里程', `${formatNumber(latestWorkout?.cyclingDistanceKm, 1)} km`, '有氧通勤/骑行'),
      buildMetricStat('activeHours', '活动小时数', `${formatNumber(latestWorkout?.activeHours, 0)} 小时`, '日常活动覆盖'),
    ],
    typeBreakdown,
  };
}

function buildNutritionStats(latestNutrition, settings) {
  const intakeCalories = latestNutrition?.totalCalories;
  const mealCount = latestNutrition?.meals?.length ?? 0;
  const recommendedMax = settings.calorieRecommendedMax;
  const calorieOverage = calculateCalorieOverage(intakeCalories, recommendedMax);

  return [
    buildMetricStat('intake', '总摄入', `${formatNumber(intakeCalories, 0)} kcal`, `${formatNumber(mealCount, 0)} 餐记录`),
    buildMetricStat('recommendedMax', '建议上限', `${formatNumber(recommendedMax, 0)} kcal`, buildCalorieSecondary(calorieOverage)),
    buildMetricStat('largestMeal', '最高单餐', `${formatNumber(maxMealCalories(latestNutrition?.meals), 0)} kcal`, latestNutrition?.meals?.find((meal) => meal?.calories === maxMealCalories(latestNutrition?.meals))?.name || '暂无餐次'),
  ];
}

function buildRollingStats(daily) {
  const recent7 = lastDays(daily, 7);
  const recent30 = lastDays(daily, 30);
  const averageSleepMinutes = average(recent7.map((day) =>
    day.sleepSummary?.totalSleepMinutes ?? day.sleepSummary?.nightSleepMinutes));
  return [
    buildMetricStat('weight7d', '7日平均体重', `${formatNumber(average(recent7.map((day) => day.measurement?.weightKg)), 1)} kg`, '短期体重中枢'),
    buildMetricStat('sleep7d', '7日平均睡眠', `${formatNumber(isFiniteNumber(averageSleepMinutes) ? averageSleepMinutes / 60 : null, 1)} h`, '恢复基础'),
    buildMetricStat('intake7d', '7日平均摄入', `${formatNumber(average(recent7.map((day) => day.nutrition?.totalCalories)), 0)} kcal`, '饮食维护'),
    buildMetricStat('training30d', '30日训练消耗', `${formatNumber(sum(recent30.map((day) => day.workoutSummary?.trainingCalories)), 0)} kcal`, '训练总量'),
  ];
}

function buildDataQuality(daily, latestDay) {
  const recent = lastDays(daily, 7);
  const checks = [
    { id: 'measurement', label: '体脂', present: Boolean(latestDay?.measurement) },
    { id: 'nutrition', label: '饮食', present: isFiniteNumber(latestDay?.nutrition?.totalCalories) },
    { id: 'sleep', label: '睡眠', present: hasSleepData(latestDay) },
    { id: 'workout', label: '训练', present: Number(latestDay?.workoutSummary?.trainingCalories ?? 0) > 0 },
  ];
  const completenessPct = checks.length
    ? Math.round((checks.filter((check) => check.present).length / checks.length) * 100)
    : 0;
  const recentCompletenessPct = recent.length
    ? Math.round((recent.reduce((total, day) => total + calculateDayCompleteness(day), 0) / recent.length) * 100)
    : 0;

  return {
    completenessPct,
    recentCompletenessPct,
    missingItems: checks.filter((check) => !check.present).map((check) => check.label),
    stats: [
      buildMetricStat('todayCompleteness', '今日完整率', `${completenessPct}%`, '体脂/饮食/睡眠/训练'),
      buildMetricStat('recentCompleteness', '7日完整率', `${recentCompletenessPct}%`, `${formatNumber(recent.length, 0)} 天窗口`),
      buildMetricStat('latestDate', '最新归档', latestDay?.date || '—', '数据维护锚点'),
    ],
  };
}

function buildEmptyTrainingStructure() {
  return { stats: [], typeBreakdown: [] };
}

function buildEmptyDataQuality() {
  return { completenessPct: 0, recentCompletenessPct: 0, missingItems: [], stats: [] };
}

function buildAlerts({ latestMeasurement, latestSleep, latestWorkout, latestNutrition, settings, dataQuality }) {
  const alerts = [];
  const sleepMinutes = latestSleep?.totalSleepMinutes ?? latestSleep?.nightSleepMinutes;
  if (Number(sleepMinutes ?? 0) > 0 && sleepMinutes < 360) {
    alerts.push(`昨日睡眠 ${formatNumber(sleepMinutes / 60, 1)}h 偏少`);
  }

  const calorieOverage = calculateCalorieOverage(latestNutrition?.totalCalories, settings.calorieRecommendedMax);
  if (calorieOverage !== null && calorieOverage > 0) {
    alerts.push(`今日摄入已超建议上限 ${formatNumber(calorieOverage, 0)} kcal`);
  }

  if (!latestMeasurement) {
    alerts.push('今日缺少体脂测量数据');
  }

  if (Number(latestWorkout?.trainingCalories ?? 0) <= 0) {
    alerts.push('今日暂无训练消耗记录');
  }

  if (dataQuality?.missingItems?.length) {
    alerts.push(`今日数据缺失：${dataQuality.missingItems.join('、')}`);
  }

  return alerts.length ? alerts : ['当前无明显异常提示'];
}

function buildMetricStat(id, label, value, hint = '') {
  return {
    id,
    label,
    value: value === null || value === undefined || value === 'null' ? '—' : value,
    hint,
  };
}

function normalizeDailyEntries(daily) {
  return [...(Array.isArray(daily) ? daily : [])]
    .map((day) => ({
      ...day,
      date: normalizeDateValue(day?.date) || day?.date,
      measurement: normalizeMeasurement(day?.measurement),
      measurements: (day?.measurements || []).map(normalizeMeasurement),
    }))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

function normalizeMeasurement(measurement) {
  if (!measurement) {
    return measurement;
  }
  return {
    ...measurement,
    archivedDate: normalizeDateValue(measurement.archivedDate) || measurement.archivedDate,
  };
}

function findLatestDay(dashboard, daily) {
  const latestDate = normalizeDateValue(dashboard.latest?.daily?.date);
  if (latestDate) {
    return daily.find((day) => normalizeDateValue(day.date) === latestDate) || normalizeDayDate(dashboard.latest.daily);
  }
  return daily.at(-1) || null;
}

function findLatestMeasurement(dashboard, daily, latestDay) {
  if (dashboard.latest?.measurement) {
    return normalizeMeasurement(dashboard.latest.measurement);
  }
  if (latestDay?.measurement) {
    return normalizeMeasurement(latestDay.measurement);
  }
  return [...daily].reverse().map((day) => day.measurement).find(Boolean) || null;
}

function findLatestDataDate({ latestMeasurement, latestDay, daily }) {
  return (
    normalizeDateValue(latestMeasurement?.archivedDate) ||
    normalizeDateValue(latestDay?.date) ||
    [...daily].reverse().map((day) => normalizeDateValue(day?.date)).find(Boolean) ||
    null
  );
}

function findPreviousDay(daily, latestDate) {
  const normalizedDate = normalizeDateValue(latestDate);
  if (!normalizedDate) {
    return null;
  }
  const index = daily.findIndex((day) => normalizeDateValue(day.date) === normalizedDate);
  return index > 0 ? daily[index - 1] : null;
}

function findPreviousMeasurement(daily, latestMeasurementDate) {
  const normalizedDate = normalizeDateValue(latestMeasurementDate);
  const previous = [...daily]
    .filter((day) => normalizeDateValue(day.date) < normalizedDate)
    .reverse()
    .map((day) => day.measurement)
    .find(Boolean);
  return previous || null;
}

function findLatestSleepSummary(daily) {
  return [...daily].reverse().map((day) => day.sleepSummary).find(Boolean) || null;
}

function findPreviousSleepSummary(daily, latestDate) {
  const previousDay = findPreviousDay(daily, latestDate);
  return previousDay?.sleepSummary || null;
}

function normalizeDayDate(day) {
  if (!day) {
    return day;
  }
  return {
    ...day,
    date: normalizeDateValue(day.date) || day.date,
    measurement: normalizeMeasurement(day.measurement),
    measurements: (day.measurements || []).map(normalizeMeasurement),
  };
}

function filterChartPoints(points, startDate) {
  return (points || [])
    .map((point) => {
      const date = normalizeDateValue(point?.date);
      return date ? { ...point, date } : point;
    })
    .filter((point) => {
      const date = normalizeDateValue(point?.date);
      return date && (!startDate || date >= startDate) && isFiniteNumber(point.value);
    });
}

function buildDailyChart(daily, startDate, pickValue) {
  return daily
    .filter((day) => !startDate || normalizeDateValue(day.date) >= startDate)
    .map((day) => ({
      date: normalizeDateValue(day.date),
      value: pickValue(day),
    }))
    .filter((point) => point.date && isFiniteNumber(point.value))
    .map((point) => ({
      date: point.date,
      value: Number(point.value),
    }));
}

function calculateWeightProgress(weightKg, weightGoalKg) {
  if (!isFiniteNumber(weightKg) || !isFiniteNumber(weightGoalKg) || weightKg <= 0) {
    return 0;
  }
  return clamp(Math.round((weightGoalKg / weightKg) * 100), 0, 100);
}

function buildWeightProgressLabel(weightKg, weightGoalKg) {
  const progress = calculateWeightProgress(weightKg, weightGoalKg);
  return progress > 0 ? `目标达成 ${progress}%` : '目标待设置';
}

function calculateBodyFatProgress(bodyFatPct, standardMaxPct) {
  if (!isFiniteNumber(bodyFatPct) || !isFiniteNumber(standardMaxPct) || bodyFatPct <= 0) {
    return 0;
  }
  if (bodyFatPct <= standardMaxPct) {
    return 82;
  }
  return clamp(Math.round((standardMaxPct / bodyFatPct) * 82), 8, 76);
}

function calculateSleepProgress(sleep, sleepTargetMinutes) {
  if (isFiniteNumber(sleep?.sleepScore)) {
    return clamp(Math.round(sleep.sleepScore), 0, 100);
  }
  const minutes = sleep?.totalSleepMinutes ?? sleep?.nightSleepMinutes;
  if (!isFiniteNumber(minutes) || !isFiniteNumber(sleepTargetMinutes) || sleepTargetMinutes <= 0) {
    return 0;
  }
  return clamp(Math.round((minutes / sleepTargetMinutes) * 100), 0, 100);
}

function buildSleepStatus(sleep, sleepTargetMinutes) {
  if (isFiniteNumber(sleep?.sleepScore)) {
    if (sleep.sleepScore >= 80) {
      return '良好';
    }
    if (sleep.sleepScore >= 60) {
      return '一般';
    }
    return '偏低';
  }
  const minutes = sleep?.totalSleepMinutes ?? sleep?.nightSleepMinutes;
  return Number(minutes ?? 0) >= sleepTargetMinutes ? '达标' : '偏少';
}

function calculateCalorieOverage(intakeCalories, recommendedMax) {
  if (!isFiniteNumber(intakeCalories) || !isFiniteNumber(recommendedMax)) {
    return null;
  }
  return Number(intakeCalories) - Number(recommendedMax);
}

function resolveCalorieRecommendedMax(nutrition, configuredMax) {
  if (isFiniteNumber(configuredMax)) {
    return Number(configuredMax);
  }
  const mealMaxValues = (nutrition?.meals || [])
    .map((meal) => meal?.recommendedMax)
    .filter(isFiniteNumber)
    .map(Number);
  if (!mealMaxValues.length) {
    return null;
  }
  return mealMaxValues.reduce((total, value) => total + value, 0);
}

function calculateCalorieProgress(calorieOverage, recommendedMax) {
  if (calorieOverage === null || !isFiniteNumber(recommendedMax) || recommendedMax <= 0) {
    return 0;
  }
  if (calorieOverage <= 0) {
    return 78;
  }
  return clamp(Math.round(100 - (calorieOverage / recommendedMax) * 100), 8, 100);
}

function buildCalorieProgressLabel(intakeCalories, trainingCalories) {
  if (!isFiniteNumber(intakeCalories) || !isFiniteNumber(trainingCalories)) {
    return '待补齐';
  }
  if (trainingCalories > intakeCalories) {
    return '消耗 > 摄入';
  }
  return '摄入 / 消耗';
}

function buildCalorieSecondary(calorieOverage) {
  if (calorieOverage === null) {
    return '建议上限待设置';
  }
  if (calorieOverage > 0) {
    return `摄入超建议 ${formatNumber(calorieOverage, 0)} kcal`;
  }
  return `低于建议上限 ${formatNumber(Math.abs(calorieOverage), 0)} kcal`;
}

function buildMeasurementChart(points, daily, startDate, pickValue) {
  const filteredPoints = filterChartPoints(points, startDate);
  if (filteredPoints.length) {
    return filteredPoints;
  }
  return buildDailyChart(daily, startDate, (day) => pickValue(day.measurement));
}

function buildRatioHint(partMinutes, totalMinutes) {
  if (!isFiniteNumber(partMinutes) || !isFiniteNumber(totalMinutes) || Number(totalMinutes) <= 0) {
    return '暂无占比';
  }
  return `占比 ${formatNumber((Number(partMinutes) / Number(totalMinutes)) * 100, 1)}%`;
}

function formatSignedDelta(current, previous, { label, unit, digits }) {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous)) {
    return '暂无对比';
  }
  const delta = Number(current) - Number(previous);
  const sign = delta > 0 ? '+' : '';
  return `${label} ${sign}${formatNumber(delta, digits)}${unit}`;
}

function countTrailingStreak(daily, predicate) {
  let count = 0;
  for (let index = daily.length - 1; index >= 0; index -= 1) {
    if (!predicate(daily[index])) {
      break;
    }
    count += 1;
  }
  return count;
}

function countLatestPassingStreak(daily, predicate) {
  let count = 0;
  let started = false;
  for (let index = daily.length - 1; index >= 0; index -= 1) {
    if (!predicate(daily[index])) {
      if (started) {
        break;
      }
      continue;
    }
    started = true;
    count += 1;
  }
  return count;
}

function calculateAverageHeartRate(activities) {
  const values = (activities || [])
    .map((activity) => activity?.heartRate ?? activity?.averageHeartRateBpm)
    .filter(isFiniteNumber);
  if (!values.length) {
    return null;
  }
  return Math.round(values.reduce((total, value) => total + Number(value), 0) / values.length);
}

function maxMealCalories(meals) {
  const values = (meals || []).map((meal) => meal?.calories).filter(isFiniteNumber).map(Number);
  return values.length ? Math.max(...values) : null;
}

function lastDays(daily, count) {
  return [...(daily || [])].slice(-count);
}

function sum(values) {
  const numericValues = values.filter(isFiniteNumber).map(Number);
  return numericValues.reduce((total, value) => total + value, 0);
}

function average(values) {
  const numericValues = values.filter(isFiniteNumber).map(Number);
  if (!numericValues.length) {
    return null;
  }
  return sum(numericValues) / numericValues.length;
}

function hasSleepData(day) {
  return isFiniteNumber(day?.sleepSummary?.totalSleepMinutes) ||
    isFiniteNumber(day?.sleepSummary?.nightSleepMinutes) ||
    isFiniteNumber(day?.sleepSummary?.sleepScore);
}

function calculateDayCompleteness(day) {
  const checks = [
    Boolean(day?.measurement),
    isFiniteNumber(day?.nutrition?.totalCalories),
    hasSleepData(day),
    Number(day?.workoutSummary?.trainingCalories ?? 0) > 0,
  ];
  return checks.filter(Boolean).length / checks.length;
}

function minutesFromSeconds(seconds) {
  if (!isFiniteNumber(seconds)) {
    return null;
  }
  return Number((Number(seconds) / 60).toFixed(2));
}

function normalizeDateValue(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    return null;
  }
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[1] ? null : match[1];
}

function addDays(dateString, offset) {
  const normalizedDate = normalizeDateValue(dateString);
  if (!normalizedDate) {
    return null;
  }
  const date = new Date(`${normalizedDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function formatTimeLabel(value) {
  if (typeof value !== 'string') {
    return '—';
  }
  const match = value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : '—';
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
