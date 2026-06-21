import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BodyMetricRepositoryPort,
  HealthDailyRepositoryPort,
  SleepRepositoryPort,
  ThoughtRepositoryPort,
  TrainingRepositoryPort,
} from '../src/core/repositories/index.mjs';
import {
  PostgresTelegramBatchRepository,
  PostgresThoughtRepository,
  PostgresTrainingRepository,
} from '../src/adapters/postgres/index.mjs';
import { ensureCoreSchema } from '../src/adapters/postgres/schema-preflight.pg.mjs';

test('repository ports fail explicitly until implemented by adapters', async () => {
  await assert.rejects(new TrainingRepositoryPort().findByDate('2026-05-09'), /findByDate/);
  await assert.rejects(new BodyMetricRepositoryPort().findLatest(), /findLatest/);
  await assert.rejects(new SleepRepositoryPort().findByDate('2026-05-09'), /findByDate/);
  await assert.rejects(new HealthDailyRepositoryPort().save({}), /save/);
  await assert.rejects(new ThoughtRepositoryPort().findByTelegramMessageId(1), /findByTelegramMessageId/);
});

test('PostgresTrainingRepository requires a pg client-like adapter', () => {
  assert.throws(() => new PostgresTrainingRepository(null), /pg client-like/);
});

test('PostgresTrainingRepository.findByDate reads a core day through adapter SQL', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push([sql, params]);
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [{
            archived_date: '2026-06-03',
            total_activities: 1,
            total_duration_seconds: 600,
            training_calories: 120,
            workout_duration_minutes: 10,
            active_hours: 1,
            cycling_distance_km: 0,
            intake_calories: 900,
            sleep_total_minutes: 411,
            night_sleep_minutes: 411,
            nap_minutes: null,
            sleep_start_time: '23:26',
            sleep_end_time: '06:19',
            deep_sleep_minutes: 145,
            light_sleep_minutes: 195,
            rem_sleep_minutes: 71,
            awake_minutes: null,
            nutrition_details_json: ['existing dinner'],
          }],
        };
      }
      if (/from core\.sleep/i.test(sql)) {
        return {
          rows: [{
            archived_date: '2026-06-03',
            sleep_type: '夜间睡眠',
            bedtime: '23:26',
            wake_time: '06:19',
            night_sleep_minutes: 411,
            total_sleep_minutes: 411,
            nap_minutes: null,
            deep_sleep_minutes: 145,
            light_sleep_minutes: 195,
            rem_sleep_minutes: 71,
            awake_minutes: null,
          }],
        };
      }
      return { rows: [] };
    },
  };

  const repository = new PostgresTrainingRepository(client);
  const day = await repository.findByDate('2026-06-03');

  assert.equal(day.date, '2026-06-03');
  assert.equal(day.sleepSummary.totalSleepMinutes, 411);
  assert.equal(day.sleepSummary.sleepStartTime, '23:26');
  assert.ok(queries.some(([sql]) => /from core\.measurement/i.test(sql)));
  assert.ok(queries.every(([, params]) => {
    assert.deepEqual(params[0], ['2026-06-03']);
    return true;
  }));
});

test('PostgresTrainingRepository.findByDates reads requested dates in one batched query set', async () => {
  const queries = [];
  const requestedDates = ['2026-06-03', '2026-06-04'];
  const client = {
    async query(sql, params) {
      queries.push([sql, params]);
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-06-03',
              total_activities: 1,
              total_duration_seconds: 600,
              training_calories: 120,
              workout_duration_minutes: 10,
              active_hours: 1,
              cycling_distance_km: 0,
              intake_calories: 900,
              nutrition_details_json: [],
            },
            {
              archived_date: '2026-06-04',
              total_activities: 0,
              total_duration_seconds: 0,
              training_calories: 0,
              workout_duration_minutes: null,
              active_hours: null,
              cycling_distance_km: 0,
              intake_calories: null,
              nutrition_details_json: [],
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const repository = new PostgresTrainingRepository(client);
  const days = await repository.findByDates(requestedDates);

  assert.deepEqual(days.map((day) => day.date), requestedDates);
  assert.equal(queries.filter(([sql]) => /from core\.training_day/i.test(sql)).length, 1);
  assert.ok(queries.every(([, params]) => {
    assert.deepEqual(params?.[0], requestedDates);
    return true;
  }));
});

test('ensureCoreSchema adds source identity columns and indexes for thought and ingest tables', async () => {
  const calls = [];
  await ensureCoreSchema({
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [] };
    },
  });

  const preflightSql = calls.map(([sql]) => sql).join('\n');
  assert.match(preflightSql, /alter table core\.thought add column if not exists source_chat_id/i);
  assert.match(preflightSql, /create unique index if not exists ux_core_thought_identity/i);
  assert.match(preflightSql, /alter table ingest\.telegram_message add column if not exists source_message_id/i);
  assert.match(preflightSql, /create unique index if not exists ux_ingest_telegram_message_source_identity/i);
  assert.match(preflightSql, /create table if not exists ingest\.ai_call_log/i);
  assert.match(preflightSql, /ai_call_id text primary key/i);
  assert.match(preflightSql, /idempotency_key text/i);
  assert.match(preflightSql, /prompt_tokens integer/i);
  assert.match(preflightSql, /completion_tokens integer/i);
  assert.match(preflightSql, /total_tokens integer/i);
  assert.match(preflightSql, /cost_usd numeric/i);
});

test('PostgresTelegramBatchRepository persists batch envelope, messages, and recognitions', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [] };
    },
  };
  const repository = new PostgresTelegramBatchRepository(client);
  const processedAt = new Date('2026-06-10T00:00:00.000Z');
  const batch = {
    batchId: 'batch-1',
    status: 'ready',
    archivedDate: '2026-06-03',
    updateIds: [1],
    messages: [{
      messageId: 10,
      updateId: 1,
      chatId: 123,
      photos: [{ fileId: 'file-id', fileUniqueId: 'file-unique-id' }],
    }],
    recognitions: [{ messageId: 10, result: { ok: true } }],
  };

  await repository.upsertBatch(batch, 'payload-hash', processedAt);
  await repository.upsertMessages(batch, processedAt);
  await repository.upsertRecognitions(batch, processedAt);

  assert.match(calls[0][0], /insert into ingest\.telegram_batch/i);
  assert.equal(calls[0][1][0], 'batch-1');
  assert.match(calls[1][0], /insert into ingest\.telegram_message/i);
  assert.equal(JSON.parse(calls[1][1][8])[0], 'file-id');
  assert.match(calls[2][0], /insert into ingest\.telegram_recognition/i);
});

test('PostgresTelegramBatchRepository stores null chat_id for Feishu string chat ids', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [] };
    },
  };
  const repository = new PostgresTelegramBatchRepository(client);
  const processedAt = new Date('2026-06-10T00:00:00.000Z');

  await repository.upsertMessages({
    batchId: 'feishu-batch-1',
    messages: [{
      messageId: 10,
      updateId: 1,
      chatId: 'oc_chat_1',
      sourceChatId: 'oc_chat_1',
      photos: [{ fileId: 'img_v3_1', fileUniqueId: 'img_v3_1' }],
    }],
  }, processedAt);

  assert.match(calls[0][0], /insert into ingest\.telegram_message/i);
  assert.equal(calls[0][1][4], null);
});

test('PostgresTelegramBatchRepository keys messages by source channel, chat, and message id', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [] };
    },
  };
  const repository = new PostgresTelegramBatchRepository(client);
  const processedAt = new Date('2026-06-10T00:00:00.000Z');

  await repository.upsertMessages({
    batchId: 'cross-chat-batch',
    sourceChannel: 'feishu',
    messages: [
      {
        messageId: 10,
        updateId: 1,
        chatId: 'oc_chat_1',
        sourceChannel: 'feishu',
        sourceChatId: 'oc_chat_1',
        sourceMessageId: 'om_message_1',
        photos: [{ fileId: 'img_v3_1', fileUniqueId: 'img_v3_1' }],
      },
      {
        messageId: 10,
        updateId: 2,
        chatId: 'oc_chat_2',
        sourceChannel: 'feishu',
        sourceChatId: 'oc_chat_2',
        sourceMessageId: 'om_message_1',
        photos: [{ fileId: 'img_v3_2', fileUniqueId: 'img_v3_2' }],
      },
    ],
  }, processedAt);

  const messageInsert = calls.find(([sql]) => /insert into ingest\.telegram_message/i.test(sql));
  assert.ok(messageInsert, 'expected message upsert');
  assert.match(messageInsert[0], /source_channel/i);
  assert.match(messageInsert[0], /source_chat_id/i);
  assert.match(messageInsert[0], /source_message_id/i);
  assert.match(messageInsert[0], /on conflict\s*\(\s*source_channel\s*,\s*source_chat_id\s*,\s*source_message_id\s*\)/i);
  assert.equal(calls[0][1][10], 'feishu');
  assert.equal(calls[0][1][11], 'oc_chat_1');
  assert.equal(calls[0][1][12], 'om_message_1');
  assert.equal(calls[1][1][11], 'oc_chat_2');
});

test('PostgresThoughtRepository persists thought mirror batches through core.thought SQL', async () => {
  const calls = [];
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [] };
    },
  });

  await repository.persistMirror(
    {
      kind: 'thought',
      batchId: 'thought-batch-1',
      thought: {
        telegramMessageId: 126,
        telegramChatId: 123,
        command: '/thought',
        body: '今天骑行 40 公里',
        thoughtModule: 'misc',
        storage: {
          markdownPath: 'source/_posts/2026-05-17-telegram-thought-126.md',
          photoPaths: ['/images/1.jpg'],
        },
      },
    },
    new Date('2026-06-10T00:00:00.000Z'),
  );

  assert.match(calls[0][0], /insert into core\.thought/i);
  assert.equal(calls[0][1][0], 126);
  assert.equal(calls[0][1][3], 'telegram');
  assert.equal(calls[0][1][5], '今天骑行 40 公里');
  assert.equal(calls[0][1][6], 'misc');
  assert.deepEqual(JSON.parse(calls[0][1][10]), ['/images/1.jpg']);
});

test('PostgresThoughtRepository keys thought mirrors by source identity and falls back to legacy message id lookup', async () => {
  const calls = [];
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /source_channel = \$1/i.test(sql)) {
        return {
          rows: [{
            telegram_message_id: 10,
            source_channel: params[0],
            source_chat_id: params[1],
            source_message_id: params[2],
            thought_module: 'misc',
          }],
        };
      }
      return { rows: [] };
    },
  });

  await repository.persistMirror(
    {
      kind: 'thought',
      batchId: 'feishu-thought-1',
      sourceChannel: 'feishu',
      messages: [{
        messageId: 10,
        chatId: 'oc_chat_1',
        sourceChannel: 'feishu',
        sourceChatId: 'oc_chat_1',
        sourceMessageId: 'om_message_1',
      }],
      thought: {
        telegramMessageId: 10,
        telegramChatId: 'oc_chat_1',
        sourceMessageId: 'om_message_1',
        sourceChatId: 'oc_chat_1',
        command: '/随想',
        body: '飞书随想正文',
        thoughtModule: 'misc',
        storage: {
          markdownPath: null,
          photoPaths: [],
        },
      },
    },
    new Date('2026-06-10T00:00:00.000Z'),
  );

  const upsertCall = calls.find(([sql]) => /insert into core\.thought/i.test(sql));
  assert.ok(upsertCall, 'expected thought upsert');
  assert.match(upsertCall[0], /source_chat_id/i);
  assert.match(upsertCall[0], /source_message_id/i);
  assert.match(upsertCall[0], /on conflict\s*\(\s*source_channel\s*,\s*source_chat_id\s*,\s*source_message_id\s*\)/i);
  assert.equal(upsertCall[1][13], 'oc_chat_1');
  assert.equal(upsertCall[1][14], 'om_message_1');

  await repository.persistMirror(
    {
      kind: 'thought_edit',
      batchId: 'feishu-thought-edit-1',
      sourceChannel: 'feishu',
      messages: [{
        messageId: 11,
        chatId: 'oc_chat_1',
        sourceChannel: 'feishu',
        sourceChatId: 'oc_chat_1',
        sourceMessageId: 'om_edit_1',
      }],
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: 10,
        targetSourceMessageId: 'om_message_1',
        sourceChatId: 'oc_chat_1',
        body: '更新后的飞书随想正文',
        thoughtModule: null,
        telegramChatId: 'oc_chat_1',
        storage: {
          markdownPath: null,
          photoPaths: [],
        },
      },
    },
    new Date('2026-06-10T00:01:00.000Z'),
  );

  const sourceLookup = calls.find(([sql]) => /from core\.thought/i.test(sql) && /source_channel = \$1/i.test(sql));
  assert.ok(sourceLookup, 'expected source identity lookup before legacy fallback');
  assert.equal(sourceLookup[1][0], 'feishu');
  assert.equal(sourceLookup[1][1], 'oc_chat_1');
  assert.equal(sourceLookup[1][2], 'om_message_1');
});

test('PostgresThoughtRepository locates migrated thought targets for edit delete and move ids', async () => {
  const calls = [];
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /source_channel = \$1/i.test(sql)) {
        const [, sourceChatId, sourceMessageId] = params;
        if (sourceChatId === 'oc_chat_new' && sourceMessageId === 'om_source_thought') {
          return {
            rows: [{
              telegram_message_id: 338182848231025,
              source_channel: 'feishu',
              source_chat_id: 'oc_chat_new',
              source_message_id: 'om_source_thought',
              thought_module: 'misc',
            }],
          };
        }
        return { rows: [] };
      }
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        if (params[0] === 501) {
          return {
            rows: [{
              telegram_message_id: 501,
              thought_module: 'workout',
            }],
          };
        }
        if (params[0] === 338182848231024) {
          return {
            rows: [{
              telegram_message_id: 338182848231024,
              source_channel: 'feishu',
              source_chat_id: 'oc_chat_legacy',
              source_message_id: 'om_legacy_proxy',
              thought_module: 'body_feedback',
            }],
          };
        }
      }
      return { rows: [] };
    },
  });

  const editResult = await repository.persistMirror(
    {
      kind: 'thought_edit',
      batchId: 'telegram-legacy-edit',
      messages: [{
        messageId: 901,
        chatId: 42,
        sourceChatId: '42',
        sourceMessageId: '901',
      }],
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: 501,
        body: '旧 Telegram 整数 ID 编辑后的正文',
        thoughtModule: null,
        telegramChatId: 42,
        storage: {
          writeStatus: 'thought_edit_database_only',
          markdownPath: null,
          photoPaths: null,
        },
      },
    },
    new Date('2026-06-16T02:19:00.000Z'),
  );

  const deleteResult = await repository.persistMirror(
    {
      kind: 'thought_delete',
      batchId: 'feishu-safe-integer-delete',
      sourceChannel: 'feishu',
      messages: [{
        messageId: 902,
        chatId: 'oc_chat_legacy',
        sourceChannel: 'feishu',
        sourceChatId: 'oc_chat_legacy',
        sourceMessageId: 'om_delete_command',
      }],
      thoughtDelete: {
        command: '/随想删',
        targetMessageId: 338182848231024,
        telegramChatId: null,
        sourceChatId: 'oc_chat_legacy',
        storage: {
          writeStatus: 'thought_delete_database_only',
          markdownPath: null,
          deletedPhotoPaths: [],
        },
      },
    },
    new Date('2026-06-16T02:20:00.000Z'),
  );

  const moveResult = await repository.persistMirror(
    {
      kind: 'thought_move',
      batchId: 'feishu-source-identity-move',
      sourceChannel: 'feishu',
      messages: [{
        messageId: 903,
        chatId: 'oc_chat_new',
        sourceChannel: 'feishu',
        sourceChatId: 'oc_chat_new',
        sourceMessageId: 'om_move_command',
      }],
      thoughtMove: {
        command: '/移动',
        targetMessageId: 338182848231025,
        targetSourceMessageId: 'om_source_thought',
        sourceChatId: 'oc_chat_new',
        thoughtModule: 'workout',
        telegramChatId: null,
        storage: {
          writeStatus: 'thought_move_database_only',
          markdownPath: null,
          photoPaths: null,
        },
      },
    },
    new Date('2026-06-16T02:21:00.000Z'),
  );

  assert.deepEqual(editResult, { status: 'stored', messageId: 501, thoughtModule: 'workout' });
  assert.deepEqual(deleteResult, {
    status: 'stored',
    messageId: 338182848231024,
    thoughtModule: 'body_feedback',
  });
  assert.deepEqual(moveResult, {
    status: 'stored',
    messageId: 338182848231025,
    thoughtModule: 'workout',
  });

  const legacyLookups = calls.filter(
    ([sql]) => /from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql),
  );
  assert.deepEqual(legacyLookups.map(([, params]) => params[0]), [501, 338182848231024]);

  const sourceLookups = calls.filter(
    ([sql]) => /from core\.thought/i.test(sql) && /source_channel = \$1/i.test(sql),
  );
  assert.ok(
    sourceLookups.some(([, params]) =>
      params[0] === 'feishu' &&
      params[1] === 'oc_chat_new' &&
      params[2] === 'om_source_thought'
    ),
    'expected source identity lookup for new Feishu thought id path',
  );

  const writes = calls.filter(([sql]) => /insert into core\.thought/i.test(sql));
  assert.equal(writes.length, 3);
  assert.equal(writes[0][1][0], 501);
  assert.equal(writes[0][1][13], '42');
  assert.equal(writes[0][1][14], '501');
  assert.match(writes[1][0], /'deleted'/);
  assert.equal(writes[1][1][0], 338182848231024);
  assert.equal(writes[1][1][12], 'oc_chat_legacy');
  assert.equal(writes[1][1][13], 'om_legacy_proxy');
  assert.equal(writes[2][1][0], 338182848231025);
  assert.equal(writes[2][1][13], 'oc_chat_new');
  assert.equal(writes[2][1][14], 'om_source_thought');
});

test('PostgresThoughtRepository preserves existing Feishu source identity when editing by numeric proxy id', async () => {
  const calls = [];
  const targetMessageId = 3248321714433710;
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /source_channel = \$1/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return {
          rows: [{
            telegram_message_id: targetMessageId,
            source_channel: 'feishu',
            source_chat_id: 'oc_original_chat',
            source_message_id: 'om_original_thought',
            thought_module: 'body_feedback',
          }],
        };
      }
      return { rows: [] };
    },
  });

  const result = await repository.persistMirror(
    {
      kind: 'thought_edit',
      batchId: 'feishu-edit-by-proxy-id',
      sourceChannel: 'feishu',
      messages: [{
        messageId: 23,
        chatId: 'oc_command_chat',
        sourceChannel: 'feishu',
        sourceChatId: 'oc_command_chat',
        sourceMessageId: 'om_edit_command',
      }],
      thoughtEdit: {
        command: '/随想编',
        targetMessageId,
        body: '测试23 23:00',
        thoughtModule: 'body_feedback',
        telegramChatId: null,
        sourceChatId: 'oc_command_chat',
        storage: {
          writeStatus: 'thought_edit_database_only',
          markdownPath: null,
          photoPaths: null,
        },
      },
    },
    new Date('2026-06-20T15:00:00.000Z'),
  );

  assert.deepEqual(result, { status: 'stored', messageId: targetMessageId, thoughtModule: 'body_feedback' });
  const upsertCall = calls.find(([sql]) => /insert into core\.thought/i.test(sql));
  assert.ok(upsertCall, 'expected edit upsert');
  assert.equal(upsertCall[1][3], 'feishu');
  assert.equal(upsertCall[1][13], 'oc_original_chat');
  assert.equal(upsertCall[1][14], 'om_original_thought');
});

test('PostgresThoughtRepository preserves existing Feishu source identity when Telegram deletes a Feishu thought', async () => {
  const calls = [];
  const targetMessageId = 1729845219532063;
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /source_channel = \$1/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return {
          rows: [{
            telegram_message_id: targetMessageId,
            source_channel: 'feishu',
            source_chat_id: 'oc_feishu_chat',
            source_message_id: 'om_replayed_failed_thought',
            thought_module: 'misc',
          }],
        };
      }
      return { rows: [] };
    },
  });

  const result = await repository.persistMirror(
    {
      kind: 'thought_delete',
      batchId: 'telegram-delete-feishu-thought',
      sourceChannel: 'telegram',
      messages: [{
        messageId: 663,
        chatId: 42,
        sourceChatId: '42',
        sourceMessageId: '663',
      }],
      thoughtDelete: {
        command: '/随想删',
        targetMessageId,
        telegramChatId: 42,
        storage: {
          writeStatus: 'thought_delete_database_only',
          markdownPath: null,
          deletedPhotoPaths: [],
        },
      },
    },
    new Date('2026-06-20T15:05:00.000Z'),
  );

  assert.deepEqual(result, { status: 'stored', messageId: targetMessageId, thoughtModule: 'misc' });
  const deleteCall = calls.find(([sql]) => /insert into core\.thought/i.test(sql));
  assert.ok(deleteCall, 'expected delete upsert');
  assert.equal(deleteCall[1][3], 'feishu');
  assert.equal(deleteCall[1][12], 'oc_feishu_chat');
  assert.equal(deleteCall[1][13], 'om_replayed_failed_thought');
});

test('PostgresThoughtRepository reports the effective module when editing without a module token', async () => {
  const calls = [];
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return {
          rows: [{
            telegram_message_id: params[0],
            thought_module: 'misc',
          }],
        };
      }
      return { rows: [] };
    },
  });

  const result = await repository.persistMirror(
    {
      kind: 'thought_edit',
      batchId: 'thought-edit-592',
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: 592,
        body: '保留原模块的新正文',
        thoughtModule: null,
        telegramChatId: 42,
        storage: {
          writeStatus: 'thought_edit_database_only',
          markdownPath: null,
          photoPaths: null,
        },
      },
    },
    new Date('2026-06-16T02:19:00.000Z'),
  );

  assert.deepEqual(result, { status: 'stored', messageId: 592, thoughtModule: 'misc' });
  assert.equal(calls.some(([sql]) => /insert into core\.thought/i.test(sql)), true);
});

test('PostgresThoughtRepository passes null body for module-only thought edits to preserve existing content', async () => {
  const calls = [];
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return {
          rows: [{
            telegram_message_id: params[0],
            thought_module: 'misc',
            body: '现有的随想内容',
          }],
        };
      }
      return { rows: [] };
    },
  });

  const result = await repository.persistMirror(
    {
      kind: 'thought_edit',
      batchId: 'thought-edit-593',
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: 593,
        body: null,
        thoughtModule: 'body_feedback',
        telegramChatId: 42,
        storage: {
          writeStatus: 'thought_edit_database_only',
          markdownPath: null,
          photoPaths: null,
        },
      },
    },
    new Date('2026-06-16T02:19:00.000Z'),
  );

  assert.deepEqual(result, { status: 'stored', messageId: 593, thoughtModule: 'body_feedback' });
  const upsertCall = calls.find(([sql]) => /insert into core\.thought/i.test(sql));
  assert.ok(upsertCall, 'expected an upsert query');
  const bodyParam = upsertCall[1][5];
  assert.equal(bodyParam, null, 'body parameter should be null so coalesce preserves existing body');
  const moduleParam = upsertCall[1][6];
  assert.equal(moduleParam, 'body_feedback', 'thought_module parameter should be body_feedback');
});

test('PostgresThoughtRepository preserves bigint thought ids as SQL strings without precision loss', async () => {
  const calls = [];
  const largeMessageId = '9007199254740993';
  const largeChatId = '9007199254740995';
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return {
          rows: [{
            telegram_message_id: params[0],
            thought_module: 'misc',
          }],
        };
      }
      return { rows: [] };
    },
  });

  const result = await repository.persistMirror(
    {
      kind: 'thought_edit',
      batchId: 'thought-edit-bigint',
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: largeMessageId,
        body: '保留大整数目标 ID 的正文',
        thoughtModule: null,
        telegramChatId: largeChatId,
        messageDateUnix: 9007199254740997n,
        storage: {
          writeStatus: 'thought_edit_database_only',
          markdownPath: null,
          photoPaths: null,
        },
      },
    },
    new Date('2026-06-16T02:19:00.000Z'),
  );

  assert.deepEqual(result, { status: 'stored', messageId: largeMessageId, thoughtModule: 'misc' });

  const findCall = calls.find(([sql]) => /from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql));
  assert.ok(findCall, 'expected target lookup');
  assert.equal(findCall[1][0], largeMessageId);

  const upsertCall = calls.find(([sql]) => /insert into core\.thought/i.test(sql));
  assert.ok(upsertCall, 'expected thought upsert');
  assert.equal(upsertCall[1][0], largeMessageId);
  assert.equal(upsertCall[1][1], largeChatId);
  assert.equal(upsertCall[1][8], '9007199254740997');
});

test('PostgresThoughtRepository does not create a thought when an edit target is missing', async () => {
  const calls = [];
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const result = await repository.persistMirror(
    {
      kind: 'thought_edit',
      batchId: 'thought-edit-999',
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: 501,
        body: '应该更新目标正文',
        thoughtModule: 'misc',
        telegramChatId: 42,
        storage: {
          writeStatus: 'thought_edit_database_only',
          markdownPath: null,
          photoPaths: [],
        },
      },
    },
    new Date('2026-06-15T09:15:00.000Z'),
  );

  assert.deepEqual(result, { status: 'not_found', messageId: 501 });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /from core\.thought/i);
  assert.equal(calls[0][1][0], 501);
  assert.equal(calls.some(([sql]) => /insert into core\.thought/i.test(sql)), false);
});

test('PostgresThoughtRepository does not create a thought when a move target is missing', async () => {
  const calls = [];
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const result = await repository.persistMirror(
    {
      kind: 'thought_move',
      batchId: 'thought-move-999',
      thoughtMove: {
        command: '/移动',
        targetMessageId: 502,
        thoughtModule: 'misc',
        telegramChatId: 42,
        storage: {
          writeStatus: 'thought_move_database_only',
          markdownPath: null,
          photoPaths: [],
        },
      },
    },
    new Date('2026-06-15T09:20:00.000Z'),
  );

  assert.deepEqual(result, { status: 'not_found', messageId: 502 });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /from core\.thought/i);
  assert.equal(calls[0][1][0], 502);
  assert.equal(calls.some(([sql]) => /insert into core\.thought/i.test(sql)), false);
});

test('PostgresThoughtRepository reports the effective module when deleting without a module token', async () => {
  const calls = [];
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return {
          rows: [{
            telegram_message_id: params[0],
            thought_module: 'body_feedback',
          }],
        };
      }
      return { rows: [] };
    },
  });

  const result = await repository.persistMirror(
    {
      kind: 'thought_delete',
      batchId: 'thought-delete-801',
      thoughtDelete: {
        command: '/随想删',
        targetMessageId: 801,
        thoughtModule: null,
        telegramChatId: 42,
        storage: {
          writeStatus: 'thought_delete_database_only',
          markdownPath: null,
          deletedPhotoPaths: [],
        },
      },
    },
    new Date('2026-06-16T02:20:00.000Z'),
  );

  assert.deepEqual(result, { status: 'stored', messageId: 801, thoughtModule: 'body_feedback' });
  assert.equal(calls.some(([sql]) => /insert into core\.thought/i.test(sql)), true);
});

test('PostgresThoughtRepository does not create a deleted thought when a delete target is missing', async () => {
  const calls = [];
  const repository = new PostgresThoughtRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const result = await repository.persistMirror(
    {
      kind: 'thought_delete',
      batchId: 'thought-delete-999',
      thoughtDelete: {
        command: '/随想删',
        targetMessageId: 999,
        thoughtModule: null,
        telegramChatId: 42,
        storage: {
          writeStatus: 'thought_delete_database_only',
          markdownPath: null,
          deletedPhotoPaths: [],
        },
      },
    },
    new Date('2026-06-16T02:20:00.000Z'),
  );

  assert.deepEqual(result, { status: 'not_found', messageId: 999 });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /from core\.thought/i);
  assert.equal(calls[0][1][0], 999);
  assert.equal(calls.some(([sql]) => /insert into core\.thought/i.test(sql)), false);
});
