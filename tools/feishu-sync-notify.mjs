import { notifyFeishuSyncResultFromFile } from '../src/app/use-cases/feishu-sync.use-case.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await notifyFeishuSyncFromEnv({ env: process.env });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function notifyFeishuSyncFromEnv({
  env = process.env,
  sendMessage,
} = {}) {
  const resultPath = env.FEISHU_SYNC_RESULT_PATH?.trim() || env.TELEGRAM_SYNC_RESULT_PATH?.trim();
  return notifyFeishuSyncResultFromFile({
    resultPath,
    env,
    sendMessage,
  });
}
