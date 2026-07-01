import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateTrainingAnalysisReply } from './training-analysis.impl.mjs';

export async function runTrainingAnalysisUseCase(options = {}) {
  return generateTrainingAnalysisReply(options);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  const reply = await runTrainingAnalysisUseCase();
  process.stdout.write(`${reply}\n`);
}
