export function buildDashboardViewModel(snapshot) {
  const dashboard = snapshot || { daily: [], charts: {}, latest: {} };
  const latestMeasurement = dashboard.latest?.measurement || null;
  const latestDay = latestMeasurement
    ? dashboard.daily.find((entry) => entry.date === latestMeasurement.archivedDate) || dashboard.latest?.daily || null
    : dashboard.latest?.daily || null;
  const latestDayIndex = latestDay
    ? dashboard.daily.findIndex((entry) => entry.date === latestDay.date)
    : -1;
  const previousDay = latestDayIndex > 0 ? dashboard.daily[latestDayIndex - 1] : null;
  const latestDashboardDate =
    latestMeasurement?.archivedDate || latestDay?.date || dashboard.daily.at(-1)?.date || null;
  const chartWindowDays = 30;
  const dailyCardLimit = 4;
  const chartStartDate = latestDashboardDate ? addDays(latestDashboardDate, -(chartWindowDays - 1)) : null;
  const dailyOverviewEntries = [...(dashboard.daily || [])].reverse().map((day) => ({
    date: day.date,
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
  const trainedDays = (dashboard.daily || []).filter((entry) => (entry.workoutSummary?.trainingCalories || 0) > 0).length;

  return {
    generatedAt: dashboard.generatedAt ?? null,
    latestMeasurement,
    latestDay,
    previousDay,
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
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function filterChartsByDate(charts, startDate) {
  if (!startDate) {
    return charts;
  }

  return Object.fromEntries(
    Object.entries(charts).map(([key, points]) => [
      key,
      (points || []).filter((point) => point.date >= startDate),
    ]),
  );
}
