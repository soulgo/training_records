import { runGenerateTrainingDataUseCase } from '../app/use-cases/generate-training-data.use-case.mjs';

// Job layer orchestration for training data generation.
// Keep CLI and workflow wrappers thin by delegating into this module.

export async function runGenerateTrainingDataJob(options = {}) {
  return runGenerateTrainingDataUseCase(options);
}
