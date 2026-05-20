import { formatNumber, formatDuration, formatWorkoutDuration, escapeHtml } from './lib/format.mjs';

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
  const latestDashboardDate = findLatestDashboardDate({
    latestMeasurement,
    latestDay,
    daily: dailyEntries,
  });
  const chartWindowDays = 30;
  const dailyCardLimit = 4;
  const chartStartDate = latestDashboardDate ? addDays(latestDashboardDate, -(chartWindowDays - 1)) : null;
  const dailyOverviewEntries = [...dailyEntries].reverse().map((day) => {
    const date = normalizeDateValue(day.date) || String(day.date ?? '—');
    const weightLabel = day.measurement ? `${formatNumber(day.measurement.weightKg)} kg` : '无体脂数据';
    const activityCount = formatNumber(day.workoutSummary.totalActivities, 0);
    const trainingCaloriesLabel = `${formatNumber(day.workoutSummary.trainingCalories, 0)} kcal`;
    const workoutDurationLabel = formatWorkoutDuration(day);
    const cyclingDistanceLabel = `${formatNumber(day.workoutSummary.cyclingDistanceKm)} km`;
    const nutritionCaloriesLabel =
      day.nutrition.totalCalories === null ? '—' : `${formatNumber(day.nutrition.totalCalories, 0)} kcal`;
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
    </ul>
    ${tagsHtml}
  </article>`,
    };
  });
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
    chartPayload: {
      charts: filterChartsByDate(dashboard.charts || {}, chartStartDate),
    },
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
