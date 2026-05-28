import { generateTrainingData } from '../../tools/generate-training-data.mjs';

// Job layer orchestration for training data generation.
// Keep CLI and workflow wrappers thin by delegating into this module.

export async function runGenerateTrainingDataJob(options = {}) {
  return generateTrainingData(options);
}
