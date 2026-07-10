(function () {
  const actionHistoryPayload = document.getElementById('action-history-data');
  const actionHistoryGrid = document.querySelector('[data-action-history-grid]');
  const actionHistoryStatus = document.querySelector('[data-action-history-status]');
  const actionHistoryNewerButton = document.querySelector('[data-action-history-nav="prev"]');
  const actionHistoryOlderButton = document.querySelector('[data-action-history-nav="next"]');
  const parameterValidityPayload = document.getElementById('parameter-validity-data');
  const parameterValidityGrid = document.querySelector('[data-parameter-validity-grid]');
  const parameterValidityStatus = document.querySelector('[data-parameter-validity-status]');
  const parameterValidityNewerButton = document.querySelector('[data-parameter-validity-nav="prev"]');
  const parameterValidityOlderButton = document.querySelector('[data-parameter-validity-nav="next"]');
  const parameterValidityModal = document.querySelector('[data-parameter-validity-modal]');
  const parameterValidityModalName = document.querySelector('[data-parameter-validity-modal-name]');
  const parameterValidityModalCategory = document.querySelector('[data-parameter-validity-modal-category]');
  const parameterValidityModalScope = document.querySelector('[data-parameter-validity-modal-scope]');
  const parameterValidityModalStatus = document.querySelector('[data-parameter-validity-modal-status]');
  const parameterValidityModalDue = document.querySelector('[data-parameter-validity-modal-due]');
  const parameterValidityModalEvidence = document.querySelector('[data-parameter-validity-modal-evidence]');
  const parameterValidityModalChecked = document.querySelector('[data-parameter-validity-modal-checked]');
  const parameterValidityModalMessage = document.querySelector('[data-parameter-validity-modal-message]');

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

  function renderParameterValidityRow(item) {
    const tone = escapeHtml(item.tone || 'neutral');

    return '<div class="parameter-validity__row parameter-validity__row--' + tone + '" role="listitem" tabindex="0" data-parameter-validity-open="' + escapeHtml(item.key) + '">' +
      '<span class="parameter-validity__identity">' +
      '<strong class="parameter-validity__name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</strong>' +
      '<small>' + escapeHtml(item.category) + ' · ' + escapeHtml(item.scope) + ' · ' + escapeHtml(item.evidenceLabel || '仅登记参数名称') + '</small>' +
      '</span>' +
      '<span class="parameter-validity__due">' + escapeHtml(item.dueDateLabel || '—') + '<small>' + escapeHtml(item.dueLabel || '无到期数据') + '</small></span>' +
      '<span class="parameter-validity__state">' +
      '<span class="parameter-validity__status"><em>' + escapeHtml(item.statusLabel) + '</em></span>' +
      '<span class="parameter-validity__message">' + escapeHtml(item.message || '—') + '</span>' +
      '</span>' +
      '</div>';
  }

  function closeParameterValidityModal() {
    if (!parameterValidityModal) {
      return;
    }
    parameterValidityModal.hidden = true;
    document.body.classList.remove('parameter-validity-modal-open');
  }

  function openParameterValidityModal(item) {
    if (!parameterValidityModal || !item) {
      return;
    }

    const dueText = [item.dueDateLabel || '—', item.dueLabel || '无到期数据'].filter(Boolean).join(' · ');
    const checkedText = [item.checkedAtLabel || '—', item.lastCheckedLabel || '—'].filter(Boolean).join(' · ');

    parameterValidityModalName.textContent = item.name || '—';
    parameterValidityModalCategory.textContent = item.category || '—';
    parameterValidityModalScope.textContent = item.scope || '—';
    parameterValidityModalStatus.textContent = item.statusLabel || '未知';
    parameterValidityModalDue.textContent = dueText;
    if (parameterValidityModalEvidence) {
      parameterValidityModalEvidence.textContent = item.evidenceLabel || '仅登记参数名称';
    }
    parameterValidityModalChecked.textContent = checkedText;
    parameterValidityModalMessage.textContent = item.message || '—';
    parameterValidityModal.hidden = false;
    document.body.classList.add('parameter-validity-modal-open');
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

  if (parameterValidityPayload && parameterValidityGrid) {
    const entries = JSON.parse(parameterValidityPayload.textContent || '[]');
    const entriesByKey = new Map(entries.map(function (entry) {
      return [String(entry.key || ''), entry];
    }));
    const pageSize = Number(parameterValidityPayload.dataset.pageSize || '5');
    const maxPage = Math.max(Math.ceil(entries.length / pageSize) - 1, 0);
    let pageIndex = 0;

    function syncParameterValidity() {
      const start = pageIndex * pageSize;
      const visibleEntries = entries.slice(start, start + pageSize);

      parameterValidityGrid.innerHTML = visibleEntries.map(renderParameterValidityRow).join('');
      if (parameterValidityStatus) {
        parameterValidityStatus.textContent = renderParameterRange(pageIndex, pageSize, entries.length);
      }
      if (parameterValidityNewerButton) {
        parameterValidityNewerButton.disabled = pageIndex === 0;
      }
      if (parameterValidityOlderButton) {
        parameterValidityOlderButton.disabled = pageIndex >= maxPage;
      }
    }

    if (parameterValidityNewerButton) {
      parameterValidityNewerButton.addEventListener('click', function () {
        if (pageIndex === 0) {
          return;
        }
        pageIndex -= 1;
        syncParameterValidity();
      });
    }

    if (parameterValidityOlderButton) {
      parameterValidityOlderButton.addEventListener('click', function () {
        if (pageIndex >= maxPage) {
          return;
        }
        pageIndex += 1;
        syncParameterValidity();
      });
    }

    parameterValidityGrid.addEventListener('click', function (event) {
      const row = event.target.closest('[data-parameter-validity-open]');
      if (row) {
        openParameterValidityModal(entriesByKey.get(row.dataset.parameterValidityOpen));
      }
    });

    parameterValidityGrid.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      const row = event.target.closest('[data-parameter-validity-open]');
      if (!row) {
        return;
      }
      event.preventDefault();
      openParameterValidityModal(entriesByKey.get(row.dataset.parameterValidityOpen));
    });

    syncParameterValidity();
  }

  document.addEventListener('click', function (event) {
    const closeButton = event.target.closest('[data-parameter-validity-modal-close]');
    if (closeButton) {
      closeParameterValidityModal();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeParameterValidityModal();
    }
  });
}());
