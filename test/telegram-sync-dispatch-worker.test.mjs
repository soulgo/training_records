import test from 'node:test';
import assert from 'node:assert/strict';

import { handleTelegramWebhook } from '../cloudflare/telegram-sync-dispatch-worker.mjs';

function createEnv() {
  return {
    GITHUB_OWNER: 'soulgo',
    GITHUB_REPO: 'training_records',
    GITHUB_TOKEN: 'github-token',
    TELEGRAM_SECRET_TOKEN: 'secret-token',
  };
}

test('handleTelegramWebhook dispatches telegram updates to GitHub', async () => {
  const calls = [];
  const request = new Request('https://worker.example.com', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'secret-token',
    },
    body: JSON.stringify({
      update_id: 123,
      message: {
        message_id: 1,
      },
    }),
  });

  const response = await handleTelegramWebhook(request, createEnv(), {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/soulgo/training_records/dispatches');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    event_type: 'telegram_update',
    client_payload: {
      telegram_update: {
        update_id: 123,
        message: {
          message_id: 1,
        },
      },
    },
  });
});

test('handleTelegramWebhook rejects requests with the wrong Telegram secret', async () => {
  const request = new Request('https://worker.example.com', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
    },
    body: JSON.stringify({ update_id: 123 }),
  });

  const response = await handleTelegramWebhook(request, createEnv(), {
    fetchImpl: async () => {
      throw new Error('GitHub dispatch should not run when the secret is invalid');
    },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'unauthorized',
  });
});
