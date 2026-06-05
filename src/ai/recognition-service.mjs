import pg from 'pg';

import {
  extractAiResponseContent,
  parseAiJsonContent,
  validateAiJsonValue,
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
  const requestInput = {
    messages: buildRecognitionMessages({ imageUrl, message, systemPrompt }),
    retryableStatuses: RECOGNITION_RETRYABLE_STATUSES,
    logPrefix: '[telegram-sync] AI recognition',
    finalErrorMessage: 'AI recognition request failed',
  };
  const response = await requestRecognitionWithFormatFallback({
    aiProvider,
    requestInput,
    schemaName,
  });

  if (!response.ok) {
    const details = await summarizeRecognitionFailure(response);
    const error = new Error(
      details
        ? `AI recognition failed with HTTP ${response.status}: ${details}`
        : `AI recognition failed with HTTP ${response.status}`,
    );
    error.status = response.status;
    error.responseDetails = details;
    throw error;
  }

  const payload = await parseAiResponsePayload(response, {
    schemaName,
    schemaVersion,
  });
  const content = extractAiResponseContent(payload, {
    label: 'AI recognition',
    schemaName,
    schemaVersion,
  });

  try {
    return parseRecognitionContent(content, {
      schemaName,
      schemaVersion,
    });
  } catch (error) {
    if (error instanceof AiProviderError || error instanceof AiSchemaError) {
      const retryResult = await retryRecognitionAfterInvalidContent({
        aiProvider,
        requestInput,
        schemaName,
        schemaVersion,
        invalidContent: content,
      });
      if (retryResult.ok) {
        return retryResult.value;
      }
      if (!error.summary) {
        error.summary = buildSafeAiContentSummary({
          content,
          contentType: payload?.__aiResponseContentType,
          parseStage: 'message_content_json',
        });
      }
      logRecognitionParseFailure(error, {
        schemaName,
        schemaVersion,
        contentType: payload?.__aiResponseContentType,
      });
      throw error;
    }
    const schemaError = new AiSchemaError('AI recognition returned invalid schema', {
      cause: error,
      schemaName,
      schemaVersion,
    });
    schemaError.summary = buildSafeAiContentSummary({
      content,
      contentType: payload?.__aiResponseContentType,
      parseStage: 'message_content_schema',
    });
    logRecognitionParseFailure(schemaError, {
      schemaName,
      schemaVersion,
      contentType: payload?.__aiResponseContentType,
    });
    throw schemaError;
  }
}

async function retryRecognitionAfterInvalidContent({
  aiProvider,
  requestInput,
  schemaName,
  schemaVersion,
  invalidContent,
}) {
  const retryInput = {
    ...requestInput,
    messages: buildStrictJsonRetryMessages(requestInput.messages, invalidContent),
  };

  try {
    const response = await requestRecognitionWithFormatFallback({
      aiProvider,
      requestInput: retryInput,
      schemaName,
    });

    if (!response.ok) {
      return { ok: false };
    }

    const payload = await parseAiResponsePayload(response, {
      schemaName,
      schemaVersion,
    });
    const content = extractAiResponseContent(payload, {
      label: 'AI recognition retry',
      schemaName,
      schemaVersion,
    });
    return {
      ok: true,
      value: parseRecognitionContent(content, {
        schemaName,
        schemaVersion,
      }),
    };
  } catch {
    return { ok: false };
  }
}

async function parseAiResponsePayload(response, { schemaName, schemaVersion }) {
  if (typeof response.text === 'function') {
    const body = await response.text();
    const payload = parseAiJsonContentToValue(body, { schemaName, schemaVersion });
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return {
        ...payload,
        __aiResponseContentType: response.headers?.get?.('content-type') ?? null,
      };
    }
    return payload;
  }

  return response.json();
}

function parseRecognitionContent(content, { schemaName, schemaVersion }) {
  const value = parseAiJsonContentToValue(content, { schemaName, schemaVersion });
  const normalized = normalizeRecognitionPayload(value);

  validateAiJsonValue(normalized, buildRecognitionSchema(), {
    schemaName,
    schemaVersion,
    allowAdditionalProperties: true,
  });

  return normalized;
}

function parseAiJsonContentToValue(content, { schemaName, schemaVersion }) {
  const normalizedContent = typeof content === 'string' ? content.trim() : content;

  if (normalizedContent === '' || normalizedContent === null || normalizedContent === undefined) {
    throw new AiProviderError(`${schemaName} returned empty content`, {
      schemaName,
      schemaVersion,
      path: '$',
    });
  }

  if (typeof normalizedContent !== 'string') {
    return normalizedContent;
  }

  const candidates = collectJsonCandidates(normalizedContent);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const error = new AiSchemaError(`${schemaName} returned invalid JSON`, {
    cause: lastError,
    schemaName,
    schemaVersion,
    path: '$',
  });
  error.summary = buildSafeAiContentSummary({
    content: normalizedContent,
    contentType: null,
    parseStage: 'json_parse',
  });
  throw error;
}

function collectJsonCandidates(content) {
  const trimmed = String(content ?? '').trim();
  const candidates = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) {
    candidates.push(fenced);
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0) {
    const withoutDataPrefix = lines.map((line) => line.replace(/^data:\s*/i, '')).join('');
    if (withoutDataPrefix && withoutDataPrefix !== trimmed) {
      candidates.push(withoutDataPrefix);
    }
  }

  const jsonStart = trimmed.search(/[\[{]/);
  const jsonEnd = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    candidates.push(trimmed.slice(jsonStart, jsonEnd + 1).trim());
  }

  candidates.push(...extractBalancedJsonCandidates(trimmed));

  return [...new Set(candidates.filter(Boolean))];
}

function extractBalancedJsonCandidates(content) {
  const candidates = [];
  const text = String(content ?? '');

  for (let index = 0; index < text.length; index += 1) {
    const startChar = text[index];
    if (startChar !== '{' && startChar !== '[') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let cursor = index; cursor < text.length; cursor += 1) {
      const char = text[cursor];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        depth += 1;
        continue;
      }

      if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(index, cursor + 1).trim());
          break;
        }
      }
    }
  }

  return candidates;
}

function normalizeRecognitionPayload(value) {
  if (!isPlainObject(value)) {
    return value;
  }

  const records = isPlainObject(value.records) ? value.records : {};
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  const missingMeasurementData = value.imageType === 'measurement' && !isPlainObject(records.measurement);
  return {
    ...value,
    confidence: missingMeasurementData
      ? Math.min(Number.isFinite(value.confidence) ? value.confidence : 0, 0.5)
      : value.confidence,
    warnings: missingMeasurementData
      ? [...warnings, 'measurement image missing measurement data']
      : warnings,
    records: {
      measurement: records.measurement ?? null,
      activities: Array.isArray(records.activities) ? records.activities : [],
      meals: Array.isArray(records.meals) ? records.meals : [],
      totalCalories: records.totalCalories ?? null,
      details: normalizeRecognitionDetails(records.details),
      dailyWorkoutSummary: records.dailyWorkoutSummary ?? null,
      sleep: normalizeRecognitionSleep(records.sleep ?? null),
    },
  };
}

function normalizeRecognitionDetails(details) {
  if (Array.isArray(details)) {
    return details;
  }

  if (details === null || details === undefined) {
    return [];
  }

  if (typeof details === 'string') {
    const trimmed = details.trim();
    return trimmed ? [trimmed] : [];
  }

  if (isPlainObject(details)) {
    return Object.values(details)
      .flatMap((item) => normalizeRecognitionDetails(item))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return details;
}

function normalizeRecognitionSleep(sleep) {
  if (sleep === null || sleep === undefined) {
    return null;
  }

  if (!isPlainObject(sleep)) {
    return sleep;
  }

  const nullableFields = [
    'sleepType',
    'bedtime',
    'wakeTime',
    'nightSleepMinutes',
    'totalSleepMinutes',
    'napMinutes',
    'deepSleepMinutes',
    'lightSleepMinutes',
    'remSleepMinutes',
    'awakeMinutes',
    'sleepStageText',
    'sleepScore',
    'sleepScorePercentile',
    'deepSleepRatioPct',
    'lightSleepRatioPct',
    'remSleepRatioPct',
    'deepSleepContinuityScore',
    'wakeCount',
    'breathingQualityScore',
    'averageHeartRateBpm',
    'hrvMs',
    'averageSpo2Pct',
    'averageRespiratoryRate',
    'analysisText',
    'suggestionText',
  ];
  const normalized = Object.fromEntries(nullableFields.map((field) => [field, sleep[field] ?? null]));

  return {
    ...normalized,
    sleepStageDetail: normalizeRecognitionDetails(sleep.sleepStageDetail),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requestRecognitionWithFormatFallback({
  aiProvider,
  requestInput,
  schemaName,
}) {
  const strictResponse = await aiProvider.requestChatCompletion({
    ...requestInput,
    responseFormat: buildStrictRecognitionResponseFormat(schemaName),
  });
  if (strictResponse.ok) {
    return strictResponse;
  }

  const strictDetails = await summarizeRecognitionFailure(strictResponse);
  if (!shouldRetryWithJsonObjectFormat(strictResponse.status, strictDetails)) {
    throwRecognitionHttpError(strictResponse.status, strictDetails);
  }

  const jsonObjectResponse = await aiProvider.requestChatCompletion({
    ...requestInput,
    responseFormat: {
      type: 'json_object',
    },
  });
  if (jsonObjectResponse.ok) {
    return jsonObjectResponse;
  }

  const jsonObjectDetails = await summarizeRecognitionFailure(jsonObjectResponse);
  if (!shouldRetryWithoutResponseFormat(jsonObjectResponse.status, jsonObjectDetails)) {
    throwRecognitionHttpError(jsonObjectResponse.status, jsonObjectDetails);
  }

  return aiProvider.requestChatCompletion(requestInput);
}

function buildStrictRecognitionResponseFormat(schemaName) {
  return {
    type: 'json_schema',
    json_schema: {
      name: schemaName,
      strict: true,
      schema: buildRecognitionSchema(),
    },
  };
}

function buildRecognitionMessages({ imageUrl, message, systemPrompt }) {
  return [
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
            'Return only valid json.',
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
  ];
}

function buildStrictJsonRetryMessages(messages, invalidContent) {
  const nextMessages = structuredClone(messages);
  const userMessage = nextMessages.find((message) => message.role === 'user');
  if (Array.isArray(userMessage?.content)) {
    const textPart = userMessage.content.find((part) => part?.type === 'text');
    if (textPart) {
      textPart.text = [
        textPart.text,
        '',
        'The previous response was not valid json.',
        'Return only one valid JSON object matching the telegram_training_image schema.',
        'Do not include markdown, diagnostics, explanations, or error text.',
        `Previous response summary: ${summarizeAiContentSnippet(invalidContent)}`,
      ].join('\n');
    }
  }
  return nextMessages;
}

function shouldRetryWithJsonObjectFormat(status, details) {
  return status === 400 && isResponseFormatCompatibilityError(details);
}

function shouldRetryWithoutResponseFormat(status, details) {
  return status === 400 && isResponseFormatCompatibilityError(details);
}

function isResponseFormatCompatibilityError(details) {
  const normalized = String(details ?? '').toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('response_format') ||
    normalized.includes('json_schema') ||
    normalized.includes('json object') ||
    normalized.includes('structured output') ||
    normalized.includes('structured outputs') ||
    /missing required parameter:.*name/.test(normalized)
  );
}

function throwRecognitionHttpError(status, details) {
  const error = new Error(
    details
      ? `AI recognition failed with HTTP ${status}: ${details}`
      : `AI recognition failed with HTTP ${status}`,
  );
  error.status = status;
  error.responseDetails = details;
  throw error;
}

async function summarizeRecognitionFailure(response) {
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().includes('application/json')) {
      const payload = await response.json();
      const message =
        payload?.error?.message ??
        payload?.message ??
        payload?.detail ??
        payload?.details ??
        null;
      return summarizeErrorText(message);
    }

    return summarizeErrorText(await response.text());
  } catch {
    return null;
  }
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

function buildSafeAiContentSummary({ content, contentType, parseStage }) {
  return {
    contentType: String(contentType ?? '').split(';', 1)[0].trim() || null,
    parseStage,
    snippet: summarizeAiContentSnippet(content),
  };
}

function logRecognitionParseFailure(error, { schemaName, schemaVersion, contentType }) {
  const summary = error?.summary ?? null;
  const payload = {
    schemaName,
    schemaVersion,
    contentType: String(contentType ?? '').split(';', 1)[0].trim() || null,
    message: error instanceof Error ? error.message : String(error),
    summary,
  };
  process.stderr.write(`[telegram-sync] recognition parse failure: ${JSON.stringify(payload)}\n`);
}

function summarizeAiContentSnippet(content) {
  const text = String(content ?? '')
    .replace(/https:\/\/api\.telegram\.org\/file\/bot[^\s"'<>]+/gi, '[telegram-file-url]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
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
