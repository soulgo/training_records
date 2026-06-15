import { fileURLToPath } from 'node:url';

import { buildTelegramWebhookConfig, setTelegramWebhook } from '../src/adapters/telegram/index.mjs';

export { buildTelegramWebhookConfig, setTelegramWebhook };

const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 5;
const DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS = 5_000;

export async function setTelegramWebhookWithRetry(config, options = {}) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_WEBHOOK_MAX_ATTEMPTS));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS));
  const stderr = options.stderr ?? process.stderr;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await setTelegramWebhook(config, options);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryableTelegramWebhookError(error)) {
        throw error;
      }
      stderr.write(
        `[telegram-webhook] setWebhook failed: ${formatErrorMessage(error)}; retrying (${attempt}/${maxAttempts})\n`,
      );
      await delay(baseDelayMs * attempt);
    }
  }

  throw lastError ?? new Error('Telegram setWebhook failed');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = buildTelegramWebhookConfig();
  const result = await setTelegramWebhookWithRetry(config);
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

function isRetryableTelegramWebhookError(error) {
  const message = formatErrorMessage(error);
  return /Temporary failure in name resolution|Failed to resolve host|EAI_AGAIN|ETIMEDOUT|ECONNRESET/iu.test(message);
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
