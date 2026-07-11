import { Buffer } from 'node:buffer';

import { recognizeTelegramImageMessage } from '../image-recognition.use-case.mjs';
import { analyzeTelegramBatch, mapWithConcurrency } from '../../../adapters/telegram/sync-batch.adapter.mjs';
import { resolveTelegramFileUrl } from '../../../adapters/telegram/index.mjs';
import { getRecognitionPromptMetadata, stripPromptMetadataHeader } from '../../../core/ai/prompt-generator.mjs';
import { createAiProvider } from '../../../adapters/ai/ai-provider.factory.mjs';
import { shouldQueueRecognitionFailure } from '../../../db/training/pending-recognition.mjs';
import {
  classifyFailureCategory,
  hasPartialRecognitionFailure,
  summarizePartialFailureReason,
} from './status.mjs';

const defaultRecognitionPromptPath = new URL('../../../../prompts/telegram-training-image-recognition.md', import.meta.url);
const fallbackRecognitionSystemPrompt =
  '你是训练记录截图结构化助手。只能输出符合 schema 的 JSON。识别类型只允许 measurement、workout、nutrition、unknown。workout 既可能是逐条活动明细截图，也可能是当日活动总览截图；总览图请提取活动热量、锻炼时长、活动小时数到 dailyWorkoutSummary。detectedDate 只能来自截图画面里的日期；若截图日期不可靠则 detectedDate 返回 null，并在 warnings 中说明。若截图是系统相册、文件详情或分享预览页，画面里明确显示的文件名、标题、路径中的日期也算画面内可见日期。';

export async function loadRecognitionSystemPrompt(env = process.env) {
  const promptUrl = env.TELEGRAM_RECOGNITION_PROMPT_PATH?.trim() || defaultRecognitionPromptPath;

  try {
    const { readFile } = await import('node:fs/promises');
    const prompt = await readFile(promptUrl, 'utf8');
    const trimmed = stripPromptMetadataHeader(prompt).trim();
    return trimmed || fallbackRecognitionSystemPrompt;
  } catch {
    return fallbackRecognitionSystemPrompt;
  }
}

export async function recognizeBatch(batch, env, options = {}) {
  const aiProvider = options.aiProvider ?? createAiProvider(env);
  const promptMetadata = await getRecognitionPromptMetadata();
  const systemPrompt = await loadRecognitionSystemPrompt(options.rawEnv ?? process.env);
  const fetchTelegramFileById = options.fetchTelegramFileById ?? null;
  const fetchImageFileById = options.fetchImageFileById ?? fetchTelegramFileById;
  const sourceChannel = options.sourceChannel ?? batch.sourceChannel ?? 'telegram';
  const imageInputMode = resolveRecognitionImageInputMode(options.rawEnv ?? process.env, sourceChannel);
  const writeStartedRecognitionAiCallLog = options.writeStartedRecognitionAiCallLog ?? null;
  const recognitionErrors = [];
  const syncStages = createImageSyncStages();
  const recognitions = await mapWithConcurrency(batch.messages, env.aiConcurrency, async (message) => {
    const photo = message.photos.at(-1);
    const fileId = photo?.fileId;
    if (!fileId) {
      return null;
    }

    try {
      const imageUrl = await measureBatchStage(syncStages, 'image_download', () => resolveRecognitionImageUrl({
        mode: imageInputMode,
        botToken: env.botToken,
        fileId,
        fetchImageFileById,
        message,
        photo,
      }));
      const recognition = await measureBatchStage(syncStages, 'ai_schema', () => recognizeTelegramImageMessage({
        aiProvider,
        message,
        imageUrl,
        systemPrompt,
        promptMetadata,
        env: options.rawEnv ?? process.env,
        readRecognitionCache: options.readRecognitionCache,
        onCacheReadStage: (stage) => markImageStage(syncStages, 'cache_read', stage),
        onAiCallLog: buildStartedRecognitionAiCallLogWriter({
          batch,
          message,
          sourceChannel,
          writeStartedRecognitionAiCallLog,
        }),
      }));
      markCacheReadStage(syncStages, recognition);
      return attachSourceMessageId(recognition, message);
    } catch (error) {
      if (imageInputMode === 'auto' && shouldRetryRecognitionInline(error) && fetchImageFileById) {
        const inlineImage = await measureBatchStage(syncStages, 'image_download', () =>
          buildInlineImageUrl(fetchImageFileById, fileId, { message, photo })
        );
        if (inlineImage.ok) {
          try {
            const recognition = await measureBatchStage(syncStages, 'ai_schema', () => recognizeTelegramImageMessage({
              aiProvider,
              message,
              imageUrl: inlineImage.imageUrl,
              systemPrompt,
              promptMetadata,
              env: options.rawEnv ?? process.env,
              readRecognitionCache: options.readRecognitionCache,
              onCacheReadStage: (stage) => markImageStage(syncStages, 'cache_read', stage),
              onAiCallLog: buildStartedRecognitionAiCallLogWriter({
                batch,
                message,
                sourceChannel,
                writeStartedRecognitionAiCallLog,
              }),
            }));
            markCacheReadStage(syncStages, recognition);
            return attachSourceMessageId(recognition, message);
          } catch (inlineError) {
            const originalMessage = error instanceof Error ? error.message : String(error);
            const inlineMessage = inlineError instanceof Error ? inlineError.message : String(inlineError);
            markImageStageFailure(syncStages, 'ai_schema', inlineMessage, {
              failureCategory: classifyFailureCategory(inlineMessage, { phase: 'ai_recognition' }),
            });
            recognitionErrors.push({
              messageId: message.messageId,
              error: inlineMessage,
              originalError: originalMessage,
              failureCategory: classifyFailureCategory(inlineMessage, { phase: 'ai_recognition' }),
              summary: inlineError?.summary ?? null,
              ...buildRecognitionErrorAiAudit(inlineError),
            });
            process.stderr.write(
              `[telegram-sync] inline image retry failed for ${message.messageId}: ${inlineMessage} (original: ${originalMessage})\n`,
            );
            return null;
          }
        } else {
          markImageStageFailure(syncStages, 'image_download', inlineImage.error, {
            failureCategory: inlineImage.failureCategory,
          });
          recognitionErrors.push({
            messageId: message.messageId,
            error: inlineImage.error,
            originalError: error instanceof Error ? error.message : String(error),
            failureCategory: inlineImage.failureCategory,
            summary: inlineImage.summary ?? null,
          });
          process.stderr.write(
            `[telegram-sync] inline image input failed for ${message.messageId}: ${inlineImage.error}\n`,
          );
          return null;
        }
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      markImageStageFailure(syncStages, classifyFailureStage(error, imageInputMode), errorMessage, {
        failureCategory: error?.failureCategory ?? classifyFailureCategory(errorMessage, { phase: 'ai_recognition' }),
      });
      recognitionErrors.push({
        messageId: message.messageId,
        error: errorMessage,
        failureCategory: error?.failureCategory ?? classifyFailureCategory(errorMessage, { phase: 'ai_recognition' }),
        summary: error?.summary ?? null,
        ...buildRecognitionErrorAiAudit(error),
      });
      process.stderr.write(
        `[telegram-sync] image recognition failed for ${message.messageId}: ${errorMessage}\n`,
      );
      return null;
    }
  });

  return {
    recognitions: recognitions.filter(Boolean),
    recognitionErrors,
    syncStages: finalizeImageSyncStages(syncStages),
  };
}

function buildStartedRecognitionAiCallLogWriter({
  batch,
  message,
  sourceChannel,
  writeStartedRecognitionAiCallLog,
}) {
  if (typeof writeStartedRecognitionAiCallLog !== 'function') {
    return undefined;
  }

  return (event) =>
    writeStartedRecognitionAiCallLog({
      ...event,
      taskId: batch.batchId,
      sourceChannel,
      sourceChatId: message.sourceChatId ?? message.chatId ?? null,
      sourceMessageId: message.sourceMessageId ?? message.messageId ?? null,
      messageId: message.messageId ?? null,
    });
}

export function resolveRecognitionImageInputMode(env = process.env, sourceChannel = 'telegram') {
  const sourceSpecificMode =
    sourceChannel === 'feishu'
      ? env.FEISHU_RECOGNITION_IMAGE_INPUT_MODE
      : env.TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE;
  const normalized = String(sourceSpecificMode ?? env.TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE ?? 'auto')
    .trim()
    .toLowerCase();
  return ['inline', 'url', 'auto'].includes(normalized) ? normalized : 'auto';
}

async function resolveRecognitionImageUrl({ mode, botToken, fileId, fetchImageFileById, message, photo }) {
  if (mode === 'inline') {
    if (!fetchImageFileById) {
      throw new Error('recognition inline image input requires file download support');
    }
    const inlineImage = await buildInlineImageUrl(fetchImageFileById, fileId, { message, photo });
    if (!inlineImage.ok) {
      const error = new Error(inlineImage.error);
      error.failureCategory = inlineImage.failureCategory;
      error.summary = inlineImage.summary ?? null;
      throw error;
    }
    return inlineImage.imageUrl;
  }
  return resolveTelegramFileUrl(botToken, fileId);
}

function normalizeRecognitionOutput(output) {
  if (Array.isArray(output)) {
    return {
      recognitions: output.filter(Boolean),
      recognitionErrors: [],
      syncStages: null,
    };
  }
  return {
    recognitions: Array.isArray(output?.recognitions) ? output.recognitions.filter(Boolean) : [],
    recognitionErrors: Array.isArray(output?.recognitionErrors) ? output.recognitionErrors : [],
    syncStages: normalizeSyncStages(output?.syncStages),
  };
}

const IMAGE_SYNC_STAGE_NAMES = ['image_download', 'cache_read', 'ai_schema', 'db_persist'];

function createImageSyncStages() {
  return Object.fromEntries(
    IMAGE_SYNC_STAGE_NAMES.map((stage) => [
      stage,
      {
        status: 'skipped',
        durationMs: 0,
        failureCategory: null,
        failureReason: null,
      },
    ]),
  );
}

async function measureBatchStage(syncStages, stage, run) {
  const startedAt = Date.now();
  try {
    const result = await run();
    markImageStage(syncStages, stage, {
      status: 'succeeded',
      durationMs: Date.now() - startedAt,
      failureCategory: null,
      failureReason: null,
    });
    return result;
  } catch (error) {
    markImageStageFailure(syncStages, stage, error instanceof Error ? error.message : String(error), {
      failureCategory: error?.failureCategory ?? classifyFailureCategory(error, { phase: stage }),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

function markImageStage(syncStages, stage, update = {}) {
  if (!syncStages || !IMAGE_SYNC_STAGE_NAMES.includes(stage)) {
    return;
  }
  const current = syncStages[stage] ?? createImageSyncStages()[stage];
  const nextStatus = normalizeStageStatus(update.status) ?? current.status;
  const currentDuration = Number.isFinite(current.durationMs) ? current.durationMs : 0;
  const nextDuration = Number.isFinite(update.durationMs) ? Math.max(0, Math.round(update.durationMs)) : 0;
  const status = current.status === 'failed' ? 'failed' : nextStatus;
  syncStages[stage] = {
    status,
    durationMs: currentDuration + nextDuration,
    failureCategory:
      current.failureCategory ?? update.failureCategory ?? (status === 'failed' ? 'system_bug' : null),
    failureReason: current.failureReason ?? update.failureReason ?? null,
  };
}

function markImageStageFailure(syncStages, stage, failureReason, options = {}) {
  markImageStage(syncStages, stage, {
    status: 'failed',
    durationMs: options.durationMs,
    failureCategory: options.failureCategory ?? classifyFailureCategory(failureReason, { phase: stage }),
    failureReason,
  });
}

export function markImageSyncStage(batch, stage, update = {}) {
  if (!batch || !IMAGE_SYNC_STAGE_NAMES.includes(stage)) {
    return batch;
  }
  batch.syncStages = finalizeImageSyncStages(batch.syncStages);
  markImageStage(batch.syncStages, stage, update);
  batch.syncStages = finalizeImageSyncStages(batch.syncStages);
  return batch;
}

export function markImageSyncStageFailure(batch, stage, failureReason, options = {}) {
  if (!batch || !IMAGE_SYNC_STAGE_NAMES.includes(stage)) {
    return batch;
  }
  batch.syncStages = finalizeImageSyncStages(batch.syncStages);
  markImageStageFailure(batch.syncStages, stage, failureReason, options);
  batch.syncStages = finalizeImageSyncStages(batch.syncStages);
  return batch;
}

function markCacheReadStage(syncStages, recognition) {
  const status = String(recognition?.cacheStatus ?? '').trim();
  if (!status) {
    return;
  }
  markImageStage(syncStages, 'cache_read', {
    status: status === 'disabled' ? 'skipped' : 'succeeded',
    durationMs: 0,
    failureCategory: null,
    failureReason: null,
  });
}

function classifyFailureStage(error, imageInputMode) {
  if (error?.failureCategory === 'image_download') {
    return 'image_download';
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (imageInputMode === 'inline' && /image input|image download|download failed|unsupported content-type|empty/i.test(message)) {
    return 'image_download';
  }
  return 'ai_schema';
}

function inferImageSyncStages({ syncStages, recognitions, recognitionErrors }) {
  const inferred = normalizeSyncStages(syncStages);
  if ((recognitions ?? []).length > 0) {
    markImageStage(inferred, 'ai_schema', { status: 'succeeded', durationMs: 0 });
  }
  for (const error of recognitionErrors ?? []) {
    const stage = error?.failureCategory === 'image_download' ? 'image_download' : 'ai_schema';
    markImageStageFailure(inferred, stage, error?.error ?? 'recognition failed', {
      failureCategory: error?.failureCategory,
    });
  }
  return finalizeImageSyncStages(inferred);
}

function normalizeSyncStages(value) {
  const normalized = createImageSyncStages();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  for (const stage of IMAGE_SYNC_STAGE_NAMES) {
    const input = value[stage];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      continue;
    }
    normalized[stage] = {
      status: normalizeStageStatus(input.status) ?? 'skipped',
      durationMs: Number.isFinite(input.durationMs) && input.durationMs >= 0
        ? Math.round(input.durationMs)
        : 0,
      failureCategory: input.failureCategory ?? null,
      failureReason: input.failureReason ?? null,
    };
  }
  return normalized;
}

function finalizeImageSyncStages(syncStages) {
  return normalizeSyncStages(syncStages) ?? createImageSyncStages();
}

function normalizeStageStatus(status) {
  const normalized = String(status ?? '').trim();
  return ['succeeded', 'failed', 'skipped'].includes(normalized) ? normalized : null;
}

function buildRecognitionErrorAiAudit(error) {
  const audit = error?.aiAudit;
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    return {};
  }
  return {
    provider: audit.provider ?? null,
    model: audit.model ?? null,
    promptVersion: audit.promptVersion ?? null,
    aiAttemptKind: audit.aiAttemptKind ?? null,
    aiIdempotencyKey: audit.aiIdempotencyKey ?? null,
    aiLatencyMs: Number.isFinite(audit.aiLatencyMs) ? Math.round(audit.aiLatencyMs) : null,
  };
}

function normalizePendingRecognitionBatchEntry(entry) {
  const batch = entry?.batch ?? entry?.batch_payload_json ?? entry;
  if (!batch?.batchId || !Array.isArray(batch.messages)) {
    return null;
  }
  return {
    kind: batch.kind ?? 'image',
    batchId: batch.batchId,
    messages: batch.messages,
  };
}

function normalizePendingPersistenceBatchEntry(entry) {
  const batch = entry?.batch ?? entry?.batch_payload_json ?? entry;
  if (entry?.failureCategory !== 'database' && entry?.failure_category !== 'database') {
    return null;
  }
  if (!batch?.batchId || batch.status !== 'ready') {
    return null;
  }
  return batch;
}

function attachFailureMetadata(batch) {
  if (!batch) {
    return batch;
  }

  if (hasPartialRecognitionFailure(batch)) {
    batch.partialFailure = true;
    if (!batch.failureCategory) {
      batch.failureCategory = 'ai_service';
    }
    if (!batch.failureReason) {
      batch.failureReason = summarizePartialFailureReason(batch);
    }
  }

  if (Array.isArray(batch.recognitionErrors) && batch.recognitionErrors.length > 0) {
    if (!batch.failureCategory) {
      batch.failureCategory =
        batch.recognitionErrors.find((error) => error.failureCategory)?.failureCategory ?? 'ai_service';
    }
    if (!batch.failureReason) {
      batch.failureReason = batch.recognitionErrors.map((error) => error.error).filter(Boolean).join('; ');
    }
    return batch;
  }

  if (batch.failureCategory) {
    return batch;
  }

  if (batch.status === 'ignored') {
    batch.failureCategory = 'user_input';
    batch.failureReason = batch.reason ?? 'ignored';
    return batch;
  }

  if (batch.status === 'skipped') {
    const reason = [batch.reason, ...(batch.issues ?? [])].filter(Boolean).join('; ');
    batch.failureCategory = classifyFailureCategory(reason, { phase: batch.kind ?? 'sync' });
    batch.failureReason = reason || batch.reason || 'skipped';
    return batch;
  }

  if (batch.persistenceError) {
    batch.failureCategory = classifyFailureCategory(batch.persistenceError, { phase: 'database' });
    batch.failureReason = batch.persistenceError;
  }

  return batch;
}

function shouldRetryRecognitionInline(error) {
  if (error?.status === 400) {
    return true;
  }
  const name = String(error?.name ?? '');
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    name === 'AiSchemaError' ||
    /invalid JSON/i.test(message) ||
    /invalid schema/i.test(message) ||
    /schema/i.test(message)
  );
}

export async function buildImageProcessingBatch({
  batch,
  recognizeBatchRunner,
  env,
  pendingReplay = false,
  logPrefix,
}) {
  let recognitions = [];
  let recognitionErrors = [];
  let syncStages = createImageSyncStages();
  const messages = batch.messages ?? [];

  if ((batch.kind ?? 'image') === 'image') {
    try {
      const recognitionOutput = normalizeRecognitionOutput(await recognizeBatchRunner(batch, env));
      recognitions = recognitionOutput.recognitions;
      recognitionErrors = recognitionOutput.recognitionErrors;
      syncStages = recognitionOutput.syncStages ?? inferImageSyncStages({
        syncStages,
        recognitions,
        recognitionErrors,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      recognitionErrors = messages.map((message) => ({
        messageId: message.messageId,
        error: errorMessage,
        failureCategory: classifyFailureCategory(errorMessage, { phase: 'ai_recognition' }),
        ...buildRecognitionErrorAiAudit(error),
      }));
      markImageStageFailure(syncStages, 'ai_schema', errorMessage, {
        failureCategory: classifyFailureCategory(errorMessage, { phase: 'ai_recognition' }),
      });
      syncStages = finalizeImageSyncStages(syncStages);
      process.stderr.write(`[telegram-sync] ${logPrefix} for ${batch.batchId}: ${errorMessage}\n`);
    }
  }

  const analyzed = analyzeTelegramBatch(batch, recognitions, {
    minConfidence: 0.75,
  });
  const persistedBatch = {
    ...analyzed,
    kind: batch.kind ?? analyzed.kind ?? 'image',
    sourceChannel: batch.sourceChannel ?? analyzed.sourceChannel ?? 'telegram',
    updateIds: messages.map((message) => message.updateId).filter(Boolean),
    messages,
    recognitions,
    recognitionErrors,
    syncStages,
    pendingReplay,
  };
  attachFailureMetadata(persistedBatch);
  return persistedBatch;
}

export async function replayPendingRecognitionBatches({
  entries,
  recognizeBatchRunner,
  persistBatch,
  appendPendingRecognitionBatch,
  markPendingRecognitionResolved,
  now,
  env,
}) {
  const batches = [];
  let changed = false;
  let replayStoredImageAny = false;

  for (const entry of entries ?? []) {
    const pendingPersistenceBatch = normalizePendingPersistenceBatchEntry(entry);
    if (pendingPersistenceBatch) {
      try {
        const persistResult = await persistBatch({
          batch: pendingPersistenceBatch,
          processedAt: now,
        });
        const resolvedResult = await markPendingRecognitionResolved({
          batchId: pendingPersistenceBatch.batchId,
        });
        changed ||= persistResult.status === 'stored';
        replayStoredImageAny ||= persistResult.status === 'stored';
        batches.push({
          ...pendingPersistenceBatch,
          pendingReplay: true,
          persistenceStatus: persistResult.status,
          recognitionPendingStatus: resolvedResult.status,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendPendingRecognitionBatch({
          batch: pendingPersistenceBatch,
          failureCategory: 'database',
          error: errorMessage,
          failedAt: now.toISOString(),
          nextRetryAt: new Date(now.getTime() + 10 * 60 * 1000),
        });
        batches.push({
          ...pendingPersistenceBatch,
          pendingReplay: true,
          persistenceStatus: 'pending_replay',
          persistenceError: errorMessage,
          failureCategory: 'database',
          failureReason: errorMessage,
        });
      }
      continue;
    }

    const batch = normalizePendingRecognitionBatchEntry(entry);
    if (!batch) {
      continue;
    }

    const persistedBatch = await buildImageProcessingBatch({
      batch,
      recognizeBatchRunner,
      env,
      pendingReplay: true,
      logPrefix: 'pending image recognition failed',
    });

    if (persistedBatch.status !== 'ready') {
      await queueRecognitionFailureIfNeeded({
        batch: persistedBatch,
        appendPendingRecognitionBatch,
        now,
        immediateRetry: false,
        nextRetryAt: new Date(now.getTime() + 10 * 60 * 1000),
      });
      batches.push(persistedBatch);
      continue;
    }

    const persistResult = await persistBatch({
      batch: persistedBatch,
      processedAt: now,
    });
    const resolvedResult = await markPendingRecognitionResolved({ batchId: persistedBatch.batchId });
    changed ||= persistResult.status === 'stored';
    replayStoredImageAny ||= persistResult.status === 'stored';
    batches.push({
      ...persistedBatch,
      persistenceStatus: persistResult.status,
      recognitionPendingStatus: resolvedResult.status,
    });
  }

  return {
    changed,
    replayStoredImageAny,
    batches,
  };
}

export async function queueRecognitionFailureIfNeeded({
  batch,
  appendPendingRecognitionBatch,
  now,
  immediateRetry = true,
  nextRetryAt,
}) {
  if (!shouldQueueRecognitionFailure(batch)) {
    return batch;
  }

  try {
    const queueResult = await appendPendingRecognitionBatch({
      batch: {
        kind: batch.kind ?? 'image',
        batchId: batch.batchId,
        sourceChannel: batch.sourceChannel ?? 'telegram',
        messages: batch.messages ?? [],
        recognitionErrors: batch.recognitionErrors ?? [],
      },
      failureCategory: batch.failureCategory,
      error: batch.failureReason,
      failedAt: now.toISOString(),
      nextRetryAt: nextRetryAt ?? (immediateRetry ? now : undefined),
    });
    batch.recognitionPendingStatus = queueResult.status;
    batch.aiCallLogStatus = queueResult.aiCallLogStatus ?? batch.aiCallLogStatus ?? null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    batch.recognitionPendingStatus = 'failed';
    batch.recognitionPendingError = errorMessage;
    process.stderr.write(
      `[telegram-sync] failed to queue pending recognition for ${batch.batchId}: ${errorMessage}\n`,
    );
  }

  return batch;
}

async function buildInlineImageUrl(fetchImageFileById, fileId, context = {}) {
  try {
    const file = await fetchImageFileById(fileId, context);
    if (!(file?.data instanceof Uint8Array) || file.data.length === 0) {
      return inlineImageFailure('empty_data', 'inline image input is empty', { fileId, context });
    }
    const contentType = normalizeInlineImageContentType(file);
    if (!contentType) {
      return inlineImageFailure(
        'unsupported_type',
        `inline image input has unsupported content-type: ${file?.contentType || 'unknown'}`,
        { fileId, context },
      );
    }
    return {
      ok: true,
      imageUrl: `data:${contentType};base64,${Buffer.from(file.data).toString('base64')}`,
    };
  } catch (error) {
    return inlineImageFailure('image_download', sanitizeInlineImageError(error, { fileId, context }), {
      fileId,
      context,
    });
  }
}

function inlineImageFailure(reason, error, { fileId, context }) {
  return {
    ok: false,
    error: `${error} (${describeInlineImageSource({ fileId, context })})`,
    failureCategory: reason === 'image_download' ? 'image_download' : 'user_input',
    summary: {
      phase: 'inline_image_input',
      reason,
      fileId: String(fileId ?? ''),
      sourceChannel: context?.message?.sourceChannel ?? 'telegram',
      sourceMessageId: context?.message?.sourceMessageId ?? null,
    },
  };
}

function sanitizeInlineImageError(error, { fileId, context }) {
  const message = error instanceof Error ? error.message : String(error);
  const withoutUrls = message
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/bot[A-Za-z0-9:_+\-/=]+/g, 'bot[redacted]');
  const sourceChannel = context?.message?.sourceChannel;
  if (sourceChannel === 'feishu' && !withoutUrls.includes(String(fileId))) {
    return `${withoutUrls}; image_key=${fileId}`;
  }
  if (!withoutUrls.includes(String(fileId))) {
    return `${withoutUrls}; file_id=${fileId}`;
  }
  return withoutUrls;
}

function describeInlineImageSource({ fileId, context }) {
  if (context?.message?.sourceChannel === 'feishu') {
    return `feishu image_key=${fileId}`;
  }
  return `telegram file_id=${fileId}`;
}

function attachSourceMessageId(recognition, message) {
  if (!message?.sourceMessageId || recognition?.sourceMessageId) {
    return recognition;
  }
  return {
    ...recognition,
    sourceMessageId: message.sourceMessageId,
  };
}

function normalizeInlineImageContentType(file) {
  const rawContentType = String(file?.contentType ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (rawContentType.startsWith('image/')) {
    return rawContentType;
  }

  const filePath = String(file?.filePath ?? '').toLowerCase();
  if (filePath.endsWith('.png')) {
    return 'image/png';
  }
  if (filePath.endsWith('.webp')) {
    return 'image/webp';
  }
  if (filePath.endsWith('.gif')) {
    return 'image/gif';
  }
  if (filePath.endsWith('.bmp')) {
    return 'image/bmp';
  }
  if (filePath.endsWith('.heic')) {
    return 'image/heic';
  }
  if (filePath.endsWith('.heif')) {
    return 'image/heif';
  }
  if (filePath.endsWith('.tif') || filePath.endsWith('.tiff')) {
    return 'image/tiff';
  }
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  return null;
}

export async function readPendingRecognitionBatchesForRun({
  readPendingRecognitionBatches,
  allowFallback = false,
}) {
  try {
    return await readPendingRecognitionBatches();
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[telegram-sync] could not read pending recognition batches: ${message}; continuing without replay queue\n`,
    );
    return [];
  }
}
