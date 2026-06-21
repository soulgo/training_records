import path from 'node:path';
import { fileURLToPath } from 'node:url';

export {
  buildTelegramSyncReport,
  createRecognitionAiProvider,
  loadRecognitionSystemPrompt,
  main,
  notifyTelegramSyncResultFromFile,
  notifyTelegramSyncResultFromReport,
  runMessageSync,
  runTelegramSync,
  shouldPersistTelegramArtifacts,
} from '../src/app/use-cases/telegram-sync.use-case.mjs';

import {
  buildTelegramSyncReport,
  runTelegramSync,
} from '../src/app/use-cases/telegram-sync.use-case.mjs';

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  const result = await runTelegramSync();
  process.stdout.write(JSON.stringify(buildTelegramSyncReport(result), null, 2));
  process.stdout.write('\n');
}
