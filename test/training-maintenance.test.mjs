import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readTrainingBatchAudit,
  readTrainingBatchAuditClient,
  runTrainingMaintenance,
} from '../tools/training-maintenance.mjs';

const readRepoFile = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const readMigrationChecksum = async (relativePath) => {
  const sql = await readRepoFile(relativePath);
  return createHash('sha256').update(sql, 'utf8').digest('hex');
};

const readMaintenanceGuide = async () => [
  await readRepoFile('docs/02_系统核心逻辑/系统总览.md'),
  await readRepoFile('docs/02_系统核心逻辑/Action日志与失败补偿.md'),
  await readRepoFile('docs/02_系统核心逻辑/数据入库流程.md'),
  await readRepoFile('docs/04_问题与排查/Action日志.md'),
].join('\n\n');

const readInterfaceManual = async () => [
  await readRepoFile('docs/02_系统核心逻辑/README.md'),
  await readRepoFile('docs/02_系统核心逻辑/Action日志与失败补偿.md'),
  await readRepoFile('docs/02_系统核心逻辑/时间归档逻辑.md'),
].join('\n\n');

const readWorkflowGuide = async () => [
  await readRepoFile('docs/01_系统配置/README.md'),
  await readRepoFile('docs/01_系统配置/dev.md'),
  await readRepoFile('docs/01_系统配置/main.md'),
  await readRepoFile('docs/02_系统核心逻辑/Action日志与失败补偿.md'),
].join('\n\n');

const readTroubleshootingGuide = async () => [
  await readRepoFile('docs/04_问题与排查/Action日志.md'),
  await readRepoFile('docs/04_问题与排查/Telegram.md'),
  await readRepoFile('docs/04_问题与排查/飞书.md'),
].join('\n\n');

test('training maintenance inspect is read-only and reports database pending queue counts', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-maintenance-inspect-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, 'training-archive-failures.ndjson'),
    `${JSON.stringify({ error: 'database unavailable' })}\n`,
    'utf8',
  );

  let syncCalled = false;
  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    rootDir: tempRoot,
    syncTrainingCore: async () => {
      syncCalled = true;
      return { status: 'stored' };
    },
    readPendingBatches: async () => [
      { batchId: 'pending-1', failureCategory: 'database' },
      { batchId: 'pending-2', failureCategory: 'ai_service' },
    ],
    stdout: { write() {} },
  });

  assert.equal(syncCalled, false);
  assert.equal(result.mode, 'inspect');
  assert.equal(result.readonly, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.data.pendingDatabaseCount, 2);
  assert.equal(result.data.pendingDatabaseStatus, 'ok');
  assert.equal(result.data.pendingDatabaseError, null);
  assert.equal(result.data.archiveFailureCount, 1);
});

test('training maintenance inspect reports pending queue age attempts and threshold level', async () => {
  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    now: new Date('2026-06-21T00:00:00.000Z'),
    readPendingBatches: async () => [
      { batchId: 'pending-old', createdAt: '2026-06-19T23:00:00.000Z', attemptCount: 25 },
      ...Array.from({ length: 10 }, (_, index) => ({
        batchId: `pending-${index + 1}`,
        createdAt: '2026-06-20T23:45:00.000Z',
        attemptCount: index,
      })),
    ],
    stdout: { write() {} },
  });

  assert.equal(result.data.pendingDatabaseCount, 11);
  assert.equal(result.data.pendingDatabaseOldestAt, '2026-06-19T23:00:00.000Z');
  assert.equal(result.data.pendingDatabaseOldestAgeMinutes, 1500);
  assert.equal(result.data.pendingDatabaseMaxAttemptCount, 25);
  assert.equal(result.data.pendingDatabaseAlertLevel, 'P1');
  assert.deepEqual(result.data.pendingDatabaseAlertReasons, [
    'pending_count_gt_10',
    'pending_oldest_gt_24h',
    'pending_attempt_count_gte_25',
  ]);
  assert.deepEqual(result.data.pendingDatabaseThresholds, {
    p2OldestAgeMinutes: 30,
    p1OldestAgeMinutes: 1440,
    p1Count: 10,
    p1AttemptCount: 25,
  });
});

test('training maintenance inspect reports a read-only database permission audit', async () => {
  const queries = [];
  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_app:secret@example.com:5432/training_records',
    },
    readPendingBatches: async () => [],
    createClient() {
      return {
        async connect() {
          queries.push('connect');
        },
        async query(sql) {
          queries.push(sql);
          if (/from ingest\.ai_call_log/i.test(sql)) {
            return {
              rows: [{
                total_calls: 0,
                recognition_calls: 0,
                analysis_calls: 0,
                failed_calls: 0,
                schema_failure_count: 0,
                avg_recognition_latency_ms: null,
                max_recognition_latency_ms: null,
                total_tokens: 0,
                total_cost_usd: '0',
              }],
            };
          }
          if (/from ingest\.telegram_recognition/i.test(sql)) {
            return {
              rows: [{
                recognition_fallback_count: 0,
                recognition_total_count: 0,
              }],
            };
          }
          if (/current_user::text as current_user/i.test(sql)) {
            return {
              rows: [{
                current_user: 'training_app',
                session_user: 'training_app',
                is_superuser: false,
                can_create_core: false,
                can_create_ingest: false,
                can_create_archive: false,
                can_create_public: false,
              }],
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        async end() {
          queries.push('end');
        },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(result.data.database.permissionAudit.status, 'ok');
  assert.equal(result.data.database.permissionAudit.currentUser, 'training_app');
  assert.equal(result.data.database.permissionAudit.isSuperuser, false);
  assert.equal(result.data.database.permissionAudit.isMigratorLikeUser, false);
  assert.deepEqual(result.data.database.permissionAudit.schemaCreatePrivileges, {
    archive: false,
    core: false,
    ingest: false,
    public: false,
  });
  assert.deepEqual(result.data.database.permissionAudit.dangerousPrivilegeReasons, []);
  assert.equal(queries.some((sql) => /create table|alter table|create index/i.test(sql)), false);
  assert.doesNotMatch(JSON.stringify(result), /postgresql:\/\/|secret/i);
});

test('training maintenance inspect uses the default pending summary without claiming rows', async () => {
  const calls = [];
  const observedUrls = [];
  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_app:secret@example.com:5432/training_records',
      TRAINING_DB_READONLY_URL: 'postgresql://training_readonly:secret@example.com:5432/training_records',
    },
    now: new Date('2026-06-21T00:00:00.000Z'),
    createClient: (config) => ({
      async connect() {
        observedUrls.push(config.url);
        calls.push(['connect']);
      },
      async query(sql, params = []) {
        calls.push([sql, params]);
        assert.doesNotMatch(sql, /\bupdate\b/i);
        assert.doesNotMatch(sql, /for update/i);

        if (/from ingest\.telegram_pending_batch/i.test(sql)) {
          return {
            rows: [{
              batch_id: 'pending-old',
              kind: 'image',
              failure_category: 'database',
              failure_reason: 'database unavailable',
              attempt_count: 1,
              next_retry_at: '2026-06-20T00:10:00.000Z',
              last_failed_at: '2026-06-20T00:00:00.000Z',
              created_at: '2026-06-20T23:00:00.000Z',
              updated_at: '2026-06-20T23:00:00.000Z',
            }],
          };
        }
        if (/from ingest\.ai_call_log/i.test(sql)) {
          return {
            rows: [{
              total_calls: 0,
              recognition_calls: 0,
              analysis_calls: 0,
              failed_calls: 0,
              schema_failure_count: 0,
              avg_recognition_latency_ms: null,
              max_recognition_latency_ms: null,
              total_tokens: 0,
              total_cost_usd: '0',
            }],
          };
        }
        if (/from ingest\.telegram_recognition/i.test(sql)) {
          return {
            rows: [{
              recognition_fallback_count: 0,
              recognition_total_count: 0,
            }],
          };
        }
        if (/current_user::text as current_user/i.test(sql)) {
          return {
            rows: [{
              current_user: 'training_readonly',
              session_user: 'training_readonly',
              is_superuser: false,
              can_create_core: false,
              can_create_ingest: false,
              can_create_archive: false,
              can_create_public: false,
            }],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      async end() {
        calls.push(['end']);
      },
    }),
    stdout: { write() {} },
  });

  assert.equal(result.data.pendingDatabaseCount, 1);
  assert.equal(result.data.pendingDatabaseOldestAgeMinutes, 60);
  assert.equal(result.data.pendingDatabaseAlertLevel, 'P2');
  assert.deepEqual(result.data.pendingDatabaseAlertReasons, ['pending_oldest_gt_30m']);
  assert.equal(calls.some(([sql]) => sql === 'BEGIN' || sql === 'COMMIT'), false);
  assert.deepEqual([...new Set(observedUrls)], [
    'postgresql://training_readonly:secret@example.com:5432/training_records',
  ]);
});

test('training maintenance inspect reports AI monitoring source from database logs', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    now: new Date('2026-06-21T00:00:00.000Z'),
    createClient: () => ({
      async connect() {
        calls.push(['connect']);
      },
      async query(sql, params = []) {
        calls.push([sql, params]);
        assert.doesNotMatch(sql, /\bupdate\b/i);
        assert.doesNotMatch(sql, /for update/i);

        if (/from ingest\.telegram_pending_batch/i.test(sql)) {
          return { rows: [] };
        }
        if (/from ingest\.ai_call_log/i.test(sql)) {
          return {
            rows: [
              {
                total_calls: 5,
                recognition_calls: 4,
                analysis_calls: 1,
                fallback_calls: 2,
                schema_failure_count: 2,
                failed_calls: 1,
                avg_recognition_latency_ms: '1750.5',
                max_recognition_latency_ms: 4200,
                total_tokens: '9300',
                total_cost_usd: '0.123456',
              },
            ],
          };
        }
        if (/from ingest\.telegram_recognition/i.test(sql)) {
          return {
            rows: [
              { recognition_fallback_count: 2, recognition_total_count: 4 },
            ],
          };
        }
        return { rows: [] };
      },
      async end() {
        calls.push(['end']);
      },
    }),
    stdout: { write() {} },
  });

  assert.equal(result.data.aiMonitoringStatus, 'ok');
  assert.equal(result.data.aiMonitoringTotalCalls, 5);
  assert.equal(result.data.aiMonitoringRecognitionCalls, 4);
  assert.equal(result.data.aiMonitoringAnalysisCalls, 1);
  assert.equal(result.data.aiMonitoringFallbackCalls, 2);
  assert.equal(result.data.aiMonitoringFallbackRate, 0.5);
  assert.equal(result.data.aiMonitoringSchemaFailureCount, 2);
  assert.equal(result.data.aiMonitoringAvgRecognitionLatencyMs, 1751);
  assert.equal(result.data.aiMonitoringMaxRecognitionLatencyMs, 4200);
  assert.equal(result.data.aiMonitoringTotalTokens, 9300);
  assert.equal(result.data.aiMonitoringTotalCostUsd, 0.123456);
  assert.deepEqual(result.data.aiMonitoringSources, [
    'ingest.ai_call_log',
    'ingest.telegram_recognition.recognition_json.aiAttemptKind',
  ]);
  assert.deepEqual(result.data.aiMonitoringAlertReasons, [
    'ai_fallback_rate_gt_30pct',
    'ai_schema_failure_gte_2_per_hour',
  ]);
  assert.equal(calls.some(([sql]) => sql === 'BEGIN' || sql === 'COMMIT'), false);
});

test('training maintenance sync delegates to syncTrainingCore', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync'],
    env: { TRAINING_DB_ENABLED: 'false' },
    syncTrainingCore: async (options) => {
      calls.push(options);
      return { status: 'unchanged', archive: { status: 'unchanged' } };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'safe');
  assert.equal(result.mode, 'sync');
  assert.equal(result.phase, 'safe');
  assert.equal(result.readonly, false);
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.result, { status: 'unchanged', archive: { status: 'unchanged' } });
});

test('training maintenance inspect reports unavailable database pending queue without file fallback', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-maintenance-inspect-db-'));

  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    rootDir: tempRoot,
    readPendingBatches: async () => {
      throw new Error('database unavailable');
    },
    stdout: { write() {} },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.data.pendingDatabaseCount, 0);
  assert.equal(result.data.pendingDatabaseStatus, 'unavailable');
  assert.match(result.data.pendingDatabaseError, /database unavailable/);
});

test('training maintenance inspect still reports archive failure log count', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-maintenance-inspect-archive-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, 'training-archive-failures.ndjson'),
    `${JSON.stringify({ error: 'database unavailable' })}\nnot-json\n`,
    'utf8',
  );

  const result = await runTrainingMaintenance({
    argv: ['inspect'],
    rootDir: tempRoot,
    readPendingBatches: async () => [],
    stdout: { write() {} },
  });

  assert.equal(result.data.archiveFailureCount, 1);
  assert.equal(result.data.archiveFailureInvalidLines, 1);
});

test('training maintenance inspect can audit one AI batch for recovery target dates', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['inspect', '--batch-id', 'album-ai-wrong'],
    readPendingBatches: async () => [],
    readBatchAudit: async (options) => {
      calls.push(options);
      return {
        status: 'ok',
        batchId: 'album-ai-wrong',
        readonly: true,
        batch: {
          status: 'ready',
          archivedDate: '2026-06-14',
        },
        recognitions: [
          {
            sourceChannel: 'telegram',
            sourceChatId: '1001',
            sourceMessageId: '6102',
            recognitionJson: {
              schemaVersion: 'v2',
              detectedDate: '2026-06-14',
              nutrition: { meals: [{ name: '晚餐', calories: 465 }] },
            },
          },
        ],
        coreTargets: {
          measurement: [],
          activity: [],
          meal: [{ archivedDate: '2026-06-14', rowCount: 1 }],
          sleep: [],
          trainingDay: [{ archivedDate: '2026-06-14', rowCount: 1 }],
        },
        recoveryTargetDays: ['2026-06-14'],
      };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].batchId, 'album-ai-wrong');
  assert.equal(result.mode, 'inspect');
  assert.equal(result.readonly, true);
  assert.equal(result.data.batchAudit.readonly, true);
  assert.equal(result.data.batchAudit.batchId, 'album-ai-wrong');
  assert.deepEqual(result.data.batchAudit.recoveryTargetDays, ['2026-06-14']);
  assert.deepEqual(result.data.batchAudit.recognitions[0].recognitionJson.nutrition.meals[0], {
    name: '晚餐',
    calories: 465,
  });
  assert.deepEqual(result.data.batchAudit.coreTargets.meal, [
    { archivedDate: '2026-06-14', rowCount: 1 },
  ]);
});

test('readTrainingBatchAuditClient traces recognition json and core target dates by batch id', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/from ingest\.telegram_batch/i.test(sql)) {
        return {
          rows: [
            {
              batch_id: 'album-ai-wrong',
              status: 'ready',
              archived_date: '2026-06-14',
              reason: null,
              confidence: 'high',
              processed_at: '2026-06-14T10:00:00.000Z',
            },
          ],
        };
      }
      if (/from ingest\.telegram_recognition/i.test(sql)) {
        return {
          rows: [
            {
              message_id: '6102',
              source_channel: 'telegram',
              source_chat_id: '1001',
              source_message_id: '6102',
              recognition_json: {
                detectedDate: '2026-06-14',
                imageDate: '2026-06-14',
                nutrition: { meals: [{ name: '晚餐', calories: 465 }] },
              },
              updated_at: '2026-06-14T10:00:01.000Z',
            },
          ],
        };
      }
      return {
        rows: [
          { target: 'meal', archived_date: '2026-06-14', row_count: 1 },
          { target: 'trainingDay', archived_date: '2026-06-14', row_count: 1 },
        ],
      };
    },
  };

  const audit = await readTrainingBatchAuditClient(client, { batchId: 'album-ai-wrong' });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.params), [
    ['album-ai-wrong'],
    ['album-ai-wrong'],
    ['album-ai-wrong'],
  ]);
  assert.equal(audit.readonly, true);
  assert.equal(audit.batch.archivedDate, '2026-06-14');
  assert.equal(audit.recognitions[0].recognitionJson.nutrition.meals[0].calories, 465);
  assert.deepEqual(audit.coreTargets.meal, [{ archivedDate: '2026-06-14', rowCount: 1 }]);
  assert.deepEqual(audit.recoveryTargetDays, ['2026-06-14']);
});

test('readTrainingBatchAudit prefers readonly database url when configured', async () => {
  const observedUrls = [];
  const queries = [];
  const audit = await readTrainingBatchAudit({
    batchId: 'album-ai-wrong',
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_app:secret@example.com:5432/training_records',
      TRAINING_DB_READONLY_URL: 'postgresql://training_readonly:secret@example.com:5432/training_records',
    },
    createClient: (config) => ({
      async connect() {
        observedUrls.push(config.url);
      },
      async query(sql, params = []) {
        queries.push({ sql, params });
        assert.doesNotMatch(sql, /\b(insert|update|delete|create|alter|drop)\b/i);

        if (/from ingest\.telegram_batch/i.test(sql)) {
          return {
            rows: [{
              batch_id: 'album-ai-wrong',
              status: 'ready',
              archived_date: '2026-06-14',
              reason: null,
              confidence: 'high',
              processed_at: '2026-06-14T10:00:00.000Z',
            }],
          };
        }
        if (/from ingest\.telegram_recognition/i.test(sql)) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      async end() {},
    }),
  });

  assert.equal(audit.status, 'ok');
  assert.equal(audit.readonly, true);
  assert.deepEqual(observedUrls, [
    'postgresql://training_readonly:secret@example.com:5432/training_records',
  ]);
  assert.equal(queries.length, 3);
});

test('training maintenance sync can explicitly run all database phases', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync', '--phase', 'all'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return {
        status: 'stored',
        archive: { status: 'unchanged' },
        ingest: { status: 'unchanged' },
        markdown: { status: 'stored', days: 1 },
        thoughts: { status: 'unchanged' },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'all');
  assert.equal(result.mode, 'sync');
  assert.equal(result.phase, 'all');
  assert.equal(result.status, 'stored');
  assert.equal(result.result.markdown.status, 'stored');
});

test('training maintenance sync can run one legacy database phase through the unified entrypoint', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync', '--phase', 'archive'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return { status: 'unchanged', archive: { status: 'unchanged' } };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'archive');
  assert.equal(result.mode, 'sync');
  assert.equal(result.phase, 'archive');
  assert.equal(result.status, 'unchanged');
});

test('training maintenance sync can run the ingest repair phase directly', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync', '--phase', 'ingest'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return { status: 'stored', ingest: { status: 'stored', batchesBackfilled: 1 } };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'ingest');
  assert.equal(result.mode, 'sync');
  assert.equal(result.phase, 'ingest');
  assert.equal(result.status, 'stored');
});

test('training maintenance export delegates markdown export through the unified entrypoint', async () => {
  const calls = [];
  let stdoutText = '';
  const result = await runTrainingMaintenance({
    argv: ['export', 'markdown'],
    exportDerivedTrainingMarkdown: async (options) => {
      calls.push(options);
      return {
        outputPath: '训练记录.md',
        snapshot: {
          generatedAt: '2026-06-03T00:00:00.000Z',
          daily: [
            {
              date: '2026-06-03',
              measurement: { weightKg: 71.7, bodyFatPct: 21.9 },
              sleep: [{ sleepStageText: '深睡、浅睡、快速眼动', analysisText: '睡眠质量良好' }],
            },
          ],
          thoughts: [{ telegramMessageId: 1 }],
        },
        thoughts: { exportedCount: 1, removedCount: 2 },
      };
    },
    stdout: { write(chunk) { stdoutText += chunk; } },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.mode, 'export');
  assert.equal(result.target, 'markdown');
  assert.equal(result.status, 'stored');
  assert.equal(result.outputPath, '训练记录.md');
  assert.equal(result.dailyCount, 1);
  assert.equal(result.thoughtExportedCount, 1);
  assert.equal(result.thoughtRemovedCount, 2);
  assert.equal(typeof result.durationMs, 'number');
  assert.equal('result' in result, false);
  assert.doesNotMatch(stdoutText, /snapshot|weightKg|bodyFatPct|sleepStageText|analysisText/);
});

test('training maintenance export supports explicit local debug json with full payload', async () => {
  const result = await runTrainingMaintenance({
    argv: ['export', 'markdown', '--debug-json'],
    env: { GITHUB_ACTIONS: 'false' },
    exportDerivedTrainingMarkdown: async () => ({
      outputPath: '训练记录.md',
      snapshot: { daily: [{ measurement: { weightKg: 71.7 } }] },
      thoughts: { exportedCount: 0, removedCount: 0 },
    }),
    stdout: { write() {} },
  });

  assert.equal(result.status, 'stored');
  assert.equal(result.result.snapshot.daily[0].measurement.weightKg, 71.7);
});

test('training maintenance export rejects debug json in GitHub Actions before reading data', async () => {
  let exportCalled = false;
  const result = await runTrainingMaintenance({
    argv: ['export', 'markdown', '--debug-json'],
    env: { GITHUB_ACTIONS: 'true' },
    exportDerivedTrainingMarkdown: async () => {
      exportCalled = true;
      return { outputPath: '训练记录.md', snapshot: {} };
    },
    stdout: { write() {} },
  });

  assert.equal(exportCalled, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /debug-json/i);
});

test('training maintenance migrate requires dry-run or confirm before write-capable work', async () => {
  let syncCalled = false;
  const result = await runTrainingMaintenance({
    argv: ['migrate'],
    syncTrainingCore: async () => {
      syncCalled = true;
      return { status: 'stored' };
    },
    stdout: { write() {} },
  });

  assert.equal(syncCalled, false);
  assert.equal(result.mode, 'migrate');
  assert.equal(result.status, 'blocked');
  assert.equal(result.requiresConfirm, true);
});

test('training maintenance migrate supports dry-run without running sync', async () => {
  let syncCalled = false;
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--dry-run'],
    syncTrainingCore: async () => {
      syncCalled = true;
      return { status: 'stored' };
    },
    stdout: { write() {} },
  });

  assert.equal(syncCalled, false);
  assert.equal(result.mode, 'migrate');
  assert.equal(result.status, 'planned');
  assert.equal(result.dryRun, true);
  assert.ok(result.plan.some((entry) => entry.id === '001_runtime_schema_preflight_backfill'));
  assert.deepEqual(
    result.plan.map((entry) => entry.status),
    ['pending'],
  );
  assert.match(result.plan[0].file, /sql\/training_records\/migrations\/001_runtime_schema_preflight_backfill\.sql$/);
});

test('training maintenance migrate dry-run reads applied migration status when migration url is configured', async () => {
  const queries = [];
  const checksum = await readMigrationChecksum('sql/training_records/migrations/001_runtime_schema_preflight_backfill.sql');
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--dry-run'],
    env: {
      TRAINING_DB_MIGRATION_URL: 'postgresql://training_migrator:secret@example.com:5432/training_records',
    },
    createClient() {
      return {
        async connect() {
          queries.push('connect');
        },
        async query(sql) {
          queries.push(sql);
          if (/to_regclass\('maintenance\.schema_migration'\)/i.test(sql)) {
            return { rows: [{ table_name: 'maintenance.schema_migration' }] };
          }
          if (/select migration_id/i.test(sql)) {
            return {
              rows: [{
                migration_id: '001_runtime_schema_preflight_backfill',
                checksum_sha256: checksum,
              }],
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        async end() {
          queries.push('end');
        },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(result.status, 'planned');
  assert.equal(result.migrationHistory.status, 'read');
  assert.deepEqual(result.plan.map((entry) => entry.status), ['applied']);
  assert.equal(queries.some((sql) => /alter table core\.sleep/i.test(sql)), false);
});

test('training maintenance migrate dry-run reports checksum drift for changed migration sql', async () => {
  const queries = [];
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--dry-run'],
    env: {
      TRAINING_DB_MIGRATION_URL: 'postgresql://training_migrator:secret@example.com:5432/training_records',
    },
    createClient() {
      return {
        async connect() {
          queries.push('connect');
        },
        async query(sql) {
          queries.push(sql);
          if (/to_regclass\('maintenance\.schema_migration'\)/i.test(sql)) {
            return { rows: [{ table_name: 'maintenance.schema_migration' }] };
          }
          if (/select migration_id/i.test(sql)) {
            return {
              rows: [{
                migration_id: '001_runtime_schema_preflight_backfill',
                checksum_sha256: 'old-checksum',
              }],
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        async end() {
          queries.push('end');
        },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(result.status, 'planned');
  assert.equal(result.migrationHistory.checksumMismatchCount, 1);
  assert.deepEqual(result.plan.map((entry) => entry.status), ['checksum_mismatch']);
  assert.equal(queries.some((sql) => /alter table core\.sleep/i.test(sql)), false);
});

test('training maintenance migrate dry-run redacts migration history errors', async () => {
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--dry-run'],
    env: {
      TRAINING_DB_MIGRATION_URL: 'postgresql://training_migrator:secret@example.com:5432/training_records',
    },
    createClient() {
      return {
        async connect() {
          throw new Error(
            'connect failed for postgresql://training_migrator:secret@example.com:5432/training_records',
          );
        },
        async end() {},
      };
    },
    stdout: { write() {} },
  });

  assert.equal(result.status, 'planned');
  assert.equal(result.migrationHistory.status, 'unavailable');
  assert.match(result.migrationHistory.error, /\[redacted-db-url\]/);
  assert.doesNotMatch(JSON.stringify(result), /training_migrator|secret|postgresql:\/\//i);
});

test('training maintenance migrate confirm requires migration database url', async () => {
  let syncCalled = false;
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--confirm'],
    syncTrainingCore: async () => {
      syncCalled = true;
      return { status: 'stored' };
    },
    stdout: { write() {} },
  });

  assert.equal(syncCalled, false);
  assert.equal(result.mode, 'migrate');
  assert.equal(result.status, 'blocked');
  assert.match(result.error, /TRAINING_DB_MIGRATION_URL/);
});

test('training maintenance migrate confirm executes explicit migration sql', async () => {
  const queries = [];
  const observedUrls = [];
  let syncCalled = false;
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--confirm'],
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_app:secret@example.com:5432/training_records',
      TRAINING_DB_MIGRATION_URL: 'postgresql://training_migrator:secret@example.com:5432/training_records',
    },
    syncTrainingCore: async () => {
      syncCalled = true;
      return { status: 'stored' };
    },
    createClient(config) {
      observedUrls.push(config.url);
      return {
        async connect() {
          queries.push('connect');
        },
        async query(sql) {
          queries.push(sql);
          return { rows: [], rowCount: 0 };
        },
        async end() {
          queries.push('end');
        },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(syncCalled, false);
  assert.deepEqual([...new Set(observedUrls)], [
    'postgresql://training_migrator:secret@example.com:5432/training_records',
  ]);
  assert.ok(queries.some((sql) => /alter table core\.sleep add column if not exists total_sleep_minutes/i.test(sql)));
  assert.equal(result.mode, 'migrate');
  assert.equal(result.status, 'applied');
  assert.equal(result.confirmed, true);
  assert.deepEqual(result.appliedMigrations.map((entry) => entry.id), ['001_runtime_schema_preflight_backfill']);
});

test('training maintenance migrate confirm skips migration sql already recorded in history', async () => {
  const queries = [];
  const checksum = await readMigrationChecksum('sql/training_records/migrations/001_runtime_schema_preflight_backfill.sql');
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--confirm'],
    env: {
      TRAINING_DB_MIGRATION_URL: 'postgresql://training_migrator:secret@example.com:5432/training_records',
    },
    createClient() {
      return {
        async connect() {
          queries.push('connect');
        },
        async query(sql) {
          queries.push(sql);
          if (/to_regclass\('maintenance\.schema_migration'\)/i.test(sql)) {
            return { rows: [{ table_name: 'maintenance.schema_migration' }] };
          }
          if (/select migration_id/i.test(sql)) {
            return {
              rows: [{
                migration_id: '001_runtime_schema_preflight_backfill',
                checksum_sha256: checksum,
              }],
            };
          }
          return { rows: [], rowCount: 0 };
        },
        async end() {
          queries.push('end');
        },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.appliedMigrations, []);
  assert.deepEqual(result.skippedMigrations.map((entry) => entry.id), ['001_runtime_schema_preflight_backfill']);
  assert.equal(queries.some((sql) => /alter table core\.sleep/i.test(sql)), false);
});

test('training maintenance migrate confirm blocks when applied migration checksum changed', async () => {
  const queries = [];
  const result = await runTrainingMaintenance({
    argv: ['migrate', '--confirm'],
    env: {
      TRAINING_DB_MIGRATION_URL: 'postgresql://training_migrator:secret@example.com:5432/training_records',
    },
    createClient() {
      return {
        async connect() {
          queries.push('connect');
        },
        async query(sql) {
          queries.push(sql);
          if (/to_regclass\('maintenance\.schema_migration'\)/i.test(sql)) {
            return { rows: [{ table_name: 'maintenance.schema_migration' }] };
          }
          if (/select migration_id/i.test(sql)) {
            return {
              rows: [{
                migration_id: '001_runtime_schema_preflight_backfill',
                checksum_sha256: 'old-checksum',
              }],
            };
          }
          return { rows: [], rowCount: 0 };
        },
        async end() {
          queries.push('end');
        },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'applied migration checksum mismatch');
  assert.deepEqual(result.plan.map((entry) => entry.status), ['checksum_mismatch']);
  assert.equal(queries.some((sql) => /alter table core\.sleep/i.test(sql)), false);
});

test('package exposes explicit maintenance command boundaries', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageJson.scripts['maintenance:inspect'], 'node tools/training-maintenance.mjs inspect');
  assert.equal(packageJson.scripts['maintenance:sync'], 'node tools/training-maintenance.mjs sync');
  assert.equal(packageJson.scripts['maintenance:migrate'], 'node tools/training-maintenance.mjs migrate');
  assert.equal(packageJson.scripts['backfill:core'], 'node tools/training-maintenance.mjs sync --phase archive');
  assert.equal(packageJson.scripts['backfill:thoughts'], 'node tools/training-maintenance.mjs sync --phase thoughts');
  assert.equal(packageJson.scripts['import:markdown'], 'node tools/training-maintenance.mjs sync --phase markdown');
  assert.equal(packageJson.scripts['reconcile:markdown'], 'node tools/training-maintenance.mjs sync --phase markdown');
  assert.equal(packageJson.scripts['export:markdown'], 'node tools/training-maintenance.mjs export markdown');
});

test('training maintenance import markdown remains an explicit legacy phase', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync', '--phase', 'markdown'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return { status: 'stored', markdown: { status: 'stored', days: 1 } };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'markdown');
  assert.equal(result.phase, 'markdown');
  assert.equal(result.status, 'stored');
});

test('training maintenance can dry-run markdown import before replacement', async () => {
  const calls = [];
  const result = await runTrainingMaintenance({
    argv: ['sync', '--phase', 'markdown', '--dry-run'],
    syncTrainingCore: async (options) => {
      calls.push(options);
      return {
        status: 'planned',
        markdown: {
          status: 'planned',
          dryRun: true,
          affectedDays: ['2026-04-06'],
          days: 1,
        },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'markdown');
  assert.equal(calls[0].dryRun, true);
  assert.equal(result.phase, 'markdown');
  assert.equal(result.readonly, true);
  assert.equal(result.status, 'planned');
  assert.deepEqual(result.result.markdown.affectedDays, ['2026-04-06']);
});

test('current maintenance docs and scripts document inspect sync and migrate commands', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const maintenanceGuide = await readMaintenanceGuide();

  assert.equal(packageJson.scripts['maintenance:inspect'], 'node tools/training-maintenance.mjs inspect');
  assert.equal(packageJson.scripts['maintenance:sync'], 'node tools/training-maintenance.mjs sync');
  assert.equal(packageJson.scripts['maintenance:migrate'], 'node tools/training-maintenance.mjs migrate');
  assert.match(maintenanceGuide, /npm run sync:db/);
  assert.match(maintenanceGuide, /npm run import:markdown/);
  assert.match(maintenanceGuide, /npm run export:markdown/);
  assert.match(maintenanceGuide, /npm run reconcile:markdown/);
  assert.match(maintenanceGuide, /npm run backfill:core/);
  assert.match(maintenanceGuide, /npm run backfill:thoughts/);
  assert.match(maintenanceGuide, /npm run maintenance:inspect -- --batch-id <batchId>/);
  assert.match(maintenanceGuide, /pendingDatabaseOldestAgeMinutes/);
  assert.match(maintenanceGuide, /pendingDatabaseMaxAttemptCount/);
  assert.match(maintenanceGuide, /pendingDatabaseAlertLevel/);
  assert.match(maintenanceGuide, /aiMonitoringFallbackRate/);
  assert.match(maintenanceGuide, /aiMonitoringSchemaFailureCount/);
  assert.match(maintenanceGuide, /aiMonitoringAvgRecognitionLatencyMs/);
  assert.match(maintenanceGuide, /aiMonitoringTotalCostUsd/);
  assert.match(maintenanceGuide, /recoveryTargetDays/);
  assert.match(maintenanceGuide, /node tools\/telegram-sync-fallback\.mjs inspect/);
  assert.match(maintenanceGuide, /旧 NDJSON pending 已从同步主链路下线/);
  assert.doesNotMatch(maintenanceGuide, /TELEGRAM_SYNC_REPLAY_LEGACY_NDJSON_PENDING/);
});

test('maintenance guide includes onboarding exercise prompts for production handoff', async () => {
  const maintenanceGuide = await readMaintenanceGuide();

  assert.match(maintenanceGuide, /接手演练题卡/);
  assert.match(maintenanceGuide, /Telegram\/飞书 -> Worker -> Queue -> Action -> AI -> DB -> Pages/);
  assert.match(maintenanceGuide, /Action success/);
  assert.match(maintenanceGuide, /业务 stored/);
  assert.match(maintenanceGuide, /auto_retry/);
  assert.match(maintenanceGuide, /manual_intervention/);
  assert.match(maintenanceGuide, /skipped/);
  assert.match(maintenanceGuide, /core\.\*/);
  assert.match(maintenanceGuide, /ingest\.\*/);
  assert.match(maintenanceGuide, /archive\.\*/);
  assert.match(maintenanceGuide, /训练记录\.md/);
  assert.match(maintenanceGuide, /恢复优先级/);
  assert.match(maintenanceGuide, /人工验收/);
});

test('current long-term docs cover maintenance phases and CI/test controls', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const interfaceManual = await readInterfaceManual();
  const maintenanceGuide = await readMaintenanceGuide();
  const workflowGuide = await readWorkflowGuide();

  assert.match(packageJson.scripts['backfill:core'], /--phase archive/);
  assert.match(packageJson.scripts['import:markdown'], /--phase markdown/);
  assert.match(packageJson.scripts['reconcile:markdown'], /--phase markdown/);
  assert.match(interfaceManual, /--phase markdown/);
  assert.match(interfaceManual, /--phase all/);
  assert.match(interfaceManual, /import:markdown/);
  assert.match(interfaceManual, /export:markdown/);
  assert.match(interfaceManual, /aiCallLogStatus/);
  assert.match(interfaceManual, /recognitionAttemptKinds/);
  assert.match(interfaceManual, /syncStages/);
  assert.match(interfaceManual, /dateConfidence/);
  assert.match(interfaceManual, /dateStages/);
  assert.match(maintenanceGuide, /安全数据库修复/);
  assert.match(workflowGuide, /sync\.yml/);
  assert.match(workflowGuide, /sync-dev\.yml/);
  assert.match(workflowGuide, /taskStatus/);
  assert.match(workflowGuide, /failureDisposition/);
});

test('current long-term docs cover GitHub Actions queue failure timeout and rerun recovery', async () => {
  const maintenanceGuide = await readMaintenanceGuide();
  const troubleshootingGuide = await readTroubleshootingGuide();

  for (const documentText of [maintenanceGuide, troubleshootingGuide]) {
    assert.match(documentText, /queue_task_id/);
    assert.match(documentText, /workflow run 查找超时|run lookup timeout/);
    assert.match(documentText, /dead-letter/);
    assert.match(documentText, /重跑|rerun/i);
    assert.match(documentText, /payload_hash|payloadHash/);
    assert.match(documentText, /unchanged/);
    assert.match(documentText, /重复写 core/);
  }
});

test('current docs index points maintainers to long-term operational entries instead of deleted v8 docs', async () => {
  const docsIndex = await readFile(
    new URL('../docs/README.md', import.meta.url),
    'utf8',
  );
  const maintenanceGuide = await readMaintenanceGuide();

  assert.match(docsIndex, /02_系统核心逻辑\/README\.md/);
  assert.match(docsIndex, /01_系统配置\/README\.md/);
  assert.match(docsIndex, /维护命令/);
  assert.match(docsIndex, /消息链路/);
  assert.doesNotMatch(docsIndex, /系统核心\.md/);
  assert.doesNotMatch(docsIndex, /系统配置\.md/);
  assert.doesNotMatch(docsIndex, /部署与同步优化_v8/);
  assert.doesNotMatch(docsIndex, /docs\/归档|\[归档\]|\(归档\/\)|归档\//);
  assert.doesNotMatch(maintenanceGuide, /部署与同步优化_v8/);
});
