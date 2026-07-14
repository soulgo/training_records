import pg from 'pg';
import {
  RECOGNITION_SCHEMA_NAME,
  RECOGNITION_SCHEMA_VERSION,
} from '../../core/ai/telegram-recognition-schema.mjs';
import { buildNormalizedRecognition } from '../../core/ai/normalized-recognition.mjs';
import { resolveTrainingCoreConfig } from '../../adapters/postgres/training-config.pg.mjs';
import { createHash } from 'node:crypto';
import { requestRecognitionWithProviderFallback } from './image-recognition-provider.mjs';

const { Client } = pg;

export function isRecognitionCacheEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.TELEGRAM_RECOGNITION_CACHE_ENABLED ?? '').trim().toLowerCase(),
  );
}

export function buildRecognitionCacheKey({
  sourceChannel = 'telegram',
  fileUniqueId,
  promptVersion,
  schemaVersion,
  model,
  capabilityMode = 'strict_schema',
}) {
  if (!fileUniqueId || !promptVersion || !schemaVersion || !model) {
    return null;
  }

  return [
    `${normalizeRecognitionCacheChannel(sourceChannel)}:file_unique_id`,
    fileUniqueId,
    'prompt',
    promptVersion,
    'schema',
    schemaVersion,
    'model',
    model,
    'capability',
    capabilityMode,
  ].join(':');
}

export function resolveRecognitionCapabilityMode(capabilities = {}) {
  if (capabilities.vision === false) return 'unsupported_vision';
  if (capabilities.jsonSchema !== false) return 'strict_schema';
  if (capabilities.jsonObject !== false) return 'json_object';
  if (capabilities.textJson !== false) return 'text_json';
  return 'unsupported_json';
}

function normalizeRecognitionCacheChannel(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return normalized || 'telegram';
}

export async function recognizeTelegramImageMessage({
  aiProvider,
  message,
  imageUrl,
  systemPrompt,
  promptMetadata,
  env = process.env,
  readRecognitionCache,
  processImage,
  extractOcr,
  onCacheReadStage,
  onAiCallLog,
}) {
  const schemaName = promptMetadata?.schemaName ?? RECOGNITION_SCHEMA_NAME;
  const schemaVersion = promptMetadata?.schemaVersion ?? RECOGNITION_SCHEMA_VERSION;
  const promptVersion = promptMetadata?.version ?? '';
  const model = aiProvider?.env?.model ?? env.AI_MODEL ?? '';
  const fileUniqueId = message.photos?.at(-1)?.fileUniqueId ?? null;
  const sourceChannel = message.sourceChannel ?? 'telegram';
  const capabilityMode = resolveRecognitionCapabilityMode(aiProvider?.capabilities);
  const cacheKey = buildRecognitionCacheKey({
    sourceChannel,
    fileUniqueId,
    promptVersion,
    schemaVersion,
    model,
  });

  if (cacheKey && isRecognitionCacheEnabled(env)) {
    const cacheStartedAt = Date.now();
    let cached = null;
    try {
      cached = await readCachedRecognition({
        env,
        readRecognitionCache,
        cacheKey,
        fileUniqueId,
        promptVersion,
        schemaVersion,
        model,
      });
      onCacheReadStage?.({
        status: 'succeeded',
        durationMs: Date.now() - cacheStartedAt,
        failureCategory: null,
        failureReason: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[telegram-sync] recognition cache read failed for ${fileUniqueId}: ${message}; continuing without cache\n`,
      );
      onCacheReadStage?.({
        status: 'failed',
        durationMs: Date.now() - cacheStartedAt,
        failureCategory: 'database',
        failureReason: message,
      });
    }
    if (cached) {
      const cacheStatus = 'hit';
      const provider = aiProvider?.name ?? 'openai-compatible';
      return {
        ...cached,
        messageId: message.messageId,
        cacheKey,
        cacheStatus,
        normalizedRecognition: buildNormalizedRecognition({
          payload: cached,
          runtime: {
            schemaName,
            schemaVersion,
            provider,
            model,
            promptVersion,
            cacheKey,
            cacheStatus,
          },
        }),
      };
    }
  }

  const processedImage = typeof processImage === 'function'
    ? await processImage({ imageUrl, message })
    : { imageUrl, metadata: null };
  if (!processedImage?.imageUrl) {
    throw new Error('image processor returned no recognition image');
  }
  const ocrDocument = typeof extractOcr === 'function'
    ? await extractOcr({ imageUrl: processedImage.imageUrl, message })
    : null;

  const recognitionResult = await requestRecognitionWithProviderFallback({
    aiProvider,
    imageUrl: processedImage.imageUrl,
    ocrDocument,
    message,
    systemPrompt,
    promptVersion,
    schemaName,
    schemaVersion,
    env,
    onAiCallLog,
    idempotencyKey: buildRecognitionIdempotencyKey({
      message,
      imageUrl,
      promptVersion,
      schemaName,
      schemaVersion,
      model,
    }),
  });
  const parsed = recognitionResult.value;
  const usedModel = recognitionResult.aiProvider?.env?.model ?? model;
  const usedCapabilityMode = resolveRecognitionCapabilityMode(recognitionResult.aiProvider?.capabilities);
  const effectiveCacheKey = usedModel === model && usedCapabilityMode === capabilityMode
    ? cacheKey
    : buildRecognitionCacheKey({
        sourceChannel,
        fileUniqueId,
        promptVersion,
        schemaVersion,
        model: usedModel,
        capabilityMode: usedCapabilityMode,
      });
  const cacheStatus = cacheKey && isRecognitionCacheEnabled(env) ? 'miss' : 'disabled';
  const provider = recognitionResult.aiProvider?.name ?? 'openai-compatible';
  const normalizedRecognition = buildNormalizedRecognition({
    payload: parsed,
    ocr: ocrDocument,
    image: processedImage.metadata ?? null,
    runtime: {
      schemaName,
      schemaVersion,
      provider,
      model: usedModel,
      promptVersion,
      cacheKey: effectiveCacheKey,
      cacheStatus,
    },
  });

  return {
    messageId: message.messageId,
    ...parsed,
    aiAttemptKind: recognitionResult.attemptKind ?? 'normal',
    aiIdempotencyKey: recognitionResult.idempotencyKey,
    aiUsage: recognitionResult.aiUsage,
    provider,
    promptVersion,
    schemaName,
    schemaVersion,
    model: usedModel,
    cacheKey: effectiveCacheKey,
    cacheStatus,
    normalizedRecognition,
  };
}

async function readCachedRecognition({
  env,
  readRecognitionCache,
  cacheKey,
  fileUniqueId,
  promptVersion,
  schemaVersion,
  model,
}) {
  const cached =
    readRecognitionCache
      ? await readRecognitionCache({ cacheKey, fileUniqueId, promptVersion, schemaVersion, model })
      : await readRecognitionFromDatabaseCache({
          env,
          cacheKey,
          fileUniqueId,
          promptVersion,
          schemaVersion,
          model,
        });

  if (!cached) {
    return null;
  }

  return stripRecognitionRuntimeMetadata(cached);
}

export async function readRecognitionFromDatabaseCache(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url || !options.cacheKey) {
    return null;
  }

  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));
  const client = createClient(config);

  try {
    await client.connect();
    const result = await client.query(
      `
        select r.raw_result_json as recognition_json
        from ingest.recognition_run r
        where r.cache_key = $1
        order by r.updated_at desc
        limit 1
      `,
      [options.cacheKey],
    );
    return result.rows[0]?.recognition_json ?? null;
  } finally {
    await client.end();
  }
}

function buildRecognitionIdempotencyKey({
  message,
  imageUrl,
  promptVersion,
  schemaName,
  schemaVersion,
  model,
}) {
  const imageFingerprint =
    message.photos?.at(-1)?.fileUniqueId ??
    message.photos?.at(-1)?.fileId ??
    imageUrl;
  const keySource = JSON.stringify({
    schemaName,
    schemaVersion,
    promptVersion,
    model,
    imageFingerprint,
    messageId: message.messageId ?? null,
    sourceMessageId: message.sourceMessageId ?? null,
  });
  const digest = createHash('sha256').update(keySource).digest('hex');
  return [
    'recognition',
    schemaName,
    schemaVersion,
    promptVersion,
    model,
    sanitizeIdempotencyKeyPart(imageFingerprint),
    digest,
  ]
    .filter(Boolean)
    .join(':');
}

function sanitizeIdempotencyKeyPart(value) {
  const normalized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '_');
  return normalized.slice(0, 64) || 'image';
}

function stripRecognitionRuntimeMetadata(recognition) {
  if (!recognition || typeof recognition !== 'object') {
    return null;
  }

  const {
    messageId,
    promptVersion,
    schemaName,
    schemaVersion,
    model,
    cacheKey,
    cacheStatus,
    ...payload
  } = recognition;
  return payload;
}
