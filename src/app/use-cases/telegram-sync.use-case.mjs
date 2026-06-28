import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAiProvider, isAiSchedulerEnabled } from '../../ai/provider.mjs';
import { groupTelegramUpdates } from '../../adapters/telegram/sync-batch.adapter.mjs';
import {
  appendPendingRecognitionBatch as appendPendingRecognitionBatchToDatabase,
  backfillCoreSleepFromIngestBatches as backfillCoreSleepFromIngestBatchesToDatabase,
  getLastProcessedTelegramUpdateId,
  markPendingRecognitionResolved as markPendingRecognitionResolvedInDatabase,
  persistNormalizedBatch as persistNormalizedBatchToDatabase,
  readPendingRecognitionBatches as readPendingRecognitionBatchesFromDatabase,
  writeStartedRecognitionAiCallLog as writeStartedRecognitionAiCallLogToDatabase,
} from '../../../tools/training-db-core.mjs';
import {
  generateTrainingAnalysisResult,
  splitTelegramMessage,
} from '../../../tools/training-analysis.mjs';
import {
  fetchTelegramUpdates,
  resolveDispatchTelegramUpdates,
  sendTelegramMessage,
  fetchTelegramFile,
} from '../../../tools/telegram-transport.mjs';
import {
  createImageStorage,
  writeThoughtImageArtifacts,
  readExistingThoughtMessageKeys,
} from '../../../tools/telegram-thoughts.mjs';
import {
  getThoughtModuleTags,
  isThoughtBatchKind,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
} from '../../../tools/lib/thought-modules.mjs';
import { TELEGRAM_HELP_TEXT } from '../../telegram/help.mjs';
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
} from './telegram-sync/status.mjs';
import {
  appendPendingFallbackBatch,
  readPendingFallbackBatches,
  writePendingFallbackBatches,
} from './telegram-sync/fallback.mjs';
import {
  buildImageProcessingBatch,
  loadRecognitionSystemPrompt,
  markImageSyncStage,
  markImageSyncStageFailure,
  queueRecognitionFailureIfNeeded,
  readPendingRecognitionBatchesForRun,
  recognizeBatch,
  replayPendingRecognitionBatches,
} from './telegram-sync/image-processing.mjs';

export {
  buildTelegramSyncReport,
  createImageStorage,
  loadRecognitionSystemPrompt,
  notifyTelegramSyncResultFromFile,
  notifyTelegramSyncResultFromReport,
  shouldPersistTelegramArtifacts,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..', '..');
const MAX_THOUGHT_MARKDOWN_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export async function main() {
  const result = await runTelegramSync();
  process.stdout.write(JSON.stringify(buildTelegramSyncReport(result), null, 2));
  process.stdout.write('\n');
}

export async function runTelegramSync(options = {}) {
  return runMessageSync({
    ...options,
    adapter: {
      channel: 'telegram',
      ...(options.adapter ?? {}),
    },
  });
}

export async function runMessageSync(options = {}) {
  const timings = createSyncTimings();
  const adapter = normalizeMessageSyncAdapter(options.adapter);
  const rawEnv = options.env ?? process.env;
  const env = loadRequiredEnv(rawEnv, { adapter });
  const activeRootDir = options.rootDir ?? rootDir;
  const recordPath = path.join(activeRootDir, '训练记录.md');
  const thoughtsDir = path.join(activeRootDir, 'source', '_posts');
  const runtimeDir = path.join(activeRootDir, 'runtime');
  const pendingQueuePath = path.join(runtimeDir, 'telegram-sync-pending.ndjson');
  const now = options.now ?? new Date();
  const imageStorage = options.imageStorage ?? createImageStorage({
    env: rawEnv,
    rootDir: activeRootDir,
    createCosClient: options.createCosClient,
  });
  const aiProvider = options.aiProvider ?? createAiProvider(rawEnv);
  const recognitionAiProvider =
    options.recognitionAiProvider ?? createRecognitionAiProvider(rawEnv, aiProvider);
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
  const fetchTelegramFileById =
    options.fetchTelegramFile ??
    ((fileId) =>
      fetchTelegramFile({
        botToken: env.botToken,
        fileId,
      }));
  const fetchTelegramImageFileById =
    options.fetchTelegramFile ??
    ((fileId) =>
      fetchTelegramFile({
        botToken: env.botToken,
        fileId,
        maxDownloadBytes: rawEnv.MAX_IMAGE_DOWNLOAD_BYTES,
      }));
  const writeStartedRecognitionAiCallLog =
    options.writeStartedRecognitionAiCallLog ??
    (!options.persistNormalizedBatch && !options.recognizeBatch
      ? (event) =>
          writeStartedRecognitionAiCallLogToDatabase({
            ...event,
            env: options.env ?? process.env,
            occurredAt: now,
          })
      : undefined);
  const recognizeBatchRunner =
    options.recognizeBatch ??
    ((batch) => recognizeBatch(batch, env, {
      aiProvider: recognitionAiProvider,
      rawEnv,
      fetchTelegramFileById: fetchTelegramImageFileById,
      writeStartedRecognitionAiCallLog,
    }));
  const sourceChannel = options.sourceChannel ?? adapter.channel;
  const persistNormalizedBatchRunner =
    options.persistNormalizedBatch ??
    ((input) => persistNormalizedBatchToDatabase(input));
  const persistBatch = (input) =>
    persistNormalizedBatchRunner({
      ...input,
      sourceChannel: input.sourceChannel ?? sourceChannel,
      env: input.env ?? options.env ?? process.env,
    });
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
  const generateAnalysisReply =
    options.generateTrainingAnalysisReply ??
    ((input) =>
      generateTrainingAnalysisResult({
        ...input,
        rootDir: activeRootDir,
        env: rawEnv,
        now,
        aiProvider,
        snapshot: options.snapshot,
        buildTrainingSnapshot: options.buildTrainingSnapshot,
        createClient: options.createClient,
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
  const resolveDispatchUpdates = options.resolveDispatchUpdates ?? resolveDispatchTelegramUpdates;
  const groupUpdates = options.groupUpdates ?? groupTelegramUpdates;
  const dispatchUpdates = await measureSyncStage(timings, 'resolveUpdates', () =>
    resolveDispatchUpdates({
      repositoryDispatchEvent: options.repositoryDispatchEvent,
      githubEventName: env.githubEventName,
      githubEventPath: env.githubEventPath,
      dispatchPayload: env.dispatchPayload,
    }),
  );
  const previousLastProcessedUpdateId = await measureSyncStage(timings, 'readOffset', () =>
    readLastProcessedUpdateIdForRun({
      readLastProcessedUpdateId,
      dispatchUpdates,
      allowFallback: Boolean(dispatchUpdates) || env.githubEventName === 'repository_dispatch',
    }),
  );
  const shouldReplayLegacyNdjsonPending = shouldReplayLegacyPendingQueue(rawEnv, options);
  const pendingBatches = await measureSyncStage(timings, 'readPendingFallback', () =>
    shouldReplayLegacyNdjsonPending
      ? readPendingFallbackBatches(pendingQueuePath)
      : [],
  );
  let replayStoredAny = false;
  let storedSleepAny = false;

  await measureSyncStage(timings, 'replayFallbackPersist', async () => {
    for (const pending of pendingBatches) {
      try {
        const replayResult = await persistBatch({
          batch: pending.batch,
          processedAt: now,
          sourceChannel: pending.batch?.sourceChannel ?? sourceChannel,
          env: options.env ?? process.env,
        });
        if (replayResult.status === 'stored' || replayResult.status === 'unchanged') {
          replayStoredAny = replayStoredAny || replayResult.status === 'stored';
          storedSleepAny =
            storedSleepAny ||
            (isTrainingDataBatchKind(pending.batch?.kind) &&
              replayResult.status === 'stored' &&
              hasSleepBatchPayload(pending.batch));
          pending.replayed = true;
        }
      } catch {
        pending.replayed = false;
      }
    }
  });

  await measureSyncStage(timings, 'writePendingFallback', async () => {
    if (!shouldReplayLegacyNdjsonPending || pendingBatches.length === 0) {
      return;
    }
    await writePendingFallbackBatches(
      pendingQueuePath,
      pendingBatches.filter((pending) => !pending.replayed),
      { backupBeforeWrite: true, now },
    );
  });

  const updates = await measureSyncStage(timings, 'fetchUpdates', () =>
    dispatchUpdates ??
    (env.syncTransport === 'webhook'
      ? []
      : fetchUpdates({
          offset: previousLastProcessedUpdateId + 1,
          limit: env.pollLimit,
        })),
  );
  const knownThoughtMessageKeys = await measureSyncStage(timings, 'readThoughtKeys', () =>
    readExistingThoughtMessageKeys(thoughtsDir),
  );
  const grouped = measureSyncStageSync(timings, 'groupUpdates', () =>
    groupUpdates(updates, { knownThoughtMessageKeys }),
  );
  const batchResults = [];
  let changed = replayStoredAny;

  const pendingRecognitionEntries = await measureSyncStage(timings, 'readPendingRecognition', () =>
    readPendingRecognitionBatchesForRun({
      readPendingRecognitionBatches,
      allowFallback: Boolean(dispatchUpdates) || env.githubEventName === 'repository_dispatch',
    }),
  );
  const replayRecognitionResults = await measureSyncStage(timings, 'replayRecognition', () =>
    replayPendingRecognitionBatches({
      entries: pendingRecognitionEntries,
      recognizeBatchRunner,
      persistBatch,
      appendPendingRecognitionBatch,
      markPendingRecognitionResolved,
      now,
      env,
    }),
  );
  changed ||= replayRecognitionResults.changed;
  storedSleepAny ||= replayRecognitionResults.batchResults.some((batch) =>
    batch.persistenceStatus === 'stored' && hasSleepBatchPayload(batch)
  );
  batchResults.push(...replayRecognitionResults.batchResults);

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

    const persistedBatch = await measureSyncStage(timings, 'recognition', () =>
      buildImageProcessingBatch({
        batch,
        recognizeBatchRunner,
        env,
        logPrefix: 'image recognition failed',
      }),
    );
    await measureSyncStage(timings, 'queueRecognition', () =>
      queueRecognitionFailureIfNeeded({
        batch: persistedBatch,
        appendPendingRecognitionBatch,
        now,
      }),
    );

    if (persistedBatch.status !== 'ready') {
      batchResults.push(persistedBatch);
      continue;
    }

    if (persistedBatch.kind === 'help') {
      const helpResult = await measureSyncStage(timings, 'notify', () =>
        handleHelpBatch({
          batch: persistedBatch,
          sendMessage,
        }),
      );
      batchResults.push({
        ...persistedBatch,
        helpReplyStatus: helpResult.status,
        helpReplyError: helpResult.error ?? null,
      });
      continue;
    }

    if (persistedBatch.kind === 'analysis') {
      const analysisResult = await measureSyncStage(timings, 'analysis', () =>
        handleAnalysisBatch({
          batch: persistedBatch,
          generateAnalysisReply,
          sendMessage,
        }),
      );
      batchResults.push({
        ...persistedBatch,
        analysisReplyStatus: analysisResult.status,
        analysisReplyError: analysisResult.error ?? null,
        analysisReplyParts: analysisResult.parts ?? 0,
        analysisAttemptKind: analysisResult.aiAttemptKind ?? null,
        analysisModel: analysisResult.model ?? null,
        analysisSnapshotSource: analysisResult.snapshotSource ?? null,
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

    if (isThoughtBatchKind(persistedBatch.kind)) {
      const thoughtResult = await measureSyncStage(timings, 'persist', () =>
        handleThoughtSyncBatch({
          batch: persistedBatch,
          kind: persistedBatch.kind,
          thoughtsDir,
          activeRootDir,
          now,
          env: rawEnv,
          persistBatch,
          appendPendingPersistenceBatch: appendPendingRecognitionBatch,
          fetchTelegramFile: options.fetchMessageFile ?? fetchTelegramFileById,
          imageStorage,
        }),
      );
      changed ||= thoughtResult.changed;
      batchResults.push(thoughtResult.batchResult);
      continue;
    }

    try {
      const persistStartedAt = nowMs();
      const persistResult = await measureSyncStage(timings, 'persist', () =>
        persistBatch({
          batch: persistedBatch,
          processedAt: now,
          sourceChannel: persistedBatch.sourceChannel ?? sourceChannel,
          env: options.env ?? process.env,
        }),
      );
      markImageSyncStage(persistedBatch, 'db_persist', {
        status: 'succeeded',
        durationMs: elapsedMs(persistStartedAt),
        failureCategory: null,
        failureReason: null,
      });

      const storedSleepImageBatch =
        isTrainingDataBatchKind(persistedBatch.kind) &&
        persistResult.status === 'stored' &&
        hasSleepBatchPayload(persistedBatch);
      changed ||= persistedBatch.status === 'ready' && persistResult.status === 'stored';
      storedSleepAny ||= storedSleepImageBatch;
      batchResults.push({
        ...persistedBatch,
        persistenceStatus: persistResult.status,
      });
      await measureSyncStage(timings, 'markRecognitionResolved', () =>
        markPendingRecognitionResolved({ batchId: persistedBatch.batchId }),
      );
    } catch (error) {
      if (persistedBatch.status === 'ready') {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const failureCategory = classifyFailureCategory(errorMessage, { phase: 'database' });
        markImageSyncStageFailure(persistedBatch, 'db_persist', errorMessage, {
          failureCategory,
        });
        if (failureCategory === 'user_input') {
          batchResults.push({
            ...persistedBatch,
            persistenceStatus: 'manual_intervention',
            persistenceError: errorMessage,
            failureCategory,
            failureReason: errorMessage,
          });
          continue;
        }
        await measureSyncStage(timings, 'queuePersistenceReplay', () =>
          appendPendingRecognitionBatch({
            batch: persistedBatch,
            failureCategory,
            error: errorMessage,
            failedAt: now.toISOString(),
          }),
        );
        process.stderr.write(
          `[telegram-sync] queued database replay for ${persistedBatch.batchId} (${persistedBatch.archivedDate ?? 'unknown date'}): ${errorMessage}\n`,
        );
        batchResults.push({
          ...persistedBatch,
          persistenceStatus: 'pending_replay',
          persistenceError: errorMessage,
          failureCategory,
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

  if (shouldRunSleepBackfill({ rawEnv, storedSleepAny })) {
    try {
      await measureSyncStage(timings, 'sleepBackfill', () =>
        backfillCoreSleep({
          processedAt: now,
          sourceChannel: options.sleepBackfillSourceChannel ?? 'telegram_sync',
        }),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[telegram-sync] sleep backfill failed: ${errorMessage}\n`);
    }
  }

  const result = {
    changed,
    fallbackUsed: false,
    updatesFetched: updates.length,
    lastProcessedUpdateId: nextLastProcessedUpdateId,
    readyBatches: batchResults.filter((batch) => batch.status === 'ready').length,
    batchResults,
    tasks: buildMessageSyncTasks(batchResults, { channel: sourceChannel }),
    timingsMs: timings.timingsMs,
  };
  finalizeSyncTimings(timings, result);
  await maybePersistTelegramSyncResult(resultPath, result);

  if (shouldNotifyImmediately) {
    await measureSyncStage(timings, 'notify', () =>
      notifyTelegramSyncResult({
        batchResults,
        sendMessage,
        env: rawEnv,
      }),
    );
    finalizeSyncTimings(timings, result);
    await maybePersistTelegramSyncResult(resultPath, result);
  }

  logSyncTimings(result.timingsMs);

  return result;
}

function createSyncTimings() {
  return {
    startedAt: nowMs(),
    timingsMs: {},
  };
}

async function measureSyncStage(timings, stage, run) {
  const startedAt = nowMs();
  try {
    return await run();
  } finally {
    addTiming(timings, stage, elapsedMs(startedAt));
  }
}

function measureSyncStageSync(timings, stage, run) {
  const startedAt = nowMs();
  try {
    return run();
  } finally {
    addTiming(timings, stage, elapsedMs(startedAt));
  }
}

function addTiming(timings, stage, durationMs) {
  if (!timings?.timingsMs || !stage) {
    return;
  }
  timings.timingsMs[stage] = Math.round((timings.timingsMs[stage] ?? 0) + durationMs);
}

function finalizeSyncTimings(timings, result) {
  timings.timingsMs.total = elapsedMs(timings.startedAt);
  result.timingsMs = timings.timingsMs;
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

function nowMs() {
  return Number(globalThis.performance?.now?.() ?? Date.now());
}

function logSyncTimings(timingsMs) {
  if (!timingsMs || Object.keys(timingsMs).length === 0) {
    return;
  }
  process.stderr.write(`[telegram-sync] timings ${JSON.stringify(timingsMs)}\n`);
}

function shouldReplayLegacyPendingQueue(rawEnv, options = {}) {
  if (options.replayLegacyNdjsonPending !== undefined) {
    return Boolean(options.replayLegacyNdjsonPending);
  }
  return ['1', 'true', 'yes', 'on'].includes(
    String(rawEnv.TELEGRAM_SYNC_REPLAY_LEGACY_NDJSON_PENDING ?? '').trim().toLowerCase(),
  );
}

export function createRecognitionAiProvider(rawEnv, defaultProvider) {
  const schedulerEnabled = isAiSchedulerEnabled(rawEnv);
  const recognitionModel = String(
    schedulerEnabled
      ? rawEnv.AI_RECOGNITION_MODEL ?? rawEnv.TELEGRAM_RECOGNITION_MODEL ?? ''
      : rawEnv.TELEGRAM_RECOGNITION_MODEL ?? '',
  ).trim();
  const recognitionTimeoutMs = String(schedulerEnabled ? rawEnv.AI_RECOGNITION_TIMEOUT_MS ?? '' : '').trim();
  const shouldCreateSceneProvider = Boolean(recognitionModel || recognitionTimeoutMs);
  const primaryProvider = shouldCreateSceneProvider
    ? createAiProvider({
        ...rawEnv,
        ...(recognitionModel ? { AI_MODEL: recognitionModel } : {}),
        ...(recognitionTimeoutMs ? { AI_TIMEOUT_MS: recognitionTimeoutMs } : {}),
      })
    : defaultProvider;
  const fallbackProvider = createRecognitionFallbackAiProvider(rawEnv);
  if (!fallbackProvider) {
    return primaryProvider;
  }
  return {
    ...primaryProvider,
    fallbackProvider,
  };
}

function createRecognitionFallbackAiProvider(rawEnv) {
  const apiKey = String(rawEnv.TELEGRAM_RECOGNITION_FALLBACK_API_KEY ?? '').trim();
  const baseUrl = String(rawEnv.TELEGRAM_RECOGNITION_FALLBACK_BASE_URL ?? '').trim();
  const model = String(rawEnv.TELEGRAM_RECOGNITION_FALLBACK_MODEL ?? '').trim();

  if (!apiKey && !baseUrl && !model) {
    return null;
  }
  if (!apiKey || !baseUrl || !model) {
    process.stderr.write(
      '[telegram-sync] fallback recognition AI provider is not configured completely; ignoring fallback provider\n',
    );
    return null;
  }

  return createAiProvider({
    ...rawEnv,
    AI_API_KEY: apiKey,
    AI_BASE_URL: baseUrl,
    AI_MODEL: model,
    AI_PROVIDER: rawEnv.TELEGRAM_RECOGNITION_FALLBACK_PROVIDER || rawEnv.AI_PROVIDER,
    AI_TIMEOUT_MS:
      (isAiSchedulerEnabled(rawEnv) ? rawEnv.AI_RECOGNITION_FALLBACK_TIMEOUT_MS : '') ||
      rawEnv.TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS ||
      rawEnv.AI_TIMEOUT_MS,
  });
}

function shouldRunSleepBackfill({ rawEnv, storedSleepAny }) {
  const flag = String(rawEnv.TELEGRAM_SYNC_RUN_SLEEP_BACKFILL ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(flag)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(flag)) {
    return false;
  }
  return storedSleepAny;
}

function hasSleepBatchPayload(batch) {
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

function attachThoughtStorageMetadata(batch, writeResult, activeRootDir) {
  const storage = {
    markdownPath: toRepoRelativePath(writeResult.postPath, activeRootDir),
    photoPaths: writeResult.photoPaths ?? [],
    deletedPhotoPaths: (writeResult.deletedPhotoPaths ?? [])
      .map((photoPath) => toPublicThoughtImagePath(photoPath, activeRootDir))
      .filter(Boolean),
    writeStatus: writeResult.status ?? null,
    imageUploadStats: writeResult.storageStats ?? null,
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
    const nextModule = normalizeThoughtModuleOrNull(writeResult.thoughtModule ?? batch.thoughtEdit?.thoughtModule);
    return {
      ...batch,
      thoughtEdit: {
        ...batch.thoughtEdit,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thoughtEdit?.tags,
        storage,
      },
    };
  }

  if (batch.kind === 'thought_delete') {
    const nextModule = normalizeThoughtModuleOrNull(writeResult.thoughtModule ?? batch.thoughtDelete?.thoughtModule);
    return {
      ...batch,
      thoughtDelete: {
        ...batch.thoughtDelete,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thoughtDelete?.tags,
        storage,
      },
    };
  }

  if (batch.kind === 'thought_move') {
    const nextModule = normalizeThoughtModuleOrNull(writeResult.thoughtModule ?? batch.thoughtMove?.thoughtModule);
    return {
      ...batch,
      thoughtMove: {
        ...batch.thoughtMove,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thoughtMove?.tags,
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

function normalizeMessageSyncAdapter(adapter = {}) {
  const channel = String(adapter.channel ?? 'telegram').trim().toLowerCase() || 'telegram';
  return {
    channel,
    botTokenEnvName: adapter.botTokenEnvName ?? (channel === 'telegram' ? 'TELEGRAM_BOT_TOKEN' : null),
    allowedChatIdsEnvName:
      adapter.allowedChatIdsEnvName ?? (channel === 'telegram' ? 'TELEGRAM_ALLOWED_CHAT_IDS' : null),
    transportEnvName:
      adapter.transportEnvName ?? (channel === 'telegram' ? 'TELEGRAM_SYNC_TRANSPORT' : null),
  };
}

function loadRequiredEnv(env = process.env, options = {}) {
  const adapter = options.adapter ?? normalizeMessageSyncAdapter();
  const botToken = adapter.botTokenEnvName
    ? env[adapter.botTokenEnvName]
    : env.TELEGRAM_BOT_TOKEN ?? adapter.channel;
  const apiKey = env.AI_API_KEY;
  const baseUrl = env.AI_BASE_URL;
  const model = env.AI_MODEL;
  const allowedChatIdsRaw = adapter.allowedChatIdsEnvName
    ? env[adapter.allowedChatIdsEnvName]
    : env.TELEGRAM_ALLOWED_CHAT_IDS;
  const dbEnabled = env.TRAINING_DB_ENABLED;
  const dbUrl = env.TRAINING_DB_URL;
  const pollLimit = Number(env.TELEGRAM_POLL_LIMIT ?? 20);
  const aiConcurrency = normalizeAiConcurrency(env.AI_CONCURRENCY, {
    maxValue: env.AI_CONCURRENCY_MAX,
  });

  const required = [
    ['AI_API_KEY', apiKey],
    ['AI_BASE_URL', baseUrl],
    ['AI_MODEL', model],
    ['TRAINING_DB_ENABLED', dbEnabled],
    ['TRAINING_DB_URL', dbUrl],
  ];
  if (adapter.botTokenEnvName) {
    required.unshift([adapter.botTokenEnvName, botToken]);
  }
  if (adapter.allowedChatIdsEnvName) {
    required.push([adapter.allowedChatIdsEnvName, allowedChatIdsRaw]);
  }

  for (const [name, value] of required) {
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  const syncTransportValue = adapter.transportEnvName
    ? env[adapter.transportEnvName]
    : env.TELEGRAM_SYNC_TRANSPORT;

  return {
    botToken,
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    syncTransport:
      String(syncTransportValue ?? 'poll').toLowerCase() === 'webhook'
        ? 'webhook'
        : 'poll',
    githubEventName: env.GITHUB_EVENT_NAME?.trim() || '',
    githubEventPath: env.SYNC_DISPATCH_EVENT_PATH?.trim() || env.GITHUB_EVENT_PATH?.trim() || '',
    dispatchPayload: env.SYNC_DISPATCH_PAYLOAD ?? env.DISPATCH_PAYLOAD ?? '',
    pollLimit: Number.isFinite(pollLimit) && pollLimit > 0 ? pollLimit : 20,
    aiConcurrency,
    allowedChatIds: parseAllowedChatIds(allowedChatIdsRaw),
  };
}

function normalizeAiConcurrency(value, options = {}) {
  const defaultValue = 3;
  const configured = Number(value ?? defaultValue);
  const maxValue = Number(options.maxValue ?? 5);
  const limit = Number.isFinite(maxValue) && maxValue > 0 ? Math.floor(maxValue) : 5;
  const normalized =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : defaultValue;
  return Math.min(normalized, limit);
}

function buildMessageSyncTasks(batchResults, { channel }) {
  return (batchResults ?? []).map((batch) => {
    const kind = batch.kind ?? 'image';
    const messages = Array.isArray(batch.messages) ? batch.messages : [];
    const chatIds = [
      ...new Set(messages
        .map((message) => message?.sourceChatId ?? message?.chatId)
        .filter((value) => value !== null && value !== undefined && value !== '')),
    ];
    const sourceMessageIds = messages
      .map((message) => message?.sourceMessageId ?? message?.messageId)
      .filter((value) => value !== null && value !== undefined);

    return {
      taskId: `${channel}:${kind}:${batch.batchId ?? 'unknown'}`,
      channel,
      kind,
      batchId: batch.batchId ?? null,
      taskStatus: batch.taskStatus ?? batch.status ?? 'queued',
      persistenceStatus: batch.persistenceStatus ?? null,
      failureCategory: batch.failureCategory ?? null,
      failureReason: batch.failureReason ?? batch.reason ?? null,
      archivedDate: batch.archivedDate ?? null,
      chatIds,
      sourceMessageIds,
    };
  });
}

function parseAllowedChatIds(value) {
  const ids = new Set();
  for (const entry of String(value ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    ids.add(trimmed);
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      ids.add(numeric);
    }
  }
  return ids;
}

async function handleAnalysisBatch({ batch, generateAnalysisReply, sendMessage }) {
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

async function handleThoughtSyncBatch({
  batch,
  kind,
  thoughtsDir,
  activeRootDir,
  now,
  env,
  persistBatch,
  appendPendingPersistenceBatch,
  fetchTelegramFile,
  imageStorage,
}) {
  const preparedThoughtBatch = await prepareThoughtMarkdownBody({
    batch,
    kind,
    fetchTelegramFile,
  });
  if (preparedThoughtBatch.status === 'failed') {
    return {
      changed: false,
      batchResult: {
        ...batch,
        status: 'skipped',
        reason: preparedThoughtBatch.reason,
        failureCategory: preparedThoughtBatch.failureCategory,
        failureReason: preparedThoughtBatch.reason,
        postPath: null,
        thoughtWriteStatus: 'failed',
        persistenceStatus: null,
      },
    };
  }
  const batchWithMarkdownBody = preparedThoughtBatch.batch;
  const thoughtWriteResult = await writeThoughtArtifact({
    batch: batchWithMarkdownBody,
    kind,
    thoughtsDir,
    activeRootDir,
    fetchTelegramFile,
    env,
    imageStorage,
  });
  const thoughtStorageBatch = attachThoughtStorageMetadata(
    batchWithMarkdownBody,
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
    if (persistResult.status === 'not_found') {
      const targetMessageId = persistResult.messageId ?? getThoughtTargetMessageId(thoughtStorageBatch);
      const reason = `target thought ${targetMessageId ?? 'unknown'} not found`;
      return {
        changed: false,
        batchResult: {
          ...baseBatchResult,
          status: 'skipped',
          reason,
          thoughtWriteStatus: 'not_found',
          persistenceStatus: 'not_found',
          failureCategory: 'user_input',
          failureReason: reason,
        },
      };
    }
    return {
      changed: thoughtWriteResult.changed || persistResult.status === 'stored',
      batchResult: {
        ...baseBatchResult,
        persistenceStatus: persistResult.status,
        persistedThoughtModule: persistResult.thoughtModule ?? null,
        persistedThoughtMessageId:
          persistResult.messageId ?? getPersistedThoughtMessageId(thoughtStorageBatch),
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await appendPendingPersistenceBatch({
      batch: thoughtStorageBatch,
      failureCategory: 'database',
      error: errorMessage,
      failedAt: now.toISOString(),
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

function getThoughtTargetMessageId(batch) {
  return (
    batch.thoughtEdit?.targetMessageId ??
    batch.thoughtDelete?.targetMessageId ??
    batch.thoughtMove?.targetMessageId ??
    null
  );
}

function getPersistedThoughtMessageId(batch) {
  return batch.thought?.telegramMessageId ?? getThoughtTargetMessageId(batch);
}

async function prepareThoughtMarkdownBody({ batch, kind, fetchTelegramFile }) {
  if (kind !== 'thought' && kind !== 'thought_edit') {
    return { status: 'ready', batch };
  }

  const markdownDocument = findThoughtMarkdownDocument(batch);
  if (!markdownDocument) {
    return { status: 'ready', batch };
  }

  if (!fetchTelegramFile) {
    return {
      status: 'failed',
      reason: 'Telegram markdown attachment download is not configured',
      failureCategory: 'telegram_api',
    };
  }

  if (
    Number.isFinite(markdownDocument.fileSize) &&
    markdownDocument.fileSize > MAX_THOUGHT_MARKDOWN_ATTACHMENT_BYTES
  ) {
    return {
      status: 'failed',
      reason: `markdown attachment too large: ${markdownDocument.fileSize} bytes`,
      failureCategory: 'user_input',
    };
  }

  try {
    const file = await fetchTelegramFile(markdownDocument.fileId);
    const data = file?.data;
    if (!(data instanceof Uint8Array)) {
      return {
        status: 'failed',
        reason: 'markdown attachment download returned no file data',
        failureCategory: 'telegram_api',
      };
    }
    if (data.byteLength > MAX_THOUGHT_MARKDOWN_ATTACHMENT_BYTES) {
      return {
        status: 'failed',
        reason: `markdown attachment too large: ${data.byteLength} bytes`,
        failureCategory: 'user_input',
      };
    }

    const body = new TextDecoder('utf-8').decode(data).replace(/^\uFEFF/u, '').trim();
    if (!body) {
      return {
        status: 'failed',
        reason: 'empty markdown attachment',
        failureCategory: 'user_input',
      };
    }

    return {
      status: 'ready',
      batch: attachMarkdownBodyToThoughtBatch(batch, kind, body),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: errorMessage,
      failureCategory: classifyFailureCategory(errorMessage, { phase: 'telegram_file_download' }),
    };
  }
}

function attachMarkdownBodyToThoughtBatch(batch, kind, body) {
  if (kind === 'thought_edit') {
    return {
      ...batch,
      thoughtEdit: {
        ...batch.thoughtEdit,
        body,
      },
    };
  }

  return {
    ...batch,
    thought: {
      ...batch.thought,
      body,
    },
  };
}

function findThoughtMarkdownDocument(batch) {
  const sourceMessageId = batch.thought?.sourceMessageId ?? null;
  const messages = [...(batch.messages ?? [])].sort((left, right) => left.messageId - right.messageId);
  const sourceMessage = messages.find((message) => message.messageId === sourceMessageId);
  return (
    sourceMessage?.markdownDocuments?.[0] ??
    messages.find((message) => (message.markdownDocuments?.length ?? 0) > 0)?.markdownDocuments?.[0] ??
    null
  );
}

async function writeThoughtArtifact({
  batch,
  kind,
  thoughtsDir,
  activeRootDir,
  fetchTelegramFile,
  imageStorage,
}) {
  if (kind === 'thought') {
    const result = await writeThoughtImageArtifacts({
      batch,
      rootDir: activeRootDir,
      fetchTelegramFile,
      imageStorage,
    });
    if (result.status === 'no_images') {
      return {
        ...result,
        status: 'thought_database_only',
      };
    }
    return result;
  }

  if (kind === 'thought_edit') {
    if (batch.thoughtEdit?.replacePhotos) {
      return writeThoughtImageArtifacts({
        batch,
        rootDir: activeRootDir,
        fetchTelegramFile,
        imageStorage,
        overwrite: true,
      });
    }
    return buildDatabaseOnlyThoughtWriteResult(batch, kind);
  }

  if (kind === 'thought_delete' || kind === 'thought_move') {
    return buildDatabaseOnlyThoughtWriteResult(batch, kind);
  }

  throw new Error(`Unsupported thought batch kind: ${kind}`);
}

function buildDatabaseOnlyThoughtWriteResult(batch, kind) {
  const thought =
    batch.thought ??
    batch.thoughtEdit ??
    batch.thoughtDelete ??
    batch.thoughtMove ??
    {};
  const thoughtModule = normalizeThoughtModuleOrNull(thought.thoughtModule);
  const sourceChannel = thought.sourceChannel ?? batch.sourceChannel;
  return {
    changed: false,
    status: `${kind}_database_only`,
    postPath: null,
    photoPaths: null,
    deletedPhotoPaths: [],
    thoughtModule,
    tags: thoughtModule ? getThoughtModuleTags(thoughtModule, { sourceChannel }) : null,
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
