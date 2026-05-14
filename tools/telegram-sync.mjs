import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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

  for (const pending of pendingBatches) {
    try {
      const replayResult = await persistBatch({
        batch: pending.batch,
        processedAt: now,
        env: options.env ?? process.env,
      });
      if (replayResult.status === 'stored' || replayResult.status === 'unchanged') {
        replayStoredAny = replayStoredAny || replayResult.status === 'stored';
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
  const grouped = groupTelegramUpdates(updates);
  const batchResults = [];
  let changed = replayStoredAny;
  let fallbackUsed = false;
  let fallbackMarkdown = await readMarkdownOrDefault(recordPath);

  for (const batch of grouped) {
    const isAllowed = batch.messages.every((message) => env.allowedChatIds.has(message.chatId));
    if (!isAllowed) {
      batchResults.push({
        batchId: batch.batchId,
        status: 'ignored',
        reason: 'unauthorized chat',
        updateIds: batch.messages.map((message) => message.updateId),
      });
      continue;
    }

    const recognitions = (await recognizeBatchRunner(batch, env)).filter(Boolean);
    const analyzed = analyzeTelegramBatch(batch, recognitions, {
      minConfidence: 0.75,
    });
    const persistedBatch = {
      ...analyzed,
      updateIds: batch.messages.map((message) => message.updateId),
      messages: batch.messages,
      recognitions,
    };

    if (analyzed.status !== 'ready') {
      batchResults.push(persistedBatch);
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
  } else if (changed) {
    const readyPersistedBatches = batchResults.filter(
      (batch) => batch.status === 'ready' && batch.persistenceStatus === 'stored',
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
  return {
    changed: result.changed,
    fallbackUsed: result.fallbackUsed,
    updatesFetched: result.updatesFetched,
    lastProcessedUpdateId: result.lastProcessedUpdateId,
    readyBatches: result.readyBatches,
    batches: (result.batchResults ?? []).map((batch) => ({
      batchId: batch.batchId,
      status: batch.status,
      archivedDate: batch.archivedDate ?? null,
      persistenceStatus: batch.persistenceStatus ?? null,
      persistenceError: batch.persistenceError ?? null,
      warnings: batch.warnings ?? [],
      issues: batch.issues ?? [],
      reason: batch.reason ?? null,
    })),
  };
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
    allowed_updates: JSON.stringify(['message']),
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
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!response.ok) {
    throw new Error(`Telegram getFile failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.ok || !payload.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${payload.description ?? 'missing file_path'}`);
  }
  return `https://api.telegram.org/file/bot${botToken}/${payload.result.file_path}`;
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
