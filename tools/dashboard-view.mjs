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
  const dailyOverviewEntries = [...dailyEntries].reverse().map((day) => ({
    date: normalizeDateValue(day.date) || String(day.date ?? '—'),
    weightLabel: day.measurement ? `${formatNumber(day.measurement.weightKg)} kg` : '无体脂数据',
    activityCount: formatNumber(day.workoutSummary.totalActivities, 0),
    trainingCaloriesLabel: `${formatNumber(day.workoutSummary.trainingCalories, 0)} kcal`,
    workoutDurationLabel: formatWorkoutDuration(day),
    cyclingDistanceLabel: `${formatNumber(day.workoutSummary.cyclingDistanceKm)} km`,
    nutritionCaloriesLabel:
      day.nutrition.totalCalories === null ? '—' : `${formatNumber(day.nutrition.totalCalories, 0)} kcal`,
    tags: Object.entries(day.workoutSummary.countsByType || {})
      .filter(([, count]) => count > 0)
      .map(([type, count]) => `${type} × ${count}`),
  }));
  const recentDays = dailyOverviewEntries.slice(0, dailyCardLimit);
  const dailyOverviewTotal = dailyOverviewEntries.length;
  const trainedDays = dailyEntries.filter((entry) => (entry.workoutSummary?.trainingCalories || 0) > 0).length;

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
    chartPayload: {
      charts: filterChartsByDate(dashboard.charts || {}, chartStartDate),
    },
  };
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return Number(value).toFixed(digits).replace(/\.00$/, '');
}

function formatDuration(seconds) {
  if (!seconds) {
    return '—';
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}小时${minutes}分`;
  }
  return `${minutes}分`;
}

function formatWorkoutDuration(day) {
  const workoutDurationMinutes = day?.workoutSummary?.workoutDurationMinutes;
  if (workoutDurationMinutes !== null && workoutDurationMinutes !== undefined) {
    return `${formatNumber(workoutDurationMinutes, 0)} 分钟`;
  }
  return formatDuration(day?.workoutSummary?.totalDurationSeconds || 0);
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
