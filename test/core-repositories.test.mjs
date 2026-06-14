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
  assert.equal(calls[0][1][4], '今天骑行 40 公里');
  assert.equal(calls[0][1][5], 'misc');
  assert.deepEqual(JSON.parse(calls[0][1][9]), ['/images/1.jpg']);
});
