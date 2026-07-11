import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { buildFeishuSyncReport } from '../src/app/use-cases/feishu-sync.use-case.mjs';
import { buildTelegramSyncReport } from '../src/app/use-cases/telegram-sync.use-case.mjs';
import {
  buildTraceContext,
  formatActionLogEvent,
  hashSensitive,
} from './lib/action-logger.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2));
  process.exitCode = result.exitCode;
}

export async function main(argv = []) {
  const options = parseArgs(argv);
  const channel = normalizeChannel(options.channel);
  const trace = {
    ...buildTraceContext({
      TRACE_ID: options.traceId,
      QUEUE_TASK_ID: options.queueTaskId,
      GITHUB_WORKFLOW: options.workflow,
      GITHUB_RUN_ID: options.runId,
    }),
    channel,
  };

  const loaded = await readResult(options.resultPath);
  if (!loaded.ok) {
    process.stdout.write(renderMissingSummary({ channel, trace }));
    process.stderr.write(formatActionLogEvent({
      level: 'WARN',
      domain: 'ACTION',
      event: 'sync.summary.missing_result',
      ...trace,
      outcome: 'missing_result',
    }));
    return { exitCode: 0 };
  }

  const report = normalizeReport(channel, loaded.result);
  const markdown = renderSummary({ channel, trace, report });
  process.stdout.write(markdown);
  process.stderr.write(formatActionLogEvent({
    level: 'INFO',
    domain: 'ACTION',
    event: 'sync.summary.completed',
    ...trace,
    outcome: 'succeeded',
    batchCount: report.batches?.length ?? 0,
  }));
  return { exitCode: 0 };
}

export function renderSummary({ channel, trace, report }) {
  const title = `${capitalize(channel)} sync result`;
  const batches = report.batches ?? [];
  const lines = [`## ${title}`, ''];
  renderRunContext(lines, { channel, trace });
  renderTimings(lines, report.timingsMs ?? {});
  const businessIncomplete = renderBusinessResult(lines, { channel, batches });
  renderAiSummary(lines, batches);
  renderDatabaseSummary(lines, batches);
  renderImageStorage(lines, batches);
  renderWarnings(lines, { channel, businessIncomplete });
  return `${lines.join('\n')}\n`;
}

function renderMissingSummary({ channel, trace }) {
  const lines = [`## ${capitalize(channel)} sync result`, '', 'Result file was not written.'];
  if (trace.traceId) {
    lines.push('', `traceId: ${formatSummaryCell(trace.traceId)}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderRunContext(lines, { channel, trace }) {
  lines.push('### Run context', '');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  for (const [field, value] of Object.entries({
    workflow: trace.workflow,
    runId: trace.runId,
    traceId: trace.traceId,
    queueTaskId: trace.queueTaskId,
    channel,
  })) {
    lines.push(`| ${field} | ${formatSummaryCell(value)} |`);
  }
  lines.push('');
}

function renderTimings(lines, timings) {
  if (!timings || Object.keys(timings).length === 0) {
    return;
  }
  lines.push('### Timings', '');
  lines.push('| stage | ms |');
  lines.push('| --- | ---: |');
  for (const [stage, ms] of Object.entries(timings)) {
    lines.push(`| ${formatSummaryCell(stage)} | ${formatNumber(ms)} |`);
  }
  lines.push('');
}

function renderBusinessResult(lines, { channel, batches }) {
  const businessIncomplete = [];
  lines.push('### Business result', '');
  if (channel === 'feishu') {
    lines.push('| batchId | sourceId | chatIds | taskStatus | persistenceStatus | archivedDate | dateSources | warnings | dateConfidence | images | aiAttemptKinds | aiCallLogStatus | pending | failureDisposition | failed messageIds |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  } else {
    lines.push('| batchId | taskStatus | persistenceStatus | archivedDate | dateSources | warnings | dateConfidence | images | aiAttemptKinds | aiCallLogStatus | pending | failureDisposition | failed messageIds |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  }

  for (const batch of batches) {
    const failureDisposition = resolveFailureDisposition(batch);
    const failedIds = (batch.recognitionErrors ?? [])
      .map((item) => item?.messageId ?? item?.message_id)
      .filter((value) => value !== null && value !== undefined)
      .map(formatSummaryCell)
      .join(', ');
    const images = `${batch.sourceImageCount ?? 0}/${batch.recognizedImageCount ?? 0}/${batch.failedImageCount ?? 0}`;
    const aiAttemptKinds = (batch.recognitionAttemptKinds ?? batch.ai?.attemptKinds ?? [])
      .map(formatSummaryCell)
      .join(', ');
    const commonCells = [
      batch.batchId,
      batch.taskStatus ?? batch.status,
      batch.persistenceStatus,
      batch.archivedDate,
      formatDateSources(batch.dateSources),
      formatWarnings(batch.warnings),
      batch.dateConfidence,
      images,
      aiAttemptKinds,
      batch.aiCallLogStatus,
      batch.recognitionPendingStatus ?? batch.persistenceResult?.pendingStatus,
      failureDisposition,
      failedIds,
    ];
    if (channel === 'feishu') {
      lines.push(`| ${[
        formatSummaryCell(batch.batchId),
        formatSummaryCell(batch.sourceId),
        formatSummaryCell((batch.chatIds ?? []).join(', ')),
        ...commonCells.slice(1).map(formatSummaryCell),
      ].join(' | ')} |`);
    } else {
      lines.push(`| ${commonCells.map(formatSummaryCell).join(' | ')} |`);
    }
    if (isBusinessIncompleteBatch(batch, failureDisposition)) {
      businessIncomplete.push(
        `${formatSummaryCell(batch.batchId ?? '(unknown)')}:${formatSummaryCell(batch.persistenceStatus ?? batch.taskStatus ?? batch.status ?? 'unknown')}:${formatSummaryCell(failureDisposition)}`,
      );
    }
  }
  lines.push('');
  return businessIncomplete;
}

function renderAiSummary(lines, batches) {
  const aiRows = batches
    .map((batch) => ({ batchId: batch.batchId, ai: batch.ai ?? buildAiSummary(batch) }))
    .filter((row) => row.ai);
  if (aiRows.length === 0) {
    return;
  }
  lines.push('### AI', '');
  lines.push('| batchId | provider | model | promptVersion | fallbackUsed | retryCount | durationMs | totalTokens | attemptKinds |');
  lines.push('| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |');
  for (const { batchId, ai } of aiRows) {
    lines.push(`| ${[
      batchId,
      ai.provider,
      ai.model,
      ai.promptVersion,
      String(Boolean(ai.fallbackUsed)),
      formatNumber(ai.retryCount),
      formatNumber(ai.durationMs),
      formatNumber(ai.totalTokens),
      (ai.attemptKinds ?? []).join(', '),
    ].map(formatSummaryCell).join(' | ')} |`);
  }
  lines.push('');
}

function renderDatabaseSummary(lines, batches) {
  const dbRows = batches
    .map((batch) => ({ batchId: batch.batchId, db: batch.persistenceResult }))
    .filter((row) => row.db);
  if (dbRows.length === 0) {
    return;
  }
  lines.push('### Database', '');
  lines.push('| batchId | status | transactionId | rowCounts | pendingStatus | rollbackStatus | durationMs | slowQueries |');
  lines.push('| --- | --- | --- | --- | --- | --- | ---: | --- |');
  for (const { batchId, db } of dbRows) {
    const slowCount = Array.isArray(db.slowQueries) ? db.slowQueries.length : 0;
    lines.push(`| ${[
      batchId,
      db.status,
      db.transactionId,
      formatRowCounts(db.rowCounts),
      db.pendingStatus,
      db.rollbackStatus,
      formatNumber(db.durationMs),
      `slow=${slowCount}`,
    ].map(formatSummaryCell).join(' | ')} |`);
  }
  lines.push('');
}

function renderImageStorage(lines, batches) {
  const totals = batches
    .map((batch) => batch.imageUploadStats)
    .filter((stats) => stats && (stats.uploaded || stats.skipped || stats.failed))
    .reduce((acc, stats) => {
      acc.provider = acc.provider ?? stats.provider;
      acc.bucket = acc.bucket ?? hashSensitive(stats.bucket);
      acc.pathPrefix = acc.pathPrefix ?? hashSensitive(stats.pathPrefix);
      acc.uploaded += stats.uploaded ?? 0;
      acc.skipped += stats.skipped ?? 0;
      acc.failed += stats.failed ?? 0;
      acc.totalUploadMs += stats.totalUploadMs ?? 0;
      acc.maxSingleUploadMs = Math.max(acc.maxSingleUploadMs, stats.maxSingleUploadMs ?? 0);
      acc.firstUrlHost = acc.firstUrlHost ?? stats.firstUrlHost;
      return acc;
    }, { uploaded: 0, skipped: 0, failed: 0, totalUploadMs: 0, maxSingleUploadMs: 0 });
  if (!totals.uploaded && !totals.skipped && !totals.failed) {
    return;
  }
  lines.push('### Image storage', '');
  lines.push('| provider | bucket | pathPrefix | uploaded | skipped | failed | totalUploadMs | maxSingleUploadMs | firstUrlHost |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  lines.push(`| ${[
    totals.provider,
    totals.bucket,
    totals.pathPrefix,
    totals.uploaded,
    totals.skipped,
    totals.failed,
    totals.totalUploadMs,
    totals.maxSingleUploadMs,
    totals.firstUrlHost,
  ].map(formatSummaryCell).join(' | ')} |`);
  lines.push('');
}

function renderWarnings(lines, { channel, businessIncomplete }) {
  if (!businessIncomplete.length) {
    return;
  }
  lines.push('### Warnings', '');
  lines.push(`::warning title=${capitalize(channel)} sync business incomplete::${businessIncomplete.join('; ')}`);
  lines.push('');
}

function normalizeReport(channel, result) {
  if (!result?.batches) {
    return result ?? {};
  }
  return channel === 'feishu'
    ? buildFeishuSyncReport(result)
    : buildTelegramSyncReport(result);
}

async function readResult(resultPath) {
  try {
    return { ok: true, result: JSON.parse(await readFile(resultPath, 'utf8')) };
  } catch {
    return { ok: false, result: null };
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
    parsed[key] = argv[index + 1] ?? '';
    index += 1;
  }
  return parsed;
}

function normalizeChannel(channel) {
  return String(channel ?? 'telegram').trim().toLowerCase() === 'feishu' ? 'feishu' : 'telegram';
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatSummaryCell(value) {
  const normalized = String(value ?? '')
    .replace(/\|/gu, '/')
    .replace(/\r?\n/gu, ' ')
    .trim();
  return normalized.replace(/oc_[a-z0-9_:-]+/giu, (match) => hashSensitive(match) ?? '');
}

function formatDateSources(dateSources) {
  return Array.isArray(dateSources)
    ? dateSources
        .map((source) => {
          const sourceName = formatSummaryCell(source?.source ?? source?.type ?? 'unknown');
          const detectedDate = formatSummaryCell(source?.detectedDate ?? source?.date ?? 'null') || 'null';
          return `${sourceName}:${detectedDate}`;
        })
        .filter(Boolean)
        .join('; ')
    : '';
}

function formatWarnings(warnings) {
  return Array.isArray(warnings)
    ? warnings.map(formatSummaryCell).filter(Boolean).join('; ')
    : formatSummaryCell(warnings);
}

function resolveFailureDisposition(batch) {
  return batch.failureDisposition ??
    (batch.recognitionPendingStatus === 'queued' || batch.persistenceStatus === 'pending_replay'
      ? 'auto_retry'
      : (batch.status === 'skipped' || batch.status === 'ignored' ? 'skip' : 'none'));
}

function isBusinessIncompleteBatch(batch, failureDisposition) {
  return (
    batch.persistenceStatus === 'pending_replay' ||
    batch.taskStatus === 'partialFailure' ||
    batch.status === 'partial_failed' ||
    batch.partialFailure === true ||
    failureDisposition === 'auto_retry' ||
    failureDisposition === 'manual_intervention'
  );
}

function buildAiSummary(batch) {
  const recognitions = Array.isArray(batch.recognitions) ? batch.recognitions : [];
  if (recognitions.length === 0) {
    return null;
  }
  const attemptKinds = [...new Set(recognitions.map((item) => item?.aiAttemptKind).filter(Boolean))];
  return {
    provider: firstNonEmpty(recognitions.map((item) => item?.provider)),
    model: firstNonEmpty(recognitions.map((item) => item?.model)),
    promptVersion: firstNonEmpty(recognitions.map((item) => item?.promptVersion)),
    attemptKinds,
    fallbackUsed: attemptKinds.includes('fallback'),
    retryCount: Number(batch.retryCount ?? 0),
    durationMs: batch.syncStages?.ai_schema?.durationMs ?? null,
    totalTokens: recognitions.reduce((sum, item) => sum + normalizeNumber(item?.aiUsage?.totalTokens), 0),
  };
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : '';
}

function formatRowCounts(rowCounts) {
  if (!rowCounts || typeof rowCounts !== 'object') {
    return '';
  }
  return Object.entries(rowCounts)
    .filter(([, count]) => Number.isFinite(Number(count)))
    .map(([name, count]) => `${name}=${Math.round(Number(count))}`)
    .join('; ');
}
