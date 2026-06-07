import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAiProvider } from '../src/ai/provider.mjs';
import {
  applyTelegramSyncToMarkdown,
  analyzeTelegramBatch,
  groupTelegramUpdates,
  mapWithConcurrency,
} from './telegram-sync-lib.mjs';
import {
  appendPendingRecognitionBatch as appendPendingRecognitionBatchToDatabase,
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
import {
  getThoughtModuleTags,
  isThoughtBatchKind,
  normalizeThoughtModule,
} from './lib/thought-modules.mjs';
import { getRecognitionPromptMetadata, stripPromptMetadataHeader } from './prompt-generator.mjs';
import { recognizeTelegramImageMessage } from '../src/ai/recognition-service.mjs';
import { TELEGRAM_HELP_TEXT } from '../src/telegram/help.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultRecognitionPromptPath = path.join(
  rootDir,
  'prompts',
  'telegram-training-image-recognition.md',
);
const fallbackRecognitionSystemPrompt =
  '你是训练记录截图结构化助手。只能输出符合 schema 的 JSON。识别类型只允许 measurement、workout、nutrition、unknown。workout 既可能是逐条活动明细截图，也可能是当日活动总览截图；总览图请提取活动热量、锻炼时长、活动小时数到 dailyWorkoutSummary。detectedDate 只能来自截图画面里的日期；若截图日期不可靠则 detectedDate 返回 null，并在 warnings 中说明。若截图是系统相册、文件详情或分享预览页，画面里明确显示的文件名、标题、路径中的日期也算画面内可见日期。';

export async function main() {
  const result = await runTelegramSync();
  process.stdout.write(JSON.stringify(buildTelegramSyncReport(result), null, 2));
  process.stdout.write('\n');
}

export async function runTelegramSync(options = {}) {
  const timings = createSyncTimings();
  const rawEnv = options.env ?? process.env;
  const env = loadRequiredEnv(rawEnv);
  const activeRootDir = options.rootDir ?? rootDir;
  const recordPath = path.join(activeRootDir, '训练记录.md');
  const thoughtsDir = path.join(activeRootDir, 'source', '_posts');
  const runtimeDir = path.join(activeRootDir, 'runtime');
  const pendingQueuePath = path.join(runtimeDir, 'telegram-sync-pending.ndjson');
  const now = options.now ?? new Date();
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
  const recognizeBatchRunner =
    options.recognizeBatch ??
    ((batch) => recognizeBatch(batch, env, { aiProvider: recognitionAiProvider, rawEnv, fetchTelegramFileById }));
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
  const backfillCoreSleep = options.backfillCoreSleepFromIngestBatches ?? null;
  const notificationStage = resolveTelegramSyncNotificationStage(rawEnv);
  const shouldNotifyImmediately =
    shouldNotifyTelegramSyncResult(rawEnv) && notificationStage !== 'after_action';
  const resultPath = resolveTelegramSyncResultPath(rawEnv, activeRootDir, options.resultPath);

  const dispatchUpdates = await measureSyncStage(timings, 'resolveUpdates', () =>
    resolveDispatchTelegramUpdates({
      repositoryDispatchEvent: options.repositoryDispatchEvent,
      githubEventName: env.githubEventName,
      githubEventPath: env.githubEventPath,
    }),
  );
  const previousLastProcessedUpdateId = await measureSyncStage(timings, 'readOffset', () =>
    readLastProcessedUpdateIdForRun({
      readLastProcessedUpdateId,
      dispatchUpdates,
    }),
  );
  const pendingBatches = await measureSyncStage(timings, 'readPendingFallback', () =>
    readPendingFallbackBatches(pendingQueuePath),
  );
  let replayStoredAny = false;
  let replayStoredImageAny = false;

  await measureSyncStage(timings, 'replayFallbackPersist', async () => {
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
  });

  await measureSyncStage(timings, 'writePendingFallback', () =>
    writePendingFallbackBatches(
      pendingQueuePath,
      pendingBatches.filter((pending) => !pending.replayed),
    ),
  );

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
    groupTelegramUpdates(updates, { knownThoughtMessageKeys }),
  );
  const batchResults = [];
  let changed = replayStoredAny;
  let fallbackUsed = false;
  let fallbackMarkdown = null;
  let fallbackMarkdownLoaded = false;

  const pendingRecognitionEntries = await measureSyncStage(timings, 'readPendingRecognition', () =>
    readPendingRecognitionBatches(),
  );
  const replayRecognitionResults = await measureSyncStage(timings, 'replayRecognition', () =>
    replayPendingRecognitionBatches({
      entries: pendingRecognitionEntries,
      recognizeBatchRunner,
      persistBatch,
      appendPendingRecognitionBatch,
      markPendingRecognitionResolved,
      now,
    }),
  );
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
        updateIds: batch.messages.map((message) => message.updateId),
      });
      continue;
    }

    let recognitions = [];
    let recognitionErrors = [];
    if (batch.kind === 'image') {
      try {
        const recognitionOutput = normalizeRecognitionOutput(
          await measureSyncStage(timings, 'recognition', () => recognizeBatchRunner(batch, env)),
        );
        recognitions = recognitionOutput.recognitions;
        recognitionErrors = recognitionOutput.recognitionErrors;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        recognitionErrors = batch.messages.map((message) => ({
          messageId: message.messageId,
          error: errorMessage,
          failureCategory: classifyFailureCategory(errorMessage, { phase: 'ai_recognition' }),
        }));
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
      recognitionErrors,
    };
    attachFailureMetadata(persistedBatch);
    await measureSyncStage(timings, 'queueRecognition', () =>
      queueRecognitionFailureIfNeeded({
        batch: persistedBatch,
        appendPendingRecognitionBatch,
        now,
      }),
    );

    if (analyzed.status !== 'ready') {
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
      const aiAgentResult = await measureSyncStage(timings, 'aiAgent', () =>
        handleAiAgentBatch({
          batch: persistedBatch,
          runAiAgent,
          sendMessage,
        }),
      );
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
      const thoughtResult = await measureSyncStage(timings, 'persist', () =>
        handleThoughtSyncBatch({
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
        }),
      );
      changed ||= thoughtResult.changed;
      batchResults.push(thoughtResult.batchResult);
      continue;
    }

    try {
      const persistResult = await measureSyncStage(timings, 'persist', () =>
        persistBatch({
          batch: persistedBatch,
          processedAt: now,
          env: options.env ?? process.env,
        }),
      );

      changed ||= analyzed.status === 'ready' && persistResult.status === 'stored';
      batchResults.push({
        ...persistedBatch,
        persistenceStatus: persistResult.status,
      });
      await measureSyncStage(timings, 'markRecognitionResolved', () =>
        markPendingRecognitionResolved({ batchId: persistedBatch.batchId }),
      );
    } catch (error) {
      if (analyzed.status === 'ready') {
        const applied = await measureSyncStage(timings, 'markdownRewrite', async () =>
          applyTelegramSyncToMarkdown(await getFallbackMarkdown(), persistedBatch),
        );
        fallbackMarkdown = applied.markdown;
        changed ||= applied.changed;
        fallbackUsed = true;
        const errorMessage = error instanceof Error ? error.message : String(error);
        await measureSyncStage(timings, 'writePendingFallback', () =>
          appendPendingFallbackBatch(pendingQueuePath, {
            batch: persistedBatch,
            failedAt: now.toISOString(),
            error: errorMessage,
          }),
        );
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

  if (backfillCoreSleep && shouldRunSleepBackfill({ rawEnv, replayStoredImageAny })) {
    try {
      await measureSyncStage(timings, 'sleepBackfill', () =>
        backfillCoreSleep({
          processedAt: now,
          sourceChannel: 'telegram_sync',
        }),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[telegram-sync] sleep backfill failed: ${errorMessage}\n`);
    }
  }

  if (fallbackUsed) {
    await measureSyncStage(timings, 'markdownRewrite', () =>
      writeFile(recordPath, fallbackMarkdown, 'utf8'),
    );
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

    await measureSyncStage(timings, 'markdownRewrite', () =>
      writeFile(recordPath, markdown, 'utf8'),
    );
  }

  const result = {
    changed,
    fallbackUsed,
    updatesFetched: updates.length,
    lastProcessedUpdateId: nextLastProcessedUpdateId,
    readyBatches: batchResults.filter((batch) => batch.status === 'ready').length,
    batchResults,
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

export function createRecognitionAiProvider(rawEnv, defaultProvider) {
  const recognitionModel = String(rawEnv.TELEGRAM_RECOGNITION_MODEL ?? '').trim();
  if (!recognitionModel) {
    return defaultProvider;
  }
  return createAiProvider({
    ...rawEnv,
    AI_MODEL: recognitionModel,
  });
}

function shouldRunSleepBackfill({ rawEnv, replayStoredImageAny }) {
  const flag = String(rawEnv.TELEGRAM_SYNC_RUN_SLEEP_BACKFILL ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(flag)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(flag)) {
    return false;
  }
  return replayStoredImageAny;
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
    ...(isPlainTimingMap(result.timingsMs) ? { timingsMs: normalizeTimings(result.timingsMs) } : {}),
    batches: (result.batchResults ?? []).map((batch) => ({
      kind: batch.kind ?? 'image',
      batchId: batch.batchId,
      status: batch.status,
      partialFailure: batch.partialFailure ?? false,
      archivedDate: batch.archivedDate ?? null,
      postPath: batch.postPath ?? null,
      thoughtWriteStatus: batch.thoughtWriteStatus ?? null,
      persistenceStatus: batch.persistenceStatus ?? null,
      persistenceError: batch.persistenceError ?? null,
      failureCategory: batch.failureCategory ?? null,
      failureReason: batch.failureReason ?? null,
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
    })),
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
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeTimings(timingsMs) {
  return Object.fromEntries(
    Object.entries(timingsMs)
      .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) >= 0)
      .map(([stage, value]) => [stage, Math.max(0, Math.round(Number(value)))]),
  );
}

export async function loadRecognitionSystemPrompt(env = process.env) {
  const promptPath = env.TELEGRAM_RECOGNITION_PROMPT_PATH?.trim() || defaultRecognitionPromptPath;

  try {
    const prompt = await readFile(promptPath, 'utf8');
    const trimmed = stripPromptMetadataHeader(prompt).trim();
    return trimmed || fallbackRecognitionSystemPrompt;
  } catch {
    return fallbackRecognitionSystemPrompt;
  }
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

function shouldNotifyTelegramSyncResult(rawEnv) {
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

function resolveTelegramSyncNotificationStage(rawEnv) {
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

function resolveTelegramSyncResultPath(rawEnv, activeRootDir, explicitPath) {
  const candidate = String(explicitPath ?? rawEnv.TELEGRAM_SYNC_RESULT_PATH ?? '').trim();
  if (candidate) {
    return path.isAbsolute(candidate) ? candidate : path.resolve(activeRootDir, candidate);
  }
  return '';
}

async function maybePersistTelegramSyncResult(resultPath, result) {
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

async function notifyTelegramSyncResult({ batchResults, env = process.env, sendMessage }) {
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
      const pendingText = batch.recognitionPendingStatus === 'queued' ? '，失败图片已加入重试队列' : '';
      return [
        `部分解析失败（${countText}），${storageText}${dateText ? ` ${dateText}数据` : ''}${pendingText}`,
        failedMessages ? `失败图片：${failedMessages}` : '',
        reason ? `原因：${reason}` : '',
      ]
        .filter(Boolean)
        .join('；');
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

async function replayPendingRecognitionBatches({
  entries,
  recognizeBatchRunner,
  persistBatch,
  appendPendingRecognitionBatch,
  markPendingRecognitionResolved,
  now,
}) {
  const batchResults = [];
  let changed = false;
  let replayStoredImageAny = false;

  for (const entry of entries ?? []) {
    const batch = normalizePendingRecognitionBatchEntry(entry);
    if (!batch) {
      continue;
    }

    let recognitions = [];
    let recognitionErrors = [];
    try {
      const recognitionOutput = normalizeRecognitionOutput(await recognizeBatchRunner(batch, {}));
      recognitions = recognitionOutput.recognitions;
      recognitionErrors = recognitionOutput.recognitionErrors;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      recognitionErrors = (batch.messages ?? []).map((message) => ({
        messageId: message.messageId,
        error: errorMessage,
        failureCategory: classifyFailureCategory(errorMessage, { phase: 'ai_recognition' }),
      }));
      process.stderr.write(
        `[telegram-sync] pending image recognition failed for ${batch.batchId}: ${errorMessage}\n`,
      );
    }

    const analyzed = analyzeTelegramBatch(batch, recognitions, {
      minConfidence: 0.75,
    });
    const persistedBatch = {
      ...analyzed,
      kind: batch.kind ?? analyzed.kind ?? 'image',
      updateIds: batch.messages?.map((message) => message.updateId).filter(Boolean) ?? [],
      messages: batch.messages ?? [],
      recognitions,
      recognitionErrors,
      pendingReplay: true,
    };
    attachFailureMetadata(persistedBatch);

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

async function queueRecognitionFailureIfNeeded({
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

function hasPartialRecognitionFailure(batch) {
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

function summarizePartialFailureReason(batch) {
  return summarizeErrorText(
    batch.failureReason ||
      (batch.recognitionErrors ?? [])
        .map((error) => error?.error)
        .filter(Boolean)
        .join('; '),
  );
}

function classifyFailureCategory(message, options = {}) {
  const text = String(message ?? '');
  const phase = String(options.phase ?? '');

  if (/github|action|dispatch|rebase|push|checkout|npm ci|site_build|workflow/i.test(`${phase} ${text}`)) {
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
