import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchSiteDeploy } from '../tools/dispatch-site-deploy.mjs';

test('dispatchSiteDeploy sends one workflow dispatch without polling for a run', async () => {
  const requests = [];
  const result = await dispatchSiteDeploy({
    repository: 'soulgo/training_records',
    token: 'token',
    workflowFile: 'deploy-cloudflare-pages-dev.yml',
    ref: 'dev',
    queueTaskId: 'queue-123',
    sourceChannel: 'telegram',
    syncDispatchPayload: JSON.stringify({
      action: 'telegram_update_dev',
      notification: {
        channel: 'telegram',
        chatId: 42,
        replyToMessageId: 701,
      },
      client_payload: { telegram_updates: [{ update_id: 1, message: { text: 'private' } }] },
    }),
    thoughtCheck: {
      id: '590',
      module: 'body_feedback',
      path: '/body-feedback/',
      expectation: 'present',
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://api.github.com/repos/soulgo/training_records/actions/workflows/deploy-cloudflare-pages-dev.yml/dispatches',
  );
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    ref: 'dev',
    inputs: {
      strict_database_snapshot: 'true',
      sync_db_mode: 'never',
      run_tests: 'false',
      queue_task_id: 'queue-123',
      source_channel: 'telegram',
      notification_chat_id: '42',
      notification_message_id: '701',
      target_thought_id: '590',
      target_thought_module: 'body_feedback',
      target_thought_path: '/body-feedback/',
      target_thought_expectation: 'present',
    },
  });
  assert.deepEqual(result, {
    dispatched: true,
    workflowFile: 'deploy-cloudflare-pages-dev.yml',
    ref: 'dev',
  });
});

test('dispatchSiteDeploy rejects missing required dispatch configuration', async () => {
  await assert.rejects(
    dispatchSiteDeploy({ repository: '', token: '', workflowFile: '', ref: '' }),
    /repository, token, workflowFile, and ref are required/,
  );
});

test('dispatchSiteDeploy surfaces GitHub dispatch failures without exposing the token', async () => {
  await assert.rejects(
    dispatchSiteDeploy({
      repository: 'soulgo/training_records',
      token: 'secret-token',
      workflowFile: 'deploy-pages.yml',
      ref: 'main',
      fetchImpl: async () => new Response('forbidden', { status: 403 }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});
