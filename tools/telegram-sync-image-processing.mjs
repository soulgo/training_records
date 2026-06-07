import { Buffer } from 'node:buffer';

import { recognizeTelegramImageMessage } from '../src/ai/recognition-service.mjs';
import { analyzeTelegramBatch, mapWithConcurrency } from './telegram-sync-lib.mjs';
import { resolveTelegramFileUrl } from './telegram-transport.mjs';
import { getRecognitionPromptMetadata, stripPromptMetadataHeader } from './prompt-generator.mjs';
import { createAiProvider } from '../src/ai/provider.mjs';
import {
  classifyFailureCategory,
  hasPartialRecognitionFailure,
  summarizePartialFailureReason,
} from './telegram-sync-status.mjs';

const defaultRecognitionPromptPath = new URL('../prompts/telegram-training-image-recognition.md', import.meta.url);
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
  const imageInputMode = resolveRecognitionImageInputMode(options.rawEnv ?? process.env);
  const recognitionErrors = [];
  const recognitions = await mapWithConcurrency(batch.messages, env.aiConcurrency, async (message) => {
    const fileId = message.photos.at(-1)?.fileId;
    if (!fileId) {
      return null;
    }

    try {
      const imageUrl = await resolveRecognitionImageUrl({
        mode: imageInputMode,
        botToken: env.botToken,
        fileId,
        fetchTelegramFileById,
      });
      return await recognizeTelegramImageMessage({
        aiProvider,
        message,
        imageUrl,
        systemPrompt,
        promptMetadata,
        env: options.rawEnv ?? process.env,
      });
    } catch (error) {
      if (imageInputMode === 'auto' && shouldRetryRecognitionInline(error) && fetchTelegramFileById) {
        const inlineImageUrl = await buildInlineTelegramImageUrl(fetchTelegramFileById, fileId);
        if (inlineImageUrl) {
          try {
            return await recognizeTelegramImageMessage({
              aiProvider,
              message,
              imageUrl: inlineImageUrl,
              systemPrompt,
              promptMetadata,
              env: options.rawEnv ?? process.env,
            });
          } catch (inlineError) {
            const originalMessage = error instanceof Error ? error.message : String(error);
            const inlineMessage = inlineError instanceof Error ? inlineError.message : String(inlineError);
            recognitionErrors.push({
              messageId: message.messageId,
              error: inlineMessage,
              originalError: originalMessage,
              failureCategory: classifyFailureCategory(inlineMessage, { phase: 'ai_recognition' }),
              summary: inlineError?.summary ?? null,
            });
            process.stderr.write(
              `[telegram-sync] inline image retry failed for ${message.messageId}: ${inlineMessage} (original: ${originalMessage})\n`,
            );
            return null;
          }
        }
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      recognitionErrors.push({
        messageId: message.messageId,
        error: errorMessage,
        failureCategory: classifyFailureCategory(errorMessage, { phase: 'ai_recognition' }),
        summary: error?.summary ?? null,
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
  };
}

export function resolveRecognitionImageInputMode(env = process.env) {
  const normalized = String(env.TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE ?? 'auto')
    .trim()
    .toLowerCase();
  return ['inline', 'url', 'auto'].includes(normalized) ? normalized : 'auto';
}

async function resolveRecognitionImageUrl({ mode, botToken, fileId, fetchTelegramFileById }) {
  if (mode === 'inline') {
    if (!fetchTelegramFileById) {
      throw new Error('TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE=inline requires Telegram file download support');
    }
    const inlineImageUrl = await buildInlineTelegramImageUrl(fetchTelegramFileById, fileId);
    if (!inlineImageUrl) {
      throw new Error('Unable to build inline Telegram image input');
    }
    return inlineImageUrl;
  }
  return resolveTelegramFileUrl(botToken, fileId);
}

function normalizeRecognitionOutput(output) {
  if (Array.isArray(output)) {
    return {
      recognitions: output.filter(Boolean),
      recognitionErrors: [],
    };
  }
  return {
    recognitions: Array.isArray(output?.recognitions) ? output.recognitions.filter(Boolean) : [],
    recognitionErrors: Array.isArray(output?.recognitionErrors) ? output.recognitionErrors : [],
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

function shouldQueueRecognitionFailure(batch) {
  if (!batch || batch.kind !== 'image') {
    return false;
  }
  if (batch.recognitionPendingStatus === 'queued') {
    return false;
  }

  if (batch.status === 'ready' && hasPartialRecognitionFailure(batch)) {
    return true;
  }

  if (batch.status !== 'skipped') {
    return false;
  }
  if (batch.failureCategory !== 'ai_service') {
    return false;
  }
  return Array.isArray(batch.messages) && batch.messages.some((message) => (message.photos?.length ?? 0) > 0);
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
  const messages = batch.messages ?? [];

  if ((batch.kind ?? 'image') === 'image') {
    try {
      const recognitionOutput = normalizeRecognitionOutput(await recognizeBatchRunner(batch, env));
      recognitions = recognitionOutput.recognitions;
      recognitionErrors = recognitionOutput.recognitionErrors;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      recognitionErrors = messages.map((message) => ({
        messageId: message.messageId,
        error: errorMessage,
        failureCategory: classifyFailureCategory(errorMessage, { phase: 'ai_recognition' }),
      }));
      process.stderr.write(`[telegram-sync] ${logPrefix} for ${batch.batchId}: ${errorMessage}\n`);
    }
  }

  const analyzed = analyzeTelegramBatch(batch, recognitions, {
    minConfidence: 0.75,
  });
  const persistedBatch = {
    ...analyzed,
    kind: batch.kind ?? analyzed.kind ?? 'image',
    updateIds: messages.map((message) => message.updateId).filter(Boolean),
    messages,
    recognitions,
    recognitionErrors,
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
  const batchResults = [];
  let changed = false;
  let replayStoredImageAny = false;

  for (const entry of entries ?? []) {
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
      batchResults.push(persistedBatch);
      continue;
    }

    const persistResult = await persistBatch({
      batch: persistedBatch,
      processedAt: now,
    });
    const resolvedResult = await markPendingRecognitionResolved({ batchId: persistedBatch.batchId });
    changed ||= persistResult.status === 'stored';
    replayStoredImageAny ||= persistResult.status === 'stored';
    batchResults.push({
      ...persistedBatch,
      persistenceStatus: persistResult.status,
      recognitionPendingStatus: resolvedResult.status,
    });
  }

  return {
    changed,
    replayStoredImageAny,
    batchResults,
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
        messages: batch.messages ?? [],
      },
      failureCategory: batch.failureCategory,
      error: batch.failureReason,
      failedAt: now.toISOString(),
      nextRetryAt: nextRetryAt ?? (immediateRetry ? now : undefined),
    });
    batch.recognitionPendingStatus = queueResult.status;
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

async function buildInlineTelegramImageUrl(fetchTelegramFileById, fileId) {
  try {
    const file = await fetchTelegramFileById(fileId);
    const contentType = normalizeInlineImageContentType(file);
    if (!contentType || !(file?.data instanceof Uint8Array) || file.data.length === 0) {
      return null;
    }
    return `data:${contentType};base64,${Buffer.from(file.data).toString('base64')}`;
  } catch {
    return null;
  }
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
