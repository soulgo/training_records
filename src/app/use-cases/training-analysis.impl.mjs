import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import {
  buildTrainingSnapshot as buildTrainingSnapshotFromSource,
  isIncompleteDatabaseSnapshotError,
  isUnavailableDatabaseSnapshotError,
} from '../../domain/training/training-snapshot.mjs';
import { buildTrainingAnalysisPrompt } from '../../core/ai/training-prompt.mjs';
import { createAiProvider, isAiSchedulerEnabled } from '../../adapters/ai/ai-provider.factory.mjs';
import { normalizeAiUsage } from '../../core/ai/schema-validator.mjs';
import { resolveTrainingCoreConfig } from '../../adapters/postgres/training-config.pg.mjs';
import { loadTrainingAnalysisContext as loadTrainingAnalysisContextFromDatabase } from '../../adapters/postgres/training-analysis-repository.pg.mjs';
import { getAnalysisPromptMetadata } from '../../core/ai/prompt-generator.mjs';
import {
  inferTrainingAnalysisFocus,
  normalizeAnalysisQuestion,
  normalizeTrainingGoal,
} from './training-analysis-focus.mjs';
import { buildTrainingAnalysisSummary } from './training-analysis-summary.mjs';
import {
  normalizeTelegramReply,
  requestTrainingAnalysisResult,
  splitTelegramMessage,
} from './training-analysis-request.mjs';

export {
  buildTrainingAnalysisSummary,
  inferTrainingAnalysisFocus,
  normalizeAnalysisQuestion,
  normalizeTrainingGoal,
  splitTelegramMessage,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..', '..');
const { Client } = pg;
const strictDatabaseSnapshotReply = '数据源异常，稍后重试。';

export async function generateTrainingAnalysisReply(options = {}) {
  const result = await generateTrainingAnalysisResult(options);
  return result.reply;
}

export async function generateTrainingAnalysisResult(options = {}) {
  const rawEnv = options.env ?? process.env;
  const question = normalizeAnalysisQuestion(options.question);
  const trainingGoal = normalizeTrainingGoal(options.trainingGoal ?? rawEnv.TRAINING_ANALYSIS_GOAL);
  let snapshot;

  try {
    snapshot = options.snapshot ?? (await loadSnapshotForAnalysis(options));
  } catch (error) {
    if (isStrictDatabaseSnapshotError(error, rawEnv)) {
      return {
        status: 'snapshot_error',
        snapshotSource: 'strict_db_error',
        reply: strictDatabaseSnapshotReply,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }

  const schedulerEnabled = isAiSchedulerEnabled(rawEnv);
  const aiProvider = options.aiProvider ?? createAiProvider(buildAnalysisAiProviderEnv(rawEnv));
  const fallbackAiProvider =
    options.fallbackAiProvider ?? (schedulerEnabled ? createAnalysisFallbackAiProvider(rawEnv) : null);
  const prompt = await buildTrainingAnalysisPrompt({
    env: options.env ?? process.env,
    trainingGoal,
  });
  const promptVersion = await resolveAnalysisPromptVersion();
  const summary = buildTrainingAnalysisSummary(snapshot, options.now ?? new Date());
  const focus = inferTrainingAnalysisFocus(question);
  const analysisResponse = await requestTrainingAnalysisWithFallback({
    aiProvider,
    fallbackAiProvider,
    prompt,
    question,
    focus,
    summary,
    fetchImpl: options.fetchImpl ?? fetch,
    maxAttempts:
      options.maxAttempts ??
      (schedulerEnabled ? parsePositiveInteger(rawEnv.AI_ANALYSIS_MAX_ATTEMPTS) : undefined),
    baseDelayMs: options.baseDelayMs,
    onAiCallStarted: (event) =>
      writeAnalysisAiCallLogBestEffort({
        env: rawEnv,
        createClient: options.createClient,
        taskId: options.taskId,
        aiProvider: event.aiProvider,
        model: event.model,
        attemptKind: event.attemptKind,
        promptVersion,
        status: 'started',
        occurredAt: options.now ?? new Date(),
      }),
  });

  const reply = normalizeTelegramReply(analysisResponse.content);
  if (!reply) {
    throw new Error('Training analysis returned empty content');
  }
  const result = {
    status: 'ok',
    snapshotSource: summary.dataSource,
    reply,
    aiAttemptKind: analysisResponse.attemptKind,
    model: analysisResponse.model,
  };

  await writeAnalysisAiCallLogBestEffort({
    env: rawEnv,
    createClient: options.createClient,
    taskId: options.taskId,
    aiProvider: analysisResponse.aiProvider,
    model: analysisResponse.model,
    attemptKind: analysisResponse.attemptKind,
    promptVersion,
    latencyMs: analysisResponse.latencyMs,
    status: 'succeeded',
    occurredAt: options.now ?? new Date(),
    usage: analysisResponse.usage,
  });

  return result;
}

async function requestTrainingAnalysisWithFallback({
  aiProvider,
  fallbackAiProvider,
  prompt,
  question,
  focus,
  summary,
  fetchImpl,
  maxAttempts,
  baseDelayMs,
  onAiCallStarted,
}) {
  try {
    await emitAnalysisAiCallStarted({
      onAiCallStarted,
      aiProvider,
      attemptKind: 'primary',
    });
    const startedAt = nowMs();
    const response = await requestTrainingAnalysisResult({
      aiProvider,
      prompt,
      question,
      focus,
      summary,
      fetchImpl,
      maxAttempts,
      baseDelayMs,
    });
    return {
      ...response,
      attemptKind: 'primary',
      model: aiProvider?.env?.model ?? null,
      aiProvider,
      latencyMs: elapsedMs(startedAt),
    };
  } catch (error) {
    if (!fallbackAiProvider || !shouldFallbackAnalysis(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[training-analysis] primary AI failed: ${message}; retrying with fallback provider\n`,
    );
    await emitAnalysisAiCallStarted({
      onAiCallStarted,
      aiProvider: fallbackAiProvider,
      attemptKind: 'fallback',
    });
    const startedAt = nowMs();
    const response = await requestTrainingAnalysisResult({
      aiProvider: fallbackAiProvider,
      prompt,
      question,
      focus,
      summary,
      fetchImpl,
      maxAttempts,
      baseDelayMs,
    });
    return {
      ...response,
      attemptKind: 'fallback',
      model: fallbackAiProvider?.env?.model ?? null,
      aiProvider: fallbackAiProvider,
      latencyMs: elapsedMs(startedAt),
    };
  }
}

async function writeAnalysisAiCallLogBestEffort({
  env,
  createClient,
  taskId,
  aiProvider,
  model,
  attemptKind,
  promptVersion,
  latencyMs,
  status = 'succeeded',
  occurredAt,
  usage,
}) {
  let client = null;
  try {
    const config = resolveTrainingCoreConfig(env);
    if (!config.enabled || !config.url || !model) {
      return;
    }

    const makeClient =
      createClient ??
      ((dbConfig) =>
        new Client({
          connectionString: dbConfig.url,
          connectionTimeoutMillis: dbConfig.timeoutMs,
          application_name: dbConfig.appName,
        }));
    client = makeClient(config);
    await client.connect();
    const occurredAtIso = occurredAt.toISOString();
    const log = buildAnalysisAiCallLog({
      taskId,
      provider: aiProvider?.name ?? 'openai-compatible',
      model,
      promptVersion,
      attemptKind,
      latencyMs,
      status,
      occurredAt: occurredAtIso,
      usage,
    });
    await client.query(
      `
        insert into ingest.ai_call_log (
          ai_call_id,
          task_id,
          scene,
          provider,
          model,
          prompt_version,
          idempotency_key,
          status,
          latency_ms,
          failure_category,
          failure_reason,
          created_at,
          updated_at,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          cost_usd
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        on conflict (ai_call_id) do update set
          task_id = excluded.task_id,
          scene = excluded.scene,
          provider = excluded.provider,
          model = excluded.model,
          prompt_version = excluded.prompt_version,
          idempotency_key = excluded.idempotency_key,
          status = excluded.status,
          latency_ms = excluded.latency_ms,
          failure_category = excluded.failure_category,
          failure_reason = excluded.failure_reason,
          prompt_tokens = excluded.prompt_tokens,
          completion_tokens = excluded.completion_tokens,
          total_tokens = excluded.total_tokens,
          cost_usd = excluded.cost_usd,
          updated_at = excluded.updated_at
      `,
      [
        log.aiCallId,
        log.taskId,
        log.scene,
        log.provider,
        log.model,
        log.promptVersion,
        log.idempotencyKey,
        log.status,
        log.latencyMs,
        log.failureCategory,
        log.failureReason,
        log.createdAt,
        log.updatedAt,
        log.promptTokens,
        log.completionTokens,
        log.totalTokens,
        log.costUsd,
      ],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[training-analysis] failed to write analysis AI call log for ${taskId ?? 'unknown-task'}: ${message}\n`,
    );
  } finally {
    try {
      await client?.end();
    } catch {}
  }
}

async function resolveAnalysisPromptVersion() {
  try {
    return (await getAnalysisPromptMetadata()).version ?? null;
  } catch {
    return null;
  }
}

async function emitAnalysisAiCallStarted({ onAiCallStarted, aiProvider, attemptKind }) {
  if (typeof onAiCallStarted !== 'function') {
    return;
  }
  await onAiCallStarted({
    aiProvider,
    attemptKind,
    model: aiProvider?.env?.model ?? null,
  });
}

function buildAnalysisAiCallLog({ taskId, provider, model, promptVersion, attemptKind, latencyMs, status, occurredAt, usage }) {
  const normalizedTaskId = normalizeText(taskId);
  const normalizedModel = normalizeText(model);
  const normalizedUsage = normalizeAiUsage(usage);
  return {
    aiCallId: buildAiCallId({
      scene: 'analysis',
      taskId: normalizedTaskId,
      model: normalizedModel,
      attemptKind,
    }),
    taskId: normalizedTaskId,
    scene: 'analysis',
    provider: normalizeText(provider) ?? 'openai-compatible',
    model: normalizedModel,
    promptVersion: normalizeText(promptVersion),
    idempotencyKey: null,
    status: normalizeText(status) ?? 'succeeded',
    latencyMs: normalizeInteger(latencyMs),
    failureCategory: null,
    failureReason: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    promptTokens: normalizedUsage.promptTokens,
    completionTokens: normalizedUsage.completionTokens,
    totalTokens: normalizedUsage.totalTokens,
    costUsd: normalizedUsage.costUsd,
  };
}

function buildAiCallId(parts) {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `ai-call:${parts.scene}:${digest}`;
}

function nowMs() {
  return Number(globalThis.performance?.now?.() ?? Date.now());
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return Math.round(number);
}

async function loadSnapshotForAnalysis(options) {
  const snapshotOptions = {
    rootDir: options.rootDir ?? rootDir,
    env: options.env ?? process.env,
    now: options.now,
  };
  const databaseMode = String(snapshotOptions.env?.TRAINING_SNAPSHOT_SOURCE ?? '').trim().toLowerCase() === 'database';

  if (databaseMode && (options.loadTrainingAnalysisContext || !options.buildTrainingSnapshot)) {
    const loadTrainingAnalysisContext =
      options.loadTrainingAnalysisContext ?? loadTrainingAnalysisContextFromDatabase;
    return loadTrainingAnalysisContext({
      env: snapshotOptions.env,
      asOf: snapshotOptions.now ?? new Date(),
      createClient: options.createClient,
    });
  }

  const buildTrainingSnapshot = options.buildTrainingSnapshot ?? buildTrainingSnapshotFromSource;

  try {
    const snapshot = await buildTrainingSnapshot(snapshotOptions);
    return {
      ...snapshot,
      source: String(snapshotOptions.env?.TRAINING_SNAPSHOT_SOURCE ?? '').trim().toLowerCase() === 'database'
        ? 'database'
        : 'markdown',
    };
  } catch (error) {
    if (!canFallbackToMarkdownSnapshot(error, snapshotOptions.env)) {
      throw error;
    }
    const snapshot = await buildTrainingSnapshot({
      ...snapshotOptions,
      source: 'markdown',
    });
    return {
      ...snapshot,
      source: 'fallback_markdown',
    };
  }
}

export async function loadTrainingAnalysisPrompt(env = process.env) {
  return buildTrainingAnalysisPrompt({ env });
}

function canFallbackToMarkdownSnapshot(error, env) {
  if (
    !isIncompleteDatabaseSnapshotError(error) &&
    !isUnavailableDatabaseSnapshotError(error)
  ) {
    return false;
  }

  return (
    String(env?.TRAINING_SNAPSHOT_SOURCE ?? '').trim().toLowerCase() === 'database' &&
    resolveAnalysisSnapshotPolicy(env) !== 'strict_db'
  );
}

function isStrictDatabaseSnapshotError(error, env) {
  if (resolveAnalysisSnapshotPolicy(env) !== 'strict_db') {
    return false;
  }
  return isIncompleteDatabaseSnapshotError(error) || isUnavailableDatabaseSnapshotError(error);
}

function resolveAnalysisSnapshotPolicy(env) {
  const normalized = String(env?.TRAINING_ANALYSIS_SNAPSHOT_POLICY ?? '').trim().toLowerCase();
  return normalized === 'strict_db' ? 'strict_db' : 'allow_markdown_fallback';
}

function buildAnalysisAiProviderEnv(env) {
  if (!isAiSchedulerEnabled(env)) {
    return env;
  }
  const analysisModel = String(env?.AI_ANALYSIS_MODEL ?? '').trim();
  const analysisTimeoutMs = String(env?.AI_ANALYSIS_TIMEOUT_MS ?? '').trim();
  return {
    ...env,
    ...(analysisModel ? { AI_MODEL: analysisModel } : {}),
    ...(analysisTimeoutMs ? { AI_TIMEOUT_MS: analysisTimeoutMs } : {}),
  };
}

function createAnalysisFallbackAiProvider(env) {
  const apiKey = String(env?.AI_ANALYSIS_FALLBACK_API_KEY ?? '').trim();
  const baseUrl = String(env?.AI_ANALYSIS_FALLBACK_BASE_URL ?? '').trim();
  const model = String(env?.AI_ANALYSIS_FALLBACK_MODEL ?? '').trim();
  if (!apiKey && !baseUrl && !model) {
    return null;
  }
  if (!apiKey || !baseUrl || !model) {
    process.stderr.write('[training-analysis] fallback AI provider is not configured completely; ignoring fallback provider\n');
    return null;
  }
  return createAiProvider({
    ...env,
    AI_API_KEY: apiKey,
    AI_BASE_URL: baseUrl,
    AI_MODEL: model,
    AI_TIMEOUT_MS: env?.AI_ANALYSIS_FALLBACK_TIMEOUT_MS ?? env?.AI_ANALYSIS_TIMEOUT_MS ?? env?.AI_TIMEOUT_MS,
  });
}

function shouldFallbackAnalysis(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /timeout|timed out|HTTP\s*(?:429|5\d\d)|network|fetch failed|socket|empty content|Training analysis request failed/i.test(message);
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}
