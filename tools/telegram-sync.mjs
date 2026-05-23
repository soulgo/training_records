import { appendFile, access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyTelegramSyncToMarkdown,
  analyzeTelegramBatch,
  groupTelegramUpdates,
  mapWithConcurrency,
} from './telegram-sync-lib.mjs';
import {
  exportTrainingMarkdown as exportTrainingMarkdownFromSnapshot,
  getLastProcessedTelegramUpdateId,
  persistNormalizedBatch as persistNormalizedBatchToDatabase,
  resolveTrainingCoreConfig,
} from './training-db-core.mjs';
import {
  buildTrainingSnapshot as buildTrainingSnapshotFromSource,
  isIncompleteDatabaseSnapshotError,
  isUnavailableDatabaseSnapshotError,
} from './training-snapshot.mjs';
import {
  generateTrainingAnalysisReply,
  splitTelegramMessage,
} from './training-analysis.mjs';
import { buildRecognitionSchema } from './telegram-recognition-schema.mjs';
import {
  fetchTelegramUpdates,
  resolveDispatchTelegramUpdates,
  sendTelegramMessage,
  resolveTelegramFileUrl,
  fetchTelegramFile,
} from './telegram-transport.mjs';
import {
  writeThoughtPostFile,
  editThoughtPost,
  deleteThoughtPost,
  moveThoughtPost,
  readExistingThoughtMessageKeys,
} from './telegram-thoughts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultRecognitionPromptPath = path.join(
  rootDir,
  'prompts',
  'telegram-training-image-recognition.md',
);
const RECOGNITION_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const fallbackRecognitionSystemPrompt =
  '你是训练记录截图结构化助手。只能输出符合 schema 的 JSON。识别类型只允许 measurement、workout、nutrition、unknown。workout 既可能是逐条活动明细截图，也可能是当日活动总览截图；总览图请提取活动热量、锻炼时长、活动小时数到 dailyWorkoutSummary。detectedDate 只能来自截图画面里的日期；若截图日期不可靠则 detectedDate 返回 null，并在 warnings 中说明。若截图是系统相册、文件详情或分享预览页，画面里明确显示的文件名、标题、路径中的日期也算画面内可见日期。';

export async function main() {
  const result = await runTelegramSync();
  process.stdout.write(JSON.stringify(buildTelegramSyncReport(result), null, 2));
  process.stdout.write('\n');
}

export async function runTelegramSync(options = {}) {
  const env = loadRequiredEnv(options.env ?? process.env);
  const activeRootDir = options.rootDir ?? rootDir;
  const recordPath = path.join(activeRootDir, '训练记录.md');
  const thoughtsDir = path.join(activeRootDir, 'source', '_posts');
  const runtimeDir = path.join(activeRootDir, 'runtime');
  const pendingQueuePath = path.join(runtimeDir, 'telegram-sync-pending.ndjson');
  const now = options.now ?? new Date();
  const readLastProcessedUpdateId =
    options.getLastProcessedUpdateId ??
    (() => getLastProcessedTelegramUpdateId({ env: options.env ?? process.env }));
  const fetchUpdates =
    options.fetchTelegramUpdates ??
    ((input) =>
      fetchTelegramUpdates({
        botToken: env.botToken,
        offset: input.offset,
        limit: input.limit,
      }));
  const recognizeBatchRunner =
    options.recognizeBatch ??
    ((batch) => recognizeBatch(batch, env));
  const persistBatch =
    options.persistNormalizedBatch ??
    ((input) =>
      persistNormalizedBatchToDatabase({
        ...input,
        env: options.env ?? process.env,
      }));
  const buildSnapshot =
    options.buildTrainingSnapshot ??
    ((input) =>
      buildTrainingSnapshotFromSource({
        ...input,
        rootDir: activeRootDir,
        env: options.env ?? process.env,
      }));
  const exportMarkdown = options.exportTrainingMarkdown ?? exportTrainingMarkdownFromSnapshot;
  const onFallbackMarkdownWritten = options.onFallbackMarkdownWritten ?? null;
  const writeThoughtPost =
    options.writeThoughtPost ??
    ((input) =>
      writeThoughtPostFile({
        ...input,
        rootDir: activeRootDir,
        fetchTelegramFile:
          options.fetchTelegramFile ??
          ((fileId) =>
            fetchTelegramFile({
              botToken: env.botToken,
              fileId,
            })),
      }));
  const generateAnalysisReply =
    options.generateTrainingAnalysisReply ??
    ((input) =>
      generateTrainingAnalysisReply({
        ...input,
        rootDir: activeRootDir,
        env: options.env ?? process.env,
        now,
      }));
  const sendMessage =
    options.sendTelegramMessage ??
    ((input) =>
      sendTelegramMessage({
        ...input,
          botToken: env.botToken,
      }));
  const shouldNotify =
    options.notifyTelegramSyncResult ??
    shouldNotifyTelegramSyncResult(env, options.env ?? process.env);
  const trainingDbConfig = resolveTrainingCoreConfig(options.env ?? process.env);

  const dispatchUpdates = await resolveDispatchTelegramUpdates({
    repositoryDispatchEvent: options.repositoryDispatchEvent,
    githubEventName: env.githubEventName,
    githubEventPath: env.githubEventPath,
  });
  const previousLastProcessedUpdateId = await readLastProcessedUpdateIdForRun({
    readLastProcessedUpdateId,
    dispatchUpdates,
  });
  const pendingBatches = await readPendingFallbackBatches(pendingQueuePath);
  let replayStoredAny = false;
  let replayStoredImageAny = false;

  for (const pending of pendingBatches) {
    try {
      const replayResult = await persistBatch({
        batch: pending.batch,
        processedAt: now,
        env: options.env ?? process.env,
      });
      if (replayResult.status === 'stored' || replayResult.status === 'unchanged') {
        replayStoredAny = replayStoredAny || replayResult.status === 'stored';
        replayStoredImageAny =
          replayStoredImageAny ||
          (isTrainingDataBatchKind(pending.batch?.kind) && replayResult.status === 'stored');
        pending.replayed = true;
      }
    } catch {
      pending.replayed = false;
    }
  }

  await writePendingFallbackBatches(
    pendingQueuePath,
    pendingBatches.filter((pending) => !pending.replayed),
  );

  const updates =
    dispatchUpdates ??
    (env.syncTransport === 'webhook'
      ? []
      : await fetchUpdates({
          offset: previousLastProcessedUpdateId + 1,
          limit: env.pollLimit,
        }));
  const knownThoughtMessageKeys = await readExistingThoughtMessageKeys(thoughtsDir);
  const grouped = groupTelegramUpdates(updates, { knownThoughtMessageKeys });
  const batchResults = [];
  let changed = replayStoredAny;
  let fallbackUsed = false;
  let fallbackMarkdown = null;
  let fallbackMarkdownLoaded = false;

  async function getFallbackMarkdown() {
    if (!fallbackMarkdownLoaded) {
      fallbackMarkdown = await readMarkdownOrDefault(recordPath);
      fallbackMarkdownLoaded = true;
    }
    return fallbackMarkdown;
  }

  for (const batch of grouped) {
    const isAllowed = batch.messages.every((message) => env.allowedChatIds.has(message.chatId));
    if (!isAllowed) {
      batchResults.push({
        kind: batch.kind ?? 'image',
        batchId: batch.batchId,
        status: 'ignored',
        reason: 'unauthorized chat',
        updateIds: batch.messages.map((message) => message.updateId),
      });
      continue;
    }

    let recognitions = [];
    if (batch.kind === 'image') {
      try {
        recognitions = (await recognizeBatchRunner(batch, env)).filter(Boolean);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[telegram-sync] image recognition failed for ${batch.batchId}: ${errorMessage}\n`,
        );
      }
    }
    const analyzed = analyzeTelegramBatch(batch, recognitions, {
      minConfidence: 0.75,
    });
    const persistedBatch = {
      ...analyzed,
      kind: batch.kind ?? analyzed.kind ?? 'image',
      updateIds: batch.messages.map((message) => message.updateId),
      messages: batch.messages,
      recognitions,
    };

    if (analyzed.status !== 'ready') {
      batchResults.push(persistedBatch);
      continue;
    }

    if (persistedBatch.kind === 'analysis') {
      const analysisResult = await handleAnalysisBatch({
        batch: persistedBatch,
        generateAnalysisReply,
        sendMessage,
      });
      batchResults.push({
        ...persistedBatch,
        analysisReplyStatus: analysisResult.status,
        analysisReplyError: analysisResult.error ?? null,
        analysisReplyParts: analysisResult.parts ?? 0,
      });
      continue;
    }

    if (persistedBatch.kind === 'thought') {
      const thoughtWriteResult = await writeThoughtPost({
        batch: persistedBatch,
        thoughtsDir,
      });
      const thoughtStorageBatch = attachThoughtStorageMetadata(
        persistedBatch,
        thoughtWriteResult,
        activeRootDir,
      );
      changed ||= thoughtWriteResult.changed;

      try {
        const persistResult = await persistBatch({
          batch: thoughtStorageBatch,
          processedAt: now,
          env: options.env ?? process.env,
        });
        changed ||= persistResult.status === 'stored';
        batchResults.push({
          ...thoughtStorageBatch,
          postPath: thoughtWriteResult.postPath,
          thoughtWriteStatus: thoughtWriteResult.status,
          persistenceStatus: persistResult.status,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendPendingFallbackBatch(pendingQueuePath, {
          batch: thoughtStorageBatch,
          failedAt: now.toISOString(),
          error: errorMessage,
        });
        batchResults.push({
          ...thoughtStorageBatch,
          postPath: thoughtWriteResult.postPath,
          thoughtWriteStatus: thoughtWriteResult.status,
          persistenceStatus: 'pending_replay',
          persistenceError: errorMessage,
        });
      }
      continue;
    }

    if (persistedBatch.kind === 'thought_edit') {
      const thoughtEditResult = await editThoughtPost({
        batch: persistedBatch,
        thoughtsDir,
        rootDir: activeRootDir,
        fetchTelegramFile:
          options.fetchTelegramFile ??
          ((fileId) =>
            fetchTelegramFile({
              botToken: env.botToken,
              fileId,
            })),
      });
      const thoughtStorageBatch = attachThoughtStorageMetadata(
        persistedBatch,
        thoughtEditResult,
        activeRootDir,
      );
      changed ||= thoughtEditResult.changed;

      try {
        const persistResult = await persistBatch({
          batch: thoughtStorageBatch,
          processedAt: now,
          env: options.env ?? process.env,
        });
        changed ||= persistResult.status === 'stored';
        batchResults.push({
          ...thoughtStorageBatch,
          postPath: thoughtEditResult.postPath,
          thoughtWriteStatus: thoughtEditResult.status,
          persistenceStatus: persistResult.status,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendPendingFallbackBatch(pendingQueuePath, {
          batch: thoughtStorageBatch,
          failedAt: now.toISOString(),
          error: errorMessage,
        });
        batchResults.push({
          ...thoughtStorageBatch,
          postPath: thoughtEditResult.postPath,
          thoughtWriteStatus: thoughtEditResult.status,
          persistenceStatus: 'pending_replay',
          persistenceError: errorMessage,
        });
      }
      continue;
    }

    if (persistedBatch.kind === 'thought_delete') {
      const thoughtDeleteResult = await deleteThoughtPost({
        batch: persistedBatch,
        thoughtsDir,
        rootDir: activeRootDir,
      });
      const thoughtStorageBatch = attachThoughtStorageMetadata(
        persistedBatch,
        thoughtDeleteResult,
        activeRootDir,
      );
      changed ||= thoughtDeleteResult.changed;

      try {
        const persistResult = await persistBatch({
          batch: thoughtStorageBatch,
          processedAt: now,
          env: options.env ?? process.env,
        });
        changed ||= persistResult.status === 'stored';
        batchResults.push({
          ...thoughtStorageBatch,
          postPath: thoughtDeleteResult.postPath,
          thoughtWriteStatus: thoughtDeleteResult.status,
          deletedPhotoPaths: thoughtDeleteResult.deletedPhotoPaths ?? [],
          persistenceStatus: persistResult.status,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendPendingFallbackBatch(pendingQueuePath, {
          batch: thoughtStorageBatch,
          failedAt: now.toISOString(),
          error: errorMessage,
        });
        batchResults.push({
          ...thoughtStorageBatch,
          postPath: thoughtDeleteResult.postPath,
          thoughtWriteStatus: thoughtDeleteResult.status,
          deletedPhotoPaths: thoughtDeleteResult.deletedPhotoPaths ?? [],
          persistenceStatus: 'pending_replay',
          persistenceError: errorMessage,
        });
      }
      continue;
    }

    if (persistedBatch.kind === 'thought_move') {
      const thoughtMoveResult = await moveThoughtPost({
        batch: persistedBatch,
        thoughtsDir,
      });
      const thoughtStorageBatch = attachThoughtStorageMetadata(
        persistedBatch,
        thoughtMoveResult,
        activeRootDir,
      );
      changed ||= thoughtMoveResult.changed;

      try {
        const persistResult = await persistBatch({
          batch: thoughtStorageBatch,
          processedAt: now,
          env: options.env ?? process.env,
        });
        changed ||= persistResult.status === 'stored';
        batchResults.push({
          ...thoughtStorageBatch,
          postPath: thoughtMoveResult.postPath,
          thoughtWriteStatus: thoughtMoveResult.status,
          persistenceStatus: persistResult.status,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendPendingFallbackBatch(pendingQueuePath, {
          batch: thoughtStorageBatch,
          failedAt: now.toISOString(),
          error: errorMessage,
        });
        batchResults.push({
          ...thoughtStorageBatch,
          postPath: thoughtMoveResult.postPath,
          thoughtWriteStatus: thoughtMoveResult.status,
          persistenceStatus: 'pending_replay',
          persistenceError: errorMessage,
        });
      }
      continue;
    }

    try {
      const persistResult = await persistBatch({
        batch: persistedBatch,
        processedAt: now,
        env: options.env ?? process.env,
      });

      changed ||= analyzed.status === 'ready' && persistResult.status === 'stored';
      batchResults.push({
        ...persistedBatch,
        persistenceStatus: persistResult.status,
      });
      } catch (error) {
      if (analyzed.status === 'ready') {
        const applied = applyTelegramSyncToMarkdown(await getFallbackMarkdown(), persistedBatch);
        fallbackMarkdown = applied.markdown;
        changed ||= applied.changed;
        fallbackUsed = true;
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendPendingFallbackBatch(pendingQueuePath, {
          batch: persistedBatch,
          failedAt: now.toISOString(),
          error: errorMessage,
        });
        process.stderr.write(
          `[telegram-sync] fallback to markdown for ${persistedBatch.batchId} (${persistedBatch.archivedDate ?? 'unknown date'}): ${errorMessage}\n`,
        );
        batchResults.push({
          ...persistedBatch,
          persistenceStatus: 'fallback_markdown',
          persistenceError: errorMessage,
        });
        continue;
      }
      throw error;
    }
  }

  const nextLastProcessedUpdateId = Math.max(
    previousLastProcessedUpdateId,
    updates.reduce((max, update) => Math.max(max, update.update_id ?? 0), 0),
  );

  if (fallbackUsed) {
    await writeFile(recordPath, fallbackMarkdown, 'utf8');
    onFallbackMarkdownWritten?.(fallbackMarkdown);
  } else if (changed && shouldRewriteTrainingMarkdown({ replayStoredImageAny, batchResults })) {
    const readyPersistedBatches = batchResults.filter(
      (batch) =>
        isTrainingDataBatchKind(batch.kind) &&
        batch.status === 'ready' &&
        batch.persistenceStatus === 'stored',
    );
    const snapshotOptions = {
      source: 'database',
      rootDir: activeRootDir,
      env: options.env ?? process.env,
      now,
    };
    let markdown;

    const currentMarkdown = await getFallbackMarkdown();
    try {
      const snapshot = await buildSnapshot(snapshotOptions);
      markdown = snapshotCoversPersistedBatches(snapshot, readyPersistedBatches)
        ? exportMarkdown(snapshot)
        : rebuildMarkdownFromPersistedBatches(currentMarkdown, readyPersistedBatches);
    } catch (error) {
      const canFallbackFromDatabase =
        trainingDbConfig.enabled && Boolean(trainingDbConfig.url);
      if (canFallbackFromDatabase && canRebuildMarkdownFromPersistedBatches(error)) {
        process.stderr.write(
          `[telegram-sync] ${error.message}; rebuilding markdown from persisted batches\n`,
        );
        markdown = rebuildMarkdownFromPersistedBatches(currentMarkdown, readyPersistedBatches);
      } else {
        throw error;
      }
    }

    await writeFile(recordPath, markdown, 'utf8');
  }

  if (shouldNotify) {
    await notifyTelegramSyncResult({
      batchResults,
      sendMessage,
    });
  }

  return {
    changed,
    fallbackUsed,
    updatesFetched: updates.length,
    lastProcessedUpdateId: nextLastProcessedUpdateId,
    readyBatches: batchResults.filter((batch) => batch.status === 'ready').length,
    batchResults,
  };
}

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
    batches: (result.batchResults ?? []).map((batch) => ({
      kind: batch.kind ?? 'image',
      batchId: batch.batchId,
      status: batch.status,
      archivedDate: batch.archivedDate ?? null,
      postPath: batch.postPath ?? null,
      thoughtWriteStatus: batch.thoughtWriteStatus ?? null,
      persistenceStatus: batch.persistenceStatus ?? null,
      persistenceError: batch.persistenceError ?? null,
      warnings: batch.warnings ?? [],
      issues: batch.issues ?? [],
      reason: batch.reason ?? null,
    })),
  };

  for (const [index, batch] of (result.batchResults ?? []).entries()) {
    if ((batch.kind ?? 'image') === 'analysis') {
      normalized.batches[index].analysisReplyStatus = batch.analysisReplyStatus ?? null;
      normalized.batches[index].analysisReplyError = batch.analysisReplyError ?? null;
      normalized.batches[index].analysisReplyParts = batch.analysisReplyParts ?? null;
    }
  }

  return normalized;
}

export async function loadRecognitionSystemPrompt(env = process.env) {
  const promptPath = env.TELEGRAM_RECOGNITION_PROMPT_PATH?.trim() || defaultRecognitionPromptPath;

  try {
    const prompt = await readFile(promptPath, 'utf8');
    const trimmed = prompt.trim();
    return trimmed || fallbackRecognitionSystemPrompt;
  } catch {
    return fallbackRecognitionSystemPrompt;
  }
}

function snapshotCoversPersistedBatches(snapshot, batches) {
  const snapshotDates = new Set((snapshot?.daily ?? []).map((day) => String(day?.date ?? '')));
  return batches.every((batch) => !batch.archivedDate || snapshotDates.has(batch.archivedDate));
}

function rebuildMarkdownFromPersistedBatches(markdown, batches) {
  return batches.reduce((currentMarkdown, batch) => {
    const applied = applyTelegramSyncToMarkdown(currentMarkdown, batch);
    return applied.markdown;
  }, markdown);
}

function shouldRewriteTrainingMarkdown({ replayStoredImageAny, batchResults }) {
  if (replayStoredImageAny) {
    return true;
  }

  return (batchResults ?? []).some(
    (batch) =>
      isTrainingDataBatchKind(batch.kind) &&
      batch.status === 'ready' &&
      batch.persistenceStatus === 'stored',
  );
}

function shouldNotifyTelegramSyncResult(env, rawEnv) {
  const flag = String(rawEnv.TELEGRAM_SYNC_NOTIFY ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(flag)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(flag)) {
    return false;
  }

  return rawEnv.GITHUB_ACTIONS === 'true' && env.syncTransport === 'webhook';
}

async function notifyTelegramSyncResult({ batchResults, sendMessage }) {
  const messagesByChat = new Map();

  for (const batch of batchResults ?? []) {
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

  for (const [chatId, messages] of messagesByChat.entries()) {
    for (const message of messages) {
      try {
        await sendMessage({
          chatId,
          text: message.text,
          replyToMessageId: message.replyToMessageId,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[telegram-sync] failed to send sync notification to ${chatId}: ${errorMessage}\n`,
        );
      }
    }
  }
}

function shouldNotifyBatch(batch) {
  if (!batch || batch.kind === 'analysis') {
    return false;
  }

  if (!isTrainingDataBatchKind(batch.kind)) {
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
  if (batch.status === 'ready') {
    const dateText = formatChineseDate(batch.archivedDate);
    const storageText = formatPersistenceStatus(batch.persistenceStatus);
    return `解析成功，${storageText}${dateText ? ` ${dateText}数据` : ''}`;
  }

  if (batch.status === 'skipped') {
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

function formatChineseDate(dateValue) {
  const match = String(dateValue ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return '';
  }

  return `${Number(match[1])} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
}

function isTrainingDataBatchKind(kind) {
  return kind !== 'thought' && kind !== 'thought_edit' && kind !== 'thought_delete' && kind !== 'thought_move' && kind !== 'analysis';
}

function attachThoughtStorageMetadata(batch, writeResult, activeRootDir) {
  const storage = {
    markdownPath: toRepoRelativePath(writeResult.postPath, activeRootDir),
    photoPaths: writeResult.photoPaths ?? [],
    deletedPhotoPaths: (writeResult.deletedPhotoPaths ?? [])
      .map((photoPath) => toPublicThoughtImagePath(photoPath, activeRootDir))
      .filter(Boolean),
    writeStatus: writeResult.status ?? null,
  };

  if (batch.kind === 'thought') {
    return {
      ...batch,
      thought: {
        ...batch.thought,
        thoughtModule: writeResult.thoughtModule ?? batch.thought?.thoughtModule ?? 'workout',
        tags: writeResult.tags ?? batch.thought?.tags ?? ['训练', '随想', 'Telegram'],
        storage,
      },
    };
  }

  if (batch.kind === 'thought_edit') {
    return {
      ...batch,
      thoughtEdit: {
        ...batch.thoughtEdit,
        thoughtModule: writeResult.thoughtModule ?? batch.thoughtEdit?.thoughtModule ?? null,
        tags: writeResult.tags ?? batch.thoughtEdit?.tags ?? null,
        storage,
      },
    };
  }

  if (batch.kind === 'thought_delete') {
    return {
      ...batch,
      thoughtDelete: {
        ...batch.thoughtDelete,
        thoughtModule: writeResult.thoughtModule ?? batch.thoughtDelete?.thoughtModule ?? null,
        tags: writeResult.tags ?? batch.thoughtDelete?.tags ?? null,
        storage,
      },
    };
  }

  if (batch.kind === 'thought_move') {
    return {
      ...batch,
      thoughtMove: {
        ...batch.thoughtMove,
        thoughtModule: writeResult.thoughtModule ?? batch.thoughtMove?.thoughtModule ?? null,
        tags: writeResult.tags ?? batch.thoughtMove?.tags ?? null,
        storage,
      },
    };
  }

  return batch;
}

function toRepoRelativePath(targetPath, activeRootDir) {
  if (!targetPath || !activeRootDir) {
    return null;
  }

  const relative = path.relative(activeRootDir, targetPath).split(path.sep).join('/');
  return relative && !relative.startsWith('..') ? relative : targetPath;
}

function toPublicThoughtImagePath(targetPath, activeRootDir) {
  if (!targetPath || !activeRootDir) {
    return null;
  }

  const relative = toRepoRelativePath(targetPath, activeRootDir);
  if (typeof relative !== 'string') {
    return null;
  }
  return relative.startsWith('source/images/')
    ? `/${relative.slice('source/'.length)}`
    : relative;
}

async function readLastProcessedUpdateIdForRun({
  readLastProcessedUpdateId,
  dispatchUpdates,
}) {
  try {
    return await readLastProcessedUpdateId();
  } catch (error) {
    if (!dispatchUpdates) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[telegram-sync] could not read last processed update id: ${message}; continuing with repository dispatch payload\n`,
    );
    return 0;
  }
}

function canRebuildMarkdownFromPersistedBatches(error) {
  return isIncompleteDatabaseSnapshotError(error) || isUnavailableDatabaseSnapshotError(error);
}

function loadRequiredEnv(env = process.env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const apiKey = env.AI_API_KEY;
  const baseUrl = env.AI_BASE_URL;
  const model = env.AI_MODEL;
  const allowedChatIdsRaw = env.TELEGRAM_ALLOWED_CHAT_IDS;
  const dbEnabled = env.TRAINING_DB_ENABLED;
  const dbUrl = env.TRAINING_DB_URL;
  const pollLimit = Number(env.TELEGRAM_POLL_LIMIT ?? 20);
  const aiConcurrency = Number(env.AI_CONCURRENCY ?? 3);

  for (const [name, value] of [
    ['TELEGRAM_BOT_TOKEN', botToken],
    ['AI_API_KEY', apiKey],
    ['AI_BASE_URL', baseUrl],
    ['AI_MODEL', model],
    ['TELEGRAM_ALLOWED_CHAT_IDS', allowedChatIdsRaw],
    ['TRAINING_DB_ENABLED', dbEnabled],
    ['TRAINING_DB_URL', dbUrl],
  ]) {
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  return {
    botToken,
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    syncTransport:
      String(env.TELEGRAM_SYNC_TRANSPORT ?? 'poll').toLowerCase() === 'webhook'
        ? 'webhook'
        : 'poll',
    githubEventName: env.GITHUB_EVENT_NAME?.trim() || '',
    githubEventPath: env.GITHUB_EVENT_PATH?.trim() || '',
    pollLimit: Number.isFinite(pollLimit) && pollLimit > 0 ? pollLimit : 20,
    aiConcurrency: Number.isFinite(aiConcurrency) && aiConcurrency > 0 ? aiConcurrency : 3,
    allowedChatIds: new Set(
      allowedChatIdsRaw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map(Number),
    ),
  };
}

async function recognizeBatch(batch, env) {
  const recognitions = await mapWithConcurrency(batch.messages, env.aiConcurrency, async (message) => {
    const fileId = message.photos.at(-1)?.fileId;
    if (!fileId) {
      return null;
    }
    const imageUrl = await resolveTelegramFileUrl(env.botToken, fileId);
    try {
      return await recognizeImageMessage(message, imageUrl, env);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[telegram-sync] image recognition failed for ${message.messageId}: ${errorMessage}\n`,
      );
      return null;
    }
  });

  return recognitions.filter(Boolean);
}

async function readMarkdownOrDefault(recordPath) {
  try {
    return await readFile(recordPath, 'utf8');
  } catch {
    return '';
  }
}

const MAX_PENDING_QUEUE_SIZE = 1000;

async function appendPendingFallbackBatch(queuePath, payload) {
  const existing = await readPendingFallbackBatchesRaw(queuePath);
  const deduped = existing.filter((entry) => entry.batch?.batchId !== payload.batch?.batchId);
  const trimmed = deduped.length >= MAX_PENDING_QUEUE_SIZE
    ? deduped.slice(-MAX_PENDING_QUEUE_SIZE + 1)
    : deduped;
  trimmed.push(payload);
  await mkdir(path.dirname(queuePath), { recursive: true });
  const content = trimmed.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(queuePath, content ? `${content}\n` : '', 'utf8');
}

async function writePendingFallbackBatches(queuePath, entries) {
  await mkdir(path.dirname(queuePath), { recursive: true });
  const trimmed = entries.length > MAX_PENDING_QUEUE_SIZE
    ? entries.slice(-MAX_PENDING_QUEUE_SIZE)
    : entries;
  const content = trimmed.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(queuePath, content ? `${content}\n` : '', 'utf8');
}

async function readPendingFallbackBatches(queuePath) {
  return readPendingFallbackBatchesRaw(queuePath);
}

async function readPendingFallbackBatchesRaw(queuePath) {
  try {
    const raw = await readFile(queuePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function handleAnalysisBatch({ batch, generateAnalysisReply, sendMessage }) {
  const message = batch.messages?.[0] ?? {};
  try {
    const reply = await generateAnalysisReply({
      question: batch.analysis?.question ?? '',
    });
    const parts = splitTelegramMessage(reply);
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

async function recognizeImageMessage(message, imageUrl, env) {
  const response = await fetchRecognitionResponse(`${env.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.apiKey}`,
    },
    body: JSON.stringify({
      model: env.model,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'telegram_training_image',
          strict: true,
          schema: buildRecognitionSchema(),
        },
      },
      messages: [
        {
          role: 'system',
          content: await loadRecognitionSystemPrompt(env),
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `caption: ${message.caption || '(empty)'}`,
                `text: ${message.text || '(empty)'}`,
                '将图片识别为训练系统可写回的结构化结果。',
              ].join('\n'),
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`AI recognition failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('AI recognition returned empty content');
  }

  const parsed = JSON.parse(content);
  return {
    messageId: message.messageId,
    ...parsed,
  };
}

async function fetchRecognitionResponse(url, init, options = {}) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 350));
  let lastResponse = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || !RECOGNITION_RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts) {
        return response;
      }
      lastResponse = response;
      process.stderr.write(
        `[telegram-sync] AI recognition request failed with HTTP ${response.status}; retrying (${attempt}/${maxAttempts})\n`,
      );
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }
      process.stderr.write(
        `[telegram-sync] AI recognition request failed: ${error instanceof Error ? error.message : String(error)}; retrying (${attempt}/${maxAttempts})\n`,
      );
    }

    await delay(baseDelayMs * attempt);
  }

  if (lastResponse) {
    return lastResponse;
  }
  throw lastError ?? new Error('AI recognition request failed');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
