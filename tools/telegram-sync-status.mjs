import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sendTelegramMessage } from './telegram-transport.mjs';
import { isThoughtBatchKind } from './lib/thought-modules.mjs';

export function shouldPersistTelegramArtifacts({
  updatesFetched,
  changed,
  previousLastProcessedUpdateId,
  nextLastProcessedUpdateId,
}) {
  return (
    changed ||
    updatesFetched > 0 ||
    nextLastProcessedUpdateId > previousLastProcessedUpdateId
  );
}

export function buildTelegramSyncReport(result) {
  const normalized = {
    changed: result.changed,
    fallbackUsed: result.fallbackUsed,
    updatesFetched: result.updatesFetched,
    lastProcessedUpdateId: result.lastProcessedUpdateId,
    readyBatches: result.readyBatches,
    ...(isPlainTimingMap(result.timingsMs) ? { timingsMs: normalizeTimings(result.timingsMs) } : {}),
    batches: (result.batchResults ?? []).map((batch) => {
      const taskAudit = buildSyncTaskAuditFields(batch);
      return {
        kind: batch.kind ?? 'image',
        batchId: batch.batchId,
        taskId: taskAudit.taskId,
        sourceType: taskAudit.sourceType,
        sourceId: taskAudit.sourceId,
        taskStatus: taskAudit.taskStatus,
        retryState: taskAudit.retryState,
        retryCount: taskAudit.retryCount,
        messageIds: taskAudit.messageIds,
        updateIds: taskAudit.updateIds,
        status: batch.status,
        partialFailure: batch.partialFailure ?? false,
        archivedDate: batch.archivedDate ?? null,
        postPath: batch.postPath ?? null,
        thoughtWriteStatus: batch.thoughtWriteStatus ?? null,
        persistenceStatus: batch.persistenceStatus ?? null,
        persistenceError: batch.persistenceError ?? null,
        failureCategory: batch.failureCategory ?? null,
        failureReason: batch.failureReason ?? null,
        failureDisposition: normalizeFailureDisposition(batch),
        recognitionPendingStatus: batch.recognitionPendingStatus ?? null,
        recognitionPendingError: batch.recognitionPendingError ?? null,
        pendingReplay: batch.pendingReplay ?? false,
        sourceImageCount: batch.sourceImageCount ?? 0,
        recognizedImageCount: batch.recognizedImageCount ?? 0,
        failedImageCount: batch.failedImageCount ?? 0,
        recognitionErrors: batch.recognitionErrors ?? [],
        warnings: batch.warnings ?? [],
        issues: batch.issues ?? [],
        reason: batch.reason ?? null,
        dateSources: batch.dateSources ?? [],
      };
    }),
  };

  for (const [index, batch] of (result.batchResults ?? []).entries()) {
    if ((batch.kind ?? 'image') === 'analysis') {
      normalized.batches[index].analysisReplyStatus = batch.analysisReplyStatus ?? null;
      normalized.batches[index].analysisReplyError = batch.analysisReplyError ?? null;
      normalized.batches[index].analysisReplyParts = batch.analysisReplyParts ?? null;
    }
    if ((batch.kind ?? 'image') === 'ai_agent') {
      normalized.batches[index].aiAgentReplyStatus = batch.aiAgentReplyStatus ?? null;
      normalized.batches[index].aiAgentReplyError = batch.aiAgentReplyError ?? null;
      normalized.batches[index].aiAgentReplyParts = batch.aiAgentReplyParts ?? null;
    }
    if ((batch.kind ?? 'image') === 'help') {
      normalized.batches[index].helpReplyStatus = batch.helpReplyStatus ?? null;
      normalized.batches[index].helpReplyError = batch.helpReplyError ?? null;
    }
  }

  return normalized;
}

function isPlainTimingMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTimings(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, duration]) => Number.isFinite(duration) && duration >= 0)
      .map(([stage, duration]) => [stage, Math.round(duration)]),
  );
}

function buildSyncTaskAuditFields(batch) {
  const kind = batch.kind ?? 'image';
  const batchId = String(batch.batchId ?? 'unknown');
  const messages = Array.isArray(batch.messages) ? batch.messages : [];
  const messageIds = messages
    .map((message) => message?.messageId)
    .filter((messageId) => messageId !== null && messageId !== undefined);
  const updateIds = messages
    .map((message) => message?.updateId)
    .filter((updateId) => updateId !== null && updateId !== undefined);

  return {
    taskId: `telegram:${kind}:${batchId}`,
    sourceType: normalizeSyncTaskSourceType(batch),
    sourceId: buildSyncTaskSourceId({ batchId, messages }),
    taskStatus: normalizeSyncTaskStatus(batch),
    retryState: normalizeSyncRetryState(batch),
    retryCount: normalizeSyncRetryCount(batch),
    messageIds,
    updateIds,
  };
}

function normalizeSyncTaskSourceType(batch) {
  if (batch.pendingReplay === true) {
    return 'pending_replay';
  }
  return 'telegram_update';
}

function buildSyncTaskSourceId({ batchId, messages }) {
  const firstMessage = messages.find(Boolean);
  const chatId = firstMessage?.chatId;
  const mediaGroupId = firstMessage?.mediaGroupId;
  if (chatId !== null && chatId !== undefined && mediaGroupId) {
    return `telegram:chat:${chatId}:media_group:${mediaGroupId}`;
  }
  if (chatId !== null && chatId !== undefined && firstMessage?.messageId !== null && firstMessage?.messageId !== undefined) {
    return `telegram:chat:${chatId}:message:${firstMessage.messageId}`;
  }
  return `telegram:batch:${batchId}`;
}

function normalizeSyncTaskStatus(batch) {
  if (batch.partialFailure === true) {
    return 'partialFailure';
  }
  if (batch.recognitionPendingStatus === 'queued') {
    return 'deferred';
  }
  if (batch.recognitionPendingStatus === 'resolved') {
    return 'resolved';
  }
  if (batch.persistenceStatus === 'stored' || batch.persistenceStatus === 'unchanged') {
    return 'stored';
  }
  if (batch.persistenceStatus === 'fallback_markdown' || batch.persistenceStatus === 'pending_replay') {
    return 'deferred';
  }
  if (batch.status === 'ready') {
    return 'ready';
  }
  if (batch.status === 'skipped') {
    return 'skipped';
  }
  if (batch.status === 'ignored') {
    return 'skipped';
  }
  if (batch.status === 'failed') {
    return 'failed';
  }
  return batch.status ?? 'queued';
}

function normalizeSyncRetryState(batch) {
  if (batch.recognitionPendingStatus === 'queued') {
    return 'queued';
  }
  if (batch.recognitionPendingStatus === 'resolved') {
    return 'resolved';
  }
  if (batch.persistenceStatus === 'fallback_markdown' || batch.persistenceStatus === 'pending_replay') {
    return 'pending_replay';
  }
  if (batch.pendingReplay === true) {
    return batch.persistenceStatus === 'stored' || batch.persistenceStatus === 'unchanged' ? 'resolved' : 'replaying';
  }
  return 'none';
}

function normalizeSyncRetryCount(batch) {
  if (Number.isFinite(batch.retryCount) && batch.retryCount >= 0) {
    return Math.floor(batch.retryCount);
  }
  return batch.pendingReplay === true ? 1 : 0;
}

function normalizeFailureDisposition(batch) {
  if (batch.recognitionPendingStatus === 'queued') {
    return 'auto_retry';
  }
  if (batch.persistenceStatus === 'fallback_markdown' || batch.persistenceStatus === 'pending_replay') {
    return 'auto_retry';
  }
  if (batch.failureCategory === 'ai_service' || batch.failureCategory === 'telegram_api') {
    return 'auto_retry';
  }
  if (batch.failureCategory === 'database' || batch.failureCategory === 'github_action') {
    return 'auto_retry';
  }
  if (batch.failureCategory === 'user_input') {
    return 'manual_intervention';
  }
  if (batch.status === 'skipped' || batch.status === 'ignored') {
    return 'skip';
  }
  if (batch.status === 'failed') {
    return 'manual_intervention';
  }
  return 'none';
}

export function shouldNotifyTelegramSyncResult(rawEnv) {
  const flag = String(rawEnv.TELEGRAM_SYNC_NOTIFY ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(flag)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(flag)) {
    return false;
  }

  return (
    rawEnv.GITHUB_ACTIONS === 'true' &&
    String(rawEnv.TELEGRAM_SYNC_TRANSPORT ?? '').trim().toLowerCase() === 'webhook'
  );
}

export function resolveTelegramSyncNotificationStage(rawEnv) {
  const stage = String(rawEnv.TELEGRAM_SYNC_NOTIFY_STAGE ?? '').trim().toLowerCase();
  if (
    stage === 'after_action' ||
    stage === 'after-action' ||
    stage === 'post_action' ||
    stage === 'post-action'
  ) {
    return 'after_action';
  }
  return 'inline';
}

export function resolveTelegramSyncResultPath(rawEnv, activeRootDir, explicitPath) {
  const candidate = String(explicitPath ?? rawEnv.TELEGRAM_SYNC_RESULT_PATH ?? '').trim();
  if (candidate) {
    return path.isAbsolute(candidate) ? candidate : path.resolve(activeRootDir, candidate);
  }
  return '';
}

export async function maybePersistTelegramSyncResult(resultPath, result) {
  if (!resultPath) {
    return;
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export async function notifyTelegramSyncResultFromFile({
  resultPath,
  env = process.env,
  sendMessage = sendTelegramMessage,
}) {
  if (!resultPath) {
    return { notified: false, reason: 'missing_result_path' };
  }

  const raw = await readFile(resultPath, 'utf8');
  const report = JSON.parse(raw);
  return notifyTelegramSyncResultFromReport({ report, env, sendMessage });
}

export async function notifyTelegramSyncResultFromReport({
  report,
  env = process.env,
  sendMessage = sendTelegramMessage,
}) {
  return notifyTelegramSyncResult({
    batchResults: report?.batchResults ?? report?.batches ?? [],
    env,
    sendMessage,
  });
}

export async function notifyTelegramSyncResult({ batchResults, env = process.env, sendMessage }) {
  const messagesByChat = new Map();
  const shouldNotify = shouldNotifyTelegramSyncResult(env);
  if (!shouldNotify) {
    return { notified: false, reason: 'notification_disabled' };
  }

  for (const batch of batchResults) {
    if (!shouldNotifyBatch(batch)) {
      continue;
    }

    const chatId = getBatchChatId(batch);
    if (chatId === null || chatId === undefined) {
      continue;
    }

    const replyToMessageId = getBatchReplyMessageId(batch);
    const text = formatTelegramSyncNotification(batch);
    if (!text) {
      continue;
    }

    if (!messagesByChat.has(chatId)) {
      messagesByChat.set(chatId, []);
    }
    messagesByChat.get(chatId).push({
      text,
      replyToMessageId,
    });
  }

  let sent = 0;
  for (const [chatId, messages] of messagesByChat.entries()) {
    for (const message of messages) {
      try {
        await sendMessage({
          chatId,
          text: message.text,
          replyToMessageId: message.replyToMessageId,
        });
        sent += 1;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[telegram-sync] failed to send sync notification to ${chatId}: ${errorMessage}\n`,
        );
      }
    }
  }

  return { notified: sent > 0, sent };
}

function shouldNotifyBatch(batch) {
  if (!batch || batch.kind === 'analysis') {
    return false;
  }

  if (!isTrainingDataBatchKind(batch.kind) && !isThoughtBatchKind(batch.kind)) {
    return false;
  }

  if (!Array.isArray(batch.messages) || batch.messages.length === 0) {
    return false;
  }

  return batch.status === 'ready' || batch.status === 'skipped' || batch.status === 'ignored';
}

function getBatchChatId(batch) {
  return batch.messages?.find((message) => message.chatId !== null && message.chatId !== undefined)?.chatId ?? null;
}

function getBatchReplyMessageId(batch) {
  return batch.messages?.[0]?.messageId ?? null;
}

function formatTelegramSyncNotification(batch) {
  if (isThoughtBatchKind(batch.kind)) {
    return formatThoughtSyncNotification(batch);
  }

  if (batch.status === 'ready') {
    const dateText = formatChineseDate(batch.archivedDate);
    const storageText = formatPersistenceStatus(batch.persistenceStatus);
    const countText = formatImageCountText(batch);
    if (hasPartialRecognitionFailure(batch)) {
      const failedMessages = formatFailedRecognitionMessageIds(batch);
      const reason = summarizePartialFailureReason(batch);
      const pendingText = batch.recognitionPendingStatus === 'queued' ? '，AI 识别失败图片已加入重试队列' : '';
      return [
        `部分解析失败（${countText}），${storageText}${dateText ? ` ${dateText}数据` : ''}${pendingText}`,
        failedMessages ? `失败图片：${failedMessages}` : '',
        reason ? `原因：${reason}` : '',
      ]
        .filter(Boolean)
        .join('；');
    }
    if (isDeferredPersistenceStatus(batch.persistenceStatus)) {
      return `图片已识别（${countText}），数据库写入未完成，${storageText}${dateText ? ` ${dateText}数据` : ''}`;
    }
    return `解析成功（${countText}），${storageText}${dateText ? ` ${dateText}数据` : ''}`;
  }

  if (batch.status === 'skipped') {
    if (batch.failureCategory === 'ai_service' && batch.recognitionPendingStatus === 'queued') {
      const countText = formatImageCountText(batch);
      const reason = batch.failureReason ? `：${batch.failureReason}` : '';
      return `AI 识别失败（${countText}），已加入重试队列${reason}`;
    }
    if (batch.failureCategory === 'ai_service') {
      const reason = batch.failureReason ? `：${batch.failureReason}` : '';
      return `解析失败：AI 服务失败${reason}`;
    }
    const reason = batch.reason ? `：${batch.reason}` : '';
    return `解析未入库${reason}`;
  }

  if (batch.status === 'ignored') {
    return `解析未处理：${batch.reason ?? 'ignored'}`;
  }

  return null;
}

function formatPersistenceStatus(status) {
  if (status === 'stored' || status === 'unchanged') {
    return '已入库';
  }
  if (status === 'fallback_markdown') {
    return '已写入 Markdown，等待数据库重放';
  }
  if (status === 'pending_replay') {
    return '已记录，等待数据库重放';
  }
  return '已处理';
}

function isDeferredPersistenceStatus(status) {
  return status === 'fallback_markdown' || status === 'pending_replay';
}

function formatImageCountText(batch) {
  const source = batch.sourceImageCount ?? 0;
  const recognized = batch.recognizedImageCount ?? 0;
  const failed = batch.failedImageCount ?? 0;
  if (source <= 0) {
    return '';
  }
  return `已识别 ${recognized}/${source}${failed > 0 ? `，失败 ${failed}` : ''}`;
}

function formatChineseDate(dateValue) {
  const match = String(dateValue ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return '';
  }

  return `${Number(match[1])} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
}

export function isTrainingDataBatchKind(kind) {
  return kind !== 'thought' && kind !== 'thought_edit' && kind !== 'thought_delete' && kind !== 'thought_move' && kind !== 'analysis';
}

export function hasPartialRecognitionFailure(batch) {
  if (!batch || batch.status !== 'ready') {
    return false;
  }
  if (batch.partialFailure === true) {
    return true;
  }
  if (batch.failedImageCount > 0) {
    return true;
  }
  if (batch.sourceImageCount > 0 && batch.recognizedImageCount < batch.sourceImageCount) {
    return true;
  }
  if (Array.isArray(batch.recognitionErrors) && batch.recognitionErrors.length > 0) {
    return true;
  }
  return (batch.issues ?? []).some((issue) => /missing recognition/i.test(String(issue)));
}

function formatFailedRecognitionMessageIds(batch) {
  const ids = new Set();
  for (const error of batch.recognitionErrors ?? []) {
    if (error?.messageId !== null && error?.messageId !== undefined) {
      ids.add(String(error.messageId));
    }
  }
  for (const issue of batch.issues ?? []) {
    const match = String(issue).match(/missing recognition for message\s+(\S+)/i);
    if (match) {
      ids.add(match[1]);
    }
  }
  return [...ids].join(', ');
}

export function summarizePartialFailureReason(batch) {
  return summarizeErrorText(
    batch.failureReason ||
      (batch.recognitionErrors ?? [])
        .map((error) => error?.error)
        .filter(Boolean)
        .join('; '),
  );
}

export function classifyFailureCategory(message, options = {}) {
  const text = String(message ?? '');
  const phase = String(options.phase ?? '');

  if (/github|action|dispatch|rebase|push|checkout|npm ci|workflow/i.test(`${phase} ${text}`)) {
    return 'github_action';
  }
  if (/getFile|sendMessage|file download|download failed/i.test(text)) {
    return 'telegram_api';
  }
  if (/database|postgres|TRAINING_DB|ECONN|connection|pending_replay|fallback_markdown/i.test(`${phase} ${text}`)) {
    return 'database';
  }
  if (/missing recognition/i.test(text)) {
    return 'user_input';
  }
  if (/\bAI\b|recognition|analysis|agent|schema|JSON|HTTP\s*(?:4\d\d|5\d\d)|rate|timeout|timed out|empty content|provider/i.test(`${phase} ${text}`)) {
    return 'ai_service';
  }
  if (/unauthorized|no reliable|low confidence|conflicting|missing target|not_found|ignored|skipped|filename date/i.test(text)) {
    return 'user_input';
  }
  return 'system_bug';
}

function summarizeErrorText(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return null;
  }
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function formatThoughtSyncNotification(batch) {
  const actionText = formatThoughtActionText(batch.kind, batch.thoughtWriteStatus);
  const storageText = formatThoughtPersistenceText(batch.persistenceStatus);
  const errorText = batch.persistenceError || batch.failureReason
    ? `：${batch.persistenceError ?? batch.failureReason}`
    : '';

  if (batch.thoughtWriteStatus === 'not_found') {
    return `${actionText}：目标随想不存在`;
  }

  return `${actionText}，${storageText}${errorText}`;
}

function formatThoughtActionText(kind, status) {
  const action = {
    thought: '随想写入',
    thought_edit: '随想更新',
    thought_delete: '随想删除',
    thought_move: '随想移动',
  }[kind] ?? '随想处理';

  if (status === 'duplicate') {
    return `${action}成功（重复消息已跳过）`;
  }
  if (status === 'unchanged') {
    return `${action}成功（内容无变化）`;
  }
  if (status === 'not_found') {
    return `${action}失败`;
  }
  return `${action}成功`;
}

function formatThoughtPersistenceText(status) {
  if (status === 'stored' || status === 'unchanged') {
    return '已入库';
  }
  if (status === 'pending_replay') {
    return 'Markdown 已写入，数据库待补偿';
  }
  return formatPersistenceStatus(status);
}
