import { formatNumber, formatWorkoutDuration, escapeHtml } from '../shared/format.mjs';

export function buildDashboardViewModel(snapshot) {
  const dashboard = snapshot || { daily: [], charts: {}, latest: {} };
  const dailyEntries = Array.isArray(dashboard.daily) ? dashboard.daily : [];
  const latestMeasurement = dashboard.latest?.measurement || null;
  const latestMeasurementDate = normalizeDateValue(latestMeasurement?.archivedDate);
  const latestDay = latestMeasurement
    ? dailyEntries.find((entry) => normalizeDateValue(entry.date) === latestMeasurementDate) || dashboard.latest?.daily || null
    : dashboard.latest?.daily || null;
  const latestDayDate = normalizeDateValue(latestDay?.date);
  const latestDayIndex = latestDay
    ? dailyEntries.findIndex((entry) => normalizeDateValue(entry.date) === latestDayDate)
    : -1;
  const previousDay = latestDayIndex > 0 ? dailyEntries[latestDayIndex - 1] : null;
  const latestDashboardDate = findLatestDashboardDate({ latestMeasurement, latestDay, daily: dailyEntries });
  const chartWindowDays = 30;
  const dailyCardLimit = 4;
  const sleepDays = dailyEntries.filter((day) => hasSleepSummary(day?.sleepSummary));
  const sleepSummarySource = sleepDays.at(-1)?.sleepSummary ?? null;
  const sleepPreviousSource = sleepDays.at(-2)?.sleepSummary ?? null;
  const chartStartDate = latestDashboardDate ? addDays(latestDashboardDate, -(chartWindowDays - 1)) : null;
  const dailyOverviewEntries = [...dailyEntries].reverse().map((day) => buildDailyOverviewEntry(day));
  const recentDays = dailyOverviewEntries.slice(0, dailyCardLimit);
  const dailyOverviewTotal = dailyOverviewEntries.length;
  const trainedDays = dailyEntries.filter((entry) => (entry.workoutSummary?.trainingCalories || 0) > 0).length;
  const totalArchivedDays = dailyEntries.length;

  return {
    generatedAt: dashboard.generatedAt ?? null,
    latestMeasurement: normalizeMeasurementDate(latestMeasurement),
    latestDay: normalizeDayDate(latestDay),
    previousDay: normalizeDayDate(previousDay),
    dailyOverviewHint: buildDailyOverviewHint(),
    latestDashboardDate,
    chartWindowDays,
    dailyCardLimit,
    dailyOverviewEntries,
    recentDays,
    dailyOverviewTotal,
    trainedDays,
    totalArchivedDays,
    overviewStats: buildOverviewStats({ trainedDays, totalArchivedDays }),
    overviewMeta: buildOverviewMeta({ latestMeasurement, previousDay }),
    primaryMetrics: withComparisonHtml(
      buildPrimaryMetrics({ latestMeasurement, latestDay, previousDay }),
      'hero-card__comparison',
    ),
    secondaryMetrics: withComparisonHtml(
      buildSecondaryMetrics({ latestMeasurement, latestDay, previousDay }),
      'metric-card__comparison',
    ),
    sleepCards: withComparisonHtml(
      buildSleepCards({ sleepSummarySource, sleepPreviousSource }),
      'metric-card__comparison',
    ),
    chartCards: buildChartCards(),
    chartPayload: {
      charts: filterChartsByDate(dashboard.charts || {}, chartStartDate),
    },
  };
}

function buildOverviewStats({ trainedDays, totalArchivedDays }) {
  return [
    {
      label: '已训练天数',
      value: `${formatNumber(trainedDays, 0)} 天`,
      hint: '当前记录中有训练消耗的日期',
    },
    {
      label: '累计训练归档',
      value: `${formatNumber(totalArchivedDays, 0)} 天`,
      hint: '完整训练归档天数',
    },
  ];
}

function buildOverviewMeta({ latestMeasurement, previousDay }) {
  return [
    { label: '真实测量', value: latestMeasurement?.measuredAt || '—' },
    { label: '对比日期', value: previousDay?.date || '暂无前一日' },
  ];
}

function buildPrimaryMetrics({ latestMeasurement, latestDay, previousDay }) {
  return [
    {
      title: '体重',
      valueHtml: renderNumberValue(formatNumber(latestMeasurement.weightKg), 'kg'),
      metaHtml: renderMetaLine('BMI', formatNumber(latestMeasurement.bmi, 1)),
      comparison: buildComparison(latestMeasurement.weightKg, previousDay?.measurement?.weightKg),
    },
    {
      title: '体脂率',
      valueHtml: renderNumberValue(`${formatNumber(latestMeasurement.bodyFatPct, 1)}`, '%'),
      metaHtml: renderMetaLine('骨骼肌量', `${formatNumber(latestMeasurement.skeletalMuscleKg)} kg`),
      comparison: buildComparison(latestMeasurement.bodyFatPct, previousDay?.measurement?.bodyFatPct),
    },
    {
      title: '训练消耗',
      valueHtml: renderNumberValue(formatNumber(latestDay?.workoutSummary?.trainingCalories || 0, 0), 'kcal'),
      metaHtml: renderMetaLine('饮食摄入', `${formatNumber(latestDay?.nutrition?.totalCalories, 0)} kcal`),
      comparison: buildComparison(latestDay?.workoutSummary?.trainingCalories || 0, previousDay?.workoutSummary?.trainingCalories),
    },
    {
      title: '锻炼时长',
      valueHtml:
        latestDay?.workoutSummary?.workoutDurationMinutes !== null && latestDay?.workoutSummary?.workoutDurationMinutes !== undefined
          ? renderNumberValue(formatNumber(latestDay.workoutSummary.workoutDurationMinutes, 0), '分钟')
          : renderTextValue(formatWorkoutDuration(latestDay), 'metric-value--compact'),
      metaHtml:
        latestDay?.workoutSummary?.activeHours !== null && latestDay?.workoutSummary?.activeHours !== undefined
          ? renderMetaLine('活动小时数', `${formatNumber(latestDay.workoutSummary.activeHours, 0)} 小时`)
          : renderMetaLine('身体类型', latestMeasurement.bodyType || '—'),
      comparison: buildComparison(getWorkoutDurationValue(latestDay), getWorkoutDurationValue(previousDay)),
    },
  ];
}

function buildSecondaryMetrics({ latestMeasurement, latestDay, previousDay }) {
  return [
    {
      title: '基础代谢',
      valueHtml: renderNumberValue(formatNumber(latestMeasurement.basalMetabolismKcal, 0), 'kcal/日'),
      metaHtml: renderMetaLine('内脏脂肪等级', formatNumber(latestMeasurement.visceralFatLevel, 1)),
      comparison: buildComparison(latestMeasurement.basalMetabolismKcal, previousDay?.measurement?.basalMetabolismKcal),
    },
    {
      title: '水分与蛋白质',
      valueHtml: renderCompositeValue([
        { value: formatNumber(latestMeasurement.bodyWaterPct, 1), unit: '%' },
        { value: formatNumber(latestMeasurement.proteinPct, 1), unit: '%' },
      ]),
      metaHtml: renderMetaLine('身体年龄', `${formatNumber(latestMeasurement.bodyAge, 0)} 岁`),
      comparison: buildComparison(latestMeasurement.bodyWaterPct, previousDay?.measurement?.bodyWaterPct),
    },
    {
      title: '骑行里程',
      valueHtml: renderNumberValue(formatNumber(latestDay?.workoutSummary?.cyclingDistanceKm || 0), 'km'),
      metaHtml: renderMetaLine('当日活动', `${formatNumber(latestDay?.workoutSummary?.totalActivities || 0, 0)} 次`),
      comparison: buildComparison(latestDay?.workoutSummary?.cyclingDistanceKm || 0, previousDay?.workoutSummary?.cyclingDistanceKm),
    },
  ];
}

function buildSleepCards({ sleepSummarySource, sleepPreviousSource }) {
  const sleep = normalizeSleepDisplaySummary(sleepSummarySource || {});
  const previousSleep = normalizeSleepDisplaySummary(sleepPreviousSource || {});
  const deepRatio = sleep.deepSleepRatioPct ?? buildSleepRatioValue(sleep.deepSleepMinutes, sleep.totalSleepMinutes);
  const lightRatio = sleep.lightSleepRatioPct ?? buildSleepRatioValue(sleep.lightSleepMinutes, sleep.totalSleepMinutes);

  return [
    {
      title: '总睡眠',
      valueHtml: renderNumberValue(formatNumber(sleep.totalSleepMinutes, 0), '分钟'),
      metaHtml: renderMetaLine('夜间睡眠', `${formatNumber(sleep.nightSleepMinutes, 0)} 分钟`),
      comparison: buildComparison(sleep.totalSleepMinutes, previousSleep.totalSleepMinutes),
    },
    {
      title: '深睡 / 浅睡',
      valueHtml: renderCompositeValue([
        { value: formatNumber(sleep.deepSleepMinutes, 0), unit: '分钟' },
        { value: formatNumber(sleep.lightSleepMinutes, 0), unit: '分钟' },
      ]),
      metaHtml: renderMetaLine('REM / 清醒', `${formatNumber(sleep.remSleepMinutes, 0)} / ${formatNumber(sleep.awakeMinutes, 0)} 分钟`),
      comparison: buildComparison(sleep.deepSleepMinutes, previousSleep.deepSleepMinutes),
    },
    {
      title: '深睡 / 浅睡比例',
      valueHtml: renderCompositeValue([
        { value: deepRatio, unit: '%' },
        { value: lightRatio, unit: '%' },
      ]),
      metaHtml: renderMetaLine('深睡 / 浅睡比', buildSleepRatioText(sleep.deepSleepMinutes, sleep.lightSleepMinutes)),
      comparison: buildSleepRatioComparison(sleep, previousSleep),
    },
  ];
}

function hasSleepSummary(sleep) {
  return Boolean(sleep && [
    sleep.totalSleepMinutes,
    sleep.nightSleepMinutes,
    sleep.napMinutes,
  ].some((value) => value !== null && value !== undefined));
}

function normalizeSleepDisplaySummary(sleep) {
  if (!sleep) {
    return {};
  }
  return {
    ...sleep,
    totalSleepMinutes: sleep.totalSleepMinutes ?? sleep.nightSleepMinutes ?? null,
  };
}

function buildSleepRatioValue(partMinutes, totalMinutes) {
  if (partMinutes === null || partMinutes === undefined || totalMinutes === null || totalMinutes === undefined || totalMinutes === 0) {
    return '—';
  }
  return formatNumber((partMinutes / totalMinutes) * 100, 1);
}

function buildSleepRatioText(deepSleepMinutes, lightSleepMinutes) {
  const deep = formatNumber(deepSleepMinutes, 0);
  const light = formatNumber(lightSleepMinutes, 0);
  if (deep === '—' && light === '—') {
    return '—';
  }
  return `${deep} / ${light}`;
}

function buildSleepRatioComparison(sleep, previousSleep) {
  const currentRatio = toRatioValue(sleep.deepSleepMinutes, sleep.lightSleepMinutes);
  const previousRatio = toRatioValue(previousSleep.deepSleepMinutes, previousSleep.lightSleepMinutes);
  return buildComparison(currentRatio, previousRatio);
}

function toRatioValue(deepSleepMinutes, lightSleepMinutes) {
  const deep = Number(deepSleepMinutes ?? 0);
  const light = Number(lightSleepMinutes ?? 0);
  const total = deep + light;
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  return (deep / total) * 100;
}

function buildChartCards() {
  return [
    { id: 'weight-chart', title: '体重趋势', subtitle: '最近 30 天归档走势', className: 'chart-card chart-card--wide' },
    { id: 'composition-chart', title: '体脂与骨骼肌', subtitle: '观察减脂与保肌变化', className: 'chart-card chart-card--wide' },
    { id: 'calorie-chart', title: '热量对比', subtitle: '摄入与训练消耗对照', className: 'chart-card' },
    { id: 'cycling-chart', title: '骑行里程', subtitle: '通勤有氧累积', className: 'chart-card' },
  ];
}

function withComparisonHtml(metrics, className) {
  return metrics.map((metric) => ({
    ...metric,
    comparisonHtml: renderComparison(metric.comparison, className),
  }));
}

function buildDailyOverviewEntry(day) {
  const date = normalizeDateValue(day.date) || String(day.date ?? '—');
  const weightLabel = day.measurement ? `${formatNumber(day.measurement.weightKg)} kg` : '无体脂数据';
  const activityCount = formatNumber(day.workoutSummary.totalActivities, 0);
  const trainingCaloriesLabel = `${formatNumber(day.workoutSummary.trainingCalories, 0)} kcal`;
  const workoutDurationLabel = formatWorkoutDuration(day);
  const cyclingDistanceLabel = `${formatNumber(day.workoutSummary.cyclingDistanceKm)} km`;
  const nutritionCaloriesLabel = day.nutrition.totalCalories === null ? '—' : `${formatNumber(day.nutrition.totalCalories, 0)} kcal`;
  const sleepTotalMinutes = day.sleepSummary?.totalSleepMinutes ?? day.sleepSummary?.nightSleepMinutes ?? null;
  const sleepLabel = sleepTotalMinutes !== null && sleepTotalMinutes !== undefined
    ? `${formatNumber(sleepTotalMinutes, 0)} 分钟`
    : '—';
  const tags = Object.entries(day.workoutSummary.countsByType || {})
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} × ${count}`);
  const tagsHtml = tags.length
    ? `<div class="day-card__tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>`
    : '';

  return {
    date,
    weightLabel,
    activityCount,
    trainingCaloriesLabel,
    workoutDurationLabel,
    cyclingDistanceLabel,
    nutritionCaloriesLabel,
    sleepLabel,
    tags,
    cardHtml: `<article class="day-card">
    <div class="day-card__header">
      <h3>${escapeHtml(date)}</h3>
      <span>${escapeHtml(weightLabel)}</span>
    </div>
    <ul class="day-card__stats">
      <li>活动次数：<strong>${escapeHtml(activityCount)}</strong></li>
      <li>训练消耗：<strong>${escapeHtml(trainingCaloriesLabel)}</strong></li>
      <li>锻炼时长：<strong>${escapeHtml(workoutDurationLabel)}</strong></li>
      <li>骑行里程：<strong>${escapeHtml(cyclingDistanceLabel)}</strong></li>
      <li>饮食热量：<strong>${escapeHtml(nutritionCaloriesLabel)}</strong></li>
      <li>睡眠：<strong>${escapeHtml(sleepLabel)}</strong></li>
    </ul>
    ${tagsHtml}
  </article>`,
  };
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

function filterChartsByDate(charts, startDate) {
  return Object.fromEntries(
    Object.entries(charts).map(([key, points]) => [
      key,
      (points || [])
        .map((point) => {
          const normalizedDate = normalizeDateValue(point?.date);
          return normalizedDate ? { ...point, date: normalizedDate } : point;
        })
        .filter((point) => {
          const normalizedDate = normalizeDateValue(point?.date);
          return !startDate || (normalizedDate && normalizedDate >= startDate);
        }),
    ]),
  );
}

function findLatestDashboardDate({ latestMeasurement, latestDay, daily }) {
  return (
    normalizeDateValue(latestMeasurement?.archivedDate) ||
    normalizeDateValue(latestDay?.date) ||
    [...(daily || [])].reverse().map((entry) => normalizeDateValue(entry?.date)).find(Boolean) ||
    null
  );
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

function normalizeMeasurementDate(measurement) {
  if (!measurement) {
    return measurement;
  }
  const archivedDate = normalizeDateValue(measurement.archivedDate);
  return archivedDate ? { ...measurement, archivedDate } : measurement;
}

function normalizeDayDate(day) {
  if (!day) {
    return day;
  }
  const date = normalizeDateValue(day.date);
  return {
    ...day,
    date: date || day.date,
    measurement: normalizeMeasurementDate(day.measurement),
    measurements: (day.measurements || []).map(normalizeMeasurementDate),
  };
}

function buildDailyOverviewHint() {
  return '顶部主卡按最新体脂归档日展示，最近活动以下方日期卡片为准';
}

function summarizeSleepStageText(records) {
  const lastWithStage = [...(records || [])].reverse().find((record) => record?.sleepStageText || record?.sleepStageDetail);
  if (!lastWithStage) {
    return '';
  }
  return [lastWithStage.sleepStageText, lastWithStage.sleepStageDetail].filter(Boolean).join(' / ');
}

function buildComparison(current, previous) {
  if (
    current === null || current === undefined || Number.isNaN(current) ||
    previous === null || previous === undefined || Number.isNaN(previous) ||
    previous === 0
  ) {
    return {
      direction: 'neutral',
      arrow: '·',
      label: '暂无前一日对比',
      shortLabel: '待比较',
      value: '',
      text: '暂无前一日对比',
      strength: 0,
      delta: null,
      ratio: null,
    };
  }

  const delta = current - previous;
  const ratio = Math.abs(delta / previous) * 100;
  if (delta === 0) {
    return {
      direction: 'flat',
      arrow: '→',
      label: '较前一日',
      shortLabel: '持平',
      value: '持平',
      text: '较前一日持平',
      strength: 18,
      delta,
      ratio,
    };
  }

  const isUp = delta > 0;
  const label = `较前一日${isUp ? '新增' : '下降'}`;
  const value = `${formatNumber(ratio, 2)}%`;
  return {
    direction: isUp ? 'up' : 'down',
    arrow: isUp ? '↑' : '↓',
    label,
    shortLabel: isUp ? '上升' : '回落',
    value,
    text: `${label} ${value}`,
    strength: Math.min(100, Math.max(Math.round(ratio * 0.85), 16)),
    delta,
    ratio,
  };
}

function renderNumberValue(number, unit) {
  return `<div class="metric-value"><span class="metric-value__number">${escapeHtml(number)}</span><span class="metric-value__unit">${escapeHtml(unit)}</span></div>`;
}

function renderTextValue(text, modifier = '') {
  return `<div class="metric-value${modifier ? ` ${modifier}` : ''}"><span class="metric-value__number">${escapeHtml(text)}</span></div>`;
}

function renderCompositeValue(values) {
  return `<div class="metric-value metric-value--composite">${values.map((item) => `<span class="metric-value__pair"><span class="metric-value__number">${escapeHtml(item.value)}</span><span class="metric-value__unit">${escapeHtml(item.unit)}</span></span>`).join('<span class="metric-value__separator">/</span>')}</div>`;
}

function renderMetaLine(label, value) {
  return `<div class="metric-meta"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderComparison(comparison, className) {
  const valueMarkup = comparison.value
    ? `<span class="comparison-pill__value">${escapeHtml(comparison.value)}</span>`
    : '';
  const strengthMarkup = comparison.strength
    ? `<span class="comparison-pill__meter"><span class="comparison-pill__meter-fill" style="width:${comparison.strength}%"></span></span>`
    : `<span class="comparison-pill__meter comparison-pill__meter--empty"></span>`;

  return `<div class="${className} comparison-pill comparison-pill--${escapeHtml(comparison.direction)}"><div class="comparison-pill__summary"><span class="comparison-pill__arrow">${escapeHtml(comparison.arrow)}</span><span>${escapeHtml(comparison.text)}</span><span class="comparison-pill__label" aria-hidden="true">${escapeHtml(comparison.shortLabel)}</span></div>${valueMarkup}${strengthMarkup}</div>`;
}

function getWorkoutDurationValue(day) {
  const workoutDurationMinutes = day?.workoutSummary?.workoutDurationMinutes;
  if (workoutDurationMinutes !== null && workoutDurationMinutes !== undefined) {
    return workoutDurationMinutes;
  }
  const totalDurationSeconds = day?.workoutSummary?.totalDurationSeconds;
  if (!totalDurationSeconds) {
    return null;
  }
  return Number((totalDurationSeconds / 60).toFixed(2));
}
