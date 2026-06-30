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
      alerts: ['暂无可展示的监控数据'],
      chartPayload: {
        windowDays: settings.chartWindowDays,
        charts: {},
      },
    };
  }

  const continuityStats = buildContinuityStats(daily, resolvedSettings);
  const alerts = buildAlerts({
    latestSleep,
    latestNutrition,
    settings: resolvedSettings,
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
      chartId: 'monitor-sleep-chart',
      title: '睡眠时长 & 评分',
      subtitle: '恢复质量趋势',
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
    sleepTotalMinutes: buildDailyChart(daily, chartStartDate, (day) =>
      day.sleepSummary?.totalSleepMinutes ?? day.sleepSummary?.nightSleepMinutes),
    sleepScore: buildDailyChart(daily, chartStartDate, (day) => day.sleepSummary?.sleepScore),
    workoutDurationMinutes: buildDailyChart(daily, chartStartDate, (day) =>
      day.workoutSummary?.workoutDurationMinutes ?? minutesFromSeconds(day.workoutSummary?.totalDurationSeconds)),
    averageHeartRateBpm: buildDailyChart(daily, chartStartDate, (day) =>
      day.workoutSummary?.averageHeartRateBpm ?? calculateAverageHeartRate(day.activities)),
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

function buildAlerts({ latestSleep, latestNutrition, settings }) {
  const alerts = [];
  const sleepMinutes = latestSleep?.totalSleepMinutes ?? latestSleep?.nightSleepMinutes;
  if (Number(sleepMinutes ?? 0) > 0 && sleepMinutes < 360) {
    alerts.push(`昨日睡眠 ${formatNumber(sleepMinutes / 60, 1)}h 偏少`);
  }

  const calorieOverage = calculateCalorieOverage(latestNutrition?.totalCalories, settings.calorieRecommendedMax);
  if (calorieOverage !== null && calorieOverage > 0) {
    alerts.push(`今日摄入已超建议上限 ${formatNumber(calorieOverage, 0)} kcal`);
  }

  return alerts.length ? alerts : ['当前无明显异常提示'];
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
