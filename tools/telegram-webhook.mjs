import { fileURLToPath } from 'node:url';

import { buildTelegramWebhookConfig, setTelegramWebhook } from '../src/adapters/telegram/index.mjs';

export { buildTelegramWebhookConfig, setTelegramWebhook };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = buildTelegramWebhookConfig();
  const result = await setTelegramWebhook(config);
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        description: result.description ?? '',
        result: result.result,
        webhookUrl: config.webhookUrl,
      },
      null,
      2,
    ),
  );
}
