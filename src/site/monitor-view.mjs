import { formatNumber } from '../shared/format.mjs';

const defaultOptions = {
  weightGoalKg: 65,
  sleepTargetMinutes: 420,
  calorieRecommendedMax: null,
};

export function buildMonitorViewModel(snapshot, options = {}) {
  const settings = { ...defaultOptions, ...options };
  const dashboard = snapshot || { daily: [], latest: {} };
  const daily = normalizeDailyEntries(dashboard.daily);
  const latestDay = findLatestDay(dashboard, daily);
  const latestMeasurement = dashboard.latest?.measurement ?? latestDay?.measurement ?? null;
  const latestDataDate = latestDay?.date ?? latestMeasurement?.archivedDate ?? null;
  const latestSleep = latestDay?.sleepSummary ?? null;
  const latestWorkout = latestDay?.workoutSummary ?? {};
  const latestNutrition = latestDay?.nutrition ?? {};
  const calorieRecommendedMax = resolveCalorieRecommendedMax(latestNutrition, settings.calorieRecommendedMax);
  const dataQuality = buildDataQuality(latestDay, latestMeasurement);

  if (!latestDay && !latestMeasurement) {
    return {
      title: '每日训练报告',
      generatedAt: dashboard.generatedAt ?? null,
      updatedTime: formatTimeLabel(dashboard.generatedAt),
      latestDataDate: null,
      dailyReport: normalizeDailyReport(options.dailyReport, null, dashboard.generatedAt),
      summaryCards: [],
      facts: { body: [], training: [], nutrition: [], recovery: [] },
      dataQuality: buildEmptyDataQuality(),
      alerts: ['暂无可展示的每日数据'],
    };
  }

  return {
    title: '每日训练报告',
    generatedAt: dashboard.generatedAt ?? null,
    updatedTime: formatTimeLabel(dashboard.generatedAt),
    latestDataDate,
    dailyReport: normalizeDailyReport(options.dailyReport, latestDataDate, dashboard.generatedAt),
    summaryCards: buildSummaryCards({
      latestMeasurement,
      latestSleep,
      latestWorkout,
      latestNutrition,
      previousDay: daily.at(-2),
      settings: { ...settings, calorieRecommendedMax },
    }),
    facts: buildFacts({ latestDay, latestMeasurement, latestSleep, latestWorkout, latestNutrition, settings: { ...settings, calorieRecommendedMax } }),
    dataQuality,
    alerts: buildAlerts({ latestMeasurement, latestSleep, latestWorkout, latestNutrition, dataQuality, settings: { ...settings, calorieRecommendedMax } }),
  };
}

function buildSummaryCards({ latestMeasurement, latestSleep, latestWorkout, latestNutrition, previousDay, settings }) {
  const sleepMinutes = latestSleep?.totalSleepMinutes ?? latestSleep?.nightSleepMinutes;
  const calorieDelta = calculateCalorieDelta(latestNutrition?.totalCalories, settings.calorieRecommendedMax);

  return [
    {
      id: 'weight',
      title: '体重',
      value: `${formatNumber(latestMeasurement?.weightKg, 1)} kg`,
      hint: settings.weightGoalKg ? `目标 ${formatNumber(settings.weightGoalKg, 0)} kg` : '目标待设置',
      delta: formatDelta(latestMeasurement?.weightKg, previousDay?.measurement?.weightKg, '较上次', ' kg', 1),
      tone: 'teal',
    },
    {
      id: 'bodyFat',
      title: '体脂率',
      value: `${formatNumber(latestMeasurement?.bodyFatPct, 1)}%`,
      hint: '关注趋势，不看单日波动',
      delta: formatDelta(latestMeasurement?.bodyFatPct, previousDay?.measurement?.bodyFatPct, '较上次', '%', 1),
      tone: 'amber',
    },
    {
      id: 'sleep',
      title: '睡眠',
      value: Number.isFinite(Number(latestSleep?.sleepScore))
        ? `${formatNumber(latestSleep.sleepScore, 0)} 分`
        : `${formatNumber(Number(sleepMinutes) / 60, 1)} h`,
      hint: buildSleepHint(sleepMinutes, settings.sleepTargetMinutes),
      delta: latestSleep?.sleepScore !== null && latestSleep?.sleepScore !== undefined
        ? formatDelta(latestSleep.sleepScore, previousDay?.sleepSummary?.sleepScore, '较上次', ' 分', 0)
        : '',
      tone: Number(sleepMinutes) < settings.sleepTargetMinutes ? 'rose' : 'blue',
    },
    {
      id: 'calories',
      title: '今日摄入',
      value: `${formatNumber(latestNutrition?.totalCalories, 0)} kcal`,
      hint: settings.calorieRecommendedMax ? `建议上限 ${formatNumber(settings.calorieRecommendedMax, 0)} kcal` : '建议上限待设置',
      delta: calorieDelta === null ? '' : `${calorieDelta > 0 ? '+' : ''}${formatNumber(calorieDelta, 0)} kcal`,
      tone: calorieDelta > 0 ? 'rose' : 'green',
    },
  ];
}

function buildFacts({ latestDay, latestMeasurement, latestSleep, latestWorkout, latestNutrition, settings }) {
  return {
    body: [
      buildFact('skeletalMuscle', '骨骼肌量', `${formatNumber(latestMeasurement?.skeletalMuscleKg, 1)} kg`),
      buildFact('basalMetabolism', '基础代谢', `${formatNumber(latestMeasurement?.basalMetabolismKcal, 0)} kcal`),
      buildFact('bodyFat', '体脂率', `${formatNumber(latestMeasurement?.bodyFatPct, 1)}%`),
    ],
    training: [
      buildFact('duration', '训练时长', `${formatNumber(resolveWorkoutDurationMinutes(latestWorkout), 0)} 分钟`),
      buildFact('calories', '训练消耗', `${formatNumber(latestWorkout?.trainingCalories, 0)} kcal`),
      buildFact('types', '训练类型', resolveTrainingTypes(latestWorkout, latestDay)),
    ],
    nutrition: [
      buildFact('intake', '总摄入', `${formatNumber(latestNutrition?.totalCalories, 0)} kcal`),
      buildFact('meals', '已记录餐次', `${formatNumber(latestNutrition?.meals?.length, 0)} 餐`),
      buildFact(
        'limit',
        '建议上限',
        settings.calorieRecommendedMax ? `${formatNumber(settings.calorieRecommendedMax, 0)} kcal` : '待设置',
      ),
    ],
    recovery: [
      buildFact('sleep', '睡眠时长', `${formatNumber((latestSleep?.totalSleepMinutes ?? latestSleep?.nightSleepMinutes) / 60, 1)} 小时`),
      buildFact('score', '睡眠评分', `${formatNumber(latestSleep?.sleepScore, 0)} 分`),
      buildFact('hrv', 'HRV', `${formatNumber(latestSleep?.hrvMs, 0)} ms`),
    ],
  };
}

function buildDataQuality(latestDay, latestMeasurement) {
  const checks = [
    ['体测', Boolean(latestDay?.measurement || latestMeasurement)],
    ['训练', hasTraining(latestDay)],
    ['饮食', Number.isFinite(Number(latestDay?.nutrition?.totalCalories))],
    ['睡眠', hasSleep(latestDay)],
  ];
  const complete = checks.filter(([, present]) => present).length;
  return {
    completenessPct: Math.round((complete / checks.length) * 100),
    missingItems: checks.filter(([, present]) => !present).map(([label]) => label),
    label: `${complete}/${checks.length} 项关键数据已更新`,
  };
}

function buildEmptyDataQuality() {
  return { completenessPct: 0, missingItems: [], label: '暂无数据' };
}

function buildAlerts({ latestMeasurement, latestSleep, latestWorkout, latestNutrition, dataQuality, settings }) {
  const alerts = [];
  const sleepMinutes = latestSleep?.totalSleepMinutes ?? latestSleep?.nightSleepMinutes;
  const calorieDelta = calculateCalorieDelta(latestNutrition?.totalCalories, settings.calorieRecommendedMax);
  if (Number.isFinite(Number(sleepMinutes)) && Number(sleepMinutes) < 360) {
    alerts.push(`睡眠 ${formatNumber(Number(sleepMinutes) / 60, 1)} 小时偏少`);
  }
  if (calorieDelta !== null && calorieDelta > 0) {
    alerts.push(`摄入超过建议上限 ${formatNumber(calorieDelta, 0)} kcal`);
  }
  if (!latestMeasurement) alerts.push('缺少最新体测数据');
  if (!hasTraining({ workoutSummary: latestWorkout })) alerts.push('暂无训练记录');
  if (dataQuality?.missingItems?.length) alerts.push(`数据缺失：${dataQuality.missingItems.join('、')}`);
  return alerts.length ? alerts : ['当前没有需要优先处理的异常'];
}

function normalizeDailyReport(report, latestDataDate, generatedAt) {
  const emptySection = { summary: '暂无足够数据生成建议。', actions: [] };
  return {
    status: report?.status ?? 'unavailable',
    source: report?.source ?? 'none',
    reason: report?.reason ?? null,
    generatedAt: report?.generatedAt ?? generatedAt ?? null,
    latestDataDate: report?.latestDataDate ?? latestDataDate,
    report: {
      headline: report?.report?.headline ?? '等待最新数据生成每日建议。',
      training: report?.report?.training ?? emptySection,
      nutrition: report?.report?.nutrition ?? emptySection,
      recovery: report?.report?.recovery ?? emptySection,
      other: report?.report?.other ?? emptySection,
    },
  };
}

function buildFact(id, label, value) {
  return { id, label, value: value === 'undefined' || value === 'null' ? '—' : value };
}

function findLatestDay(dashboard, daily) {
  const latestDate = String(dashboard.latest?.daily?.date ?? '').trim();
  return daily.find((day) => day.date === latestDate) ?? daily.at(-1) ?? null;
}

function normalizeDailyEntries(daily) {
  return [...(Array.isArray(daily) ? daily : [])]
    .map((day) => ({ ...day, date: String(day?.date ?? '').slice(0, 10) }))
    .filter((day) => day.date)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function resolveCalorieRecommendedMax(nutrition, configured) {
  if (Number.isFinite(Number(configured)) && Number(configured) > 0) return Number(configured);
  const maxValues = (nutrition?.meals ?? [])
    .map((meal) => Number(meal?.recommendedMax))
    .filter((value) => Number.isFinite(value) && value > 0);
  return maxValues.length ? maxValues.reduce((total, value) => total + value, 0) : null;
}

function resolveTrainingTypes(workout, day) {
  const summaryTypes = Object.keys(workout?.countsByType ?? {});
  if (summaryTypes.length) return summaryTypes.join('、');

  const activityTypes = [...new Set((day?.activities ?? []).map((activity) => String(activity?.type ?? '').trim()).filter(Boolean))];
  return activityTypes.join('、') || '暂无记录';
}

function calculateCalorieDelta(intake, recommendedMax) {
  if (
    !Number.isFinite(Number(intake)) ||
    !Number.isFinite(Number(recommendedMax)) ||
    Number(recommendedMax) <= 0
  ) return null;
  return Number(intake) - Number(recommendedMax);
}

function buildSleepHint(sleepMinutes, targetMinutes) {
  if (!Number.isFinite(Number(sleepMinutes))) return '暂无睡眠记录';
  return Number(sleepMinutes) >= targetMinutes ? '达到恢复目标' : `目标 ${formatNumber(targetMinutes / 60, 1)} 小时`;
}

function formatDelta(current, previous, label, unit, digits) {
  if (!Number.isFinite(Number(current)) || !Number.isFinite(Number(previous))) return '';
  const delta = Number(current) - Number(previous);
  return `${label} ${delta > 0 ? '+' : ''}${formatNumber(delta, digits)}${unit}`;
}

function hasTraining(day) {
  return Number(day?.workoutSummary?.trainingCalories ?? 0) > 0 || Number(resolveWorkoutDurationMinutes(day?.workoutSummary) ?? 0) > 0 || (day?.activities?.length ?? 0) > 0;
}

function resolveWorkoutDurationMinutes(summary) {
  const explicit = Number(summary?.workoutDurationMinutes);
  if (Number.isFinite(explicit)) return explicit;
  const seconds = Number(summary?.totalDurationSeconds);
  return Number.isFinite(seconds) ? seconds / 60 : null;
}

function hasSleep(day) {
  return Number.isFinite(Number(day?.sleepSummary?.totalSleepMinutes ?? day?.sleepSummary?.nightSleepMinutes));
}

function formatTimeLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
