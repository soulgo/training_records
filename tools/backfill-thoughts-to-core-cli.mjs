import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillThoughtsToCore } from './backfill-thoughts-to-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function runBackfillThoughtsToCore(options = {}) {
  return backfillThoughtsToCore({
    rootDir: options.rootDir ?? rootDir,
    thoughtsDir: options.thoughtsDir,
    env: options.env ?? process.env,
    createClient: options.createClient,
    processedAt: options.processedAt,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runBackfillThoughtsToCore();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
