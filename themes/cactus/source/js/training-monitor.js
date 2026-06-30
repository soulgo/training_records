(function () {
  const payload = document.getElementById('training-monitor-data');
  if (!payload || typeof Chart === 'undefined') {
    return;
  }

  const data = JSON.parse(payload.textContent || '{}');
  const charts = data.charts || {};

  function getUnionLabels(seriesList) {
    return Array.from(new Set(
      seriesList.flatMap((series) => (series || []).map((point) => point.date).filter(Boolean)),
    )).sort();
  }

  function alignValues(series, labels) {
    const valuesByDate = new Map((series || []).map((point) => [point.date, point.value]));
    return labels.map((label) => valuesByDate.has(label) ? valuesByDate.get(label) : null);
  }

  function shortDateLabel(date) {
    return String(date || '').slice(5);
  }

  function shouldShowDateTick(index, total) {
    if (total <= 8) {
      return true;
    }
    const interval = Math.ceil(total / 6);
    return index === 0 || index === total - 1 || index % interval === 0;
  }

  function buildDateTicks() {
    return {
      autoSkip: true,
      autoSkipPadding: 12,
      maxTicksLimit: 7,
      color: '#64748b',
      maxRotation: 0,
      minRotation: 0,
      callback(value, index, ticks) {
        if (!shouldShowDateTick(index, ticks?.length || 0)) {
          return '';
        }
        const label = typeof this.getLabelForValue === 'function'
          ? this.getLabelForValue(value)
          : value;
        return shortDateLabel(label);
      },
    };
  }

  function makeOptions(options) {
    const extraScales = options?.extraScales || {};
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: false,
        axis: 'x',
      },
      animation: {
        duration: 750,
        easing: 'easeOutQuart',
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.94)',
          titleColor: '#f8fafc',
          bodyColor: '#e2e8f0',
          borderColor: 'rgba(148, 163, 184, 0.22)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            title(items) {
              return items?.[0]?.label || '';
            },
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: false,
          },
          ticks: buildDateTicks(),
        },
        y: {
          grid: {
            color: 'rgba(148, 163, 184, 0.16)',
          },
          ticks: {
            color: '#64748b',
            precision: 0,
          },
        },
        ...extraScales,
      },
    };
  }

  function renderLegend(chart, chartId) {
    const host = document.querySelector('[data-monitor-legend-for="' + chartId + '"]');
    if (!host) {
      return;
    }

    host.setAttribute('role', 'list');
    host.setAttribute('aria-label', '图例：' + chart.data.datasets.map((dataset) => dataset.label).join('、'));
    host.innerHTML = chart.data.datasets.map((dataset) => {
      const color = String(dataset.borderColor || dataset.backgroundColor || '#2563eb');
      return '<span class="monitor-chart-legend__item" role="listitem">' +
        '<span class="monitor-chart-legend__swatch" style="--legend-color:' + color + ';" aria-hidden="true"></span>' +
        '<span class="monitor-chart-legend__label">' + escapeHtml(dataset.label) + '</span>' +
      '</span>';
    }).join('');
  }

  function createChart(chartId, config) {
    const canvas = document.getElementById(chartId);
    if (!canvas) {
      return null;
    }
    const chart = new Chart(canvas, config);
    renderLegend(chart, chartId);
    return chart;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const calorieLabels = getUnionLabels([charts.intakeCalories, charts.trainingCalories]);
  createChart('monitor-calorie-chart', {
    type: 'bar',
    data: {
      labels: calorieLabels,
      datasets: [{
        label: '摄入 kcal',
        data: alignValues(charts.intakeCalories, calorieLabels),
        backgroundColor: 'rgba(217, 119, 6, 0.78)',
        borderRadius: 4,
        maxBarThickness: 14,
      }, {
        label: '训练消耗 kcal',
        data: alignValues(charts.trainingCalories, calorieLabels),
        backgroundColor: 'rgba(15, 118, 110, 0.78)',
        borderRadius: 4,
        maxBarThickness: 14,
      }],
    },
    options: makeOptions(),
  });

  const bodyLabels = getUnionLabels([charts.weightKg, charts.bodyFatPct]);
  createChart('monitor-body-chart', {
    type: 'line',
    data: {
      labels: bodyLabels,
      datasets: [{
        label: '体重 kg',
        data: alignValues(charts.weightKg, bodyLabels),
        borderColor: '#0f766e',
        backgroundColor: 'rgba(15, 118, 110, 0.12)',
        tension: 0.3,
        fill: false,
        pointRadius: 2.5,
      }, {
        label: '体脂率 %',
        data: alignValues(charts.bodyFatPct, bodyLabels),
        borderColor: '#e11d48',
        backgroundColor: 'rgba(225, 29, 72, 0.12)',
        tension: 0.3,
        fill: false,
        pointRadius: 2.5,
      }],
    },
    options: makeOptions(),
  });

  const sleepLabels = getUnionLabels([charts.sleepTotalMinutes, charts.sleepScore]);
  createChart('monitor-sleep-chart', {
    type: 'bar',
    data: {
      labels: sleepLabels,
      datasets: [{
        label: '睡眠分钟',
        data: alignValues(charts.sleepTotalMinutes, sleepLabels),
        backgroundColor: 'rgba(37, 99, 235, 0.72)',
        borderRadius: 4,
        maxBarThickness: 14,
      }, {
        type: 'line',
        label: '睡眠评分',
        data: alignValues(charts.sleepScore, sleepLabels),
        yAxisID: 'score',
        borderColor: '#7c3aed',
        backgroundColor: 'rgba(124, 58, 237, 0.12)',
        tension: 0.3,
        fill: false,
        pointRadius: 2.5,
      }],
    },
    options: makeOptions({
      extraScales: {
        score: {
          position: 'right',
          grid: {
            drawOnChartArea: false,
          },
          min: 0,
          max: 100,
          ticks: {
            color: '#64748b',
            precision: 0,
          },
        },
      },
    }),
  });

  const workoutLabels = getUnionLabels([charts.workoutDurationMinutes, charts.averageHeartRateBpm]);
  createChart('monitor-workout-chart', {
    type: 'bar',
    data: {
      labels: workoutLabels,
      datasets: [{
        label: '锻炼分钟',
        data: alignValues(charts.workoutDurationMinutes, workoutLabels),
        backgroundColor: 'rgba(22, 163, 74, 0.72)',
        borderRadius: 4,
        maxBarThickness: 14,
      }, {
        type: 'line',
        label: '平均心率',
        data: alignValues(charts.averageHeartRateBpm, workoutLabels),
        yAxisID: 'heartRate',
        borderColor: '#dc2626',
        backgroundColor: 'rgba(220, 38, 38, 0.12)',
        tension: 0.3,
        fill: false,
        pointRadius: 2.5,
      }],
    },
    options: makeOptions({
      extraScales: {
        heartRate: {
          position: 'right',
          grid: {
            drawOnChartArea: false,
          },
          ticks: {
            color: '#64748b',
            precision: 0,
          },
        },
      },
    }),
  });
}());
