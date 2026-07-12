(function () {
  const actionHistoryPayload = document.getElementById('action-history-data');
  const actionHistoryGrid = document.querySelector('[data-action-history-grid]');
  const actionHistoryStatus = document.querySelector('[data-action-history-status]');
  const actionHistoryNewerButton = document.querySelector('[data-action-history-nav="prev"]');
  const actionHistoryOlderButton = document.querySelector('[data-action-history-nav="next"]');
  const parameterHealthPayload = document.getElementById('parameter-health-data');
  const parameterHealthGrid = document.querySelector('[data-parameter-health-grid]');
  const parameterHealthStatus = document.querySelector('[data-parameter-health-status]');
  const parameterHealthNewerButton = document.querySelector('[data-parameter-health-nav="prev"]');
  const parameterHealthOlderButton = document.querySelector('[data-parameter-health-nav="next"]');
  const parameterHealthModal = document.querySelector('[data-parameter-health-modal]');
  const parameterHealthModalName = document.querySelector('[data-parameter-health-modal-name]');
  const parameterHealthModalCategory = document.querySelector('[data-parameter-health-modal-category]');
  const parameterHealthModalScope = document.querySelector('[data-parameter-health-modal-scope]');
  const parameterHealthModalStatus = document.querySelector('[data-parameter-health-modal-status]');
  const parameterHealthModalCheck = document.querySelector('[data-parameter-health-modal-check]');
  const parameterHealthModalLatency = document.querySelector('[data-parameter-health-modal-latency]');
  const parameterHealthModalHealthy = document.querySelector('[data-parameter-health-modal-healthy]');
  const parameterHealthModalExpiry = document.querySelector('[data-parameter-health-modal-expiry]');
  const parameterHealthModalEvidence = document.querySelector('[data-parameter-health-modal-evidence]');
  const parameterHealthModalChecked = document.querySelector('[data-parameter-health-modal-checked]');
  const parameterHealthModalMessage = document.querySelector('[data-parameter-health-modal-message]');

  function renderActionRange(pageIndex, pageSize, total) {
    if (!total) {
      return '0 / 共 0 次';
    }

    const start = pageIndex * pageSize + 1;
    const end = Math.min(start + pageSize - 1, total);

    return start + '-' + end + ' / 共 ' + total + ' 次';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderParameterRange(pageIndex, pageSize, total) {
    if (!total) {
      return '0 / 共 0 个';
    }

    const start = pageIndex * pageSize + 1;
    const end = Math.min(start + pageSize - 1, total);
    return start + '-' + end + ' / 共 ' + total + ' 个';
  }

  function renderActionRun(run) {
    const tone = escapeHtml(run.tone || 'neutral');
    const href = escapeHtml(run.htmlUrl || '#');
    const statusLabel = escapeHtml(run.statusLabel || '未知');
    const runNumber = run.runNumber ? ' #' + escapeHtml(run.runNumber) : '';
    const commit = run.commitShortSha
      ? '<span>Commit <strong>' + escapeHtml(run.commitShortSha) + '</strong></span>'
      : '';
    const actor = run.actorLogin
      ? '<span>pushed by <strong>' + escapeHtml(run.actorLogin) + '</strong></span>'
      : '';
    const error = run.errorSummary
      ? '<small class="action-run__error">' + escapeHtml(run.errorSummary) + '</small>'
      : '';

    return '<a class="action-run action-run--' + tone + '" href="' + href + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="action-run__status" aria-label="' + statusLabel + '"></span>' +
      '<div class="action-run__main">' +
      '<h3>' + escapeHtml(run.title) + '</h3>' +
      '<p>' +
      '<span>' + escapeHtml(run.workflowName) + runNumber + '</span>' +
      commit +
      actor +
      '</p>' +
      error +
      '</div>' +
      '<span class="action-run__branch">' + escapeHtml(run.branch || '') + '</span>' +
      '<div class="action-run__metrics">' +
      '<span>' + escapeHtml(run.timeLabel || '—') + '</span>' +
      '<span>' + escapeHtml(run.durationLabel || '—') + '</span>' +
      '</div>' +
      '</a>';
  }

  function renderParameterHealthRow(item) {
    const tone = escapeHtml(item.tone || 'neutral');

    return '<div class="parameter-health__row parameter-health__row--' + tone + '" role="listitem" tabindex="0" data-parameter-health-open="' + escapeHtml(item.key) + '">' +
      '<span class="parameter-health__identity">' +
      '<strong class="parameter-health__name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</strong>' +
      '<small>' + escapeHtml(item.category) + ' · ' + escapeHtml(item.scope) + ' · ' + escapeHtml(item.evidenceLabel || '仅 registry 登记') + '</small>' +
      '</span>' +
      '<span class="parameter-health__due">' + escapeHtml(item.checkTypeLabel || '未知探测方式') + '<small>' + escapeHtml(item.latencyLabel || '—') + ' · ' + escapeHtml(item.lastCheckedLabel || '—') + '</small></span>' +
      '<span class="parameter-health__state">' +
      '<span class="parameter-health__status"><em>' + escapeHtml(item.statusLabel) + '</em></span>' +
      '<span class="parameter-health__message">' + escapeHtml(item.message || '—') + '</span>' +
      '</span>' +
      '</div>';
  }

  function closeParameterHealthModal() {
    if (!parameterHealthModal) {
      return;
    }
    parameterHealthModal.hidden = true;
    document.body.classList.remove('parameter-health-modal-open');
  }

  function openParameterHealthModal(item) {
    if (!parameterHealthModal || !item) {
      return;
    }

    const checkedText = [item.checkedAtLabel || '—', item.lastCheckedLabel || '—'].filter(Boolean).join(' · ');

    parameterHealthModalName.textContent = item.name || '—';
    parameterHealthModalCategory.textContent = item.category || '—';
    parameterHealthModalScope.textContent = item.scope || '—';
    parameterHealthModalStatus.textContent = item.statusLabel || '未知';
    if (parameterHealthModalCheck) {
      parameterHealthModalCheck.textContent = item.checkTypeLabel || '未知探测方式';
    }
    if (parameterHealthModalLatency) {
      parameterHealthModalLatency.textContent = item.latencyLabel || '—';
    }
    if (parameterHealthModalHealthy) {
      parameterHealthModalHealthy.textContent = item.lastHealthyLabel || '尚无成功记录';
    }
    if (parameterHealthModalExpiry) {
      parameterHealthModalExpiry.textContent = item.expiryLabel || 'Provider 未提供到期时间';
    }
    if (parameterHealthModalEvidence) {
      parameterHealthModalEvidence.textContent = item.evidenceLabel || '仅 registry 登记';
    }
    parameterHealthModalChecked.textContent = checkedText;
    parameterHealthModalMessage.textContent = item.message || '—';
    parameterHealthModal.hidden = false;
    document.body.classList.add('parameter-health-modal-open');
  }

  if (
    actionHistoryPayload &&
    actionHistoryGrid &&
    actionHistoryStatus &&
    actionHistoryNewerButton &&
    actionHistoryOlderButton
  ) {
    const entries = JSON.parse(actionHistoryPayload.textContent || '[]');
    const pageSize = Number(actionHistoryPayload.dataset.pageSize || '15');
    const maxPage = Math.max(Math.ceil(entries.length / pageSize) - 1, 0);
    let pageIndex = 0;

    function syncActionHistory() {
      const start = pageIndex * pageSize;
      const visibleEntries = entries.slice(start, start + pageSize);

      actionHistoryGrid.innerHTML = visibleEntries.map(renderActionRun).join('');
      actionHistoryStatus.textContent = renderActionRange(pageIndex, pageSize, entries.length);
      actionHistoryNewerButton.disabled = pageIndex === 0;
      actionHistoryOlderButton.disabled = pageIndex >= maxPage;
    }

    actionHistoryNewerButton.addEventListener('click', function () {
      if (pageIndex === 0) {
        return;
      }
      pageIndex -= 1;
      syncActionHistory();
    });

    actionHistoryOlderButton.addEventListener('click', function () {
      if (pageIndex >= maxPage) {
        return;
      }
      pageIndex += 1;
      syncActionHistory();
    });

    syncActionHistory();
  }

  if (parameterHealthPayload && parameterHealthGrid) {
    const entries = JSON.parse(parameterHealthPayload.textContent || '[]');
    const entriesByKey = new Map(entries.map(function (entry) {
      return [String(entry.key || ''), entry];
    }));
    const pageSize = Number(parameterHealthPayload.dataset.pageSize || '5');
    const maxPage = Math.max(Math.ceil(entries.length / pageSize) - 1, 0);
    let pageIndex = 0;

    function syncParameterHealth() {
      const start = pageIndex * pageSize;
      const visibleEntries = entries.slice(start, start + pageSize);

      parameterHealthGrid.innerHTML = visibleEntries.map(renderParameterHealthRow).join('');
      if (parameterHealthStatus) {
        parameterHealthStatus.textContent = renderParameterRange(pageIndex, pageSize, entries.length);
      }
      if (parameterHealthNewerButton) {
        parameterHealthNewerButton.disabled = pageIndex === 0;
      }
      if (parameterHealthOlderButton) {
        parameterHealthOlderButton.disabled = pageIndex >= maxPage;
      }
    }

    if (parameterHealthNewerButton) {
      parameterHealthNewerButton.addEventListener('click', function () {
        if (pageIndex === 0) {
          return;
        }
        pageIndex -= 1;
        syncParameterHealth();
      });
    }

    if (parameterHealthOlderButton) {
      parameterHealthOlderButton.addEventListener('click', function () {
        if (pageIndex >= maxPage) {
          return;
        }
        pageIndex += 1;
        syncParameterHealth();
      });
    }

    parameterHealthGrid.addEventListener('click', function (event) {
      const row = event.target.closest('[data-parameter-health-open]');
      if (row) {
        openParameterHealthModal(entriesByKey.get(row.dataset.parameterHealthOpen));
      }
    });

    parameterHealthGrid.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      const row = event.target.closest('[data-parameter-health-open]');
      if (!row) {
        return;
      }
      event.preventDefault();
      openParameterHealthModal(entriesByKey.get(row.dataset.parameterHealthOpen));
    });

    syncParameterHealth();
  }

  document.addEventListener('click', function (event) {
    const closeButton = event.target.closest('[data-parameter-health-modal-close]');
    if (closeButton) {
      closeParameterHealthModal();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeParameterHealthModal();
    }
  });
}());
