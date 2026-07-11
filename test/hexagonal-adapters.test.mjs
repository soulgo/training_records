import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTelegramWebhookConfig,
  fetchTelegramUpdates,
  sendTelegramMessage,
  setTelegramWebhook,
} from '../src/adapters/telegram/index.mjs';

test('telegram transport adapter exposes polling and webhook functions from src', async () => {
  const updates = await fetchTelegramUpdates({
    botToken: 'token',
    offset: 10,
    limit: 1,
    fetch: async (url) => {
      assert.match(url, /getUpdates/);
      assert.match(url, /offset=10/);
      return jsonResponse(200, { ok: true, result: [{ update_id: 10 }] });
    },
  });
  assert.deepEqual(updates, [{ update_id: 10 }]);

  const sent = await sendTelegramMessage({
    botToken: 'token',
    chatId: 1,
    text: 'hello',
    fetch: async (url, init) => {
      assert.match(url, /sendMessage/);
      assert.equal(JSON.parse(init.body).text, 'hello');
      return jsonResponse(200, { ok: true, result: { message_id: 1 } });
    },
  });
  assert.equal(sent.message_id, 1);

  const config = buildTelegramWebhookConfig({
    TELEGRAM_BOT_TOKEN: ' token ',
    TELEGRAM_WEBHOOK_URL: ' https://example.com/hook ',
    TELEGRAM_SECRET_TOKEN: ' secret ',
  });
  const result = await setTelegramWebhook(config, {
    fetch: async () => jsonResponse(200, { ok: true, result: true }),
  });
  assert.equal(result.ok, true);
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
