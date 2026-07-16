import { splitTelegramMessage } from './training-analysis.impl.mjs';
import { TELEGRAM_HELP_TEXT } from '../../telegram/help.mjs';

export function shouldRunSleepBackfill({ rawEnv, storedSleepAny }) {
  const flag = String(rawEnv.TELEGRAM_SYNC_RUN_SLEEP_BACKFILL ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(flag)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(flag)) {
    return false;
  }
  return storedSleepAny;
}

export function addArchivedDate(target, value) {
  const normalized = normalizeArchivedDate(value);
  if (normalized) {
    target.add(normalized);
  }
}

function normalizeArchivedDate(value) {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function hasSleepBatchPayload(batch) {
  const sleep = batch?.sleep;
  if (!sleep) {
    return false;
  }

  if (Array.isArray(sleep.records) && sleep.records.length > 0) {
    return true;
  }

  return [
    sleep.totalSleepMinutes,
    sleep.nightSleepMinutes,
    sleep.napMinutes,
    sleep.bedtime,
    sleep.wakeTime,
    sleep.sleepStartTime,
    sleep.sleepEndTime,
    sleep.deepSleepMinutes,
    sleep.lightSleepMinutes,
    sleep.remSleepMinutes,
    sleep.awakeMinutes,
    sleep.sleepStageText,
    sleep.sleepStageDetail,
    sleep.sleepScore,
    sleep.analysisText,
    sleep.suggestionText,
  ].some((value) => value !== null && value !== undefined && value !== '' && value !== 0);
}

export async function handleAnalysisBatch({ batch, generateAnalysisReply, sendMessage }) {
  const message = batch.messages?.[0] ?? {};
  try {
    const analysis = normalizeAnalysisReplyResult(await generateAnalysisReply({
      taskId: batch.batchId,
      question: batch.analysis?.question ?? '',
    }));
    const parts = splitTelegramMessage(analysis.reply);
    for (const [index, part] of parts.entries()) {
      await sendMessage({
        chatId: message.chatId,
        text: part,
        replyToMessageId: index === 0 ? message.messageId : null,
      });
    }
    return {
      status: 'sent',
      parts: parts.length,
      aiAttemptKind: analysis.aiAttemptKind,
      model: analysis.model,
      snapshotSource: analysis.snapshotSource,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await sendMessage({
      chatId: message.chatId,
      text: `训练分析暂时生成失败：${errorMessage}`,
      replyToMessageId: message.messageId,
    });
    return {
      status: 'failed',
      error: errorMessage,
      parts: 1,
    };
  }
}

function normalizeAnalysisReplyResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      reply: value.reply ?? '',
      aiAttemptKind: value.aiAttemptKind ?? null,
      model: value.model ?? null,
      snapshotSource: value.snapshotSource ?? null,
    };
  }
  return {
    reply: String(value ?? ''),
    aiAttemptKind: null,
    model: null,
    snapshotSource: null,
  };
}

export async function handleHelpBatch({ batch, sendMessage }) {
  const message = batch.messages?.[0] ?? {};
  try {
    await sendMessage({
      chatId: message.chatId,
      text: TELEGRAM_HELP_TEXT,
      replyToMessageId: message.messageId,
    });
    return {
      status: 'sent',
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
