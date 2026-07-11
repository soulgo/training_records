import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendTelegramMessage } from '../src/adapters/telegram/telegram-api.mjs';
import { notifyTelegramSyncResultFromFile } from '../src/app/use-cases/telegram-sync/status.mjs';

export async function main() {
  const result = await notifyTelegramSyncFromEnv({ env: process.env });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function notifyTelegramSyncFromEnv({
  env = process.env,
  sendMessage = sendTelegramMessage,
} = {}) {
  const resultPath = env.TELEGRAM_SYNC_RESULT_PATH?.trim();
  return notifyTelegramSyncResultFromFile({
    resultPath,
    env,
    sendMessage: (message) =>
      sendMessage({
        ...message,
        botToken: env.TELEGRAM_BOT_TOKEN,
      }),
  });
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main();
}
