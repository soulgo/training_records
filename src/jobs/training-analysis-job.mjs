import { runTrainingAnalysisUseCase } from '../app/use-cases/training-analysis.use-case.mjs';

// Job layer orchestration for training analysis.
// This stays intentionally thin and only coordinates the existing adapter-facing flow.

export async function runTrainingAnalysisJob(options = {}) {
  return runTrainingAnalysisUseCase(options);
}
