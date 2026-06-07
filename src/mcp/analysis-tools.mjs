import {
  buildTrainingAnalysisSummary,
  generateTrainingAnalysisReply,
  inferTrainingAnalysisFocus,
  normalizeAnalysisQuestion,
  normalizeTrainingGoal,
} from '../../tools/training-analysis.mjs';
import { loadSnapshot } from './tool-support.mjs';

export async function getAnalysisSummaryTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const summary = buildTrainingAnalysisSummary(snapshot, context.options.now ?? new Date());
  return {
    data: { summary },
    source: snapshot.source,
    generatedAt: summary.generatedAt,
  };
}

export async function generateAnalysisTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const question = normalizeAnalysisQuestion(args.question);
  const trainingGoal = normalizeTrainingGoal(args.goal ?? context.env.TRAINING_ANALYSIS_GOAL);
  const focus = inferTrainingAnalysisFocus(question);
  const summary = buildTrainingAnalysisSummary(snapshot, context.options.now ?? new Date());
  const reply = await generateTrainingAnalysisReply({
    env: context.env,
    rootDir: context.rootDir,
    question,
    trainingGoal,
    snapshot,
    now: context.options.now,
    fetchImpl: context.options.fetchImpl,
    aiProvider: context.options.aiProvider,
    maxAttempts: context.options.maxAttempts,
    baseDelayMs: context.options.baseDelayMs,
  });

  return {
    data: {
      reply,
      summary,
      focus,
      dataSource: summary.dataSource,
    },
    source: snapshot.source,
    generatedAt: summary.generatedAt,
  };
}
