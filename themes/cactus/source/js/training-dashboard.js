(function () {
  const payload = document.getElementById('training-dashboard-data');
  if (payload && typeof Chart !== 'undefined') {
    const data = JSON.parse(payload.textContent);
    const charts = data.charts || {};

    const labels = (charts.weightKg || []).map((point) => point.date);
    const weightValues = (charts.weightKg || []).map((point) => point.value);
    const bodyFatValues = (charts.bodyFatPct || []).map((point) => point.value);
    const muscleValues = (charts.skeletalMuscleKg || []).map((point) => point.value);
    const intakeValues = (charts.intakeCalories || []).map((point) => point.value);
    const trainingValues = (charts.trainingCalories || []).map((point) => point.value);
    const cyclingLabels = (charts.cyclingDistanceKm || []).map((point) => point.date);
    const cyclingValues = (charts.cyclingDistanceKm || []).map((point) => point.value);

    function shortDateLabel(date) {
      return String(date || '').slice(5);
    }

    function shouldShowDateTick(index, total) {
      if (total <= 10) {
        return true;
      }

      const interval = Math.ceil(total / 8);
      return index === 0 || index === total - 1 || index % interval === 0;
    }

    function makeCommonOptions() {
      return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            usePointStyle: true,
            boxWidth: 10,
          },
        },
        tooltip: {
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
          ticks: {
            autoSkip: false,
            callback(value, index, ticks) {
              const total = ticks?.length || 0;
              if (!shouldShowDateTick(index, total)) {
                return '';
              }
              const label = typeof this.getLabelForValue === 'function'
                ? this.getLabelForValue(value)
                : value;
              return shortDateLabel(label);
            },
          },
        },
        y: {
          ticks: {
            precision: 0,
          },
        },
      },
    };
    }

    new Chart(document.getElementById('weight-chart'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '体重 (kg)',
          data: weightValues,
          borderColor: '#0f766e',
          backgroundColor: 'rgba(15, 118, 110, 0.12)',
          tension: 0.35,
          fill: true,
          pointRadius: 3,
        }],
      },
      options: makeCommonOptions(),
    });

    new Chart(document.getElementById('composition-chart'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '体脂率 (%)',
          data: bodyFatValues,
          borderColor: '#ea580c',
          backgroundColor: 'rgba(234, 88, 12, 0.12)',
          tension: 0.35,
          fill: false,
          pointRadius: 3,
        }, {
          label: '骨骼肌量 (kg)',
          data: muscleValues,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.12)',
          tension: 0.35,
          fill: false,
          pointRadius: 3,
        }],
      },
      options: makeCommonOptions(),
    });

    new Chart(document.getElementById('calorie-chart'), {
      type: 'bar',
      data: {
        labels: (charts.intakeCalories || []).map((point) => point.date),
        datasets: [{
          label: '饮食摄入 (kcal)',
          data: intakeValues,
          backgroundColor: '#f97316',
        }, {
          label: '训练消耗 (kcal)',
          data: trainingValues,
          backgroundColor: '#14b8a6',
        }],
      },
      options: makeCommonOptions(),
    });

    new Chart(document.getElementById('cycling-chart'), {
      type: 'line',
      data: {
        labels: cyclingLabels,
        datasets: [{
          label: '骑行里程 (km)',
          data: cyclingValues,
          borderColor: '#7c3aed',
          backgroundColor: 'rgba(124, 58, 237, 0.12)',
          tension: 0.35,
          fill: true,
          pointRadius: 3,
        }],
      },
      options: makeCommonOptions(),
    });
  }

  const dailyPayload = document.getElementById('daily-overview-data');
  const dailyGrid = document.querySelector('[data-daily-grid]');
  const dailyStatus = document.querySelector('[data-daily-status]');
  const newerButton = document.querySelector('[data-daily-nav="prev"]');
  const olderButton = document.querySelector('[data-daily-nav="next"]');
  const sleepCards = document.querySelectorAll('.metric-card--sleep');

  function renderSleepProgress(card, ratio) {
    if (!card) {
      return;
    }

    const existing = card.querySelector('.metric-card__progress');
    if (existing) {
      existing.remove();
    }

    const progress = document.createElement('div');
    progress.className = 'metric-card__progress';
    progress.innerHTML = '<span class="metric-card__progress-bar"><span class="metric-card__progress-fill" style="width:' + Math.max(8, Math.min(100, ratio)) + '%"></span></span>';
    card.appendChild(progress);
  }

  sleepCards.forEach((card) => {
    const comparisonText = card.querySelector('.metric-card__comparison');
    const metaText = card.querySelector('.metric-card__meta');
    if (comparisonText) {
      comparisonText.setAttribute('aria-live', 'polite');
    }
    if (metaText) {
      metaText.setAttribute('aria-live', 'polite');
    }

    const valueNumber = card.querySelector('.metric-value__number');
    if (!valueNumber) {
      return;
    }

    const rawValue = parseFloat(valueNumber.textContent || '0');
    if (Number.isNaN(rawValue)) {
      return;
    }

    renderSleepProgress(card, rawValue);
  });

  function renderDailyRange(pageIndex, pageSize, total) {
    if (!total) {
      return '0 / 共 0 天';
    }

    const start = pageIndex * pageSize + 1;
    const end = Math.min(start + pageSize, total);

    return start + '-' + end + ' / 共 ' + total + ' 天';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderDailyCard(day) {
    const tags = (day.tags || []).length
      ? '<div class="day-card__tags">' + day.tags.map((tag) => '<span>' + escapeHtml(tag) + '</span>').join('') + '</div>'
      : '';

    return '<article class="day-card">' +
      '<div class="day-card__header">' +
      '<h3>' + escapeHtml(day.date) + '</h3>' +
      '<span>' + escapeHtml(day.weightLabel) + '</span>' +
      '</div>' +
      '<ul class="day-card__stats">' +
      '<li>活动次数：<strong>' + escapeHtml(day.activityCount) + '</strong></li>' +
      '<li>训练消耗：<strong>' + escapeHtml(day.trainingCaloriesLabel) + '</strong></li>' +
      '<li>锻炼时长：<strong>' + escapeHtml(day.workoutDurationLabel) + '</strong></li>' +
      '<li>骑行里程：<strong>' + escapeHtml(day.cyclingDistanceLabel) + '</strong></li>' +
      '<li>饮食热量：<strong>' + escapeHtml(day.nutritionCaloriesLabel) + '</strong></li>' +
      '<li>睡眠：<strong>' + escapeHtml(day.sleepLabel || '—') + '</strong></li>' +
      '</ul>' +
      tags +
      '</article>';
  }

  if (dailyPayload && dailyGrid && dailyStatus && newerButton && olderButton) {
    const entries = JSON.parse(dailyPayload.textContent || '[]');
    const pageSize = Number(dailyPayload.dataset.pageSize || '4');
    const maxPage = Math.max(Math.ceil(entries.length / pageSize) - 1, 0);
    let pageIndex = 0;

    function syncDailyOverview() {
      const start = pageIndex * pageSize;
      const visibleEntries = entries.slice(start, start + pageSize);

      dailyGrid.innerHTML = visibleEntries.map(renderDailyCard).join('');
      dailyStatus.textContent = renderDailyRange(pageIndex, pageSize, entries.length);
      newerButton.disabled = pageIndex === 0;
      olderButton.disabled = pageIndex >= maxPage;
    }

    newerButton.addEventListener('click', function () {
      if (pageIndex === 0) {
        return;
      }
      pageIndex -= 1;
      syncDailyOverview();
    });

    olderButton.addEventListener('click', function () {
      if (pageIndex >= maxPage) {
        return;
      }
      pageIndex += 1;
      syncDailyOverview();
    });

    syncDailyOverview();
  }
}());
