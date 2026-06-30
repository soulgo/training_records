import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTraceContext,
  deriveTraceId,
  formatActionLogEvent,
  hashSensitive,
  redactSensitive,
} from '../tools/lib/action-logger.mjs';

test('deriveTraceId produces a stable non-sensitive id from queue task id', () => {
  const queueTaskId = 'telegram:520905856:telegram_update:8dbfe3e65db19d85';

  assert.equal(deriveTraceId(queueTaskId), deriveTraceId(queueTaskId));
  assert.match(deriveTraceId(queueTaskId), /^tr_[a-f0-9]{16}$/);
  assert.doesNotMatch(deriveTraceId(queueTaskId), /520905856|telegram_update/);
});

test('buildTraceContext prefers explicit trace id and keeps queue task id for summaries', () => {
  assert.deepEqual(
    buildTraceContext({
      TRACE_ID: 'tr_existing',
      QUEUE_TASK_ID: 'telegram:1:telegram_update:abc',
      GITHUB_WORKFLOW: 'Sync (Main)',
      GITHUB_RUN_ID: '123',
    }),
    {
      traceId: 'tr_existing',
      queueTaskId: 'telegram:1:telegram_update:abc',
      workflow: 'Sync (Main)',
      runId: '123',
    },
  );
});

test('redactSensitive hashes chat ids Feishu ids COS keys and file ids recursively', () => {
  const redacted = redactSensitive({
    chatId: '6314355239',
    sourceId: 'oc_47126c2d831c7a201c30c801ad77ef71',
    bucket: 'private-training-bucket',
    pathPrefix: 'thoughts/2026/06',
    fileId: 'AgACAgUAAxkBAAIC12pAeCjyxK681vrrxY2XJ70zRqey',
    nested: {
      chatIds: ['oc_47126c2d831c7a201c30c801ad77ef71'],
      imageKey: 'img_v3_abcdef',
    },
  });
  const serialized = JSON.stringify(redacted);

  assert.doesNotMatch(serialized, /6314355239/);
  assert.doesNotMatch(serialized, /oc_47126c2d831c7a201c30c801ad77ef71/);
  assert.doesNotMatch(serialized, /private-training-bucket/);
  assert.doesNotMatch(serialized, /thoughts\/2026\/06/);
  assert.doesNotMatch(serialized, /AgACAgUAAxkBAAIC12pAeCjyxK681vrrxY2XJ70zRqey/);
  assert.match(redacted.chatId, /^sha256:[a-f0-9]{16}$/);
});

test('formatActionLogEvent emits one prefixed compact JSON line with safe fields', () => {
  const line = formatActionLogEvent({
    level: 'info',
    domain: 'database',
    event: 'batch.persist.completed',
    traceId: 'tr_1234567890abcdef',
    durationMs: 12.4,
    chatId: '6314355239',
    sql: 'select * from secret',
    params: ['secret-param'],
  });

  assert.match(line, /^\[action-log\] \{.*\}\n$/);
  assert.doesNotMatch(line, /\n.+\n/);
  assert.doesNotMatch(line, /6314355239|secret-param|select \*/);
  const payload = JSON.parse(line.replace(/^\[action-log\] /, ''));
  assert.equal(payload.level, 'INFO');
  assert.equal(payload.domain, 'DATABASE');
  assert.equal(payload.event, 'batch.persist.completed');
  assert.equal(payload.durationMs, 12);
});

test('hashSensitive returns null for empty values and stable hashes otherwise', () => {
  assert.equal(hashSensitive(''), null);
  assert.equal(hashSensitive(null), null);
  assert.equal(hashSensitive('oc_1'), hashSensitive('oc_1'));
  assert.match(hashSensitive('oc_1'), /^sha256:[a-f0-9]{16}$/);
});
