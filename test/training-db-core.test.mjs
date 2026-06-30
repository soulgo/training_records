import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  appendPendingRecognitionBatch,
  backfillCoreFromLatestArchiveSnapshot,
  backfillCoreSleepFromIngestBatchesClient,
  exportTrainingMarkdown,
  getLastProcessedTelegramUpdateId,
  importTrainingMarkdownToDatabase,
  markPendingRecognitionResolved,
  persistNormalizedBatch,
  persistTrainingSnapshotToCore,
  readPendingRecognitionBatches,
  readPendingRecognitionSummary,
  readArchiveTrainingSnapshotFromDatabaseClient,
  readTrainingSnapshotFromDatabaseClient,
  readTrainingSnapshotFromDatabase,
} from '../tools/training-db-core.mjs';
import { parseTrainingRecord } from '../src/domain/training/training-parser.mjs';
import {
  shouldQueueRecognitionFailure,
} from '../src/db/training/pending-recognition.mjs';
import {
  persistTelegramImageBatchIncremental,
} from '../src/adapters/postgres/incremental-write.pg.mjs';
import {
  assertSequentialUnnestParameters,
  buildCoreTestDay,
  createIncrementalPersistClient,
  normalizedBatch,
} from './helpers/training-db-core-fixtures.mjs';

test('readTrainingSnapshotFromDatabaseClient normalizes archived dates before grouping rows', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: new Date('2026-05-22T00:00:00.000Z'),
              total_activities: 7,
              total_duration_seconds: 8888,
              training_calories: 1077,
              workout_duration_minutes: 148,
              active_hours: 14,
              cycling_distance_km: 11.74,
              intake_calories: 1385,
              nutrition_details_json: ['早餐 597千卡'],
            },
          ],
        };
      }
      if (/from core\.measurement/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: new Date('2026-05-22T00:00:00.000Z'),
              measured_at: '2026-05-22',
              body_score: 76,
              weight_kg: 73.7,
              bmi: 23.7,
              body_fat_pct: 22.8,
              skeletal_muscle_kg: 30.8,
              visceral_fat_level: 9,
              basal_metabolism_kcal: 1605,
              body_water_pct: 50,
              protein_pct: 23.1,
              bone_mass_kg: 2.975,
              fat_free_mass_kg: 56.9,
              body_age: 31,
              body_type: '肥胖型',
            },
          ],
        };
      }
      if (/from core\.activity/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: new Date('2026-05-22T00:00:00.000Z'),
              activity_time: '06:40',
              activity_type: 'mixed_cardio',
              raw_type: 'mixed_cardio',
              detail: '总消耗375千卡，时长00:40:01，平均心率145次/分钟',
              calories: 375,
              heart_rate: 145,
              distance_km: null,
              avg_speed_kmh: null,
              duration_text: '00:40:01',
              duration_seconds: 2401,
            },
          ],
        };
      }
      if (/from core\.meal/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: new Date('2026-05-22T00:00:00.000Z'),
              meal_name: '早餐',
              calories: 597,
              recommended_min: 512,
              recommended_max: 922,
            },
          ],
        };
      }
      if (/from core\.sleep/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.thought/i.test(sql)) {
        return {
          rows: [
            {
              telegram_message_id: 610,
              telegram_chat_id: 42,
              body: '训练后右膝外侧酸胀',
              thought_module: 'body_feedback',
              message_date_unix: 1779445200,
              markdown_path: 'source/_posts/2026-05-22-telegram-thought-610.md',
              updated_at: '2026-05-22T18:20:00.000+08:00',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const snapshot = await readTrainingSnapshotFromDatabaseClient(
    client,
    new Date('2026-05-23T00:00:00.000Z'),
  );
  const day = snapshot.daily.find((entry) => entry.date === '2026-05-22');

  assert.ok(day);
  assert.equal(day.activities.length, 1);
  assert.equal(day.nutrition.meals.length, 1);
  assert.equal(day.measurement.weightKg, 73.7);
  assert.equal(day.sleep.length, 0);
  assert.equal(day.sleepSummary.totalSleepMinutes, null);
  assert.equal(snapshot.bodyFeedback.length, 1);
  assert.equal(snapshot.bodyFeedback[0].date, '2026-05-22');
  assert.equal(snapshot.bodyFeedback[0].body, '训练后右膝外侧酸胀');
  assert.equal(snapshot.charts.weightKg[0].date, '2026-05-22');
  assert.ok(queries.some((sql) => /from core\.sleep/i.test(sql)));
});

test('readTrainingSnapshotFromDatabaseClient preserves thought source channels from core.thought', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/from core\.training_day/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.(measurement|activity|meal|sleep)/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.thought/i.test(sql)) {
        return {
          rows: [
            {
              telegram_message_id: 338182848231024,
              telegram_chat_id: null,
              source_channel: 'feishu',
              body: '飞书随想正文',
              command: '/随想',
              thought_module: 'workout',
              tags_json: ['训练', '随想', '飞书'],
              message_date_unix: 1781576400,
              markdown_path: 'source/_posts/2026-06-16-feishu-thought-338182848231024.md',
              image_refs_json: [],
              updated_at: '2026-06-16T10:20:00.000+08:00',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const snapshot = await readTrainingSnapshotFromDatabaseClient(
    client,
    new Date('2026-06-16T02:30:00.000Z'),
  );

  assert.ok(queries.some((sql) => /source_channel/i.test(sql)));
  assert.equal(snapshot.thoughts.length, 1);
  assert.equal(snapshot.thoughts[0].sourceChannel, 'feishu');
  assert.equal(snapshot.thoughts[0].telegramMessageId, 338182848231024);
  assert.equal(snapshot.thoughts[0].body, '飞书随想正文');
});

test('readTrainingSnapshotFromDatabaseClient keeps only the latest row for a duplicated thought id', async () => {
  const client = {
    async query(sql) {
      if (/from core\.training_day/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.(measurement|activity|meal|sleep)/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.thought/i.test(sql)) {
        return {
          rows: [
            {
              telegram_message_id: 1442054985160403,
              telegram_chat_id: null,
              source_channel: 'feishu',
              body: '旧模块正文',
              command: '/随想',
              thought_module: 'misc',
              tags_json: ['杂七杂八', '随想', '飞书'],
              message_date_unix: 1781573700,
              markdown_path: 'source/_posts/2026-06-16-feishu-thought-1442054985160403.md',
              image_refs_json: [],
              updated_at: '2026-06-16T09:35:00.000+08:00',
            },
            {
              telegram_message_id: 1442054985160403,
              telegram_chat_id: null,
              source_channel: 'feishu',
              body: '正式 2026 年 6 月 16 日 12:33:38',
              command: '/随想编',
              thought_module: 'body_feedback',
              tags_json: ['身体反馈', '随想', '飞书'],
              message_date_unix: 1781584418,
              markdown_path: 'source/_posts/2026-06-16-feishu-thought-1442054985160403.md',
              image_refs_json: [],
              updated_at: '2026-06-16T12:33:38.000+08:00',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const snapshot = await readTrainingSnapshotFromDatabaseClient(
    client,
    new Date('2026-06-16T05:00:00.000Z'),
  );

  assert.equal(snapshot.thoughts.length, 1);
  assert.equal(snapshot.thoughts[0].telegramMessageId, 1442054985160403);
  assert.equal(snapshot.thoughts[0].thoughtModule, 'body_feedback');
  assert.equal(snapshot.thoughts[0].body, '正式 2026 年 6 月 16 日 12:33:38');
  assert.equal(snapshot.bodyFeedback.length, 1);
  assert.equal(snapshot.bodyFeedback[0].telegramMessageId, 1442054985160403);
});

test('readTrainingSnapshotFromDatabaseClient prefers core sleep rows over day sleep summary for sleep cards', async () => {
  const client = {
    async query(sql) {
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-06-10',
              total_activities: 0,
              total_duration_seconds: 0,
              training_calories: 0,
              workout_duration_minutes: null,
              active_hours: null,
              cycling_distance_km: 0,
              intake_calories: null,
              sleep_total_minutes: 735,
              night_sleep_minutes: 354,
              nap_minutes: null,
              sleep_start_time: '00:08',
              sleep_end_time: '06:08',
              deep_sleep_minutes: null,
              light_sleep_minutes: null,
              rem_sleep_minutes: null,
              awake_minutes: null,
              nutrition_details_json: [],
            },
          ],
        };
      }
      if (/from core\.sleep/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-06-10',
              sleep_type: '夜间睡眠',
              bedtime: '00:08',
              wake_time: '06:08',
              night_sleep_minutes: 354,
              total_sleep_minutes: 381,
              nap_minutes: 27,
              deep_sleep_minutes: 79,
              light_sleep_minutes: 226,
              rem_sleep_minutes: 49,
              awake_minutes: null,
              sleep_score: 76,
              deep_sleep_ratio_pct: 22,
              light_sleep_ratio_pct: 64,
            },
          ],
        };
      }
      if (/from core\.(measurement|activity|meal|thought)/i.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const snapshot = await readTrainingSnapshotFromDatabaseClient(
    client,
    new Date('2026-06-12T00:00:00.000Z'),
  );
  const day = snapshot.daily.find((entry) => entry.date === '2026-06-10');

  assert.ok(day);
  assert.equal(day.sleep.length, 1);
  assert.equal(day.sleepSummary.totalSleepMinutes, 381);
  assert.equal(day.sleepSummary.nightSleepMinutes, 354);
  assert.equal(day.sleepSummary.napMinutes, 27);
  assert.equal(day.sleepSummary.deepSleepMinutes, 79);
  assert.equal(day.sleepSummary.lightSleepMinutes, 226);
  assert.equal(day.sleepSummary.remSleepMinutes, 49);
  assert.equal(day.sleepSummary.deepSleepRatioPct, 22);
  assert.equal(day.sleepSummary.lightSleepRatioPct, 64);
});

test('readTrainingSnapshotFromDatabase can limit daily rows by date window', async () => {
  const queries = [];
  const snapshot = await readTrainingSnapshotFromDatabase({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return {
        async connect() {},
        async end() {},
        async query(sql) {
          queries.push(sql);
          if (/from core\.training_day/i.test(sql)) {
            return {
              rows: [
                {
                  archived_date: '2026-05-08',
                  total_activities: 1,
                  total_duration_seconds: 600,
                  training_calories: 120,
                  workout_duration_minutes: 10,
                  active_hours: 1,
                  cycling_distance_km: 0,
                  intake_calories: 800,
                },
                {
                  archived_date: '2026-05-09',
                  total_activities: 2,
                  total_duration_seconds: 1200,
                  training_calories: 240,
                  workout_duration_minutes: 20,
                  active_hours: 2,
                  cycling_distance_km: 1.2,
                  intake_calories: 900,
                },
              ],
            };
          }
          if (/from core\.measurement/i.test(sql)) {
            return {
              rows: [
                {
                  archived_date: '2026-05-09',
                  measured_at: '2026-05-09 06:42',
                  body_score: 74,
                  weight_kg: '72.85',
                  bmi: '23.5',
                  body_fat_pct: '22.8',
                  skeletal_muscle_kg: '30.45',
                  visceral_fat_level: '8',
                  basal_metabolism_kcal: 1587,
                  body_water_pct: null,
                  protein_pct: null,
                  bone_mass_kg: null,
                  fat_free_mass_kg: null,
                  body_age: null,
                  body_type: null,
                },
              ],
            };
          }
          if (/from core\.activity/i.test(sql) || /from core\.meal/i.test(sql) || /from core\.sleep/i.test(sql)) {
            return { rows: [] };
          }
          if (/from core\.thought/i.test(sql)) {
            return {
              rows: [
                {
                  telegram_message_id: 608,
                  telegram_chat_id: 42,
                  body: '窗口外反馈',
                  thought_module: 'body_feedback',
                  message_date_unix: 1778198400,
                  markdown_path: 'source/_posts/2026-05-08-telegram-thought-608.md',
                  updated_at: '2026-05-08T08:00:00.000+08:00',
                },
                {
                  telegram_message_id: 609,
                  telegram_chat_id: 42,
                  body: '窗口内反馈',
                  thought_module: 'body_feedback',
                  message_date_unix: 1778284800,
                  markdown_path: 'source/_posts/2026-05-09-telegram-thought-609.md',
                  updated_at: '2026-05-09T08:00:00.000+08:00',
                },
              ],
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
    },
    dateFrom: '2026-05-09',
    dateTo: '2026-05-09',
  });

  assert.deepEqual(snapshot.daily.map((day) => day.date), ['2026-05-09']);
  assert.deepEqual(snapshot.bodyFeedback.map((entry) => entry.body), ['窗口内反馈']);
  assert.equal(snapshot.latest.daily?.date, '2026-05-09');
  assert.equal(snapshot.charts.trainingCalories.length, 1);
  assert.ok(queries.some((sql) => /from core\.training_day/i.test(sql)));
  assert.ok(queries.some((sql) => /from core\.sleep/i.test(sql)));
});

test('readTrainingSnapshotFromDatabaseClient includes core sleep rows in sleep summaries', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
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
      if (/from core\.sleep/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-06-04',
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
              sleep_stage_text: '深睡2小时25分钟；浅睡3小时15分钟；快速眼动1小时11分钟',
              sleep_stage_detail: ['深睡 2小时25分钟', '浅睡 3小时15分钟', '快速眼动 1小时11分钟'],
              sleep_score: 81,
              sleep_score_percentile: 77,
              deep_sleep_ratio_pct: 35,
              light_sleep_ratio_pct: 47,
              rem_sleep_ratio_pct: 18,
              deep_sleep_continuity_score: 85,
              wake_count: 1,
              breathing_quality_score: 98,
              average_heart_rate_bpm: 68,
              hrv_ms: 34,
              average_spo2_pct: 97,
              average_respiratory_rate: 14,
              analysis_text: '睡眠质量良好。',
              suggestion_text: '建议睡觉时关灯。',
            },
          ],
        };
      }
      if (/from core\.measurement/i.test(sql) || /from core\.activity/i.test(sql) || /from core\.meal/i.test(sql) || /from core\.thought/i.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const snapshot = await readTrainingSnapshotFromDatabaseClient(
    client,
    new Date('2026-06-05T00:00:00.000Z'),
  );
  const day = snapshot.daily.find((entry) => entry.date === '2026-06-04');

  assert.ok(day);
  assert.ok(queries.some((sql) => /from core\.sleep/i.test(sql)));
  assert.ok(queries.some((sql) => /from core\.sleep/i.test(sql) && /sleep_score/i.test(sql)));
  assert.ok(queries.some((sql) => /from core\.sleep/i.test(sql) && /average_heart_rate_bpm/i.test(sql)));
  assert.equal(day.sleep.length, 1);
  assert.equal(day.sleepSummary.totalSleepMinutes, 411);
  assert.equal(day.sleepSummary.deepSleepMinutes, 145);
  assert.equal(day.sleepSummary.sleepScore, 81);
  assert.equal(day.sleepSummary.averageHeartRateBpm, 68);
});

test('readArchiveTrainingSnapshotFromDatabaseClient reads schema-defined archive columns', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/from archive\.training_day/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-04-03',
              total_activities: 1,
              total_duration_seconds: 1800,
              training_calories: 220,
              workout_duration_minutes: 30,
              active_hours: 2,
              cycling_distance_km: 0,
              intake_calories: 900,
              nutrition_details_json: [],
            },
          ],
        };
      }
      if (/from archive\.training_measurement/i.test(sql)) {
        return { rows: [] };
      }
      if (/from archive\.training_activity/i.test(sql)) {
        return { rows: [] };
      }
      if (/from archive\.training_meal/i.test(sql)) {
        return { rows: [] };
      }
      if (/from archive\.training_sleep/i.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const snapshot = await readArchiveTrainingSnapshotFromDatabaseClient(
    client,
    new Date('2026-04-04T00:00:00.000Z'),
  );

  assert.deepEqual(snapshot.daily.map((day) => day.date), ['2026-04-03']);
  assert.equal(snapshot.daily[0].sleep.length, 0);
  assert.equal(snapshot.daily[0].sleepSummary.totalSleepMinutes, null);
  assert.ok(queries.some((sql) => /from archive\.training_sleep/i.test(sql)));
});

test('persistNormalizedBatch writes ingest and core records in one transaction', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: normalizedBatch,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.equal(calls[0][0], 'connect');
  assert.ok(calls.some(([sql]) => /alter table core\.sleep/i.test(sql)), 'ensureCoreSchema should run before BEGIN');
  assert.equal(calls[2][0], 'BEGIN');
  assert.ok(calls.some(([sql]) => /insert into ingest\.telegram_batch/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into ingest\.telegram_message/i.test(sql)));
  const recognitionCall = calls.find(([sql]) => /insert into ingest\.telegram_recognition/i.test(sql));
  const recognitionJson = JSON.parse(recognitionCall[1][2]);
  assert.equal(recognitionJson.detectedApp, '华为健康');
  assert.equal(recognitionJson.aiAttemptKind, 'normal');
  assert.ok(calls.some(([sql]) => /insert into core\.training_day/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into core\.measurement/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into core\.activity/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into core\.meal/i.test(sql)));
  assert.equal(calls.at(-2)[0], 'COMMIT');
  assert.equal(calls.at(-1)[0], 'end');
});

test('persistNormalizedBatch returns safe persistence summary with row counts and slow queries', async () => {
  const fakeClient = {
    async connect() {},
    async query(sql) {
      if (/insert into ingest\.telegram_batch/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/insert into ingest\.telegram_message/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/insert into ingest\.telegram_recognition/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/insert into core\.training_day/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/insert into core\.measurement/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/insert into core\.activity/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/insert into core\.meal/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/insert into core\.sleep/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };

  const result = await persistNormalizedBatch({
    batch: normalizedBatch,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TRAINING_DB_SLOW_QUERY_MS: '0',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
    sourceChannel: 'telegram',
  });

  assert.equal(result.status, 'stored');
  assert.match(result.transactionId, /^dbtx_[a-f0-9]{16}$/);
  assert.equal(result.sourceChannel, 'telegram');
  assert.deepEqual(result.rowCounts, {
    ingestBatch: 1,
    ingestMessage: 1,
    ingestRecognition: 1,
    aiCallLog: 0,
    coreTrainingDay: 2,
    coreMeasurement: 1,
    coreActivity: 0,
    coreMeal: 0,
    coreSleep: 0,
    coreThought: 0,
  });
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.slowQueries.length > 0);
  assert.ok(result.slowQueries.every((query) => query.operation && query.table && Number.isFinite(query.durationMs)));
  assert.doesNotMatch(JSON.stringify(result.slowQueries), /postgresql:\/\/|training_writer|secret|select|insert|\$/i);
  assert.deepEqual(result.persistenceResult, {
    status: 'stored',
    batchId: normalizedBatch.batchId,
    archivedDate: '2026-05-09',
    transactionId: result.transactionId,
    sourceChannel: 'telegram',
    rowCounts: result.rowCounts,
    durationMs: result.durationMs,
    slowQueries: result.slowQueries,
    pendingStatus: null,
    rollbackStatus: null,
  });
});

test('persistNormalizedBatch preserves fallback AI audit fields in recognition json', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'album-fallback-ai-audit',
      recognitions: [
        {
          ...normalizedBatch.recognitions[0],
          aiAttemptKind: 'fallback',
          model: 'gpt-fallback',
          cacheKey: 'telegram:file_unique_id:u-abc:prompt:2026-05-24:schema:v2:model:gpt-fallback',
          aiIdempotencyKey: 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-abc:abc123',
        },
      ],
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  const recognitionCall = calls.find(([sql]) => /insert into ingest\.telegram_recognition/i.test(sql));
  const recognitionJson = JSON.parse(recognitionCall[1][2]);

  assert.equal(result.status, 'stored');
  assert.equal(recognitionJson.aiAttemptKind, 'fallback');
  assert.equal(recognitionJson.model, 'gpt-fallback');
  assert.equal(recognitionJson.aiIdempotencyKey, 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-abc:abc123');
  assert.match(recognitionJson.cacheKey, /model:gpt-fallback$/);
});

test('persistNormalizedBatch preserves strict JSON retry AI audit fields in recognition json', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'album-strict-json-retry-ai-audit',
      recognitions: [
        {
          ...normalizedBatch.recognitions[0],
          aiAttemptKind: 'strict_json_retry',
          model: 'gpt-primary',
          promptVersion: '2026-05-24',
          schemaName: 'telegram_training_image',
          schemaVersion: 'v2',
          cacheKey: 'telegram:file_unique_id:u-abc:prompt:2026-05-24:schema:v2:model:gpt-primary',
          aiIdempotencyKey: 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-abc:abc123',
        },
      ],
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  const recognitionCall = calls.find(([sql]) => /insert into ingest\.telegram_recognition/i.test(sql));
  const recognitionJson = JSON.parse(recognitionCall[1][2]);

  assert.equal(result.status, 'stored');
  assert.equal(recognitionJson.aiAttemptKind, 'strict_json_retry');
  assert.equal(recognitionJson.model, 'gpt-primary');
  assert.equal(recognitionJson.promptVersion, '2026-05-24');
  assert.equal(recognitionJson.schemaVersion, 'v2');
  assert.equal(recognitionJson.aiIdempotencyKey, 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-abc:abc123');
  assert.match(recognitionJson.cacheKey, /model:gpt-primary$/);
});

test('persistNormalizedBatch writes recognition AI call log after business commit', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const processedAt = new Date('2026-06-15T00:00:00.000Z');
  const result = await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'album-ai-call-log',
      recognitions: [
        {
          ...normalizedBatch.recognitions[0],
          provider: 'openai-compatible',
          model: 'gpt-primary',
          promptVersion: '2026-05-24',
          aiIdempotencyKey: 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-abc:abc123',
          aiLatencyMs: 1234,
          aiUsage: {
            promptTokens: 1200,
            completionTokens: 300,
            totalTokens: 1500,
          },
        },
      ],
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  const commitIndex = calls.findIndex(([sql]) => sql === 'COMMIT');
  const aiLogIndex = calls.findIndex(([sql]) => /insert into ingest\.ai_call_log/i.test(sql));
  const aiLogCall = calls[aiLogIndex];

  assert.equal(result.status, 'stored');
  assert.ok(aiLogIndex > commitIndex, 'AI call log should be best-effort after business commit');
  assert.equal(aiLogCall[1][1], 'album-ai-call-log');
  assert.equal(aiLogCall[1][2], 'recognition');
  assert.equal(aiLogCall[1][3], 'openai-compatible');
  assert.equal(aiLogCall[1][4], 'gpt-primary');
  assert.equal(aiLogCall[1][5], '2026-05-24');
  assert.equal(aiLogCall[1][6], 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-abc:abc123');
  assert.equal(aiLogCall[1][7], 'succeeded');
  assert.equal(aiLogCall[1][8], 1234);
  assert.equal(aiLogCall[1][9], null);
  assert.equal(aiLogCall[1][10], null);
  assert.equal(aiLogCall[1][11], processedAt.toISOString());
  assert.equal(aiLogCall[1][12], processedAt.toISOString());
  assert.equal(aiLogCall[1][13], 1200);
  assert.equal(aiLogCall[1][14], 300);
  assert.equal(aiLogCall[1][15], 1500);
  assert.equal(aiLogCall[1][16], null);
});

test('writeStartedRecognitionAiCallLog writes started AI call log best-effort', async () => {
  const dbCore = await import('../tools/training-db-core.mjs');
  assert.equal(typeof dbCore.writeStartedRecognitionAiCallLog, 'function');

  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };
  const occurredAt = new Date('2026-06-15T00:00:01.000Z');

  const result = await dbCore.writeStartedRecognitionAiCallLog({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient: () => fakeClient,
    occurredAt,
    taskId: 'album-started-ai-call-log',
    scene: 'recognition',
    provider: 'openai-compatible',
    model: 'gpt-primary',
    promptVersion: '2026-05-24',
    idempotencyKey: 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-started:abc123',
    sourceChannel: 'telegram',
    sourceChatId: '42',
    sourceMessageId: '1773',
    messageId: 1773,
    status: 'started',
  });

  const aiLogCall = calls.find(([sql]) => /insert into ingest\.ai_call_log/i.test(sql));

  assert.equal(result.status, 'written');
  assert.match(result.aiCallId, /^ai-call:recognition:/);
  assert.ok(aiLogCall);
  assert.equal(aiLogCall[1][0], result.aiCallId);
  assert.equal(aiLogCall[1][1], 'album-started-ai-call-log');
  assert.equal(aiLogCall[1][2], 'recognition');
  assert.equal(aiLogCall[1][3], 'openai-compatible');
  assert.equal(aiLogCall[1][4], 'gpt-primary');
  assert.equal(aiLogCall[1][5], '2026-05-24');
  assert.equal(aiLogCall[1][6], 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-started:abc123');
  assert.equal(aiLogCall[1][7], 'started');
  assert.equal(aiLogCall[1][8], null);
  assert.equal(aiLogCall[1][9], null);
  assert.equal(aiLogCall[1][10], null);
  assert.equal(aiLogCall[1][11], occurredAt.toISOString());
  assert.equal(aiLogCall[1][12], occurredAt.toISOString());
});

test('started and succeeded recognition AI call logs use the same call id', async () => {
  const dbCore = await import('../tools/training-db-core.mjs');
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };
  const idempotencyKey = 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-abc:abc123';

  const started = await dbCore.writeStartedRecognitionAiCallLog({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient: () => fakeClient,
    occurredAt: new Date('2026-06-15T00:00:01.000Z'),
    taskId: 'album-ai-call-log',
    scene: 'recognition',
    provider: 'openai-compatible',
    model: 'gpt-primary',
    promptVersion: '2026-05-24',
    idempotencyKey,
    sourceChannel: 'telegram',
    sourceChatId: '42',
    sourceMessageId: '71',
    messageId: 71,
    status: 'started',
  });

  await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'album-ai-call-log',
      recognitions: [
        {
          ...normalizedBatch.recognitions[0],
          provider: 'openai-compatible',
          model: 'gpt-primary',
          promptVersion: '2026-05-24',
          aiIdempotencyKey: idempotencyKey,
          aiLatencyMs: 1234,
        },
      ],
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-06-15T00:00:02.000Z'),
  });

  const aiLogCalls = calls.filter(([sql]) => /insert into ingest\.ai_call_log/i.test(sql));
  const succeededCall = aiLogCalls.find(([, params]) => params?.[7] === 'succeeded');

  assert.ok(succeededCall);
  assert.equal(started.aiCallId, succeededCall[1][0]);
});

test('persistNormalizedBatch keeps stored result when recognition AI call log write fails', async () => {
  const calls = [];
  const stderrWrite = process.stderr.write;
  const stderrMessages = [];
  process.stderr.write = function write(chunk, ...args) {
    stderrMessages.push(String(chunk));
    if (typeof args.at(-1) === 'function') {
      args.at(-1)();
    }
    return true;
  };

  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      if (/insert into ingest\.ai_call_log/i.test(sql)) {
        throw new Error('audit table unavailable');
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  try {
    const result = await persistNormalizedBatch({
      batch: {
        ...normalizedBatch,
        batchId: 'album-ai-call-log-best-effort',
        recognitions: [
          {
            ...normalizedBatch.recognitions[0],
            model: 'gpt-primary',
            promptVersion: '2026-05-24',
            aiIdempotencyKey: 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:u-abc:abc123',
          },
        ],
      },
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      createClient() {
        return fakeClient;
      },
      processedAt: new Date('2026-06-15T00:00:00.000Z'),
    });

    assert.equal(result.status, 'stored');
    assert.ok(calls.some(([sql]) => sql === 'COMMIT'));
    assert.ok(calls.some(([sql]) => /insert into ingest\.ai_call_log/i.test(sql)));
    assert.ok(stderrMessages.some((message) => /failed to write recognition AI call log/.test(message)));
  } finally {
    process.stderr.write = stderrWrite;
  }
});

test('persistNormalizedBatch writes Feishu recognition AI call log through shared image path', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'feishu-ai-call-log',
      sourceChannel: 'feishu',
      messages: normalizedBatch.messages.map((message) => ({
        ...message,
        chatId: 'oc_chat_1',
        sourceChannel: 'feishu',
        sourceChatId: 'oc_chat_1',
        sourceMessageId: 'om_feishu_ai_log_1',
      })),
      recognitions: [
        {
          ...normalizedBatch.recognitions[0],
          sourceChannel: 'feishu',
          sourceChatId: 'oc_chat_1',
          sourceMessageId: 'om_feishu_ai_log_1',
          provider: 'openai-compatible',
          model: 'gpt-primary',
          promptVersion: '2026-05-24',
          aiIdempotencyKey: 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:img_v3:abc123',
        },
      ],
    },
    sourceChannel: 'feishu',
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-06-15T00:00:00.000Z'),
  });

  const aiLogCall = calls.find(([sql]) => /insert into ingest\.ai_call_log/i.test(sql));

  assert.equal(result.status, 'stored');
  assert.equal(aiLogCall[1][1], 'feishu-ai-call-log');
  assert.equal(aiLogCall[1][2], 'recognition');
  assert.equal(aiLogCall[1][3], 'openai-compatible');
  assert.equal(aiLogCall[1][4], 'gpt-primary');
  assert.equal(aiLogCall[1][6], 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:img_v3:abc123');
  assert.equal(aiLogCall[1][7], 'succeeded');
});

test('persistNormalizedBatch stores Feishu image batches with nullable legacy chat id and Feishu source channel', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      if (/insert into ingest\.telegram_message/i.test(sql) && typeof params?.[4] === 'string') {
        throw new Error(`invalid input syntax for type bigint: "${params[4]}"`);
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'feishu-source-channel',
      sourceChannel: 'feishu',
      messages: normalizedBatch.messages.map((message) => ({
        ...message,
        chatId: 'oc_chat_1',
        sourceChannel: 'feishu',
        sourceChatId: 'oc_chat_1',
      })),
    },
    sourceChannel: 'feishu',
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-06-14T00:00:00.000Z'),
  });

  const messageInsert = calls.find(([sql]) => /insert into ingest\.telegram_message/i.test(sql));
  const summaryInsert = calls.find(([sql]) =>
    /with\s+activity_summary/i.test(sql) && /insert into core\.training_day/i.test(sql)
  );

  assert.equal(result.status, 'stored');
  assert.equal(messageInsert[1][4], null);
  assert.equal(summaryInsert[1][2], 'feishu');
});

test('persistTelegramImageBatchIncremental requires explicit sourceChannel', async () => {
  const { calls, client } = createIncrementalPersistClient();

  await assert.rejects(
    persistTelegramImageBatchIncremental(client, normalizedBatch, new Date('2026-06-14T00:00:00.000Z')),
    /sourceChannel is required/i,
  );
  assert.equal(calls.length, 0);
});

test('core detail keys keep source-specific facts separate but canonicalize sleep identity across channels', async () => {
  const { calls, client } = createIncrementalPersistClient();
  const processedAt = new Date('2026-06-14T00:00:00.000Z');
  const batch = {
    ...normalizedBatch,
    batchId: 'same-business-fact',
    sleep: {
      sleepType: '夜间睡眠',
      bedtime: '23:10',
      wakeTime: '06:40',
      totalSleepMinutes: 450,
      nightSleepMinutes: 450,
      sleepScore: 88,
    },
  };

  await persistTelegramImageBatchIncremental(client, batch, processedAt, { sourceChannel: 'telegram' });
  await persistTelegramImageBatchIncremental(client, batch, processedAt, { sourceChannel: 'feishu' });

  const [measurementKeys, activityKeys, mealKeys, sleepKeys] = [
    /insert into core\.measurement/i,
    /insert into core\.activity/i,
    /insert into core\.meal/i,
    /insert into core\.sleep/i,
  ].map((pattern) =>
    calls
      .filter(([sql]) => pattern.test(sql))
      .map(([, params]) => params[0][0])
  );

  for (const keys of [measurementKeys, activityKeys, mealKeys]) {
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  }
  assert.equal(sleepKeys.length, 2);
  assert.equal(sleepKeys[0], sleepKeys[1]);
});

test('persistNormalizedBatch does not treat image batches without photos as Telegram image batches', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'image-empty-photos',
      kind: 'image',
      measurement: null,
      activities: [],
      workoutDailySummary: null,
      nutrition: null,
      messages: [
        {
          ...normalizedBatch.messages[0],
          messageId: 72,
          photos: [],
        },
      ],
      recognitions: [],
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.ok(calls.some(([sql]) => /insert into ingest\.telegram_batch/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into ingest\.telegram_message/i.test(sql)));
  assert.equal(calls.some(([sql]) => /insert into core\.(measurement|activity|meal|sleep|training_day)/i.test(sql)), false);
});

test('persistNormalizedBatch upserts measurement without deleting other core modules', async () => {
  const { calls, client } = createIncrementalPersistClient({
    activitySummary: { total_activities: 1, total_duration_seconds: 600, training_calories: 120, cycling_distance_km: 0 },
    mealSummary: { intake_calories: 900 },
    daySummary: {
      workout_duration_minutes: 10,
      active_hours: 1,
      intake_calories: 900,
      nutrition_details_json: ['existing dinner'],
    },
    activityRows: [{
      archived_date: '2026-05-09',
      activity_time: '08:00',
      activity_type: '力量训练',
      raw_type: '力量训练',
      detail: '总消耗120千卡，时长00:10:00',
      calories: 120,
      heart_rate: null,
      distance_km: null,
      avg_speed_kmh: null,
      duration_text: '00:10:00',
      duration_seconds: 600,
    }],
    mealRows: [{
      archived_date: '2026-05-09',
      meal_name: '晚餐',
      calories: 900,
      recommended_min: 300,
      recommended_max: 700,
    }],
    sleepRows: [{
      archived_date: '2026-05-09',
      sleep_type: '夜间睡眠',
      bedtime: '23:26',
      wake_time: '06:19',
      night_sleep_minutes: 411,
      total_sleep_minutes: 411,
    }],
  });

  await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'measurement-only',
      activities: [],
      workoutDailySummary: null,
      nutrition: { meals: [], totalCalories: null, details: [] },
      sleep: null,
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return client;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  const trainingDayInsert = calls.filter(([sql]) => /insert into core\.training_day/i.test(sql)).at(-1);

  assert.ok(calls.some(([sql]) => /insert into core\.measurement/i.test(sql)));
  assert.equal(calls.some(([sql]) => /insert into core\.activity/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.meal/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.sleep/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /delete from core\.(measurement|activity|meal|sleep)/i.test(sql)), false);
  assert.match(trainingDayInsert[0], /existing_day/i);
  assert.equal(trainingDayInsert[1][9], false);
  assert.equal(trainingDayInsert[1][10], false);
});

test('persistTelegramImageBatchIncremental rejects impossible archive dates before core writes', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [] };
    },
  };

  await assert.rejects(
    persistTelegramImageBatchIncremental(
      client,
      {
        ...normalizedBatch,
        batchId: 'image-invalid-archive-date',
        archivedDate: '2023-02-30',
      },
      new Date('2026-05-13T00:00:00.000Z'),
      { sourceChannel: 'telegram' },
    ),
    /invalid archivedDate: 2023-02-30/,
  );

  assert.equal(calls.some(([sql]) => /core\./i.test(sql)), false);
});

test('persistNormalizedBatch upserts activity without deleting same-day nutrition or sleep', async () => {
  const { calls, client } = createIncrementalPersistClient({
    activitySummary: { total_activities: 2, total_duration_seconds: 2270, training_calories: 361, cycling_distance_km: 0 },
    mealSummary: { intake_calories: 900 },
    daySummary: {
      workout_duration_minutes: 10,
      active_hours: 1,
      intake_calories: 900,
      nutrition_details_json: ['existing dinner'],
    },
    mealRows: [{
      archived_date: '2026-05-09',
      meal_name: '晚餐',
      calories: 900,
      recommended_min: 300,
      recommended_max: 700,
    }],
    sleepRows: [{
      archived_date: '2026-05-09',
      sleep_type: '夜间睡眠',
      bedtime: '23:26',
      wake_time: '06:19',
      night_sleep_minutes: 411,
      total_sleep_minutes: 411,
    }],
  });

  await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'activity-only',
      measurement: null,
      nutrition: { meals: [], totalCalories: null, details: [] },
      sleep: null,
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return client;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  const trainingDayInsert = calls.filter(([sql]) => /insert into core\.training_day/i.test(sql)).at(-1);

  assert.ok(calls.some(([sql]) => /insert into core\.activity/i.test(sql)));
  assert.equal(calls.some(([sql]) => /insert into core\.measurement/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.meal/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.sleep/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /delete from core\.(measurement|activity|meal|sleep)/i.test(sql)), false);
  assert.equal(trainingDayInsert[1][3], normalizedBatch.workoutDailySummary.activityCaloriesKcal);
  assert.equal(trainingDayInsert[1][9], true);
  assert.equal(trainingDayInsert[1][10], false);
});

test('persistNormalizedBatch upserts nutrition details without deleting activity or sleep', async () => {
  const { calls, client } = createIncrementalPersistClient({
    activitySummary: { total_activities: 1, total_duration_seconds: 600, training_calories: 120, cycling_distance_km: 0 },
    mealSummary: { intake_calories: 1400 },
    daySummary: {
      workout_duration_minutes: 10,
      active_hours: 1,
      intake_calories: 900,
      nutrition_details_json: ['existing dinner'],
    },
    activityRows: [{
      archived_date: '2026-05-09',
      activity_time: '08:00',
      activity_type: '力量训练',
      raw_type: '力量训练',
      detail: '总消耗120千卡，时长00:10:00',
      calories: 120,
      heart_rate: null,
      distance_km: null,
      avg_speed_kmh: null,
      duration_text: '00:10:00',
      duration_seconds: 600,
    }],
    sleepRows: [{
      archived_date: '2026-05-09',
      sleep_type: '夜间睡眠',
      bedtime: '23:26',
      wake_time: '06:19',
      night_sleep_minutes: 411,
      total_sleep_minutes: 411,
    }],
  });

  await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'nutrition-only',
      measurement: null,
      activities: [],
      workoutDailySummary: null,
      sleep: null,
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return client;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  const trainingDayInsert = calls.filter(([sql]) => /insert into core\.training_day/i.test(sql)).at(-1);

  assert.ok(calls.some(([sql]) => /insert into core\.meal/i.test(sql)));
  assert.equal(calls.some(([sql]) => /insert into core\.activity/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.sleep/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /delete from core\.(measurement|activity|meal|sleep)/i.test(sql)), false);
  assert.equal(trainingDayInsert[1][6], normalizedBatch.nutrition.totalCalories);
  assert.equal(trainingDayInsert[1][7], JSON.stringify(normalizedBatch.nutrition.details));
  assert.equal(trainingDayInsert[1][9], false);
  assert.equal(trainingDayInsert[1][10], true);
});

test('persistNormalizedBatch upserts sleep without deleting nutrition details', async () => {
  const { calls, client } = createIncrementalPersistClient({
    activitySummary: { total_activities: 1, total_duration_seconds: 600, training_calories: 120, cycling_distance_km: 0 },
    mealSummary: { intake_calories: 900 },
    daySummary: {
      workout_duration_minutes: 10,
      active_hours: 1,
      intake_calories: 900,
      nutrition_details_json: ['existing dinner'],
    },
    activityRows: [{
      archived_date: '2026-06-03',
      activity_time: '08:00',
      activity_type: '力量训练',
      raw_type: '力量训练',
      detail: '总消耗120千卡，时长00:10:00',
      calories: 120,
      heart_rate: null,
      distance_km: null,
      avg_speed_kmh: null,
      duration_text: '00:10:00',
      duration_seconds: 600,
    }],
    mealRows: [{
      archived_date: '2026-06-03',
      meal_name: '晚餐',
      calories: 900,
      recommended_min: 300,
      recommended_max: 700,
    }],
  });

  await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'sleep-only',
      archivedDate: '2026-06-03',
      measurement: null,
      activities: [],
      workoutDailySummary: null,
      nutrition: { meals: [], totalCalories: null, details: [] },
      sleep: {
        records: [
          {
            sleepType: '夜间睡眠',
            bedtime: '23:26',
            wakeTime: '06:19',
            nightSleepMinutes: 411,
            totalSleepMinutes: 411,
          },
        ],
      },
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return client;
    },
    processedAt: new Date('2026-06-04T00:00:00.000Z'),
  });

  const trainingDayInsert = calls.filter(([sql]) => /insert into core\.training_day/i.test(sql)).at(-1);

  assert.ok(calls.some(([sql]) => /insert into core\.sleep/i.test(sql)));
  assert.equal(calls.some(([sql]) => /insert into archive\.training_sleep/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.measurement/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.activity/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.meal/i.test(sql)), false);
  assert.ok(calls.some(([sql]) => /delete from core\.sleep/i.test(sql)));
  assert.equal(calls.some(([sql]) => /delete from core\.(measurement|activity|meal)(?!\w)/i.test(sql)), false);
  assert.match(trainingDayInsert[0], /existing_day/i);
  assert.match(trainingDayInsert[0], /sleep_summary/i);
  assert.match(trainingDayInsert[0], /sleep_total_minutes/i);
  assert.match(trainingDayInsert[0], /sleep_start_time/i);
  assert.equal(trainingDayInsert[1][9], false);
  assert.equal(trainingDayInsert[1][10], false);
});

test('persistNormalizedBatch refreshes core training day summary with one CTE upsert', async () => {
  const { calls, client } = createIncrementalPersistClient({
    activitySummary: { total_activities: 1, total_duration_seconds: 600, training_calories: 120, cycling_distance_km: 0 },
    mealSummary: { intake_calories: 900 },
    daySummary: {
      workout_duration_minutes: 10,
      active_hours: 1,
      intake_calories: 900,
      nutrition_details_json: ['existing dinner'],
    },
  });

  await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'summary-cte',
      measurement: null,
      activities: [],
      workoutDailySummary: null,
      nutrition: { meals: [], totalCalories: null, details: [] },
      sleep: null,
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return client;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  const trainingDayInsert = calls.filter(([sql]) => /insert into core\.training_day/i.test(sql)).at(-1);
  const oldSummaryReads = calls.filter(([sql]) =>
    (/^\s*select[\s\S]*count\(\*\)::integer as total_activities/i.test(sql)) ||
    (/^\s*select\s+coalesce\(sum\(calories\), 0\)::integer as intake_calories/i.test(sql)) ||
    (/^\s*select\s+workout_duration_minutes/i.test(sql) && /from core\.training_day/i.test(sql))
  );

  assert.ok(trainingDayInsert);
  assert.match(trainingDayInsert[0], /with\s+activity_summary/i);
  assert.match(trainingDayInsert[0], /meal_summary/i);
  assert.match(trainingDayInsert[0], /existing_day/i);
  assert.match(trainingDayInsert[0], /case\s+when\s+\$10::boolean/i);
  assert.match(trainingDayInsert[0], /case\s+when\s+\$11::boolean/i);
  assert.equal(oldSummaryReads.length, 0);
  assert.equal(trainingDayInsert[1][9], false);
  assert.equal(trainingDayInsert[1][10], false);
});

test('persistNormalizedBatch stores sleep payload in core without writing archive sleep', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'single-sleep-sql',
      archivedDate: '2026-06-03',
      measurement: null,
      activities: [],
      workoutDailySummary: {},
      nutrition: { meals: [], totalCalories: null, details: [] },
      sleep: {
        records: [
          {
            sleepType: '夜间睡眠',
            bedtime: '23:26',
            wakeTime: '06:19',
            nightSleepMinutes: 411,
            totalSleepMinutes: 411,
            deepSleepMinutes: 145,
            lightSleepMinutes: 195,
            remSleepMinutes: 71,
            sleepStageDetail: ['深睡 2小时25分钟', '浅睡 3小时15分钟'],
            sleepScore: 81,
            sleepScorePercentile: 77,
            deepSleepRatioPct: 35,
            lightSleepRatioPct: 47,
            remSleepRatioPct: 18,
            deepSleepContinuityScore: 85,
            wakeCount: 1,
            breathingQualityScore: 98,
            averageHeartRateBpm: 68,
            hrvMs: 34,
            averageSpo2Pct: 97,
            averageRespiratoryRate: 14,
            analysisText: '睡眠质量良好。',
            suggestionText: '建议睡觉时关灯。',
          },
        ],
      },
      recognitions: [],
      messages: [],
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-06-04T00:00:00.000Z'),
  });

  const trainingDayInsert = calls.filter(([sql]) => /insert into core\.training_day/i.test(sql)).at(-1);
  const sleepInsert = calls.find(([sql]) => /insert into core\.sleep/i.test(sql));
  const archiveSleepInsert = calls.find(([sql]) => /insert into archive\.training_sleep/i.test(sql));
  const archiveSnapshotInsert = calls.find(([sql]) => /insert into archive\.training_parse_snapshot/i.test(sql));
  const ingestBatchInsert = calls.find(([sql]) => /insert into ingest\.telegram_batch/i.test(sql));

  assert.ok(trainingDayInsert);
  assert.ok(sleepInsert);
  assert.equal(archiveSleepInsert, undefined);
  assert.equal(archiveSnapshotInsert, undefined);
  assert.ok(ingestBatchInsert);
  assert.match(sleepInsert[0], /\$16::text\[\]/i);
  assert.doesNotMatch(sleepInsert[0], /sleep_stage_detail[\s\S]*jsonb\[\]/i);
  assert.equal(sleepInsert[1][0][0], createHash('md5').update('2026-06-03|夜间睡眠|23:26|06:19').digest('hex'));
  assert.deepEqual(sleepInsert[1][1], ['2026-06-03']);
  assert.deepEqual(sleepInsert[1][7], [411]);
  assert.deepEqual(sleepInsert[1][8], [411]);
  assert.deepEqual(sleepInsert[1][10], [145]);
  assert.deepEqual(sleepInsert[1][16], [81]);
  assert.deepEqual(sleepInsert[1][17], [77]);
  assert.deepEqual(sleepInsert[1][24], [68]);
  assert.deepEqual(sleepInsert[1][29], ['建议睡觉时关灯。']);
  assert.equal(trainingDayInsert[1].length, 11);
  assert.equal(JSON.parse(ingestBatchInsert[1][9]).sleep.records[0].totalSleepMinutes, 411);
  const sleepCleanup = calls.find(([sql]) => /delete from core\.sleep/i.test(sql));
  assert.ok(sleepCleanup);
  assert.match(sleepCleanup[0], /coalesce\(existing\.bedtime, ''\) = coalesce\(incoming\.bedtime, ''\)/i);
  assert.deepEqual(sleepCleanup[1][0], ['2026-06-03']);
  assert.deepEqual(sleepCleanup[1][1], ['夜间睡眠']);
  assert.deepEqual(sleepCleanup[1][2], ['23:26']);
  assert.deepEqual(sleepCleanup[1][3], ['06:19']);
  assert.equal(calls.some(([sql]) => /delete from core\.(measurement|activity|meal)(?!\w)/i.test(sql)), false);
});

test('persistNormalizedBatch merges an existing core day using only schema-defined columns', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-06-03',
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
      if (/from core\.measurement/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.activity/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.meal/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.sleep/i.test(sql)) {
        return {
          rows: [
            {
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
              sleep_stage_text: null,
              sleep_stage_detail: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  await persistNormalizedBatch({
    batch: {
      ...normalizedBatch,
      batchId: 'single-food-after-sleep',
      archivedDate: '2026-06-03',
      measurement: null,
      activities: [],
      workoutDailySummary: {},
      nutrition: {
        meals: [{ name: '早餐', calories: 500, recommendedMin: 400, recommendedMax: 700 }],
        totalCalories: 500,
        details: ['早餐 500 千卡'],
      },
      sleep: null,
      recognitions: [],
      messages: [],
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-06-04T00:00:00.000Z'),
  });

  const trainingDayInsert = calls.filter(([sql]) => /insert into core\.training_day/i.test(sql)).at(-1);

  assert.ok(trainingDayInsert);
  assert.equal(calls.some(([sql]) => /archive\.training_sleep/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.sleep/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /delete from core\.sleep/i.test(sql)), false);
  assert.equal(trainingDayInsert[1].length, 11);
});

test('backfillCoreSleepFromIngestBatchesClient does not write archive sleep without source hash', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from ingest\.telegram_batch b/i.test(sql)) {
        return {
          rows: [
            {
              batch_id: 'single-36',
              batch_payload_json: {
                kind: 'image',
                batchId: 'single-36',
                status: 'ready',
                archivedDate: '2026-06-04',
                measurement: null,
                activities: [],
                workoutDailySummary: null,
                nutrition: { meals: [], totalCalories: null, details: [] },
                sleep: {
                  records: [
                    {
                      sleepType: '夜间睡眠',
                      bedtime: '23:26',
                      wakeTime: '06:19',
                      totalSleepMinutes: 411,
                    },
                  ],
                  totalSleepMinutes: 411,
                },
              },
            },
          ],
        };
      }
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
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
      if (/from core\.measurement/i.test(sql) || /from core\.activity/i.test(sql) || /from core\.meal/i.test(sql) || /from core\.sleep/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const result = await backfillCoreSleepFromIngestBatchesClient(fakeClient, {
    processedAt: new Date('2026-06-04T09:00:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.equal(calls.some(([sql]) => /insert into core\.sleep/i.test(sql)), true);
  assert.equal(calls.some(([sql]) => /insert into archive\.training_sleep/i.test(sql)), false);
});

test('backfillCoreSleepFromIngestBatchesClient repairs stored sleep batches missing core sleep rows', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from ingest\.telegram_batch b/i.test(sql)) {
        return {
          rows: [
            {
              batch_id: 'single-36',
              batch_payload_json: {
                kind: 'image',
                batchId: 'single-36',
                status: 'ready',
                archivedDate: '2026-06-04',
                measurement: null,
                activities: [],
                workoutDailySummary: null,
                nutrition: { meals: [], totalCalories: null, details: [] },
                sleep: {
                  records: [
                    {
                      sleepType: '夜间睡眠',
                      bedtime: '23:26',
                      wakeTime: '06:19',
                      nightSleepMinutes: 411,
                      totalSleepMinutes: 411,
                      deepSleepMinutes: 145,
                      lightSleepMinutes: 195,
                      remSleepMinutes: 71,
                    },
                  ],
                  totalSleepMinutes: 411,
                  nightSleepMinutes: 411,
                  sleepStartTime: '23:26',
                  sleepEndTime: '06:19',
                  deepSleepMinutes: 145,
                  lightSleepMinutes: 195,
                  remSleepMinutes: 71,
                },
              },
            },
          ],
        };
      }
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
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
      if (/from core\.measurement/i.test(sql) || /from core\.activity/i.test(sql) || /from core\.meal/i.test(sql) || /from core\.sleep/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const result = await backfillCoreSleepFromIngestBatchesClient(fakeClient, {
    processedAt: new Date('2026-06-04T09:00:00.000Z'),
  });
  const sleepInsert = calls.find(([sql]) => /insert into core\.sleep/i.test(sql));

  assert.equal(result.status, 'stored');
  assert.equal(result.batchesBackfilled, 1);
  assert.deepEqual(result.daysBackfilled, ['2026-06-04']);
  assert.ok(calls.some(([sql]) => sql === 'BEGIN'));
  assert.ok(calls.some(([sql]) => sql === 'COMMIT'));
  assert.ok(sleepInsert);
  assert.deepEqual(sleepInsert[1][8], [411]);
  assert.deepEqual(sleepInsert[1][10], [145]);
});

test('backfillCoreSleepFromIngestBatchesClient replays latest ingest sleep batches for existing core sleep rows', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from ingest\.telegram_batch b/i.test(sql)) {
        if (/not exists[\s\S]*from core\.sleep/i.test(sql)) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              batch_id: 'old-wrong-sleep',
              batch_payload_json: {
                status: 'ready',
                archivedDate: '2026-06-29',
                sleep: {
                  records: [{
                    sleepType: '夜间睡眠',
                    bedtime: '23:48',
                    wakeTime: '06:34',
                    nightSleepMinutes: 267,
                    totalSleepMinutes: 267,
                  }],
                },
              },
            },
            {
              batch_id: 'new-correct-sleep',
              batch_payload_json: {
                status: 'ready',
                archivedDate: '2026-06-29',
                sleep: {
                  records: [{
                    sleepType: '夜间睡眠',
                    bedtime: '23:48',
                    wakeTime: '06:34',
                    nightSleepMinutes: 387,
                    totalSleepMinutes: 387,
                  }],
                },
              },
            },
          ],
        };
      }
      if (/from archive\.training_sleep\s+a/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [{
            archived_date: '2026-06-29',
            total_activities: 0,
            total_duration_seconds: 0,
            training_calories: 0,
            workout_duration_minutes: null,
            active_hours: null,
            cycling_distance_km: 0,
            intake_calories: null,
            nutrition_details_json: [],
          }],
        };
      }
      if (/from core\.measurement/i.test(sql) || /from core\.activity/i.test(sql) || /from core\.meal/i.test(sql) || /from core\.sleep/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const result = await backfillCoreSleepFromIngestBatchesClient(fakeClient, {
    processedAt: new Date('2026-06-30T00:30:00.000Z'),
  });
  const sleepInserts = calls.filter(([sql]) => /insert into core\.sleep/i.test(sql));

  assert.equal(result.status, 'stored');
  assert.equal(result.batchesBackfilled, 2);
  assert.deepEqual(result.daysBackfilled, ['2026-06-29']);
  assert.equal(calls.some(([sql]) => /from ingest\.telegram_batch b[\s\S]*not exists[\s\S]*from core\.sleep/i.test(sql)), false);
  assert.equal(sleepInserts.length, 2);
  assert.deepEqual(sleepInserts.at(-1)[1][7], [387]);
  assert.deepEqual(sleepInserts.at(-1)[1][8], [387]);
});

test('backfillCoreSleepFromIngestBatchesClient creates core day from archive-only sleep rows', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from ingest\.telegram_batch b/i.test(sql)) {
        return { rows: [] };
      }
      if (/from archive\.training_sleep\s+a/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-06-04',
              batch_payload_json: {
                status: 'ready',
                archivedDate: '2026-06-04',
                sleep: {
                  records: [
                    {
                      sleepType: '夜间睡眠',
                      bedtime: '22:06',
                      wakeTime: '05:59',
                      nightSleepMinutes: 473,
                      totalSleepMinutes: 473,
                      deepSleepMinutes: 62,
                      lightSleepMinutes: 281,
                      remSleepMinutes: 85,
                      awakeMinutes: 45,
                      deepSleepRatioPct: 18,
                      lightSleepRatioPct: 63,
                      remSleepRatioPct: 19,
                    },
                  ],
                  totalSleepMinutes: 473,
                  nightSleepMinutes: 473,
                  sleepStartTime: '22:06',
                  sleepEndTime: '05:59',
                  deepSleepMinutes: 62,
                  lightSleepMinutes: 281,
                  remSleepMinutes: 85,
                  awakeMinutes: 45,
                  deepSleepRatioPct: 18,
                  lightSleepRatioPct: 63,
                  remSleepRatioPct: 19,
                },
              },
            },
          ],
        };
      }
      if (/from core\.training_day\s+where archived_date = \$1/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const result = await backfillCoreSleepFromIngestBatchesClient(fakeClient, {
    processedAt: new Date('2026-06-05T09:45:00.000Z'),
  });
  const dayInsert = calls.find(([sql]) => /insert into core\.training_day/i.test(sql));
  const sleepInsert = calls.find(([sql]) => /insert into core\.sleep/i.test(sql));

  assert.equal(result.status, 'stored');
  assert.deepEqual(result.daysBackfilled, ['2026-06-04']);
  assert.ok(dayInsert);
  assert.ok(sleepInsert);
  assert.deepEqual(dayInsert[1][0], ['2026-06-04']);
  assert.deepEqual(dayInsert[1][9], [null]);
  assert.deepEqual(sleepInsert[1][8], [473]);
  assert.deepEqual(sleepInsert[1][10], [62]);
});

test('pending recognition store reads, queues, and resolves database rows', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from ingest\.telegram_pending_batch/i.test(sql)) {
        return {
          rows: [
            {
              batch_id: 'single-383',
              kind: 'image',
              batch_payload_json: {
                kind: 'image',
                batchId: 'single-383',
                messages: [{ messageId: 383, photos: [{ fileId: 'file-food-383' }] }],
              },
              failure_category: 'ai_service',
              failure_reason: 'invalid JSON',
              attempt_count: 1,
              next_retry_at: '2026-05-31T03:10:00.000Z',
              last_failed_at: '2026-05-31T03:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };
  const env = {
    TRAINING_DB_ENABLED: 'true',
    TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
  };
  const createClient = () => fakeClient;

  const pending = await readPendingRecognitionBatches({
    env,
    createClient,
    now: new Date('2026-05-31T03:11:00.000Z'),
  });
  const queued = await appendPendingRecognitionBatch({
    env,
    createClient,
    now: new Date('2026-05-31T03:12:00.000Z'),
    nextRetryAt: new Date('2026-05-31T03:22:00.000Z'),
    batch: {
      kind: 'image',
      batchId: 'single-384',
      messages: [{ messageId: 384, photos: [{ fileId: 'file-food-384' }] }],
    },
    failureCategory: 'ai_service',
    error: 'telegram_training_image returned invalid JSON',
  });
  const resolved = await markPendingRecognitionResolved({
    env,
    createClient,
    now: new Date('2026-05-31T03:30:00.000Z'),
    batchId: 'single-384',
  });

  assert.equal(pending.length, 1);
  assert.equal(pending[0].batchId, 'single-383');
  assert.equal(queued.status, 'queued');
  assert.equal(resolved.status, 'resolved');
  assert.ok(calls.some(([sql]) => /insert into ingest\.telegram_pending_batch/i.test(sql)));
  assert.ok(
    calls.some(([sql]) =>
      /update ingest\.telegram_pending_batch/i.test(sql) &&
      /set\s+status\s*=\s*'resolved'/i.test(sql),
    ),
  );
});

test('appendPendingRecognitionBatch writes failed AI call log best-effort', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select status\s+from ingest\.telegram_pending_batch/i.test(sql)) {
        return { rows: [{ status: 'pending' }] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const now = new Date('2026-05-31T03:12:00.000Z');
  const result = await appendPendingRecognitionBatch({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient: () => fakeClient,
    now,
    nextRetryAt: new Date('2026-05-31T03:22:00.000Z'),
    batch: {
      kind: 'image',
      batchId: 'single-ai-failed-log',
      sourceChannel: 'telegram',
      messages: [
        {
          messageId: 384,
          chatId: 42,
          photos: [{ fileId: 'file-food-384', fileUniqueId: 'uniq-food-384' }],
        },
      ],
      recognitionErrors: [
        {
          messageId: 384,
          error: 'AI recognition failed with HTTP 429: rate limit',
          failureCategory: 'ai_service',
          provider: 'openai-compatible',
          model: 'gpt-primary',
          promptVersion: '2026-05-24',
          aiIdempotencyKey: 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:uniq-food-384:abc123',
          aiLatencyMs: 4567,
        },
      ],
    },
    failureCategory: 'ai_service',
    error: 'AI recognition failed with HTTP 429: rate limit',
  });

  const aiLogCall = calls.find(([sql]) => /insert into ingest\.ai_call_log/i.test(sql));

  assert.equal(result.status, 'queued');
  assert.ok(aiLogCall);
  assert.match(aiLogCall[1][0], /^ai-call:recognition:/);
  assert.equal(aiLogCall[1][1], 'single-ai-failed-log');
  assert.equal(aiLogCall[1][2], 'recognition');
  assert.equal(aiLogCall[1][3], 'openai-compatible');
  assert.equal(aiLogCall[1][4], 'gpt-primary');
  assert.equal(aiLogCall[1][5], '2026-05-24');
  assert.equal(aiLogCall[1][6], 'recognition:telegram_training_image:v2:2026-05-24:gpt-primary:uniq-food-384:abc123');
  assert.equal(aiLogCall[1][7], 'failed');
  assert.equal(aiLogCall[1][8], 4567);
  assert.equal(aiLogCall[1][9], 'ai_service');
  assert.match(aiLogCall[1][10], /HTTP 429/);
  assert.equal(aiLogCall[1][11], now.toISOString());
  assert.equal(aiLogCall[1][12], now.toISOString());
});

test('appendPendingRecognitionBatch keeps queued result when failed AI call log write fails', async () => {
  const stderrWrite = process.stderr.write;
  const stderrMessages = [];
  process.stderr.write = function write(chunk, ...args) {
    stderrMessages.push(String(chunk));
    if (typeof args.at(-1) === 'function') {
      args.at(-1)();
    }
    return true;
  };

  const fakeClient = {
    async connect() {},
    async query(sql) {
      if (/select status\s+from ingest\.telegram_pending_batch/i.test(sql)) {
        return { rows: [{ status: 'pending' }] };
      }
      if (/insert into ingest\.ai_call_log/i.test(sql)) {
        throw new Error('ai audit table unavailable');
      }
      return { rows: [] };
    },
    async end() {},
  };

  try {
    const result = await appendPendingRecognitionBatch({
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      createClient: () => fakeClient,
      now: new Date('2026-05-31T03:12:00.000Z'),
      batch: {
        kind: 'image',
        batchId: 'single-ai-failed-log-best-effort',
        messages: [{ messageId: 384, photos: [{ fileId: 'file-food-384' }] }],
        recognitionErrors: [
          {
            messageId: 384,
            error: 'AI recognition failed with HTTP 502',
            failureCategory: 'ai_service',
            model: 'gpt-primary',
          },
        ],
      },
      failureCategory: 'ai_service',
      error: 'AI recognition failed with HTTP 502',
    });

    assert.equal(result.status, 'queued');
    assert.equal(result.aiCallLogStatus, 'failed');
    assert.ok(stderrMessages.some((message) => /failed to write failed recognition AI call log/.test(message)));
  } finally {
    process.stderr.write = stderrWrite;
  }
});

test('shouldQueueRecognitionFailure allows non-image database failures to enter pending replay', () => {
  for (const kind of ['thought', 'analysis', 'help']) {
    assert.equal(
      shouldQueueRecognitionFailure({
        kind,
        status: 'ready',
        failureCategory: 'database',
        failureReason: 'database unavailable',
        messages: [{ messageId: 8001, photos: [] }],
      }),
      true,
      `${kind} database failures should be retryable`,
    );
  }

  assert.equal(
    shouldQueueRecognitionFailure({
      kind: 'thought',
      status: 'skipped',
      failureCategory: 'user_input',
      failureReason: 'empty thought body',
      messages: [{ messageId: 8002, photos: [] }],
    }),
    false,
  );
});

test('readPendingRecognitionBatches claims pending rows so concurrent workers do not process the same batch', async () => {
  const calls = [];
  const rows = [
    {
      pending_id: 1,
      batch_id: 'single-concurrent',
      kind: 'image',
      status: 'pending',
      batch_payload_json: {
        kind: 'image',
        batchId: 'single-concurrent',
        messages: [{ messageId: 481, photos: [{ fileId: 'file-concurrent' }] }],
      },
      failure_category: 'ai_service',
      failure_reason: 'primary and fallback failed',
      attempt_count: 2,
      next_retry_at: '2026-05-31T03:10:00.000Z',
      last_failed_at: '2026-05-31T03:00:00.000Z',
    },
  ];
  const env = {
    TRAINING_DB_ENABLED: 'true',
    TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
  };
  const now = new Date('2026-05-31T03:11:00.000Z');
  const claimUntil = new Date('2026-05-31T03:21:00.000Z');
  const createClient = () => ({
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (/for update skip locked/i.test(sql)) {
        const [nowIso, limit, claimUntilIso] = params;
        const claimed = rows
          .filter((row) => row.status === 'pending' && row.next_retry_at <= nowIso)
          .slice(0, limit);
        for (const row of claimed) {
          row.next_retry_at = claimUntilIso;
        }
        return { rows: claimed };
      }
      if (/from ingest\.telegram_pending_batch/i.test(sql)) {
        const [nowIso, limit] = params;
        return {
          rows: rows
            .filter((row) => row.status === 'pending' && row.next_retry_at <= nowIso)
            .slice(0, limit),
        };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  });

  const [firstRead, secondRead] = await Promise.all([
    readPendingRecognitionBatches({ env, createClient, now, claimUntil }),
    readPendingRecognitionBatches({ env, createClient, now, claimUntil }),
  ]);
  const claimedBatchIds = [...firstRead, ...secondRead].map((entry) => entry.batchId);

  assert.deepEqual(claimedBatchIds, ['single-concurrent']);
  assert.ok(calls.some(([sql]) => sql === 'BEGIN'));
  assert.ok(calls.some(([sql]) => sql === 'COMMIT'));
  assert.ok(calls.some(([sql]) => /for update skip locked/i.test(sql)));
});

test('readPendingRecognitionSummary reads pending metrics without claiming rows', async () => {
  const calls = [];
  const env = {
    TRAINING_DB_ENABLED: 'true',
    TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
  };
  const createClient = () => ({
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params = []) {
      calls.push([sql, params]);
      assert.doesNotMatch(sql, /\bupdate\b/i);
      assert.doesNotMatch(sql, /for update/i);
      return {
        rows: [
          {
            batch_id: 'pending-old',
            kind: 'image',
            failure_category: 'database',
            failure_reason: 'database unavailable',
            attempt_count: 25,
            next_retry_at: '2026-06-20T00:10:00.000Z',
            last_failed_at: '2026-06-20T00:00:00.000Z',
            created_at: '2026-06-19T23:00:00.000Z',
            updated_at: '2026-06-20T00:00:00.000Z',
          },
        ],
      };
    },
    async end() {
      calls.push(['end']);
    },
  });

  const pending = await readPendingRecognitionSummary({ env, createClient, limit: 1000 });

  assert.deepEqual(pending, [
    {
      batchId: 'pending-old',
      kind: 'image',
      failureCategory: 'database',
      failureReason: 'database unavailable',
      attemptCount: 25,
      nextRetryAt: '2026-06-20T00:10:00.000Z',
      lastFailedAt: '2026-06-20T00:00:00.000Z',
      createdAt: '2026-06-19T23:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
    },
  ]);
  assert.equal(calls.some(([sql]) => sql === 'BEGIN' || sql === 'COMMIT'), false);
  assert.ok(calls.some(([sql]) => /from ingest\.telegram_pending_batch/i.test(sql)));
});

test('readPendingRecognitionBatches abandons retry rows over the attempt limit before claiming work', async () => {
  const calls = [];
  const rows = [
    {
      pending_id: 1,
      batch_id: 'single-abandoned',
      kind: 'image',
      status: 'pending',
      batch_payload_json: {
        kind: 'image',
        batchId: 'single-abandoned',
        messages: [{ messageId: 482, photos: [{ fileId: 'file-abandoned' }] }],
      },
      failure_category: 'ai_service',
      failure_reason: 'primary and fallback failed',
      attempt_count: 26,
      next_retry_at: '2026-05-31T03:10:00.000Z',
      last_failed_at: '2026-05-31T03:00:00.000Z',
    },
    {
      pending_id: 2,
      batch_id: 'single-claimable',
      kind: 'image',
      status: 'pending',
      batch_payload_json: {
        kind: 'image',
        batchId: 'single-claimable',
        messages: [{ messageId: 483, photos: [{ fileId: 'file-claimable' }] }],
      },
      failure_category: 'ai_service',
      failure_reason: 'temporary timeout',
      attempt_count: 2,
      next_retry_at: '2026-05-31T03:10:00.000Z',
      last_failed_at: '2026-05-31T03:00:00.000Z',
    },
  ];
  const env = {
    TRAINING_DB_ENABLED: 'true',
    TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
  };
  const now = new Date('2026-05-31T03:11:00.000Z');
  const createClient = () => ({
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (/status = 'abandoned'/i.test(sql)) {
        const [, , , retryLimit] = params;
        for (const row of rows) {
          if (row.status === 'pending' && row.attempt_count > retryLimit) {
            row.status = 'abandoned';
          }
        }
      }
      if (/for update skip locked/i.test(sql)) {
        const [nowIso, limit, claimUntilIso] = params;
        const claimed = rows
          .filter((row) => row.status === 'pending' && row.next_retry_at <= nowIso)
          .slice(0, limit);
        for (const row of claimed) {
          row.next_retry_at = claimUntilIso;
        }
        return { rows: claimed };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  });

  const pending = await readPendingRecognitionBatches({
    env,
    createClient,
    now,
    retryLimit: 25,
  });

  assert.deepEqual(pending.map((entry) => entry.batchId), ['single-claimable']);
  assert.equal(rows[0].status, 'abandoned');
  assert.ok(calls.some(([sql]) => /status = 'abandoned'/i.test(sql)));
});

test('appendPendingRecognitionBatch does not reactivate abandoned pending rows', async () => {
  const calls = [];
  const row = { batch_id: 'single-abandoned', status: 'abandoned', attempt_count: 26 };
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (/insert into ingest\.telegram_pending_batch/i.test(sql)) {
        assert.match(sql, /where\s+ingest\.telegram_pending_batch\.status\s+<>\s+'abandoned'/i);
        return { rows: [] };
      }
      if (/select status\s+from ingest\.telegram_pending_batch/i.test(sql)) {
        return { rows: [{ status: row.status }] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await appendPendingRecognitionBatch({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    batch: {
      kind: 'image',
      batchId: 'single-abandoned',
      messages: [{ messageId: 484, photos: [{ fileId: 'file-abandoned' }] }],
    },
    failureCategory: 'ai_service',
    error: 'still failing',
    now: new Date('2026-05-31T03:20:00.000Z'),
  });

  assert.equal(result.status, 'abandoned');
  assert.equal(result.batchId, 'single-abandoned');
  assert.equal(result.aiCallLogStatus, 'skipped');
  assert.ok(calls.some(([sql]) => /select status\s+from ingest\.telegram_pending_batch/i.test(sql)));
});

test('persistNormalizedBatch can merge an existing core day without failing on body feedback reads', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.training_day\s+where archived_date = \$1/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-05-09',
              total_activities: 1,
              total_duration_seconds: 600,
              training_calories: 120,
              workout_duration_minutes: 10,
              active_hours: 1,
              cycling_distance_km: 0,
              intake_calories: 800,
              nutrition_details_json: [],
            },
          ],
        };
      }
      if (/from core\.measurement\s+where archived_date = \$1/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.activity\s+where archived_date = \$1/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.meal\s+where archived_date = \$1/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: normalizedBatch,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.equal(calls.some(([sql]) => /insert into core\.training_day/i.test(sql)), true);
  assert.equal(calls.at(-1)[0], 'end');
});

test('persistNormalizedBatch rolls back the transaction when a core write fails', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      if (/insert into core\.training_day/i.test(sql)) {
        throw new Error('core write failed');
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  await assert.rejects(
    async () => {
      try {
        await persistNormalizedBatch({
          batch: normalizedBatch,
          env: {
            TRAINING_DB_ENABLED: 'true',
            TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
          },
          createClient() {
            return fakeClient;
          },
          processedAt: new Date('2026-05-13T00:00:00.000Z'),
        });
      } catch (error) {
        assert.equal(error.persistenceResult.status, 'failed');
        assert.equal(error.persistenceResult.rollbackStatus, 'succeeded');
        assert.match(error.persistenceResult.transactionId, /^dbtx_[a-f0-9]{16}$/);
        assert.doesNotMatch(JSON.stringify(error.persistenceResult), /postgresql:\/\/|training_writer|secret|insert into|core write failed/i);
        throw error;
      }
    },
    /core write failed/,
  );

  const statements = calls.map(([sql]) => sql);
  assert.equal(statements.includes('BEGIN'), true);
  assert.equal(statements.includes('ROLLBACK'), true);
  assert.equal(statements.includes('COMMIT'), false);
  assert.equal(calls.at(-1)[0], 'end');
  assert.ok(calls.some(([sql]) => /insert into ingest\.telegram_batch/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into core\.training_day/i.test(sql)));
});

test('persistNormalizedBatch preserves the original error when rollback fails', async () => {
  const calls = [];
  const stderrWrite = process.stderr.write;
  const stderrMessages = [];
  process.stderr.write = function write(chunk, ...args) {
    stderrMessages.push(String(chunk));
    if (typeof args.at(-1) === 'function') {
      args.at(-1)();
    }
    return true;
  };

  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/insert into core\.training_day/i.test(sql)) {
        throw new Error('core write failed');
      }
      if (sql === 'ROLLBACK') {
        throw new Error('rollback failed');
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  try {
    await assert.rejects(
      persistNormalizedBatch({
        batch: normalizedBatch,
        env: {
          TRAINING_DB_ENABLED: 'true',
          TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
        },
        createClient() {
          return fakeClient;
        },
        processedAt: new Date('2026-05-13T00:00:00.000Z'),
      }),
      /core write failed/,
    );
  } finally {
    process.stderr.write = stderrWrite;
  }

  const statements = calls.map(([sql]) => sql);
  assert.equal(statements.includes('ROLLBACK'), true);
  assert.equal(calls.at(-1)[0], 'end');
  assert.ok(stderrMessages.some((message) => /rollback failed after persistNormalizedBatch error/.test(message)));
});

test('persistNormalizedBatch returns unchanged from atomic batch upsert when payload hash matches', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        throw new Error('payload hash check must be atomic with batch upsert');
      }
      if (/insert into ingest\.telegram_batch/i.test(sql)) {
        assert.match(sql, /where\s+ingest\.telegram_batch\.payload_hash\s+<>\s+excluded\.payload_hash/i);
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: normalizedBatch,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'unchanged');
  assert.equal(result.batchId, normalizedBatch.batchId);
  assert.equal(result.reason, 'payload_hash_unchanged');
  assert.match(result.transactionId, /^dbtx_[a-f0-9]{16}$/);
  assert.equal(result.persistenceResult.status, 'unchanged');
  assert.equal(result.persistenceResult.reason, 'payload_hash_unchanged');
  assert.equal(result.persistenceResult.rollbackStatus, 'not_needed');
  const statements = calls.map(([sql]) => sql);
  const beginIndex = statements.indexOf('BEGIN');
  const batchUpsertIndex = calls.findIndex(([sql]) => /insert into ingest\.telegram_batch/i.test(sql));
  const rollbackIndex = statements.indexOf('ROLLBACK');
  assert.notEqual(batchUpsertIndex, -1);
  assert.ok(beginIndex < batchUpsertIndex);
  assert.ok(batchUpsertIndex < rollbackIndex);
  assert.equal(calls.some(([sql]) => /insert into core\.training_day/i.test(sql)), false);
  assert.equal(calls.at(-1)[0], 'end');
});

test('persistNormalizedBatch mirrors thought create, edit, and delete batches into core.thought', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return { rows: [{ telegram_message_id: params[0] }] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };
  const env = {
    TRAINING_DB_ENABLED: 'true',
    TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
  };
  const processedAt = new Date('2026-05-14T03:00:00.000Z');

  await persistNormalizedBatch({
    batch: {
      kind: 'thought',
      batchId: 'thought-501',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [901],
      recognitions: [],
      messages: [
        {
          updateId: 901,
          messageId: 501,
          mediaGroupId: null,
          chatId: 42,
          caption: '',
          text: '/thought 今天训练后臀部发力更明显',
          dateUnix: 1778725800,
          photos: [],
        },
      ],
      thought: {
        command: '/thought',
        body: '今天训练后臀部发力更明显',
        thoughtModule: 'misc',
        tags: ['训练', '随想', 'Telegram'],
        telegramMessageId: 501,
        telegramChatId: 42,
        messageDateUnix: 1778725800,
        storage: {
          markdownPath: 'source/_posts/2026-05-14-telegram-thought-501.md',
          photoPaths: ['/images/thoughts/2026/05/2026-05-14-telegram-thought-501-1.jpg'],
        },
      },
    },
    env,
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  await persistNormalizedBatch({
    batch: {
      kind: 'thought_edit',
      batchId: 'thought-edit-132',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [902],
      recognitions: [],
      messages: [
        {
          updateId: 902,
          messageId: 132,
          mediaGroupId: null,
          chatId: 42,
          caption: '/随想编 501 更新后的正文',
          text: '',
          dateUnix: 1778812200,
          photos: [],
        },
      ],
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: 501,
        body: '更新后的正文',
        thoughtModule: 'misc',
        tags: ['杂七杂八', '随想', 'Telegram'],
        replacePhotos: false,
        telegramChatId: 42,
        messageDateUnix: 1778812200,
        storage: {
          markdownPath: 'source/_posts/2026-05-14-telegram-thought-501.md',
          photoPaths: [],
        },
      },
    },
    env,
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  await persistNormalizedBatch({
    batch: {
      kind: 'thought_delete',
      batchId: 'thought-delete-801',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [903],
      recognitions: [],
      messages: [
        {
          updateId: 903,
          messageId: 801,
          mediaGroupId: null,
          chatId: 42,
          caption: '',
          text: '/随想删 501',
          dateUnix: 1778898600,
          photos: [],
        },
      ],
      thoughtDelete: {
        command: '/随想删',
        targetMessageId: 501,
        telegramChatId: 42,
        messageDateUnix: 1778898600,
        storage: {
          markdownPath: 'source/_posts/2026-05-14-telegram-thought-501.md',
          deletedPhotoPaths: ['/images/thoughts/2026/05/2026-05-14-telegram-thought-501-1.jpg'],
        },
      },
    },
    env,
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  await persistNormalizedBatch({
    batch: {
      kind: 'thought_move',
      batchId: 'thought-move-133',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [904],
      recognitions: [],
      messages: [
        {
          updateId: 904,
          messageId: 133,
          mediaGroupId: null,
          chatId: 42,
          caption: '',
          text: '/移动 501 杂七杂八',
          dateUnix: 1778985000,
          photos: [],
        },
      ],
      thoughtMove: {
        command: '/移动',
        targetMessageId: 501,
        thoughtModule: 'misc',
        tags: ['杂七杂八', '随想', 'Telegram'],
        telegramChatId: 42,
        messageDateUnix: 1778985000,
        storage: {
          markdownPath: 'source/_posts/2026-05-14-telegram-thought-501.md',
          photoPaths: [],
        },
      },
    },
    env,
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  await persistNormalizedBatch({
    batch: {
      kind: 'thought_edit',
      batchId: 'thought-edit-134',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [905],
      recognitions: [],
      messages: [
        {
          updateId: 905,
          messageId: 134,
          mediaGroupId: null,
          chatId: 42,
          caption: '',
          text: '更新正文但不改模块',
          dateUnix: 1779071400,
          photos: [],
        },
      ],
      thoughtEdit: {
        command: '/thought',
        targetMessageId: 501,
        body: '更新正文但不改模块',
        thoughtModule: null,
        replacePhotos: false,
        telegramChatId: 42,
        messageDateUnix: 1779071400,
        storage: {
          markdownPath: null,
          photoPaths: null,
        },
      },
    },
    env,
    createClient() {
      return fakeClient;
    },
    processedAt,
  });

  const thoughtWrites = calls.filter(
    ([sql]) => typeof sql === 'string' && /insert into core\.thought/i.test(sql),
  );
  assert.equal(thoughtWrites.length, 5);
  assert.equal(thoughtWrites[0][1][0], 501);
  assert.equal(thoughtWrites[0][1][3], 'telegram');
  assert.equal(thoughtWrites[0][1][5], '今天训练后臀部发力更明显');
  assert.equal(thoughtWrites[0][1][6], 'misc');
  assert.equal(thoughtWrites[0][1][9], 'source/_posts/2026-05-14-telegram-thought-501.md');
  assert.deepEqual(JSON.parse(thoughtWrites[0][1][10]), [
    '/images/thoughts/2026/05/2026-05-14-telegram-thought-501-1.jpg',
  ]);
  assert.equal(thoughtWrites[1][1][5], '更新后的正文');
  assert.equal(thoughtWrites[1][1][6], 'misc');
  assert.equal(thoughtWrites[1][1][10], '[]');
  assert.match(thoughtWrites[2][0], /status = excluded\.status/i);
  assert.deepEqual(JSON.parse(thoughtWrites[2][1][9]), [
    '/images/thoughts/2026/05/2026-05-14-telegram-thought-501-1.jpg',
  ]);
  assert.equal(thoughtWrites[3][1][5], null);
  assert.equal(thoughtWrites[3][1][6], 'misc');
  assert.equal(thoughtWrites[4][1][5], '更新正文但不改模块');
  assert.equal(thoughtWrites[4][1][6], null);
  assert.equal(thoughtWrites[4][1][7], null);
});

test('persistNormalizedBatch reports missing thought edit targets without inserting a core thought', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
      if (/from core\.thought/i.test(sql) && /where telegram_message_id = \$1/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: {
      kind: 'thought_edit',
      batchId: 'thought-edit-999',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [909],
      recognitions: [],
      messages: [
        {
          updateId: 909,
          messageId: 999,
          mediaGroupId: null,
          chatId: 42,
          caption: '',
          text: '/随想编 501 杂七杂八 编辑并移动后的正文',
          dateUnix: 1781514900,
          photos: [],
        },
      ],
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: 501,
        body: '编辑并移动后的正文',
        thoughtModule: 'misc',
        tags: ['杂七杂八', '随想', 'Telegram'],
        replacePhotos: false,
        telegramChatId: 42,
        messageDateUnix: 1781514900,
        storage: {
          writeStatus: 'thought_edit_database_only',
          markdownPath: null,
          photoPaths: null,
        },
      },
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-06-15T09:15:00.000Z'),
  });

  assert.equal(result.status, 'not_found');
  assert.equal(result.batchId, 'thought-edit-999');
  assert.equal(result.messageId, 501);
  assert.equal(result.archivedDate, null);
  assert.match(result.transactionId, /^dbtx_[a-f0-9]{16}$/);
  assert.equal(result.persistenceResult.status, 'not_found');
  assert.equal(result.persistenceResult.batchId, 'thought-edit-999');
  assert.equal(calls.some(([sql]) => /insert into ingest\.telegram_batch/i.test(sql)), true);
  assert.equal(calls.some(([sql]) => /insert into core\.thought/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => sql === 'COMMIT'), true);
});

test('persistNormalizedBatch returns the effective thought module for database-only edits', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select payload_hash\s+from ingest\.telegram_batch/i.test(sql)) {
        return { rows: [] };
      }
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
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistNormalizedBatch({
    batch: {
      kind: 'thought_edit',
      batchId: 'thought-edit-592',
      status: 'ready',
      archivedDate: null,
      warnings: [],
      issues: [],
      confidence: 1,
      updateIds: [592],
      recognitions: [],
      messages: [
        {
          updateId: 592,
          messageId: 592,
          mediaGroupId: null,
          chatId: 42,
          caption: '',
          text: '/随想编 592 更新正文',
          dateUnix: 1781576340,
          photos: [],
        },
      ],
      thoughtEdit: {
        command: '/随想编',
        targetMessageId: 592,
        body: '更新正文',
        thoughtModule: null,
        replacePhotos: false,
        telegramChatId: 42,
        messageDateUnix: 1781576340,
        storage: {
          writeStatus: 'thought_edit_database_only',
          markdownPath: null,
          photoPaths: null,
        },
      },
    },
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-06-16T02:19:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.equal(result.batchId, 'thought-edit-592');
  assert.equal(result.messageId, 592);
  assert.equal(result.thoughtModule, 'misc');
  assert.equal(calls.some(([sql]) => /insert into core\.thought/i.test(sql)), true);
});

test('getLastProcessedTelegramUpdateId reads the max update id from ingest records', async () => {
  const fakeClient = {
    async connect() {},
    async end() {},
    async query(sql) {
      assert.match(sql, /max\(update_id\)/i);
      return {
        rows: [{ last_processed_update_id: 903 }],
      };
    },
  };

  const updateId = await getLastProcessedTelegramUpdateId({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
  });

  assert.equal(updateId, 903);
});

test('backfillCoreFromLatestArchiveSnapshot writes only archive dates missing from core', async () => {
  const calls = [];
  function createArchiveClient() {
    return {
      async connect() {
        calls.push(['connect']);
      },
      async query(sql, params) {
        calls.push([sql, params]);
        if (/from archive\.training_day\s+a/i.test(sql)) {
          return { rows: [{ archived_date: '2026-04-03' }] };
        }
        if (/from archive\.training_day/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-04-03',
                total_activities: 1,
                total_duration_seconds: 1920,
                training_calories: 459,
                workout_duration_minutes: 32,
                active_hours: 13,
                cycling_distance_km: 0,
                intake_calories: null,
              },
              {
                archived_date: '2026-04-13',
                total_activities: 1,
                total_duration_seconds: 3300,
                training_calories: 779,
                workout_duration_minutes: 55,
                active_hours: 14,
                cycling_distance_km: 0,
                intake_calories: null,
              },
            ],
          };
        }
        if (/from archive\.training_measurement/i.test(sql)) {
          return { rows: [] };
        }
        if (/from archive\.training_activity/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-04-03',
                activity_time: '20:18',
                activity_type: 'traditional_strength_training',
                raw_type: 'traditional_strength_training',
                detail: '总消耗459千卡，时长00:32:00',
                calories: 459,
                heart_rate: null,
                distance_km: null,
                avg_speed_kmh: null,
                duration_text: '00:32:00',
                duration_seconds: 1920,
              },
              {
                archived_date: '2026-04-13',
                activity_time: '20:12',
                activity_type: 'mixed_cardio',
                raw_type: 'mixed_cardio',
                detail: '总消耗779千卡，时长00:55:00',
                calories: 779,
                heart_rate: null,
                distance_km: null,
                avg_speed_kmh: null,
                duration_text: '00:55:00',
                duration_seconds: 3300,
              },
            ],
          };
        }
        if (/from archive\.training_meal/i.test(sql)) {
          return { rows: [] };
        }
        if (/select\s+archived_date\s+from core\.training_day/i.test(sql)) {
          return { rows: [{ archived_date: '2026-04-13' }] };
        }
        return { rows: [] };
      },
      async end() {
        calls.push(['end']);
      },
    };
  }

  const result = await backfillCoreFromLatestArchiveSnapshot({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return createArchiveClient();
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.equal(result.daysBackfilled, 1);

  const dayInserts = calls.filter(
    ([sql]) => typeof sql === 'string' && /insert into core\.training_day/i.test(sql),
  );
  assert.equal(dayInserts.length, 1);
  assert.deepEqual(dayInserts[0][1][0], ['2026-04-03']);
  assert.deepEqual(dayInserts[0][1][2], ['archive_backfill']);
});

test('backfillCoreFromLatestArchiveSnapshot reads archive and core through one client', async () => {
  const clients = [];

  function createClient() {
    const calls = [];
    const client = {
      calls,
      async connect() {
        calls.push(['connect']);
      },
      async query(sql, params) {
        calls.push([sql, params]);
        if (/from archive\.training_day\s+a/i.test(sql)) {
          return { rows: [{ archived_date: '2026-04-03' }] };
        }
        if (/from archive\.training_day/i.test(sql)) {
          return {
            rows: [
              {
                archived_date: '2026-04-03',
                total_activities: 1,
                total_duration_seconds: 1920,
                training_calories: 459,
                workout_duration_minutes: 32,
                active_hours: 13,
                cycling_distance_km: 0,
                intake_calories: null,
              },
            ],
          };
        }
        if (/from archive\.training_measurement/i.test(sql)) {
          return { rows: [] };
        }
        if (/from archive\.training_activity/i.test(sql)) {
          return { rows: [] };
        }
        if (/from archive\.training_meal/i.test(sql)) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      async end() {
        calls.push(['end']);
      },
    };
    clients.push(client);
    return client;
  }

  const result = await backfillCoreFromLatestArchiveSnapshot({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient,
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.equal(clients.length, 1);
  assert.ok(clients[0].calls.some(([sql]) => /from archive\.training_day/i.test(sql)));
  assert.ok(clients[0].calls.some(([sql]) => /insert into core\.training_day/i.test(sql)));
});

test('persistTrainingSnapshotToCore replaces multiple days with batched core writes', async () => {
  const calls = [];
  const snapshot = {
    daily: [
      buildCoreTestDay('2026-04-03', { calories: 459, activityTime: '20:18', mealName: '晚餐' }),
      buildCoreTestDay('2026-04-04', { calories: 375, activityTime: '07:30', mealName: '早餐' }),
    ],
  };

  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistTrainingSnapshotToCore({
    snapshot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
    sourceChannel: 'markdown_import',
  });

  assert.equal(result.status, 'stored');
  assert.equal(result.days, 2);

  const deleteMeasurements = calls.filter(
    ([sql]) => typeof sql === 'string' && /delete from core\.measurement/i.test(sql),
  );
  const dayInserts = calls.filter(
    ([sql]) => typeof sql === 'string' && /insert into core\.training_day/i.test(sql),
  );
  const activityInserts = calls.filter(
    ([sql]) => typeof sql === 'string' && /insert into core\.activity/i.test(sql),
  );

  assert.equal(deleteMeasurements.length, 1);
  assert.match(deleteMeasurements[0][0], /archived_date = any\(\$1::date\[\]\)/i);
  assert.deepEqual(deleteMeasurements[0][1][0], ['2026-04-03', '2026-04-04']);
  assert.equal(dayInserts.length, 1);
  assert.match(dayInserts[0][0], /unnest\(\$1::date\[\]/i);
  assert.deepEqual(dayInserts[0][1][0], ['2026-04-03', '2026-04-04']);
  assert.deepEqual(dayInserts[0][1][1], ['markdown-import-2026-04-03', 'markdown-import-2026-04-04']);
  assert.equal(activityInserts.length, 1);
  assert.deepEqual(activityInserts[0][1][1], ['2026-04-03', '2026-04-04']);
});

test('importTrainingMarkdownToDatabase returns unchanged when core already matches markdown', async () => {
  const calls = [];
  const markdown = `# 训练记录

### 2026-04-03

#### 当日体脂秤截图记录

- 测量时间：2026-04-03 07:00
- 身体得分：75分
- 体重：72.5 kg
- BMI：23.4
- 体脂率：22.1%
- 骨骼肌量：30.5 kg

#### 当日运动截图记录

##### 当日活动总览

- 活动热量：459千卡
- 锻炼时长：32分钟
- 活动小时数：13小时

##### 活动明细

- 20:18 力量训练：总消耗459千卡，时长00:32:00

#### 2026-04-03 饮食截图记录

##### 餐次汇总

- 晚餐：800千卡，建议范围317–740千卡
- 当日截图内已记录总热量：800千卡
`;

  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-04-03',
              total_activities: 1,
              total_duration_seconds: 1920,
              training_calories: 459,
              workout_duration_minutes: 32,
              active_hours: 13,
              cycling_distance_km: 0,
              intake_calories: 800,
              nutrition_details_json: [],
            },
          ],
        };
      }
      if (/from core\.measurement/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-04-03',
              measured_at: '2026-04-03 07:00',
              body_score: 75,
              weight_kg: 72.5,
              bmi: 23.4,
              body_fat_pct: 22.1,
              skeletal_muscle_kg: 30.5,
              visceral_fat_level: null,
              basal_metabolism_kcal: null,
              body_water_pct: null,
              protein_pct: null,
              bone_mass_kg: null,
              fat_free_mass_kg: null,
              body_age: null,
              body_type: null,
            },
          ],
        };
      }
      if (/from core\.activity/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-04-03',
              activity_time: '20:18',
              activity_type: '力量训练',
              raw_type: '力量训练',
              detail: '总消耗459千卡，时长00:32:00',
              calories: 459,
              heart_rate: null,
              distance_km: null,
              avg_speed_kmh: null,
              duration_text: '00:32:00',
              duration_seconds: 1920,
            },
          ],
        };
      }
      if (/from core\.meal/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-04-03',
              meal_name: '晚餐',
              calories: 800,
              recommended_min: 317,
              recommended_max: 740,
            },
          ],
        };
      }
      if (/from core\.thought/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await importTrainingMarkdownToDatabase({
    markdown,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.deepEqual(result, {
    status: 'unchanged',
    reason: 'core_matches_markdown',
    days: 1,
  });
  assert.equal(calls.some(([sql]) => /delete from core\.measurement/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.training_day/i.test(sql)), false);
});

test('importTrainingMarkdownToDatabase skips empty or malformed markdown without core writes', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      throw new Error('empty markdown should not query the database');
    },
    async end() {
      calls.push(['end']);
    },
  };

  for (const markdown of ['', '# 训练记录\n\n这不是日期段\n', '# 训练记录\n\n### 2026-13-99\n\n#### 当日运动截图记录\n']) {
    const result = await importTrainingMarkdownToDatabase({
      markdown,
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      createClient() {
        return fakeClient;
      },
      processedAt: new Date('2026-05-13T00:00:00.000Z'),
    });

    assert.deepEqual(result, {
      status: 'skipped',
      reason: 'missing_snapshot_days',
      days: 0,
    });
  }

  assert.deepEqual(calls, []);
});

test('importTrainingMarkdownToDatabase writes whole-day replacement with markdown_import source', async () => {
  const calls = [];
  const markdown = `# 训练记录

### 2026-04-03

#### 当日运动截图记录

##### 当日活动总览

- 活动热量：459千卡
- 锻炼时长：32分钟

##### 活动明细

- 20:18 力量训练：总消耗459千卡，时长00:32:00
`;

  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await importTrainingMarkdownToDatabase({
    markdown,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
    skipIfUnchanged: false,
  });

  assert.equal(result.status, 'stored');
  assert.equal(result.days, 1);
  assert.equal(calls.some(([sql]) => /delete from core\.activity/i.test(sql)), true);
  assert.equal(calls.some(([sql]) => /delete from core\.meal/i.test(sql)), true);
  assert.equal(calls.some(([sql]) => /delete from core\.sleep/i.test(sql)), true);
  const trainingDayInsert = calls.find(([sql]) => /insert into core\.training_day/i.test(sql));
  const activityInsert = calls.find(([sql]) => /insert into core\.activity/i.test(sql));
  assert.ok(trainingDayInsert);
  assert.ok(activityInsert);
  assert.deepEqual(trainingDayInsert[1][2], ['markdown_import']);
  assert.deepEqual(activityInsert[1][2], ['markdown_import']);
});

test('importTrainingMarkdownToDatabase stores when only sleep fields changed', async () => {
  const calls = [];
  const markdown = `# 训练记录

### 2026-04-03

#### 2026-04-03 睡眠截图记录

##### 睡眠明细

- 睡眠类型：夜间睡眠
- 入睡/起床：23:26 → 06:19
- 总睡眠：411分钟
- 夜间睡眠：411分钟
- 深睡：145分钟
- 浅睡：195分钟
- 快动眼睡眠：71分钟
- 睡眠评分：81分
- 睡眠阶段：深睡2小时25分钟；浅睡3小时15分钟；快速眼动1小时11分钟
`;

  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-04-03',
              total_activities: 0,
              total_duration_seconds: 0,
              training_calories: 0,
              workout_duration_minutes: null,
              active_hours: null,
              cycling_distance_km: 0,
              intake_calories: null,
              nutrition_details_json: [],
              sleep_total_minutes: 372,
              night_sleep_minutes: 372,
              nap_minutes: null,
              sleep_start_time: '23:26',
              sleep_end_time: '06:19',
              deep_sleep_minutes: 120,
              light_sleep_minutes: 190,
              rem_sleep_minutes: 62,
              awake_minutes: null,
            },
          ],
        };
      }
      if (/from core\.sleep/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-04-03',
              sleep_type: '夜间睡眠',
              bedtime: '23:26',
              wake_time: '06:19',
              night_sleep_minutes: 372,
              total_sleep_minutes: 372,
              nap_minutes: null,
              deep_sleep_minutes: 120,
              light_sleep_minutes: 190,
              rem_sleep_minutes: 62,
              awake_minutes: null,
              sleep_stage_text: '深睡2小时；浅睡3小时10分钟；快速眼动1小时2分钟',
              sleep_stage_detail: null,
              sleep_score: 76,
              sleep_score_percentile: null,
              deep_sleep_ratio_pct: null,
              light_sleep_ratio_pct: null,
              rem_sleep_ratio_pct: null,
              deep_sleep_continuity_score: null,
              wake_count: null,
              breathing_quality_score: null,
              average_heart_rate_bpm: null,
              hrv_ms: null,
              average_spo2_pct: null,
              average_respiratory_rate: null,
              analysis_text: null,
              suggestion_text: null,
            },
          ],
        };
      }
      if (/from core\.(measurement|activity|meal|thought)/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await importTrainingMarkdownToDatabase({
    markdown,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.equal(result.status, 'stored');
  assert.equal(result.days, 1);
  assert.equal(calls.some(([sql]) => /delete from core\.sleep/i.test(sql)), true);
  const sleepInsert = calls.find(([sql]) => /insert into core\.sleep/i.test(sql));
  assert.ok(sleepInsert);
  assert.deepEqual(sleepInsert[1][8], [411]);
  assert.deepEqual(sleepInsert[1][16], [81]);
});

test('importTrainingMarkdownToDatabase keeps matching sleep stage details unchanged', async () => {
  const calls = [];
  const markdown = `# 训练记录

### 2026-04-03

#### 2026-04-03 睡眠截图记录

##### 睡眠明细

- 睡眠类型：夜间睡眠
- 入睡/起床：23:26 → 06:19
- 总睡眠：411分钟
- 夜间睡眠：411分钟
- 深睡：145分钟
- 浅睡：195分钟
- 快动眼睡眠：71分钟
- 睡眠评分：81分
- 睡眠阶段：深睡2小时25分钟；浅睡3小时15分钟；快速眼动1小时11分钟
- 睡眠阶段明细：
  - 深睡 2小时25分钟
  - 浅睡 3小时15分钟
  - 快速眼动 1小时11分钟
`;

  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/from core\.training_day/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-04-03',
              total_activities: 0,
              total_duration_seconds: 0,
              training_calories: 0,
              workout_duration_minutes: null,
              active_hours: null,
              cycling_distance_km: 0,
              intake_calories: null,
              nutrition_details_json: [],
              sleep_total_minutes: 411,
              night_sleep_minutes: 411,
              nap_minutes: null,
              sleep_start_time: '23:26',
              sleep_end_time: '06:19',
              deep_sleep_minutes: 145,
              light_sleep_minutes: 195,
              rem_sleep_minutes: 71,
              awake_minutes: null,
            },
          ],
        };
      }
      if (/from core\.sleep/i.test(sql)) {
        return {
          rows: [
            {
              archived_date: '2026-04-03',
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
              sleep_stage_text: '深睡2小时25分钟；浅睡3小时15分钟；快速眼动1小时11分钟',
              sleep_stage_detail: '["深睡 2小时25分钟","浅睡 3小时15分钟","快速眼动 1小时11分钟"]',
              sleep_score: 81,
              sleep_score_percentile: null,
              deep_sleep_ratio_pct: null,
              light_sleep_ratio_pct: null,
              rem_sleep_ratio_pct: null,
              deep_sleep_continuity_score: null,
              wake_count: null,
              breathing_quality_score: null,
              average_heart_rate_bpm: null,
              hrv_ms: null,
              average_spo2_pct: null,
              average_respiratory_rate: null,
              analysis_text: null,
              suggestion_text: null,
            },
          ],
        };
      }
      if (/from core\.(measurement|activity|meal|thought)/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await importTrainingMarkdownToDatabase({
    markdown,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    processedAt: new Date('2026-05-13T00:00:00.000Z'),
  });

  assert.deepEqual(result, {
    status: 'unchanged',
    reason: 'core_matches_markdown',
    days: 1,
  });
  assert.equal(calls.some(([sql]) => /delete from core\.sleep/i.test(sql)), false);
  assert.equal(calls.some(([sql]) => /insert into core\.training_day/i.test(sql)), false);
});

test('exportTrainingMarkdown renders a readable markdown view from the canonical snapshot', async () => {
  const markdown = exportTrainingMarkdown({
    generatedAt: '2026-05-13T00:00:00.000Z',
    latest: {
      measurement: normalizedBatch.measurement,
      daily: {
        date: normalizedBatch.archivedDate,
      },
    },
    daily: [
      {
        date: normalizedBatch.archivedDate,
        measurement: {
          archivedDate: normalizedBatch.archivedDate,
          ...normalizedBatch.measurement,
        },
        measurements: [
          {
            archivedDate: normalizedBatch.archivedDate,
            ...normalizedBatch.measurement,
          },
        ],
        activities: [
          {
            time: '19:13',
            type: '力量训练',
            rawType: '力量训练',
            detail: '总消耗241千卡，时长00:27:50，平均心率129次/分钟',
            durationText: '00:27:50',
            durationSeconds: 1670,
            calories: 241,
            distanceKm: null,
            avgSpeedKmh: null,
            heartRate: 129,
          },
        ],
        workoutSummary: {
          totalActivities: 1,
          totalDurationSeconds: 1670,
          trainingCalories: 643,
          workoutDurationMinutes: 78,
          activeHours: 12,
          cyclingDistanceKm: 0,
          countsByType: {
            力量训练: 1,
          },
        },
        nutrition: normalizedBatch.nutrition,
        sleep: [
          {
            sleepType: '夜间睡眠',
            bedtime: '23:26',
            wakeTime: '06:19',
            nightSleepMinutes: 411,
            totalSleepMinutes: 411,
            napMinutes: null,
            deepSleepMinutes: 145,
            lightSleepMinutes: 195,
            remSleepMinutes: 71,
            awakeMinutes: 12,
            sleepStageText: '深睡2小时25分钟；浅睡3小时15分钟；快速眼动1小时11分钟',
            sleepStageDetail: ['深睡 2小时25分钟', '浅睡 3小时15分钟', '快速眼动 1小时11分钟'],
            sleepScore: 81,
            sleepScorePercentile: 77,
            deepSleepRatioPct: 35,
            lightSleepRatioPct: 47,
            remSleepRatioPct: 18,
            deepSleepContinuityScore: 85,
            wakeCount: 2,
            breathingQualityScore: 94,
            averageHeartRateBpm: 68,
            hrvMs: 42,
            averageSpo2Pct: 96,
            averageRespiratoryRate: 15.4,
            analysisText: '睡眠质量良好。',
            suggestionText: '建议睡觉时关灯。',
          },
        ],
        sleepSummary: {
          records: [],
        },
      },
    ],
    charts: {
      weightKg: [],
      bodyFatPct: [],
      skeletalMuscleKg: [],
      basalMetabolism: [],
      visceralFatLevel: [],
      intakeCalories: [],
      trainingCalories: [],
      cyclingDistanceKm: [],
    },
  });

  assert.match(markdown, /### 2026-05-09/);
  assert.match(markdown, /#### 当日体脂秤截图记录/);
  assert.match(markdown, /#### 当日运动截图记录/);
  assert.match(markdown, /#### 2026-05-09 饮食截图记录/);
  assert.match(markdown, /##### 餐次明细/);
  assert.match(markdown, /#### 2026-05-09 睡眠截图记录/);
  assert.match(markdown, /- 睡眠评分：81分/);
  assert.match(markdown, /- 睡眠阶段明细：/);
  assert.match(markdown, /- 19:13 力量训练：总消耗241千卡/);

  const parsed = parseTrainingRecord(markdown);
  const day = parsed.daily.find((entry) => entry.date === normalizedBatch.archivedDate);
  assert.ok(day);
  assert.deepEqual(day.nutrition.details, normalizedBatch.nutrition.details);
  assert.equal(day.sleepSummary.totalSleepMinutes, 411);
  assert.equal(day.sleepSummary.sleepScore, 81);
  assert.equal(day.sleepSummary.averageHeartRateBpm, 68);
  assert.deepEqual(day.sleep[0].sleepStageDetail, [
    '深睡 2小时25分钟',
    '浅睡 3小时15分钟',
    '快速眼动 1小时11分钟',
  ]);
});
