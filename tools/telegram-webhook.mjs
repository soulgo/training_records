import { fileURLToPath } from 'node:url';

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_URL', 'TELEGRAM_SECRET_TOKEN'];
const DEFAULT_ALLOWED_UPDATES = ['message', 'edited_message'];

export function buildTelegramWebhookConfig(env = process.env) {
  const values = {};
  for (const name of REQUIRED_ENV) {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    values[name] = value;
  }

  return {
    botToken: values.TELEGRAM_BOT_TOKEN,
    webhookUrl: values.TELEGRAM_WEBHOOK_URL,
    secretToken: values.TELEGRAM_SECRET_TOKEN,
    allowedUpdates: parseAllowedUpdates(env.TELEGRAM_WEBHOOK_ALLOWED_UPDATES),
    dropPendingUpdates: parseBoolean(env.TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES, false),
  };
}

export async function setTelegramWebhook(config, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation available');
  }

  const response = await fetchImpl(
    `https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/setWebhook`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: config.webhookUrl,
        secret_token: config.secretToken,
        allowed_updates: config.allowedUpdates,
        drop_pending_updates: config.dropPendingUpdates,
      }),
    },
  );

  const body = await readTelegramJson(response);
  if (!response.ok || body?.ok !== true) {
    const description = body?.description || response.statusText || 'unknown error';
    throw new Error(`Telegram setWebhook failed (HTTP ${response.status}): ${description}`);
  }

  return {
    ok: body.ok,
    description: body.description,
    result: body.result,
  };
}

function parseAllowedUpdates(value) {
  if (!value?.trim()) {
    return DEFAULT_ALLOWED_UPDATES;
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, defaultValue) {
  if (value == null || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

async function readTelegramJson(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Telegram setWebhook returned invalid JSON (HTTP ${response.status})`);
  }
}

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
