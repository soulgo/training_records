import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateTrainingData } from '../../../tools/generate-training-data.mjs';

export async function runGenerateTrainingDataUseCase(options = {}) {
  return generateTrainingData(options);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await runGenerateTrainingDataUseCase();
}
