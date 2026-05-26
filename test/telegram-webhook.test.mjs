import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTelegramWebhookConfig, setTelegramWebhook } from '../tools/telegram-webhook.mjs';

test('buildTelegramWebhookConfig trims required env values and keeps safe defaults', () => {
  const config = buildTelegramWebhookConfig({
    TELEGRAM_BOT_TOKEN: ' 123:abc ',
    TELEGRAM_WEBHOOK_URL: ' https://example.com/tg ',
    TELEGRAM_SECRET_TOKEN: ' secret ',
  });

  assert.deepEqual(config, {
    botToken: '123:abc',
    webhookUrl: 'https://example.com/tg',
    secretToken: 'secret',
    allowedUpdates: ['message', 'edited_message'],
    dropPendingUpdates: false,
  });
});

test('buildTelegramWebhookConfig rejects missing required env values', () => {
  assert.throws(
    () =>
      buildTelegramWebhookConfig({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_WEBHOOK_URL: '',
        TELEGRAM_SECRET_TOKEN: 'secret',
      }),
    /Missing required environment variable: TELEGRAM_WEBHOOK_URL/,
  );
});

test('setTelegramWebhook posts expected payload without exposing token in result', async () => {
  const requests = [];
  const result = await setTelegramWebhook(
    {
      botToken: '123:secret-token',
      webhookUrl: 'https://worker.example.com/',
      secretToken: 'secret-header',
      allowedUpdates: ['message', 'edited_message'],
      dropPendingUpdates: false,
    },
    {
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(200, {
          ok: true,
          result: true,
          description: 'Webhook was set',
        });
      },
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.telegram.org/bot123%3Asecret-token/setWebhook');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    url: 'https://worker.example.com/',
    secret_token: 'secret-header',
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: false,
  });
  assert.deepEqual(result, {
    ok: true,
    description: 'Webhook was set',
    result: true,
  });
});

test('setTelegramWebhook throws with Telegram description when API rejects request', async () => {
  await assert.rejects(
    () =>
      setTelegramWebhook(
        {
          botToken: '123:secret-token',
          webhookUrl: 'https://worker.example.com/',
          secretToken: 'secret-header',
          allowedUpdates: ['message', 'edited_message'],
          dropPendingUpdates: false,
        },
        {
          fetch: async () =>
            jsonResponse(401, {
              ok: false,
              description: 'Unauthorized',
            }),
        },
      ),
    /Telegram setWebhook failed \(HTTP 401\): Unauthorized/,
  );
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
