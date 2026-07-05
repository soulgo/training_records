(function () {
  const actionHistoryPayload = document.getElementById('action-history-data');
  const actionHistoryGrid = document.querySelector('[data-action-history-grid]');
  const actionHistoryStatus = document.querySelector('[data-action-history-status]');
  const actionHistoryNewerButton = document.querySelector('[data-action-history-nav="prev"]');
  const actionHistoryOlderButton = document.querySelector('[data-action-history-nav="next"]');

  function renderActionRange(pageIndex, pageSize, total) {
    if (!total) {
      return '0 / 共 0 次';
    }

    const start = pageIndex * pageSize + 1;
    const end = Math.min(start + pageSize, total);

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

  if (
    actionHistoryPayload &&
    actionHistoryGrid &&
    actionHistoryStatus &&
    actionHistoryNewerButton &&
    actionHistoryOlderButton
  ) {
    const entries = JSON.parse(actionHistoryPayload.textContent || '[]');
    const pageSize = Number(actionHistoryPayload.dataset.pageSize || '6');
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
}());
