hexo.extend.helper.register('formatNumber', function (value, digits) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return Number(value).toFixed(digits ?? 2).replace(/\.00$/, '');
});

hexo.extend.helper.register('escapeHtml', function (value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
});
