import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTrainingSnapshot as buildTrainingSnapshotFromSource,
  isIncompleteDatabaseSnapshotError,
  isUnavailableDatabaseSnapshotError,
} from './training-snapshot.mjs';
import { buildTrainingAnalysisPrompt } from './training-prompt.mjs';
import { createAiProvider } from '../src/ai/provider.mjs';
import {
  inferTrainingAnalysisFocus,
  normalizeAnalysisQuestion,
  normalizeTrainingGoal,
} from './training-analysis-focus.mjs';
import { buildTrainingAnalysisSummary } from './training-analysis-summary.mjs';
import {
  normalizeTelegramReply,
  requestTrainingAnalysis,
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
const rootDir = path.resolve(__dirname, '..');

export async function generateTrainingAnalysisReply(options = {}) {
  const rawEnv = options.env ?? process.env;
  const question = normalizeAnalysisQuestion(options.question);
  const trainingGoal = normalizeTrainingGoal(options.trainingGoal ?? rawEnv.TRAINING_ANALYSIS_GOAL);
  const aiProvider = options.aiProvider ?? createAiProvider(rawEnv);
  const snapshot =
    options.snapshot ??
    (await loadSnapshotForAnalysis(options));
  const prompt = await buildTrainingAnalysisPrompt({
    env: options.env ?? process.env,
    trainingGoal,
  });
  const summary = buildTrainingAnalysisSummary(snapshot, options.now ?? new Date());
  const focus = inferTrainingAnalysisFocus(question);
  const content = await requestTrainingAnalysis({
    aiProvider,
    prompt,
    question,
    focus,
    summary,
    fetchImpl: options.fetchImpl ?? fetch,
    maxAttempts: options.maxAttempts,
    baseDelayMs: options.baseDelayMs,
  });

  const reply = normalizeTelegramReply(content);
  if (!reply) {
    throw new Error('Training analysis returned empty content');
  }
  return reply;
}

async function loadSnapshotForAnalysis(options) {
  const buildTrainingSnapshot = options.buildTrainingSnapshot ?? buildTrainingSnapshotFromSource;
  const snapshotOptions = {
    rootDir: options.rootDir ?? rootDir,
    env: options.env ?? process.env,
    now: options.now,
  };

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

  return String(env?.TRAINING_SNAPSHOT_SOURCE ?? '').trim().toLowerCase() === 'database';
}
