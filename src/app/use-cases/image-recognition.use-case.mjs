import pg from 'pg';
import {
  RECOGNITION_SCHEMA_NAME,
  RECOGNITION_SCHEMA_VERSION,
} from '../../core/ai/telegram-recognition-schema.mjs';
import { buildNormalizedRecognition } from '../../core/ai/normalized-recognition.mjs';
import {
  evaluateRecognitionCompleteness,
  RECOGNITION_COMPLETENESS_VERSION,
} from '../../core/ai/recognition-completeness.mjs';
import { loadStructuredSource } from '../../core/ai/prompt-generator.mjs';
import { resolveTrainingCoreConfig } from '../../adapters/postgres/training-config.pg.mjs';
import { createHash } from 'node:crypto';
import {
  requestRecognitionWithProvider,
  requestRecognitionWithProviderFallback,
} from './image-recognition-provider.mjs';
import { parseRecognitionContent } from './image-recognition-parse.mjs';
import { reconcileRecognitionResults } from '../../core/ai/recognition-reconciliation.mjs';

const { Client } = pg;
let appProfilesPromise = null;

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
    'completeness',
    RECOGNITION_COMPLETENESS_VERSION,
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
  appProfiles,
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
  const fallbackModel = aiProvider?.fallbackProvider?.env?.model ?? null;
  const reconciledCacheKey = fallbackModel
    ? buildRecognitionCacheKey({
        sourceChannel,
        fileUniqueId,
        promptVersion,
        schemaVersion,
        model: `${model}+${fallbackModel}`,
        capabilityMode: 'reconciled',
      })
    : null;
  const cacheKeys = [...new Set([cacheKey, reconciledCacheKey].filter(Boolean))];
  const cacheEnabled = Boolean(cacheKey && isRecognitionCacheEnabled(env));
  const idempotencyKey = buildRecognitionIdempotencyKey({
    message,
    imageUrl,
    promptVersion,
    schemaName,
    schemaVersion,
    model,
  });
  const resolvedAppProfiles = await resolveRecognitionAppProfiles(appProfiles);
  let cachedPrimary = null;
  let cachedEnvelope = null;

  if (cacheEnabled) {
    const cacheStartedAt = Date.now();
    let cachedCandidates = [];
    try {
      cachedCandidates = await readCachedRecognition({
        env,
        readRecognitionCache,
        cacheKey,
        cacheKeys,
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
    for (const cached of cachedCandidates) {
      try {
        const candidate = revalidateRecognitionPayload(cached, { schemaName, schemaVersion });
        const cachedOcr = cached.normalizedRecognition?.evidence?.ocr ?? null;
        const completeness = evaluateRecognitionCompleteness({
          recognition: candidate,
          ocrDocument: cachedOcr,
          appProfiles: resolvedAppProfiles,
        });
        if (completeness.status === 'complete') {
          return buildRecognitionOutput({
            message,
            payload: candidate,
            ocrDocument: cachedOcr,
            imageMetadata: cached.normalizedRecognition?.evidence?.image ?? null,
            runtime: {
              schemaName,
              schemaVersion,
              provider: cached.provider ?? cached.normalizedRecognition?.runtime?.provider ?? aiProvider?.name ?? 'openai-compatible',
              model: cached.model ?? cached.normalizedRecognition?.runtime?.model ?? model,
              promptVersion,
              cacheKey: cached.cacheKey ?? cached.normalizedRecognition?.runtime?.cacheKey ?? cacheKey,
              cacheStatus: 'hit',
            },
            completeness,
            reconciliation: cached.reconciliation ?? cached.normalizedRecognition?.runtime?.reconciliation ?? primaryReconciliation(),
            aiAttemptKind: 'cache',
            aiIdempotencyKey: cached.aiIdempotencyKey ?? null,
            aiUsage: cached.aiUsage ?? null,
            fallbackModel: cached.fallbackModel ?? cached.normalizedRecognition?.runtime?.fallbackModel ?? null,
          });
        }
        if (!cachedPrimary) {
          cachedEnvelope = cached;
          cachedPrimary = candidate;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[telegram-sync] recognition cache validation failed for ${fileUniqueId}: ${errorMessage}; continuing with other cache candidates\n`,
        );
      }
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

  const primaryResult = cachedPrimary
    ? null
    : await requestRecognitionWithProviderFallback({
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
        idempotencyKey,
      });
  const parsed = cachedPrimary ?? primaryResult.value;
  const primaryCompleteness = evaluateRecognitionCompleteness({
    recognition: parsed,
    ocrDocument,
    appProfiles: resolvedAppProfiles,
  });
  const primaryUsedTechnicalFallback = primaryResult?.attemptKind === 'fallback';

  if (primaryCompleteness.status !== 'complete' && !primaryUsedTechnicalFallback) {
    return completeRecognitionWithBusinessFallback({
      aiProvider,
      primary: parsed,
      primaryCompleteness,
      cachedEnvelope,
      message,
      processedImage,
      ocrDocument,
      systemPrompt,
      promptVersion,
      schemaName,
      schemaVersion,
      env,
      onAiCallLog,
      idempotencyKey,
      appProfiles: resolvedAppProfiles,
      sourceChannel,
      fileUniqueId,
      primaryModel: model,
      primaryProvider: aiProvider?.name ?? 'openai-compatible',
      cacheKey,
      cacheStatus: cachedPrimary ? 'hit_incomplete' : (cacheEnabled ? 'miss' : 'disabled'),
      primaryResult,
    });
  }

  const usedModel = primaryResult?.aiProvider?.env?.model ?? model;
  const usedCapabilityMode = resolveRecognitionCapabilityMode(primaryResult?.aiProvider?.capabilities);
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
  const cacheStatus = cacheEnabled ? 'miss' : 'disabled';
  const provider = primaryResult?.aiProvider?.name ?? 'openai-compatible';
  const finalSingleReconciliation = primaryCompleteness.status === 'complete'
    ? primaryReconciliation(primaryUsedTechnicalFallback ? 'fallback' : 'primary')
    : incompleteReconciliation(primaryUsedTechnicalFallback ? 'fallback_incomplete' : 'primary_incomplete');
  return buildRecognitionOutput({
    message,
    payload: parsed,
    ocrDocument,
    imageMetadata: processedImage.metadata ?? null,
    runtime: {
      schemaName,
      schemaVersion,
      provider,
      model: usedModel,
      promptVersion,
      cacheKey: effectiveCacheKey,
      cacheStatus,
    },
    completeness: primaryCompleteness,
    reconciliation: finalSingleReconciliation,
    aiAttemptKind: primaryResult?.attemptKind ?? 'normal',
    aiIdempotencyKey: primaryResult?.idempotencyKey,
    aiUsage: primaryResult?.aiUsage,
  });
}

async function completeRecognitionWithBusinessFallback({
  aiProvider,
  primary,
  primaryCompleteness,
  cachedEnvelope,
  message,
  processedImage,
  ocrDocument,
  systemPrompt,
  promptVersion,
  schemaName,
  schemaVersion,
  env,
  onAiCallLog,
  idempotencyKey,
  appProfiles,
  sourceChannel,
  fileUniqueId,
  primaryModel,
  primaryProvider,
  cacheKey,
  cacheStatus,
  primaryResult,
}) {
  const fallbackProvider = aiProvider?.fallbackProvider;
  if (!fallbackProvider) {
    return buildRecognitionOutput({
      message,
      payload: primary,
      ocrDocument,
      imageMetadata: processedImage.metadata ?? null,
      runtime: {
        schemaName,
        schemaVersion,
        provider: cachedEnvelope?.provider ?? primaryResult?.aiProvider?.name ?? primaryProvider,
        model: cachedEnvelope?.model ?? primaryResult?.aiProvider?.env?.model ?? primaryModel,
        promptVersion,
        cacheKey,
        cacheStatus,
      },
      completeness: primaryCompleteness,
      reconciliation: fallbackUnavailableReconciliation(),
      aiAttemptKind: cachedEnvelope ? 'cache_incomplete' : (primaryResult?.attemptKind ?? 'normal'),
      aiIdempotencyKey: cachedEnvelope?.aiIdempotencyKey ?? primaryResult?.idempotencyKey ?? null,
      aiUsage: cachedEnvelope?.aiUsage ?? primaryResult?.aiUsage ?? null,
    });
  }

  let fallbackResult;
  try {
    fallbackResult = await requestRecognitionWithProvider({
      aiProvider: fallbackProvider,
      imageUrl: processedImage.imageUrl,
      ocrDocument,
      message,
      systemPrompt,
      promptVersion,
      schemaName,
      schemaVersion,
      env,
      onAiCallLog,
      idempotencyKey,
    });
  } catch (error) {
    const status = Number(error?.status);
    const statusSuffix = Number.isInteger(status) && status > 0 ? ` with HTTP ${status}` : '';
    process.stderr.write(
      `[telegram-sync] business fallback recognition failed${statusSuffix}; keeping primary result\n`,
    );
    return buildRecognitionOutput({
      message,
      payload: appendRecognitionWarning(primary, '备用识别服务暂不可用，已保留主识别结果'),
      ocrDocument,
      imageMetadata: processedImage.metadata ?? null,
      runtime: {
        schemaName,
        schemaVersion,
        provider: cachedEnvelope?.provider ?? primaryResult?.aiProvider?.name ?? primaryProvider,
        model: cachedEnvelope?.model ?? primaryResult?.aiProvider?.env?.model ?? primaryModel,
        promptVersion,
        cacheKey,
        cacheStatus,
      },
      completeness: primaryCompleteness,
      reconciliation: fallbackFailedReconciliation(),
      aiAttemptKind: 'fallback_business_completion_failed',
      aiIdempotencyKey: cachedEnvelope?.aiIdempotencyKey ?? primaryResult?.idempotencyKey ?? idempotencyKey,
      aiUsage: cachedEnvelope?.aiUsage ?? primaryResult?.aiUsage ?? null,
      fallbackModel: fallbackProvider?.env?.model ?? null,
    });
  }
  const reconciled = reconcileRecognitionResults({ primary, fallback: fallbackResult.value });
  if (!reconciled.value) {
    const finalCompleteness = reconciled.status === 'conflict'
      ? { ...primaryCompleteness, status: 'needs_review', requiresFallback: false }
      : primaryCompleteness;
    return buildRecognitionOutput({
      message,
      payload: primary,
      ocrDocument,
      imageMetadata: processedImage.metadata ?? null,
      runtime: {
        schemaName,
        schemaVersion,
        provider: primaryProvider,
        model: primaryModel,
        promptVersion,
        cacheKey,
        cacheStatus,
      },
      completeness: finalCompleteness,
      reconciliation: reconciled,
      aiAttemptKind: 'fallback_business_completion',
      aiIdempotencyKey: idempotencyKey,
      aiUsage: combineAiUsage(primaryResult?.aiUsage, fallbackResult.aiUsage),
      fallbackModel: fallbackProvider?.env?.model ?? null,
    });
  }

  const finalPayload = revalidateRecognitionPayload(reconciled.value, { schemaName, schemaVersion });
  const finalCompleteness = evaluateRecognitionCompleteness({
    recognition: finalPayload,
    ocrDocument,
    appProfiles,
  });
  const finalReconciliation = finalCompleteness.status === 'complete'
    ? reconciled
    : { ...reconciled, status: 'incomplete', value: null };
  const fallbackModel = fallbackProvider?.env?.model ?? null;
  const effectiveCacheKey = buildRecognitionCacheKey({
    sourceChannel,
    fileUniqueId,
    promptVersion,
    schemaVersion,
    model: `${primaryModel}+${fallbackModel}`,
    capabilityMode: 'reconciled',
  });

  return buildRecognitionOutput({
    message,
    payload: finalPayload,
    ocrDocument,
    imageMetadata: processedImage.metadata ?? null,
    runtime: {
      schemaName,
      schemaVersion,
      provider: primaryProvider,
      model: `${primaryModel}+${fallbackModel}`,
      promptVersion,
      cacheKey: effectiveCacheKey,
      cacheStatus,
    },
    completeness: finalCompleteness,
    reconciliation: finalReconciliation,
    aiAttemptKind: 'fallback_business_completion',
    aiIdempotencyKey: idempotencyKey,
    aiUsage: combineAiUsage(primaryResult?.aiUsage, fallbackResult.aiUsage),
    fallbackModel,
  });
}

function buildRecognitionOutput({
  message,
  payload,
  ocrDocument,
  imageMetadata,
  runtime,
  completeness,
  reconciliation,
  aiAttemptKind,
  aiIdempotencyKey,
  aiUsage,
  fallbackModel = null,
}) {
  const safeReconciliation = sanitizeReconciliationMetadata(reconciliation);
  const normalizedRecognition = buildNormalizedRecognition({
    payload,
    ocr: ocrDocument,
    image: imageMetadata,
    runtime: {
      ...runtime,
      completeness,
      reconciliation: safeReconciliation,
      fallbackModel,
    },
  });
  return {
    messageId: message.messageId,
    ...payload,
    completeness,
    reconciliation: safeReconciliation,
    aiAttemptKind,
    aiIdempotencyKey,
    aiUsage,
    provider: runtime.provider,
    promptVersion: runtime.promptVersion,
    schemaName: runtime.schemaName,
    schemaVersion: runtime.schemaVersion,
    model: runtime.model,
    fallbackModel,
    cacheKey: runtime.cacheKey,
    cacheStatus: runtime.cacheStatus,
    normalizedRecognition,
  };
}

function revalidateRecognitionPayload(payload, { schemaName, schemaVersion }) {
  const candidate = stripRecognitionRuntimeMetadata(payload);
  return parseRecognitionContent(JSON.stringify(candidate), { schemaName, schemaVersion });
}

async function resolveRecognitionAppProfiles(appProfiles) {
  if (appProfiles) return appProfiles;
  appProfilesPromise ??= loadStructuredSource('app-profiles').catch(() => null);
  return appProfilesPromise;
}

function primaryReconciliation(finalSource = 'primary') {
  return {
    status: 'primary',
    filledFields: [],
    agreedFields: [],
    conflictFields: [],
    fieldSources: {},
    finalSource,
  };
}

function incompleteReconciliation(finalSource) {
  return {
    status: 'incomplete',
    filledFields: [],
    agreedFields: [],
    conflictFields: [],
    fieldSources: {},
    finalSource,
  };
}

function fallbackUnavailableReconciliation() {
  return {
    status: 'fallback_unavailable',
    filledFields: [],
    agreedFields: [],
    conflictFields: [],
    fieldSources: {},
    finalSource: 'primary_incomplete',
  };
}

function fallbackFailedReconciliation() {
  return {
    status: 'fallback_failed',
    filledFields: [],
    agreedFields: [],
    conflictFields: [],
    fieldSources: {},
    finalSource: 'primary_incomplete',
  };
}

function appendRecognitionWarning(payload, warning) {
  return {
    ...payload,
    warnings: [...new Set([...(payload?.warnings ?? []), warning])],
  };
}

function combineAiUsage(primary, fallback) {
  const result = {};
  for (const field of ['promptTokens', 'completionTokens', 'totalTokens', 'costUsd']) {
    const values = [primary?.[field], fallback?.[field]].filter((value) => Number.isFinite(value));
    result[field] = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return result;
}

function sanitizeReconciliationMetadata(reconciliation) {
  const value = reconciliation && typeof reconciliation === 'object' ? reconciliation : {};
  const safe = {
    status: String(value.status ?? 'incomplete'),
    filledFields: sanitizeFieldPaths(value.filledFields),
    agreedFields: sanitizeFieldPaths(value.agreedFields),
    conflictFields: sanitizeFieldPaths(value.conflictFields),
    fieldSources: sanitizeFieldSources(value.fieldSources),
  };
  if (value.finalSource) {
    safe.finalSource = String(value.finalSource);
  }
  return safe;
}

function sanitizeFieldPaths(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((field) => String(field ?? '').trim()).filter(Boolean))]
    : [];
}

function sanitizeFieldSources(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([field, source]) => [String(field).trim(), String(source ?? '').trim()])
    .filter(([field, source]) => field && ['primary', 'fallback', 'reconciled'].includes(source)));
}

async function readCachedRecognition({
  env,
  readRecognitionCache,
  cacheKey,
  cacheKeys,
  fileUniqueId,
  promptVersion,
  schemaVersion,
  model,
}) {
  const cached =
    readRecognitionCache
      ? await readRecognitionCache({ cacheKey, cacheKeys, fileUniqueId, promptVersion, schemaVersion, model })
      : await readRecognitionFromDatabaseCache({
          env,
          cacheKey,
          cacheKeys,
          fileUniqueId,
          promptVersion,
          schemaVersion,
          model,
          returnCandidates: true,
        });

  return normalizeCachedRecognitionCandidates(cached);
}

function normalizeCachedRecognitionCandidates(cached) {
  const values = Array.isArray(cached) ? cached : cached ? [cached] : [];
  return values
    .map((candidate) => candidate?.recognition ?? candidate?.recognition_json ?? candidate)
    .filter((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate));
}

export async function readRecognitionFromDatabaseCache(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  const cacheKeys = [...new Set((options.cacheKeys ?? [options.cacheKey]).filter(Boolean))];
  if (!config.enabled || !config.url || cacheKeys.length === 0) {
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
        select r.cache_key, r.raw_result_json as recognition_json
        from ingest.recognition_run r
        where r.cache_key = any($1::text[])
        order by array_position($1::text[], r.cache_key), r.updated_at desc
      `,
      [cacheKeys],
    );
    const candidates = result.rows
      .map((row) => {
        if (!row?.recognition_json) return null;
        const cacheKey = row.recognition_json.cacheKey ?? row.cache_key ?? null;
        return cacheKey ? { ...row.recognition_json, cacheKey } : row.recognition_json;
      })
      .filter(Boolean);
    return options.returnCandidates ? candidates : (candidates[0] ?? null);
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
    completeness,
    reconciliation,
    aiAttemptKind,
    aiIdempotencyKey,
    aiUsage,
    provider,
    fallbackModel,
    normalizedRecognition,
    ...payload
  } = recognition;
  return payload;
}
