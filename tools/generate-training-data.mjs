import path from 'node:path';
import { fileURLToPath } from 'node:url';

export * from '../src/app/use-cases/generate-training-data.impl.mjs';

import { generateTrainingData } from '../src/app/use-cases/generate-training-data.impl.mjs';

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await generateTrainingData();
}
