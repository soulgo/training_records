import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildSafeSyncReport } from './message-sync/status.mjs';
import { runMessageSync } from './message-sync.use-case.mjs';

export async function main() {
  const result = await runTelegramSync();
  process.stdout.write(JSON.stringify(buildSafeSyncReport(result), null, 2));
  process.stdout.write('\n');
}

export async function runTelegramSync(options = {}) {
  return runMessageSync({
    ...options,
    adapter: {
      channel: 'telegram',
      ...(options.adapter ?? {}),
    },
  });
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
