import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { notifyTelegramSyncResultFromFile } from './telegram-sync.mjs';
import { sendTelegramMessage } from './telegram-transport.mjs';

export async function main() {
  const resultPath = process.env.TELEGRAM_SYNC_RESULT_PATH?.trim();
  const result = await notifyTelegramSyncResultFromFile({
    resultPath,
    env: process.env,
    sendMessage: sendTelegramMessage,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
