export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return Number(value).toFixed(digits).replace(/\.00$/, '');
}

export function formatDuration(seconds) {
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

export function formatWorkoutDuration(day) {
  const workoutDurationMinutes = day?.workoutSummary?.workoutDurationMinutes;
  if (workoutDurationMinutes !== null && workoutDurationMinutes !== undefined) {
    return `${formatNumber(workoutDurationMinutes, 0)} 分钟`;
  }
  return formatDuration(day?.workoutSummary?.totalDurationSeconds || 0);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
