import { appendFile, access, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import frontMatter from 'hexo-front-matter';

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
  let fallbackMarkdown = await readMarkdownOrDefault(recordPath);

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

    const recognitions = batch.kind === 'image' ? (await recognizeBatchRunner(batch, env)).filter(Boolean) : [];
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
      changed ||= thoughtWriteResult.changed;

      try {
        const persistResult = await persistBatch({
          batch: persistedBatch,
          processedAt: now,
          env: options.env ?? process.env,
        });
        changed ||= persistResult.status === 'stored';
        batchResults.push({
          ...persistedBatch,
          postPath: thoughtWriteResult.postPath,
          thoughtWriteStatus: thoughtWriteResult.status,
          persistenceStatus: persistResult.status,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendPendingFallbackBatch(pendingQueuePath, {
          batch: persistedBatch,
          failedAt: now.toISOString(),
          error: errorMessage,
        });
        batchResults.push({
          ...persistedBatch,
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
      });
      changed ||= thoughtEditResult.changed;

      try {
        const persistResult = await persistBatch({
          batch: persistedBatch,
          processedAt: now,
          env: options.env ?? process.env,
        });
        changed ||= persistResult.status === 'stored';
        batchResults.push({
          ...persistedBatch,
          postPath: thoughtEditResult.postPath,
          thoughtWriteStatus: thoughtEditResult.status,
          persistenceStatus: persistResult.status,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendPendingFallbackBatch(pendingQueuePath, {
          batch: persistedBatch,
          failedAt: now.toISOString(),
          error: errorMessage,
        });
        batchResults.push({
          ...persistedBatch,
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
      changed ||= thoughtDeleteResult.changed;

      try {
        const persistResult = await persistBatch({
          batch: persistedBatch,
          processedAt: now,
          env: options.env ?? process.env,
        });
        changed ||= persistResult.status === 'stored';
        batchResults.push({
          ...persistedBatch,
          postPath: thoughtDeleteResult.postPath,
          thoughtWriteStatus: thoughtDeleteResult.status,
          deletedPhotoPaths: thoughtDeleteResult.deletedPhotoPaths ?? [],
          persistenceStatus: persistResult.status,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendPendingFallbackBatch(pendingQueuePath, {
          batch: persistedBatch,
          failedAt: now.toISOString(),
          error: errorMessage,
        });
        batchResults.push({
          ...persistedBatch,
          postPath: thoughtDeleteResult.postPath,
          thoughtWriteStatus: thoughtDeleteResult.status,
          deletedPhotoPaths: thoughtDeleteResult.deletedPhotoPaths ?? [],
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
        const applied = applyTelegramSyncToMarkdown(fallbackMarkdown, persistedBatch);
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

    try {
      const snapshot = await buildSnapshot(snapshotOptions);
      markdown = snapshotCoversPersistedBatches(snapshot, readyPersistedBatches)
        ? exportMarkdown(snapshot)
        : rebuildMarkdownFromPersistedBatches(fallbackMarkdown, readyPersistedBatches);
    } catch (error) {
      const canFallbackFromDatabase =
        trainingDbConfig.enabled && Boolean(trainingDbConfig.url);
      if (canFallbackFromDatabase && canRebuildMarkdownFromPersistedBatches(error)) {
        process.stderr.write(
          `[telegram-sync] ${error.message}; rebuilding markdown from persisted batches\n`,
        );
        markdown = rebuildMarkdownFromPersistedBatches(fallbackMarkdown, readyPersistedBatches);
      } else {
        throw error;
      }
    }

    await writeFile(recordPath, markdown, 'utf8');
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

function isTrainingDataBatchKind(kind) {
  return kind !== 'thought' && kind !== 'thought_edit' && kind !== 'thought_delete' && kind !== 'analysis';
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

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
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

async function fetchTelegramUpdates({ botToken, offset, limit }) {
  const search = new URLSearchParams({
    timeout: '0',
    allowed_updates: JSON.stringify(['message', 'edited_message']),
    offset: String(offset),
    limit: String(limit),
  });
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?${search}`);
  if (!response.ok) {
    throw new Error(`Telegram getUpdates failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`Telegram getUpdates failed: ${payload.description ?? 'unknown error'}`);
  }
  return payload.result ?? [];
}

async function resolveDispatchTelegramUpdates({
  repositoryDispatchEvent,
  githubEventName,
  githubEventPath,
}) {
  const eventPayload =
    repositoryDispatchEvent ??
    (githubEventName === 'repository_dispatch' && githubEventPath
      ? await readGithubEventFile(githubEventPath)
      : null);

  if (!eventPayload) {
    return null;
  }

  const clientPayload = eventPayload.client_payload ?? {};
  if (clientPayload.telegram_update) {
    return [clientPayload.telegram_update];
  }
  if (Array.isArray(clientPayload.telegram_updates)) {
    return clientPayload.telegram_updates;
  }
  return [];
}

async function readGithubEventFile(eventPath) {
  try {
    const raw = await readFile(eventPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function recognizeBatch(batch, env) {
  const recognitions = await mapWithConcurrency(batch.messages, env.aiConcurrency, async (message) => {
    const fileId = message.photos.at(-1)?.fileId;
    if (!fileId) {
      return null;
    }
    const imageUrl = await resolveTelegramFileUrl(env.botToken, fileId);
    return recognizeImageMessage(message, imageUrl, env);
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

async function readPendingFallbackBatches(queuePath) {
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

async function writeThoughtPostFile({ batch, thoughtsDir, rootDir, fetchTelegramFile }) {
  const draft = buildThoughtPost(batch);
  const postPath = path.join(thoughtsDir, draft.fileName);

  if (await fileExists(postPath)) {
    return {
      changed: false,
      status: 'duplicate',
      postPath,
    };
  }

  const photoPaths = await writeThoughtImageFiles({
    batch,
    rootDir,
    dateParts: draft.dateParts,
    sourceMessageId: draft.message.messageId,
    fetchTelegramFile,
  });
  const post = buildThoughtPost(batch, { photoPaths });

  await mkdir(thoughtsDir, { recursive: true });
  await writeFile(postPath, post.content, 'utf8');
  return {
    changed: true,
    status: 'written',
    postPath,
  };
}

async function editThoughtPost({ batch, thoughtsDir }) {
  const target = await findThoughtPostByMessage({
    thoughtsDir,
    messageId: batch.thoughtEdit?.targetMessageId,
    chatId: batch.thoughtEdit?.telegramChatId,
  });

  if (!target) {
    return {
      changed: false,
      status: 'not_found',
      postPath: null,
    };
  }

  const nextContent = replaceMarkdownBody(target.raw, batch.thoughtEdit?.body ?? '');
  if (nextContent === target.raw) {
    return {
      changed: false,
      status: 'unchanged',
      postPath: target.postPath,
    };
  }

  await writeFile(target.postPath, nextContent, 'utf8');
  return {
    changed: true,
    status: 'updated',
    postPath: target.postPath,
  };
}

async function deleteThoughtPost({ batch, thoughtsDir, rootDir }) {
  const target = await findThoughtPostByMessage({
    thoughtsDir,
    messageId: batch.thoughtDelete?.targetMessageId,
    chatId: batch.thoughtDelete?.telegramChatId,
  });

  if (!target) {
    return {
      changed: false,
      status: 'not_found',
      postPath: null,
      deletedPhotoPaths: [],
    };
  }

  await unlink(target.postPath);
  const deletedPhotoPaths = [];
  for (const photoPath of resolveThoughtPhotoFilePaths({
    rootDir,
    photos: target.frontMatter.photos,
  })) {
    if (await fileExists(photoPath)) {
      await unlink(photoPath);
      deletedPhotoPaths.push(photoPath);
    }
  }

  return {
    changed: true,
    status: 'deleted',
    postPath: target.postPath,
    deletedPhotoPaths,
  };
}

function buildThoughtPost(batch, options = {}) {
  const thought = batch.thought ?? {};
  const message = resolveThoughtPostMessage(batch);
  const dateParts = formatThoughtDateParts(message.dateUnix);
  const fileName = `${dateParts.date}-telegram-thought-${message.messageId}.md`;
  const lines = [
    '---',
    `date: ${dateParts.dateTime}`,
    'tags:',
    '  - 训练',
    '  - 随想',
    '  - Telegram',
    `telegram_message_id: ${message.messageId ?? ''}`,
    `telegram_chat_id: ${message.chatId ?? ''}`,
  ];
  if (options.photoPaths?.length) {
    lines.push('photos:');
    for (const photoPath of options.photoPaths) {
      lines.push(`  - ${photoPath}`);
    }
  }
  lines.push('---', '', thought.body ?? '', '');

  return {
    fileName,
    content: lines.join('\n'),
    dateParts,
    message,
  };
}

async function findThoughtPostByMessage({ thoughtsDir, messageId, chatId }) {
  if (!messageId) {
    return null;
  }

  const directPath = await findThoughtPostPathById({ thoughtsDir, messageId });
  const candidatePaths = directPath ? [directPath] : await readDirRecursive(thoughtsDir);

  for (const postPath of candidatePaths.filter((entry) => entry.endsWith('.md'))) {
    const raw = await readFile(postPath, 'utf8');
    const parsed = frontMatter.parse(raw);
    const frontMatterData = normalizeThoughtFrontMatter(parsed);
    if (
      Number(frontMatterData.telegram_message_id) === Number(messageId) &&
      (chatId == null || Number(frontMatterData.telegram_chat_id) === Number(chatId))
    ) {
      return {
        postPath,
        raw,
        frontMatter: frontMatterData,
      };
    }
  }

  return null;
}

async function findThoughtPostPathById({ thoughtsDir, messageId }) {
  const entries = await readDirRecursive(thoughtsDir);
  const suffix = `-telegram-thought-${messageId}.md`;
  return entries.find((entry) => entry.endsWith(suffix)) ?? null;
}

function normalizeThoughtFrontMatter(parsed) {
  const { _content = '', ...frontMatterData } = parsed ?? {};
  return {
    ...frontMatterData,
    _content,
  };
}

function replaceMarkdownBody(raw, nextBody) {
  const split = frontMatter.split(raw);
  const parsed = frontMatter.parse(raw);
  const { _content, ...frontMatterData } = parsed ?? {};
  return `${frontMatter.stringify(frontMatterData, {
    separator: split.separator,
    prefixSeparator: split.prefixSeparator,
  })}\n${String(nextBody ?? '').trim()}\n`;
}

function resolveThoughtPhotoFilePaths({ rootDir, photos }) {
  if (!Array.isArray(photos) || !rootDir) {
    return [];
  }

  return photos
    .map((photoPath) =>
      typeof photoPath === 'string' && photoPath.startsWith('/images/')
        ? path.join(rootDir, 'source', photoPath.replace(/^\//, ''))
        : null,
    )
    .filter(Boolean);
}

async function readDirRecursive(dirPath) {
  const results = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      results.push(entryPath);
    }
  }

  await walk(dirPath);
  return results;
}

async function readExistingThoughtMessageKeys(thoughtsDir) {
  const keys = new Set();
  for (const postPath of (await readDirRecursive(thoughtsDir)).filter((entry) => entry.endsWith('.md'))) {
    try {
      const raw = await readFile(postPath, 'utf8');
      const parsed = frontMatter.parse(raw);
      const chatId = Number(parsed.telegram_chat_id);
      const messageId = Number(parsed.telegram_message_id);
      if (Number.isInteger(chatId) && Number.isInteger(messageId) && messageId > 0) {
        keys.add(`${chatId}:${messageId}`);
      }
    } catch {}
  }
  return keys;
}

async function writeThoughtImageFiles({
  batch,
  rootDir,
  dateParts,
  sourceMessageId,
  fetchTelegramFile,
}) {
  if (!rootDir || !fetchTelegramFile) {
    return [];
  }

  const imageMessages = (batch.messages ?? [])
    .map((message) => ({
      message,
      photo: selectThoughtImagePhoto(message),
    }))
    .filter((item) => item.photo?.fileId)
    .sort((left, right) => left.message.messageId - right.message.messageId);
  if (imageMessages.length === 0) {
    return [];
  }

  const [year, month] = dateParts.date.split('-');
  const outputDir = path.join(rootDir, 'source', 'images', 'thoughts', year, month);
  const publicPaths = [];

  for (let index = 0; index < imageMessages.length; index += 1) {
    const { photo } = imageMessages[index];
    const file = await fetchTelegramFile(photo.fileId);
    const extension = inferThoughtImageExtension(photo, file);
    const imageFileName = `${dateParts.date}-telegram-thought-${sourceMessageId}-${index + 1}${extension}`;
    const outputPath = path.join(outputDir, imageFileName);
    const publicPath = `/images/thoughts/${year}/${month}/${imageFileName}`;

    await mkdir(outputDir, { recursive: true });
    if (!(await fileExists(outputPath))) {
      await writeFile(outputPath, file.data);
    }
    publicPaths.push(publicPath);
  }

  return publicPaths;
}

function resolveThoughtPostMessage(batch) {
  const sourceMessageId = batch.thought?.sourceMessageId ?? null;
  return (
    (batch.messages ?? []).find((message) => message.messageId === sourceMessageId) ??
    batch.messages?.[0] ??
    {}
  );
}

function selectThoughtImagePhoto(message) {
  const photos = message.photos ?? [];
  const documentImage = photos.find((photo) => photo.source === 'document');
  if (documentImage) {
    return documentImage;
  }

  return (
    photos
      .filter((photo) => photo.source === 'photo')
      .toSorted((left, right) => thoughtPhotoScore(right) - thoughtPhotoScore(left))
      .at(0) ?? null
  );
}

function thoughtPhotoScore(photo) {
  if (Number.isFinite(photo.fileSize)) {
    return photo.fileSize;
  }
  return (photo.width ?? 0) * (photo.height ?? 0);
}

function inferThoughtImageExtension(photo, file) {
  const fromName = path.extname(photo.fileName ?? file.filePath ?? '').toLowerCase();
  if (/^\.(?:jpe?g|png|webp|gif|bmp|heic|heif|tiff?)$/.test(fromName)) {
    return fromName === '.jpeg' ? '.jpg' : fromName;
  }

  const mimeType = (photo.mimeType ?? file.contentType ?? '').toLowerCase().split(';')[0].trim();
  const extensionByMimeType = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/tiff': '.tiff',
  };
  return extensionByMimeType[mimeType] ?? '.jpg';
}

function formatThoughtDateParts(dateUnix) {
  const date = new Date((dateUnix ?? 0) * 1000);
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dateTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function appendPendingFallbackBatch(queuePath, payload) {
  await mkdir(path.dirname(queuePath), { recursive: true });
  await appendFile(queuePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function writePendingFallbackBatches(queuePath, entries) {
  await mkdir(path.dirname(queuePath), { recursive: true });
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(queuePath, content ? `${content}\n` : '', 'utf8');
}

async function resolveTelegramFileUrl(botToken, fileId) {
  const file = await resolveTelegramFileInfo(botToken, fileId);
  return file.url;
}

async function resolveTelegramFileInfo(botToken, fileId) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!response.ok) {
    throw new Error(`Telegram getFile failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.ok || !payload.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${payload.description ?? 'missing file_path'}`);
  }
  return {
    filePath: payload.result.file_path,
    url: `https://api.telegram.org/file/bot${botToken}/${payload.result.file_path}`,
  };
}

async function fetchTelegramFile({ botToken, fileId }) {
  const file = await resolveTelegramFileInfo(botToken, fileId);
  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  }
  return {
    ...file,
    contentType: response.headers.get('content-type') ?? '',
    data: new Uint8Array(await response.arrayBuffer()),
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

async function sendTelegramMessage({ botToken, chatId, text, replyToMessageId = null }) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
    payload.allow_sending_without_reply = true;
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  }
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram sendMessage failed: ${result.description ?? 'unknown error'}`);
  }
  return result.result;
}

async function recognizeImageMessage(message, imageUrl, env) {
  const response = await fetch(`${env.baseUrl}/chat/completions`, {
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

function buildRecognitionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['imageType', 'detectedDate', 'dateEvidence', 'records', 'confidence', 'warnings'],
    properties: {
      imageType: {
        type: 'string',
        enum: ['measurement', 'workout', 'nutrition', 'unknown'],
      },
      detectedDate: {
        type: ['string', 'null'],
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      dateEvidence: {
        type: 'string',
      },
      confidence: {
        type: 'number',
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
      },
      records: {
        type: 'object',
        additionalProperties: false,
        required: ['measurement', 'activities', 'meals', 'totalCalories', 'details', 'dailyWorkoutSummary'],
        properties: {
          measurement: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: [
              'measuredAt',
              'bodyScore',
              'weightKg',
              'bmi',
              'bodyFatPct',
              'skeletalMuscleKg',
              'visceralFatLevel',
              'basalMetabolismKcal',
              'bodyWaterPct',
              'proteinPct',
              'boneMassKg',
              'fatFreeMassKg',
              'bodyAge',
              'bodyType',
            ],
            properties: {
              measuredAt: { type: ['string', 'null'] },
              bodyScore: { type: ['number', 'null'] },
              weightKg: { type: ['number', 'null'] },
              bmi: { type: ['number', 'null'] },
              bodyFatPct: { type: ['number', 'null'] },
              skeletalMuscleKg: { type: ['number', 'null'] },
              visceralFatLevel: { type: ['number', 'null'] },
              basalMetabolismKcal: { type: ['number', 'null'] },
              bodyWaterPct: { type: ['number', 'null'] },
              proteinPct: { type: ['number', 'null'] },
              boneMassKg: { type: ['number', 'null'] },
              fatFreeMassKg: { type: ['number', 'null'] },
              bodyAge: { type: ['number', 'null'] },
              bodyType: { type: ['string', 'null'] },
            },
          },
          activities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['time', 'type', 'detail'],
              properties: {
                time: { type: 'string' },
                type: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
          meals: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'calories', 'recommendedMin', 'recommendedMax'],
              properties: {
                name: { type: 'string' },
                calories: { type: 'number' },
                recommendedMin: { type: 'number' },
                recommendedMax: { type: 'number' },
              },
            },
          },
          totalCalories: {
            type: ['number', 'null'],
          },
          details: {
            type: 'array',
            items: { type: 'string' },
          },
          dailyWorkoutSummary: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['activityCaloriesKcal', 'workoutDurationMinutes', 'activeHours'],
            properties: {
              activityCaloriesKcal: { type: ['number', 'null'] },
              workoutDurationMinutes: { type: ['number', 'null'] },
              activeHours: { type: ['number', 'null'] },
            },
          },
        },
      },
    },
  };
}
