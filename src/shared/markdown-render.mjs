export function appendMetric(lines, label, value, suffix = '') {
  if (value === null || value === undefined || value === '') {
    return;
  }
  lines.push(`- ${label}：${value}${suffix}`);
}
