import {
  AiProviderError,
  AiSchemaError,
  extractAiResponseContent,
  normalizeAiUsage,
} from '../../core/ai/schema-validator.mjs';
import { isAiSchedulerEnabled } from '../../adapters/ai/ai-provider.factory.mjs';
import {
  buildSafeAiContentSummary,
  logRecognitionParseFailure,
  parseAiResponsePayload,
  parseRecognitionContent,
  summarizeRecognitionFailure,
} from './image-recognition-parse.mjs';
import {
  buildRecognitionMessages,
  buildStrictJsonRetryMessages,
  buildStrictRecognitionResponseFormat,
  parsePositiveInteger,
  shouldRetryWithJsonObjectFormat,
  shouldRetryWithoutResponseFormat,
  throwRecognitionHttpError,
} from './image-recognition-schema.mjs';

const RECOGNITION_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RECOGNITION_FALLBACK_STATUSES = new Set([404, ...RECOGNITION_RETRYABLE_STATUSES]);

export async function requestRecognitionWithProviderFallback(input) {
  const { aiProvider } = input;
  try {
    const result = await requestRecognition(input);
    return {
      value: result.value,
      aiUsage: result.aiUsage,
      aiProvider,
      attemptKind: result.attemptKind,
      idempotencyKey: input.idempotencyKey,
    };
  } catch (error) {
    const fallbackProvider = aiProvider?.fallbackProvider;
    if (!fallbackProvider || !shouldRetryWithFallbackProvider(error)) {
      attachRecognitionAiAudit(error, {
        aiProvider,
        attemptKind: 'primary',
        idempotencyKey: input.idempotencyKey,
        promptVersion: input.promptVersion,
      });
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[telegram-sync] primary AI recognition failed: ${message}; retrying with fallback provider\n`,
    );
    try {
      const result = await requestRecognition({
        ...input,
        aiProvider: fallbackProvider,
      });
      return {
        value: result.value,
        aiUsage: result.aiUsage,
        aiProvider: fallbackProvider,
        attemptKind: 'fallback',
        idempotencyKey: input.idempotencyKey,
      };
    } catch (fallbackError) {
      attachRecognitionAiAudit(fallbackError, {
        aiProvider: fallbackProvider,
        attemptKind: 'fallback',
        idempotencyKey: input.idempotencyKey,
        promptVersion: input.promptVersion,
      });
      throw fallbackError;
    }
  }
}

export async function requestRecognitionWithProvider(input) {
  const result = await requestRecognition(input);
  return {
    value: result.value,
    aiUsage: result.aiUsage,
    aiProvider: input.aiProvider,
    attemptKind: result.attemptKind,
    idempotencyKey: input.idempotencyKey,
  };
}

function attachRecognitionAiAudit(error, { aiProvider, attemptKind, idempotencyKey, promptVersion }) {
  if (!error || typeof error !== 'object') {
    return;
  }
  error.aiAudit = {
    provider: aiProvider?.name ?? 'openai-compatible',
    model: aiProvider?.env?.model ?? null,
    promptVersion: promptVersion ?? null,
    aiAttemptKind: attemptKind,
    aiIdempotencyKey: idempotencyKey ?? null,
  };
}

function shouldRetryWithFallbackProvider(error) {
  if (error instanceof AiProviderError || error instanceof AiSchemaError) {
    return true;
  }
  if (error?.status && RECOGNITION_FALLBACK_STATUSES.has(Number(error.status))) {
    return true;
  }
  const name = String(error?.name ?? '');
  if (name === 'AbortError' || name === 'TimeoutError' || error instanceof SyntaxError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/timeout|timed out|empty content|rate limit|HTTP\s*(?:404|429|5\d\d)|network|fetch failed/i.test(message)) {
    return true;
  }
  return Boolean(error?.cause && shouldRetryWithFallbackProvider(error.cause));
}

async function requestRecognition({
  aiProvider,
  imageUrl,
  ocrDocument,
  message,
  systemPrompt,
  promptVersion,
  schemaName,
  schemaVersion,
  env = process.env,
  idempotencyKey,
  onAiCallLog,
}) {
  await emitStartedRecognitionAiCallLog({
    onAiCallLog,
    aiProvider,
    message,
    promptVersion,
    idempotencyKey,
  });
  const requestInput = {
    messages: buildRecognitionMessages({ imageUrl, message, systemPrompt, ocrDocument }),
    idempotencyKey,
    maxAttempts: isAiSchedulerEnabled(env)
      ? parsePositiveInteger(env.AI_RECOGNITION_MAX_ATTEMPTS)
      : undefined,
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
    return {
      value: parseRecognitionContent(content, {
        schemaName,
        schemaVersion,
      }),
      aiUsage: normalizeAiUsage(payload?.usage),
      attemptKind: 'normal',
    };
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
        return {
          value: retryResult.value,
          aiUsage: retryResult.aiUsage,
          attemptKind: 'strict_json_retry',
        };
      }
      if (!error.summary) {
        error.summary = buildSafeAiContentSummary({
          content,
          contentType: payload?.__aiResponseContentType,
          parseStage: 'message_content_json',
        });
      } else if (!error.summary.contentType && payload?.__aiResponseContentType) {
        error.summary = {
          ...error.summary,
          contentType: String(payload.__aiResponseContentType).split(';', 1)[0].trim() || null,
          parseStage: 'message_content_json',
        };
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
      aiUsage: normalizeAiUsage(payload?.usage),
    };
  } catch {
    return { ok: false };
  }
}

async function requestRecognitionWithFormatFallback({
  aiProvider,
  requestInput,
  schemaName,
}) {
  const capabilities = aiProvider?.capabilities ?? {};
  if (capabilities.vision === false) {
    throw new AiProviderError('AI provider does not support vision input');
  }

  if (capabilities.jsonSchema !== false) {
    const strictResponse = await aiProvider.requestChatCompletion({
      ...requestInput,
      responseFormat: buildStrictRecognitionResponseFormat(schemaName),
    });
    if (strictResponse.ok) return strictResponse;
    const strictDetails = await summarizeRecognitionFailure(strictResponse);
    if (capabilities.jsonObject === false || !shouldRetryWithJsonObjectFormat(strictResponse.status, strictDetails)) {
      throwRecognitionHttpError(strictResponse.status, strictDetails);
    }
  }

  if (capabilities.jsonObject !== false) {
    const jsonObjectResponse = await aiProvider.requestChatCompletion({
      ...requestInput,
      responseFormat: { type: 'json_object' },
    });
    if (jsonObjectResponse.ok) return jsonObjectResponse;
    const jsonObjectDetails = await summarizeRecognitionFailure(jsonObjectResponse);
    if (capabilities.textJson === false || !shouldRetryWithoutResponseFormat(jsonObjectResponse.status, jsonObjectDetails)) {
      throwRecognitionHttpError(jsonObjectResponse.status, jsonObjectDetails);
    }
  }

  if (capabilities.textJson === false) {
    throw new AiProviderError('AI provider does not support a JSON response mode');
  }
  return aiProvider.requestChatCompletion(requestInput);
}

async function emitStartedRecognitionAiCallLog({
  onAiCallLog,
  aiProvider,
  message,
  promptVersion,
  idempotencyKey,
}) {
  if (typeof onAiCallLog !== 'function') {
    return;
  }

  const model = aiProvider?.env?.model ?? null;
  if (!model) {
    return;
  }

  const event = {
    scene: 'recognition',
    provider: aiProvider?.name ?? 'openai-compatible',
    model,
    promptVersion: promptVersion ?? null,
    idempotencyKey: idempotencyKey ?? null,
    status: 'started',
    sourceChannel: message?.sourceChannel ?? 'telegram',
    sourceChatId: message?.sourceChatId ?? message?.chatId ?? null,
    sourceMessageId: message?.sourceMessageId ?? message?.messageId ?? null,
    messageId: message?.messageId ?? null,
  };

  try {
    await onAiCallLog(event);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[telegram-sync] failed to write started recognition AI call log for ${event.sourceMessageId ?? event.messageId ?? 'unknown'}: ${messageText}\n`,
    );
  }
}
