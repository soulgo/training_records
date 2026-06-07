import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAiProvider } from '../src/ai/provider.mjs';
import {
  applyTelegramSyncToMarkdown,
  groupTelegramUpdates,
} from './telegram-sync-lib.mjs';
import {
  appendPendingRecognitionBatch as appendPendingRecognitionBatchToDatabase,
  backfillCoreSleepFromIngestBatches as backfillCoreSleepFromIngestBatchesToDatabase,
  getLastProcessedTelegramUpdateId,
  markPendingRecognitionResolved as markPendingRecognitionResolvedInDatabase,
  persistNormalizedBatch as persistNormalizedBatchToDatabase,
  readPendingRecognitionBatches as readPendingRecognitionBatchesFromDatabase,
} from './training-db-core.mjs';
import {
  generateTrainingAnalysisReply,
  splitTelegramMessage,
} from './training-analysis.mjs';
import { runTelegramAiAgent } from './telegram-ai-agent.mjs';
import {
  fetchTelegramUpdates,
  resolveDispatchTelegramUpdates,
  sendTelegramMessage,
  fetchTelegramFile,
} from './telegram-transport.mjs';
import {
  writeThoughtPostFile,
  editThoughtPost,
  deleteThoughtPost,
  moveThoughtPost,
  readExistingThoughtMessageKeys,
} from './telegram-thoughts.mjs';
import {
  getThoughtModuleTags,
  isThoughtBatchKind,
  normalizeThoughtModule,
} from './lib/thought-modules.mjs';
import { TELEGRAM_HELP_TEXT } from '../src/telegram/help.mjs';
import {
  buildTelegramSyncReport,
  classifyFailureCategory,
  isTrainingDataBatchKind,
  maybePersistTelegramSyncResult,
  notifyTelegramSyncResult,
  notifyTelegramSyncResultFromFile,
  notifyTelegramSyncResultFromReport,
  resolveTelegramSyncNotificationStage,
  resolveTelegramSyncResultPath,
  shouldNotifyTelegramSyncResult,
  shouldPersistTelegramArtifacts,
} from './telegram-sync-status.mjs';
import {
  appendPendingFallbackBatch,
  readMarkdownOrDefault,
  readPendingFallbackBatches,
  rebuildMarkdownFromPersistedBatches,
  shouldRewriteTrainingMarkdown,
  writePendingFallbackBatches,
} from './telegram-sync-fallback.mjs';
import {
  buildImageProcessingBatch,
  loadRecognitionSystemPrompt,
  queueRecognitionFailureIfNeeded,
  readPendingRecognitionBatchesForRun,
  recognizeBatch,
  replayPendingRecognitionBatches,
} from './telegram-sync-image-processing.mjs';

export {
  buildTelegramSyncReport,
  loadRecognitionSystemPrompt,
  notifyTelegramSyncResultFromFile,
  notifyTelegramSyncResultFromReport,
  shouldPersistTelegramArtifacts,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function main() {
  const result = await runTelegramSync();
  process.stdout.write(JSON.stringify(buildTelegramSyncReport(result), null, 2));
  process.stdout.write('\n');
}

export async function runTelegramSync(options = {}) {
  const rawEnv = options.env ?? process.env;
  const env = loadRequiredEnv(rawEnv);
  const activeRootDir = options.rootDir ?? rootDir;
  const recordPath = path.join(activeRootDir, '训练记录.md');
  const thoughtsDir = path.join(activeRootDir, 'source', '_posts');
  const runtimeDir = path.join(activeRootDir, 'runtime');
  const pendingQueuePath = path.join(runtimeDir, 'telegram-sync-pending.ndjson');
  const now = options.now ?? new Date();
  const aiProvider = options.aiProvider ?? createAiProvider(rawEnv);
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
    ((batch) => recognizeBatch(batch, env, { aiProvider, rawEnv, fetchTelegramFileById }));
  const persistBatch =
    options.persistNormalizedBatch ??
    ((input) =>
      persistNormalizedBatchToDatabase({
        ...input,
        env: options.env ?? process.env,
      }));
  const useDefaultPendingRecognitionStore =
    !options.persistNormalizedBatch &&
    !options.fetchTelegramUpdates &&
    !options.repositoryDispatchEvent &&
    !options.readPendingRecognitionBatches &&
    !options.appendPendingRecognitionBatch &&
    !options.markPendingRecognitionResolved;
  const readPendingRecognitionBatches =
    options.readPendingRecognitionBatches ??
    (useDefaultPendingRecognitionStore
      ? () =>
          readPendingRecognitionBatchesFromDatabase({
            env: options.env ?? process.env,
            now,
          })
      : async () => []);
  const appendPendingRecognitionBatch =
    options.appendPendingRecognitionBatch ??
    (useDefaultPendingRecognitionStore
      ? (input) =>
          appendPendingRecognitionBatchToDatabase({
            ...input,
            env: options.env ?? process.env,
            now,
          })
      : async (input) => ({ status: 'skipped', reason: 'not_configured', batchId: input?.batch?.batchId }));
  const markPendingRecognitionResolved =
    options.markPendingRecognitionResolved ??
    (useDefaultPendingRecognitionStore
      ? (input) =>
          markPendingRecognitionResolvedInDatabase({
            ...input,
            env: options.env ?? process.env,
            now,
          })
      : async (input) => ({ status: 'skipped', reason: 'not_configured', batchId: input?.batchId }));
  const onFallbackMarkdownWritten = options.onFallbackMarkdownWritten ?? null;
  const fetchTelegramFileById =
    options.fetchTelegramFile ??
    ((fileId) =>
      fetchTelegramFile({
        botToken: env.botToken,
        fileId,
      }));
  const generateAnalysisReply =
    options.generateTrainingAnalysisReply ??
    ((input) =>
      generateTrainingAnalysisReply({
        ...input,
        rootDir: activeRootDir,
        env: rawEnv,
        now,
        aiProvider,
      }));
  const runAiAgent =
    options.runTelegramAiAgent ??
    ((input) =>
      runTelegramAiAgent({
        ...input,
        rootDir: activeRootDir,
        env: rawEnv,
        now,
        aiProvider,
      }));
  const sendMessage =
    options.sendTelegramMessage ??
    ((input) =>
      sendTelegramMessage({
        ...input,
        botToken: env.botToken,
      }));
  const backfillCoreSleep =
    options.backfillCoreSleepFromIngestBatches ??
    ((input) =>
      backfillCoreSleepFromIngestBatchesToDatabase({
        ...input,
        env: options.env ?? process.env,
      }));
  const notificationStage = resolveTelegramSyncNotificationStage(rawEnv);
  const shouldNotifyImmediately =
    shouldNotifyTelegramSyncResult(rawEnv) && notificationStage !== 'after_action';
  const resultPath = resolveTelegramSyncResultPath(rawEnv, activeRootDir, options.resultPath);

  const dispatchUpdates = await resolveDispatchTelegramUpdates({
    repositoryDispatchEvent: options.repositoryDispatchEvent,
    githubEventName: env.githubEventName,
    githubEventPath: env.githubEventPath,
  });
  const previousLastProcessedUpdateId = await readLastProcessedUpdateIdForRun({
    readLastProcessedUpdateId,
    dispatchUpdates,
    allowFallback: Boolean(dispatchUpdates) || env.githubEventName === 'repository_dispatch',
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

  const pendingRecognitionEntries = await readPendingRecognitionBatchesForRun({
    readPendingRecognitionBatches,
    allowFallback: Boolean(dispatchUpdates) || env.githubEventName === 'repository_dispatch',
  });
  const replayRecognitionResults = await replayPendingRecognitionBatches({
    entries: pendingRecognitionEntries,
    recognizeBatchRunner,
    persistBatch,
    appendPendingRecognitionBatch,
    markPendingRecognitionResolved,
    now,
    env,
  });
  changed ||= replayRecognitionResults.changed;
  replayStoredImageAny ||= replayRecognitionResults.replayStoredImageAny;
  batchResults.push(...replayRecognitionResults.batchResults);

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
        messages: batch.messages,
        updateIds: batch.messages.map((message) => message.updateId),
      });
      continue;
    }

    const persistedBatch = await buildImageProcessingBatch({
      batch,
      recognizeBatchRunner,
      env,
      logPrefix: 'image recognition failed',
    });
    await queueRecognitionFailureIfNeeded({
      batch: persistedBatch,
      appendPendingRecognitionBatch,
      now,
    });

    if (persistedBatch.status !== 'ready') {
      batchResults.push(persistedBatch);
      continue;
    }

    if (persistedBatch.kind === 'help') {
      const helpResult = await handleHelpBatch({
        batch: persistedBatch,
        sendMessage,
      });
      batchResults.push({
        ...persistedBatch,
        helpReplyStatus: helpResult.status,
        helpReplyError: helpResult.error ?? null,
      });
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
        failureCategory:
          analysisResult.status === 'failed'
            ? classifyFailureCategory(analysisResult.error, { phase: 'ai_analysis' })
            : persistedBatch.failureCategory,
        failureReason:
          analysisResult.status === 'failed'
            ? analysisResult.error
            : persistedBatch.failureReason,
      });
      continue;
    }

    if (persistedBatch.kind === 'ai_agent') {
      const aiAgentResult = await handleAiAgentBatch({
        batch: persistedBatch,
        runAiAgent,
        sendMessage,
      });
      batchResults.push({
        ...persistedBatch,
        aiAgentReplyStatus: aiAgentResult.status,
        aiAgentReplyError: aiAgentResult.error ?? null,
        aiAgentReplyParts: aiAgentResult.parts ?? 0,
        failureCategory:
          aiAgentResult.status === 'failed'
            ? classifyFailureCategory(aiAgentResult.error, { phase: 'ai_agent' })
            : persistedBatch.failureCategory,
        failureReason:
          aiAgentResult.status === 'failed'
            ? aiAgentResult.error
            : persistedBatch.failureReason,
      });
      continue;
    }

    if (isThoughtBatchKind(persistedBatch.kind)) {
      const thoughtResult = await handleThoughtSyncBatch({
        batch: persistedBatch,
        kind: persistedBatch.kind,
        thoughtsDir,
        activeRootDir,
        now,
        env,
        persistBatch,
        appendPendingFallbackBatch,
        pendingQueuePath,
        fetchTelegramFile: fetchTelegramFileById,
      });
      changed ||= thoughtResult.changed;
      batchResults.push(thoughtResult.batchResult);
      continue;
    }

    try {
      const persistResult = await persistBatch({
        batch: persistedBatch,
        processedAt: now,
        env: options.env ?? process.env,
      });

      changed ||= persistedBatch.status === 'ready' && persistResult.status === 'stored';
      batchResults.push({
        ...persistedBatch,
        persistenceStatus: persistResult.status,
      });
      await markPendingRecognitionResolved({ batchId: persistedBatch.batchId });
    } catch (error) {
      if (persistedBatch.status === 'ready') {
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
          failureCategory: classifyFailureCategory(errorMessage, { phase: 'database' }),
          failureReason: errorMessage,
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

  if (replayStoredImageAny || batchResults.some((batch) => batch.kind === 'image' && batch.status === 'ready')) {
    try {
      await backfillCoreSleep({
        processedAt: now,
        sourceChannel: 'telegram_sync',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[telegram-sync] sleep backfill failed: ${errorMessage}\n`);
    }
  }

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
    const currentMarkdown = await getFallbackMarkdown();
    const markdown = rebuildMarkdownFromPersistedBatches(currentMarkdown, readyPersistedBatches);

    await writeFile(recordPath, markdown, 'utf8');
  }

  const result = {
    changed,
    fallbackUsed,
    updatesFetched: updates.length,
    lastProcessedUpdateId: nextLastProcessedUpdateId,
    readyBatches: batchResults.filter((batch) => batch.status === 'ready').length,
    batchResults,
  };
  await maybePersistTelegramSyncResult(resultPath, result);

  if (shouldNotifyImmediately) {
    await notifyTelegramSyncResult({
      batchResults,
      sendMessage,
      env: rawEnv,
    });
  }

  return result;
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
    const nextModule = normalizeThoughtModule(writeResult.thoughtModule ?? batch.thought?.thoughtModule);
    return {
      ...batch,
      thought: {
        ...batch.thought,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thought?.tags ?? getThoughtModuleTags(nextModule),
        storage,
      },
    };
  }

  if (batch.kind === 'thought_edit') {
    const nextModule = normalizeThoughtModule(writeResult.thoughtModule ?? batch.thoughtEdit?.thoughtModule);
    return {
      ...batch,
      thoughtEdit: {
        ...batch.thoughtEdit,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thoughtEdit?.tags ?? getThoughtModuleTags(nextModule),
        storage,
      },
    };
  }

  if (batch.kind === 'thought_delete') {
    const nextModule = normalizeThoughtModule(writeResult.thoughtModule ?? batch.thoughtDelete?.thoughtModule);
    return {
      ...batch,
      thoughtDelete: {
        ...batch.thoughtDelete,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thoughtDelete?.tags ?? getThoughtModuleTags(nextModule),
        storage,
      },
    };
  }

  if (batch.kind === 'thought_move') {
    const nextModule = normalizeThoughtModule(writeResult.thoughtModule ?? batch.thoughtMove?.thoughtModule);
    return {
      ...batch,
      thoughtMove: {
        ...batch.thoughtMove,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thoughtMove?.tags ?? getThoughtModuleTags(nextModule),
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
  allowFallback = false,
}) {
  try {
    return await readLastProcessedUpdateId();
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[telegram-sync] could not read last processed update id: ${message}; continuing with repository dispatch payload\n`,
    );
    return 0;
  }
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

async function handleHelpBatch({ batch, sendMessage }) {
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

async function handleAiAgentBatch({ batch, runAiAgent, sendMessage }) {
  const message = batch.messages?.[0] ?? {};
  try {
    const reply = await runAiAgent({
      question: batch.aiAgent?.question ?? '',
      chatId: message.chatId,
      messageId: message.messageId,
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
      text: `AI 助手暂时生成失败：${errorMessage}`,
      replyToMessageId: message.messageId,
    });
    return {
      status: 'failed',
      error: errorMessage,
      parts: 1,
    };
  }
}

async function handleThoughtSyncBatch({
  batch,
  kind,
  thoughtsDir,
  activeRootDir,
  now,
  env,
  persistBatch,
  appendPendingFallbackBatch,
  pendingQueuePath,
  fetchTelegramFile,
}) {
  const thoughtWriteResult = await writeThoughtArtifact({
    batch,
    kind,
    thoughtsDir,
    activeRootDir,
    fetchTelegramFile,
    env,
  });
  const thoughtStorageBatch = attachThoughtStorageMetadata(
    batch,
    thoughtWriteResult,
    activeRootDir,
  );
  const baseBatchResult = {
    ...thoughtStorageBatch,
    postPath: thoughtWriteResult.postPath,
    thoughtWriteStatus: thoughtWriteResult.status,
  };
  if (Array.isArray(thoughtWriteResult.deletedPhotoPaths)) {
    baseBatchResult.deletedPhotoPaths = thoughtWriteResult.deletedPhotoPaths;
  }

  try {
    const persistResult = await persistBatch({
      batch: thoughtStorageBatch,
      processedAt: now,
      env,
    });
    return {
      changed: thoughtWriteResult.changed || persistResult.status === 'stored',
      batchResult: {
        ...baseBatchResult,
        persistenceStatus: persistResult.status,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await appendPendingFallbackBatch(pendingQueuePath, {
      batch: thoughtStorageBatch,
      failedAt: now.toISOString(),
      error: errorMessage,
    });
    return {
      changed: thoughtWriteResult.changed,
      batchResult: {
        ...baseBatchResult,
        persistenceStatus: 'pending_replay',
        persistenceError: errorMessage,
        failureCategory: classifyFailureCategory(errorMessage, { phase: 'database' }),
        failureReason: errorMessage,
      },
    };
  }
}

async function writeThoughtArtifact({
  batch,
  kind,
  thoughtsDir,
  activeRootDir,
  fetchTelegramFile,
}) {
  if (kind === 'thought') {
    return writeThoughtPostFile({
      batch,
      thoughtsDir,
      rootDir: activeRootDir,
      fetchTelegramFile,
    });
  }

  if (kind === 'thought_edit') {
    return editThoughtPost({
      batch,
      thoughtsDir,
      rootDir: activeRootDir,
      fetchTelegramFile,
    });
  }

  if (kind === 'thought_delete') {
    return deleteThoughtPost({
      batch,
      thoughtsDir,
      rootDir: activeRootDir,
    });
  }

  if (kind === 'thought_move') {
    return moveThoughtPost({
      batch,
      thoughtsDir,
    });
  }

  throw new Error(`Unsupported thought batch kind: ${kind}`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
