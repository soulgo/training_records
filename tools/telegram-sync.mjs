import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapWithConcurrency, processTelegramUpdates } from './telegram-sync-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const telegramDir = path.join(rootDir, 'telegram');
const inboxDir = path.join(telegramDir, 'inbox');
const recordPath = path.join(rootDir, '训练记录.md');
const statePath = path.join(telegramDir, 'state.json');
const processLogPath = path.join(telegramDir, 'process-log.ndjson');

export async function main() {
  const env = loadRequiredEnv();
  await ensureTelegramFiles();

  const currentState = await readJson(statePath, { lastProcessedUpdateId: 0 });
  const markdown = await readFile(recordPath, 'utf8');
  const updates = await fetchTelegramUpdates({
    botToken: env.botToken,
    offset: currentState.lastProcessedUpdateId + 1,
    limit: env.pollLimit,
  });

  const result = await processTelegramUpdates({
    markdown,
    updates,
    allowedChatIds: env.allowedChatIds,
    minConfidence: 0.75,
    recognizeBatch: async (batch) => recognizeBatch(batch, env),
  });
  const previousLastProcessedUpdateId = currentState.lastProcessedUpdateId ?? 0;
  const nextLastProcessedUpdateId = Math.max(
    previousLastProcessedUpdateId,
    result.lastProcessedUpdateId ?? 0,
  );

  const shouldPersistArtifacts = shouldPersistTelegramArtifacts({
    updatesFetched: updates.length,
    changed: result.changed,
    previousLastProcessedUpdateId,
    nextLastProcessedUpdateId,
  });

  if (shouldPersistArtifacts) {
    await persistInboxEntries(result.inboxEntries);
    await appendProcessLog({
      processedAt: new Date().toISOString(),
      updatesFetched: updates.length,
      changed: result.changed,
      lastProcessedUpdateId: result.lastProcessedUpdateId,
      batches: result.batchResults.map((batch) => ({
        batchId: batch.batchId,
        status: batch.status,
        archivedDate: batch.archivedDate ?? null,
        reason: batch.reason ?? null,
        updateIds: batch.updateIds ?? [],
      })),
    });
  }

  if (result.changed) {
    await writeFile(recordPath, result.markdown, 'utf8');
  }

  if (shouldPersistArtifacts) {
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          lastProcessedUpdateId: nextLastProcessedUpdateId,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        changed: result.changed,
        updatesFetched: updates.length,
        lastProcessedUpdateId: nextLastProcessedUpdateId,
        readyBatches: result.batchResults.filter((batch) => batch.status === 'ready').length,
      },
      null,
      2,
    ),
  );
  process.stdout.write('\n');
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

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}

function loadRequiredEnv() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL;
  const allowedChatIdsRaw = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  const pollLimit = Number(process.env.TELEGRAM_POLL_LIMIT ?? 20);
  const aiConcurrency = Number(process.env.AI_CONCURRENCY ?? 3);

  for (const [name, value] of [
    ['TELEGRAM_BOT_TOKEN', botToken],
    ['AI_API_KEY', apiKey],
    ['AI_BASE_URL', baseUrl],
    ['AI_MODEL', model],
    ['TELEGRAM_ALLOWED_CHAT_IDS', allowedChatIdsRaw],
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

async function ensureTelegramFiles() {
  await mkdir(inboxDir, { recursive: true });
  await ensureFile(statePath, `${JSON.stringify({ lastProcessedUpdateId: 0 }, null, 2)}\n`);
  await ensureFile(processLogPath, '');
}

async function ensureFile(targetPath, initialValue) {
  try {
    await readFile(targetPath, 'utf8');
  } catch {
    await writeFile(targetPath, initialValue, 'utf8');
  }
}

async function readJson(targetPath, fallback) {
  try {
    const raw = await readFile(targetPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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
          content:
            '你是训练记录截图结构化助手。只能输出符合 schema 的 JSON。识别类型只允许 measurement、workout、nutrition、unknown。workout 既可能是逐条活动明细截图，也可能是当日活动总览截图；总览图请提取活动热量、锻炼时长、活动小时数到 dailyWorkoutSummary。日期优先从用户 caption/text 提取，其次再看图片。若日期不可靠则 detectedDate 返回 null，并在 warnings 中说明。',
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

async function persistInboxEntries(entries) {
  for (const entry of entries) {
    const targetPath = path.join(inboxDir, `${entry.batchId}.ndjson`);
    await appendFile(targetPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

async function appendProcessLog(entry) {
  await appendFile(processLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
}
