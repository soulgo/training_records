import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMessageSyncReport,
  buildSafeSyncReport,
  classifyFailureCategory,
  isTrainingDataBatchKind,
  maybePersistMessageSyncResult,
  notifyMessageSyncResultFromFile,
  notifyMessageSyncResultFromReport,
  notifyMessageSyncResult,
  resolveMessageSyncNotificationStage,
  resolveMessageSyncResultPath,
  shouldNotifyMessageSyncResult,
  shouldPersistMessageSyncArtifacts,
} from './message-sync/status.mjs';
import {
  createImageStorage,
  readExistingThoughtMessageKeys,
} from './message-sync/thought-artifacts.mjs';
import { getLastProcessedTelegramUpdateId } from '../../db/training/read.mjs';
import {
  fetchTelegramFile,
  fetchTelegramUpdates,
  resolveDispatchTelegramUpdates,
  sendTelegramMessage,
} from '../../adapters/telegram/index.mjs';
import {
  buildImageProcessingBatch,
  loadRecognitionSystemPrompt,
  markImageSyncStage,
  markImageSyncStageFailure,
  queueRecognitionFailureIfNeeded,
  readPendingRecognitionBatchesForRun,
  recognizeBatch,
  replayPendingRecognitionBatches,
} from './message-sync/image-processing.mjs';
import {
  appendPendingRecognitionBatch as appendPendingRecognitionBatchToDatabase,
  markPendingRecognitionResolved as markPendingRecognitionResolvedInDatabase,
  readPendingRecognitionBatches as readPendingRecognitionBatchesFromDatabase,
  writeStartedRecognitionAiCallLog as writeStartedRecognitionAiCallLogToDatabase,
} from '../../db/training/pending-recognition.mjs';
import {
  backfillCoreSleepFromIngestBatches as backfillCoreSleepFromIngestBatchesToDatabase,
  persistNormalizedBatch as persistNormalizedBatchToDatabase,
} from '../../db/training/write.mjs';
import { generateTrainingAnalysisResult } from './training-analysis.impl.mjs';
import { groupTelegramUpdates } from '../../adapters/telegram/sync-batch-logic.adapter.mjs';
import { isThoughtBatchKind } from '../../core/thought-modules.mjs';
import { buildPersistenceSummary } from './message-sync/persistence-summary.mjs';
import {
  createAiProvider,
  isAiSchedulerEnabled,
} from '../../adapters/ai/ai-provider.factory.mjs';
import {
  addTiming,
  createSyncTimings,
  elapsedMs,
  finalizeSyncTimings,
  logSyncTimings,
  measureSyncStage,
  measureSyncStageSync,
  nowMs,
  withPendingStatus,
} from './message-sync-timings.mjs';
import {
  loadRequiredEnv,
  normalizeMessageSyncAdapter,
  readLastProcessedUpdateIdForRun,
} from './message-sync-env.mjs';
import {
  addArchivedDate,
  handleAnalysisBatch,
  handleHelpBatch,
  hasSleepBatchPayload,
  shouldRunSleepBackfill,
} from './message-sync-handlers.mjs';
import { handleThoughtSyncBatch } from './message-sync-thoughts.mjs';

export {
  buildSafeSyncReport,
  buildMessageSyncReport,
  createImageStorage,
  loadRecognitionSystemPrompt,
  notifyMessageSyncResultFromFile,
  notifyMessageSyncResultFromReport,
  shouldPersistMessageSyncArtifacts,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const rootDir = path.resolve(__dirname, '..', '..', '..');

export async function runMessageSync(options = {}) {
  const timings = createSyncTimings();
  const adapter = normalizeMessageSyncAdapter(options.adapter);
  const rawEnv = options.env ?? process.env;
  const env = loadRequiredEnv(rawEnv, { adapter });
  const activeRootDir = options.rootDir ?? rootDir;
  const recordPath = path.join(activeRootDir, '训练记录.md');
  const thoughtsDir = path.join(activeRootDir, 'source', '_posts');
  const now = options.now ?? new Date();
  const imageStorage = options.imageStorage ?? createImageStorage({
    env: rawEnv,
    rootDir: activeRootDir,
    createCosClient: options.createCosClient,
  });
  const getAiProvider = createLazyAiProvider(rawEnv, options.aiProvider);
  const getRecognitionAiProvider = createLazyRecognitionAiProvider(
    rawEnv,
    options.recognitionAiProvider,
    getAiProvider,
  );
  const readLastProcessedUpdateId =
    options.getLastProcessedUpdateId ??
    (() => getLastProcessedTelegramUpdateId({ env: options.env ?? process.env }));
  const fetchUpdates =
    options.fetchUpdates ??
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
      aiProvider: getRecognitionAiProvider(),
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
    options.useDefaultPendingRecognitionStore === true ||
    (options.useDefaultPendingRecognitionStore !== false &&
      !options.persistNormalizedBatch &&
      !options.fetchUpdates &&
      !options.repositoryDispatchEvent &&
      !options.readPendingRecognitionBatches &&
      !options.appendPendingRecognitionBatch &&
      !options.markPendingRecognitionResolved);
  const readPendingRecognitionBatches =
    options.readPendingRecognitionBatches ??
    (useDefaultPendingRecognitionStore
      ? () =>
          readPendingRecognitionBatchesFromDatabase({
            env: options.env ?? process.env,
            now,
            sourceChannel,
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
        aiProvider: getAiProvider(),
        snapshot: options.snapshot,
        buildTrainingSnapshot: options.buildTrainingSnapshot,
        createClient: options.createClient,
      }));
  const sendMessage =
    options.sendMessage ??
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
  const notificationStage = resolveMessageSyncNotificationStage(rawEnv);
  const shouldNotifyImmediately =
    shouldNotifyMessageSyncResult(rawEnv) && notificationStage !== 'after_action';
  const resultPath = resolveMessageSyncResultPath(rawEnv, activeRootDir, options.resultPath);
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
  let previousLastProcessedUpdateId = 0;
  if (dispatchUpdates || env.syncTransport === 'webhook') {
    addTiming(timings, 'readOffset', 0);
  } else {
    previousLastProcessedUpdateId = await measureSyncStage(timings, 'readOffset', () =>
      readLastProcessedUpdateIdForRun({
        readLastProcessedUpdateId,
        dispatchUpdates: null,
        allowFallback: false,
      }),
    );
  }
  let replayStoredAny = false;
  let storedSleepAny = false;
  const storedSleepArchivedDates = new Set();

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
  const batches = [];
  let changed = replayStoredAny;

  let pendingRecognitionEntries = [];
  if (env.replayMode === 'scheduled') {
    pendingRecognitionEntries = await measureSyncStage(timings, 'readPendingRecognition', () =>
      readPendingRecognitionBatchesForRun({
        readPendingRecognitionBatches,
        allowFallback: false,
      }),
    );
  } else {
    addTiming(timings, 'readPendingRecognition', 0);
  }
  const replayRecognitionResults = await measureSyncStage(timings, 'replayRecognition', () =>
    replayPendingRecognitionBatches({
      entries: pendingRecognitionEntries,
      sourceChannel,
      recognizeBatchRunner,
      persistBatch,
      appendPendingRecognitionBatch,
      markPendingRecognitionResolved,
      backfillCoreSleep,
      sleepBackfillSourceChannel: options.sleepBackfillSourceChannel ?? `${sourceChannel}_sync`,
      now,
      env,
    }),
  );
  changed ||= replayRecognitionResults.changed;
  storedSleepAny ||= replayRecognitionResults.batches.some((batch) =>
    batch.persistenceStatus === 'stored' && hasSleepBatchPayload(batch)
  );
  for (const batch of replayRecognitionResults.batches) {
    if (batch.persistenceStatus === 'stored' && hasSleepBatchPayload(batch)) {
      addArchivedDate(storedSleepArchivedDates, batch.archivedDate);
    }
  }
  batches.push(...replayRecognitionResults.batches);

  for (const batch of grouped) {
    const isAllowed = batch.messages.every((message) => env.allowedChatIds.has(message.chatId));
    if (!isAllowed) {
      batches.push({
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
      if (persistedBatch.kind === 'image' && persistedBatch.failureCategory === 'business_incomplete') {
        try {
          const persistResult = await measureSyncStage(timings, 'persist', () =>
            persistBatch({
              batch: persistedBatch,
              processedAt: now,
              sourceChannel: persistedBatch.sourceChannel ?? sourceChannel,
              env: options.env ?? process.env,
            }),
          );
          batches.push({
            ...persistedBatch,
            persistenceStatus: persistResult.status,
            persistenceResult: buildPersistenceSummary(persistResult),
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          batches.push({
            ...persistedBatch,
            persistenceStatus: 'pending_replay',
            persistenceError: errorMessage,
            failureCategory: 'database',
            failureReason: errorMessage,
          });
        }
      } else {
        batches.push(persistedBatch);
      }
      continue;
    }

    if (persistedBatch.kind === 'help') {
      const helpResult = await measureSyncStage(timings, 'notify', () =>
        handleHelpBatch({
          batch: persistedBatch,
          sendMessage,
        }),
      );
      batches.push({
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
      batches.push({
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
      batches.push(thoughtResult.batchResult);
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
      if (storedSleepImageBatch) {
        addArchivedDate(storedSleepArchivedDates, persistResult.archivedDate ?? persistedBatch.archivedDate);
      }
      const persistenceResult = buildPersistenceSummary(persistResult);
      batches.push({
        ...persistedBatch,
        persistenceStatus: persistResult.status,
        ...(persistenceResult ? { persistenceResult } : {}),
      });
      await measureSyncStage(timings, 'markRecognitionResolved', () =>
        markPendingRecognitionResolved({
          batchId: persistedBatch.batchId,
          sourceChannel: persistedBatch.sourceChannel ?? sourceChannel,
        }),
      );
    } catch (error) {
      if (persistedBatch.status === 'ready') {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const failureCategory = classifyFailureCategory(errorMessage, { phase: 'database' });
        markImageSyncStageFailure(persistedBatch, 'db_persist', errorMessage, {
          failureCategory,
        });
        if (failureCategory === 'user_input') {
          const persistenceResult = withPendingStatus(buildPersistenceSummary(error.persistenceResult), null);
          batches.push({
            ...persistedBatch,
            persistenceStatus: 'manual_intervention',
            persistenceError: errorMessage,
            failureCategory,
            failureReason: errorMessage,
            ...(persistenceResult ? { persistenceResult } : {}),
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
          `[message-sync] queued database replay for ${persistedBatch.batchId} (${persistedBatch.archivedDate ?? 'unknown date'}): ${errorMessage}\n`,
        );
        const persistenceResult = withPendingStatus(buildPersistenceSummary(error.persistenceResult), 'queued');
        batches.push({
          ...persistedBatch,
          persistenceStatus: 'pending_replay',
          persistenceError: errorMessage,
          failureCategory,
          failureReason: errorMessage,
          ...(persistenceResult ? { persistenceResult } : {}),
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
          targetArchivedDates: [...storedSleepArchivedDates].sort(),
        }),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureCategory = classifyFailureCategory(errorMessage, { phase: 'database' });
      const warning = `sleep backfill failed: ${errorMessage}`;

      // 对于非用户输入错误，将睡眠批次加入 pending 队列
      for (const batch of batches) {
        if (batch.persistenceStatus !== 'stored' || !hasSleepBatchPayload(batch)) {
          continue;
        }

        batch.partialFailure = true;
        batch.failureCategory ??= failureCategory;
        batch.failureReason ??= errorMessage;
        batch.warnings = [...new Set([...(batch.warnings ?? []), warning])];

        // 新增：如果不是用户输入错误，加入 pending 重试
        if (failureCategory !== 'user_input') {
          try {
            await measureSyncStage(timings, 'queueSleepBackfillReplay', () =>
              appendPendingRecognitionBatch({
                batch: {
                  ...batch,
                  kind: 'sleep_backfill',
                  targetArchivedDates: [...storedSleepArchivedDates].sort(),
                },
                failureCategory,
                error: errorMessage,
                failedAt: now.toISOString(),
              }),
            );
            process.stderr.write(
              `[message-sync] queued sleep backfill replay for ${batch.batchId} (${batch.archivedDate ?? 'unknown date'}): ${errorMessage}\n`,
            );
          } catch (pendingError) {
            const pendingErrorMessage = pendingError instanceof Error ? pendingError.message : String(pendingError);
            process.stderr.write(
              `[message-sync] failed to queue sleep backfill replay for ${batch.batchId}: ${pendingErrorMessage}\n`,
            );
          }
        }
      }

      process.stderr.write(`[message-sync] sleep backfill failed: ${errorMessage}\n`);
    }
  }

  const result = {
    changed,
    fallbackUsed: false,
    updatesFetched: updates.length,
    lastProcessedUpdateId: nextLastProcessedUpdateId,
    readyBatches: batches.filter((batch) => batch.status === 'ready').length,
    batches,
    timingsMs: timings.timingsMs,
  };
  finalizeSyncTimings(timings, result);
  await maybePersistMessageSyncResult(resultPath, result);

  if (shouldNotifyImmediately) {
    await measureSyncStage(timings, 'notify', () =>
      notifyMessageSyncResult({
        batches,
        sendMessage,
        env: rawEnv,
      }),
    );
    finalizeSyncTimings(timings, result);
    await maybePersistMessageSyncResult(resultPath, result);
  }

  logSyncTimings(result.timingsMs);

  return result;
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

function createLazyAiProvider(rawEnv, configuredProvider) {
  let provider = configuredProvider ?? null;
  return () => {
    provider ??= createAiProvider(rawEnv);
    return provider;
  };
}

function createLazyRecognitionAiProvider(rawEnv, configuredProvider, getDefaultProvider) {
  let provider = configuredProvider ?? null;
  return () => {
    provider ??= createRecognitionAiProvider(rawEnv, getDefaultProvider());
    return provider;
  };
}

function createRecognitionFallbackAiProvider(rawEnv) {
  const configuredApiKey = firstNonEmptyString(
    rawEnv.STANDBY_AI_API_KEY,
    rawEnv.TELEGRAM_RECOGNITION_FALLBACK_API_KEY,
  );
  const configuredBaseUrl = firstNonEmptyString(
    rawEnv.STANDBY_AI_BASE_URL,
    rawEnv.TELEGRAM_RECOGNITION_FALLBACK_BASE_URL,
  );
  const model = String(rawEnv.TELEGRAM_RECOGNITION_FALLBACK_MODEL ?? '').trim();

  if (!configuredApiKey && !configuredBaseUrl && !model) {
    return null;
  }
  const apiKey = configuredApiKey || String(rawEnv.AI_API_KEY ?? '').trim();
  const baseUrl = configuredBaseUrl || String(rawEnv.AI_BASE_URL ?? '').trim();
  if (!apiKey || !baseUrl || !model) {
    process.stderr.write(
      '[message-sync] fallback recognition AI provider is not configured completely; ignoring fallback provider\n',
    );
    return null;
  }

  return createAiProvider({
    ...rawEnv,
    AI_API_KEY: apiKey,
    AI_BASE_URL: baseUrl,
    AI_MODEL: model,
    AI_PROVIDER: rawEnv.TELEGRAM_RECOGNITION_FALLBACK_PROVIDER || rawEnv.AI_PROVIDER,
    AI_API_PROTOCOL: rawEnv.TELEGRAM_RECOGNITION_FALLBACK_API_PROTOCOL || rawEnv.AI_API_PROTOCOL,
    AI_TIMEOUT_MS:
      (isAiSchedulerEnabled(rawEnv) ? rawEnv.AI_RECOGNITION_FALLBACK_TIMEOUT_MS : '') ||
      rawEnv.TELEGRAM_RECOGNITION_FALLBACK_TIMEOUT_MS ||
      rawEnv.AI_TIMEOUT_MS,
  });
}

function firstNonEmptyString(...values) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) ?? '';
}
