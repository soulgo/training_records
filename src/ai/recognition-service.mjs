import pg from 'pg';

import {
  extractAiResponseContent,
  parseAiJsonContent,
  AiProviderError,
  AiSchemaError,
} from './schema-validator.mjs';
import { resolveTrainingCoreConfig } from '../../tools/training-db-config.mjs';
import {
  buildRecognitionSchema,
  RECOGNITION_SCHEMA_NAME,
  RECOGNITION_SCHEMA_VERSION,
} from '../../tools/telegram-recognition-schema.mjs';

const { Client } = pg;
const RECOGNITION_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function isRecognitionCacheEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.TELEGRAM_RECOGNITION_CACHE_ENABLED ?? '').trim().toLowerCase(),
  );
}

export function buildRecognitionCacheKey({
  fileUniqueId,
  promptVersion,
  schemaVersion,
  model,
}) {
  if (!fileUniqueId || !promptVersion || !schemaVersion || !model) {
    return null;
  }

  return [
    'telegram:file_unique_id',
    fileUniqueId,
    'prompt',
    promptVersion,
    'schema',
    schemaVersion,
    'model',
    model,
  ].join(':');
}

export async function recognizeTelegramImageMessage({
  aiProvider,
  message,
  imageUrl,
  systemPrompt,
  promptMetadata,
  env = process.env,
  readRecognitionCache,
}) {
  const schemaName = promptMetadata?.schemaName ?? RECOGNITION_SCHEMA_NAME;
  const schemaVersion = promptMetadata?.schemaVersion ?? RECOGNITION_SCHEMA_VERSION;
  const promptVersion = promptMetadata?.version ?? '';
  const model = aiProvider?.env?.model ?? env.AI_MODEL ?? '';
  const fileUniqueId = message.photos?.at(-1)?.fileUniqueId ?? null;
  const cacheKey = buildRecognitionCacheKey({
    fileUniqueId,
    promptVersion,
    schemaVersion,
    model,
  });

  if (cacheKey && isRecognitionCacheEnabled(env)) {
    const cached = await readCachedRecognition({
      env,
      readRecognitionCache,
      cacheKey,
      fileUniqueId,
      promptVersion,
      schemaVersion,
      model,
    });
    if (cached) {
      return {
        ...cached,
        messageId: message.messageId,
        cacheKey,
        cacheStatus: 'hit',
      };
    }
  }

  const parsed = await requestRecognition({
    aiProvider,
    imageUrl,
    message,
    systemPrompt,
    schemaName,
    schemaVersion,
  });

  return {
    messageId: message.messageId,
    ...parsed,
    promptVersion,
    schemaName,
    schemaVersion,
    model,
    cacheKey,
    cacheStatus: cacheKey && isRecognitionCacheEnabled(env) ? 'miss' : 'disabled',
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
  if (!config.enabled || !config.url || !options.fileUniqueId) {
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
        select r.recognition_json
        from ingest.telegram_recognition r
        join ingest.telegram_message m on m.message_id = r.message_id
        where m.photo_file_unique_ids_json @> $1::jsonb
          and r.recognition_json->>'promptVersion' = $2
          and r.recognition_json->>'schemaVersion' = $3
          and r.recognition_json->>'model' = $4
        order by r.updated_at desc
        limit 1
      `,
      [
        JSON.stringify([options.fileUniqueId]),
        options.promptVersion,
        options.schemaVersion,
        options.model,
      ],
    );
    return result.rows[0]?.recognition_json ?? null;
  } finally {
    await client.end();
  }
}

async function requestRecognition({
  aiProvider,
  imageUrl,
  message,
  systemPrompt,
  schemaName,
  schemaVersion,
}) {
  const response = await aiProvider.requestChatCompletion({
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: schemaName,
        strict: true,
        schema: buildRecognitionSchema(),
      },
    },
    messages: [
      {
        role: 'system',
        content: systemPrompt,
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
    retryableStatuses: RECOGNITION_RETRYABLE_STATUSES,
    logPrefix: '[telegram-sync] AI recognition',
    finalErrorMessage: 'AI recognition request failed',
  });

  if (!response.ok) {
    throw new Error(`AI recognition failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const content = extractAiResponseContent(payload, {
    label: 'AI recognition',
    schemaName,
    schemaVersion,
  });

  try {
    return parseAiJsonContent(content, buildRecognitionSchema(), {
      schemaName,
      schemaVersion,
      allowAdditionalProperties: true,
    });
  } catch (error) {
    if (error instanceof AiProviderError || error instanceof AiSchemaError) {
      throw error;
    }
    throw new AiSchemaError('AI recognition returned invalid schema', {
      cause: error,
      schemaName,
      schemaVersion,
    });
  }
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
