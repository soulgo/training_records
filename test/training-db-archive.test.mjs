import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendTrainingArchiveFailureLog,
  persistTrainingArchive,
} from '../tools/training-db-archive.mjs';
import { generateTrainingData, renderTrainingDebugMarkdown } from '../tools/generate-training-data.mjs';

const sampleMarkdown = `
### 2026-05-11

#### 当日体脂秤截图记录

- 测量时间：2026-05-11 07:00
- 身体得分：78分
- 体重：72.10 kg
- BMI：23.0
- 体脂率：21.6%
- 骨骼肌量：31.2 kg
- 内脏脂肪等级：8.0
- 基础代谢率：1598 kcal/日
`;

const sampleParsed = {
  generatedAt: '2026-05-12T00:00:00.000Z',
  latest: {
    measurement: {
      archivedDate: '2026-05-11',
      measuredAt: '2026-05-11 07:00',
      weightKg: 72.1,
      bodyFatPct: 21.6,
    },
    daily: {
      date: '2026-05-11',
    },
  },
  daily: [
    {
      date: '2026-05-11',
      measurement: {
        archivedDate: '2026-05-11',
        measuredAt: '2026-05-11 07:00',
        weightKg: 72.1,
        bodyFatPct: 21.6,
        skeletalMuscleKg: 31.2,
      },
      measurements: [],
      activities: [],
      workoutSummary: {
        totalActivities: 0,
        totalDurationSeconds: 0,
        trainingCalories: 0,
        workoutDurationMinutes: null,
        activeHours: null,
        cyclingDistanceKm: 0,
        countsByType: {},
      },
      nutrition: {
        totalCalories: null,
        meals: [],
      },
    },
  ],
  charts: {
    weightKg: [{ date: '2026-05-11', value: 72.1 }],
    bodyFatPct: [{ date: '2026-05-11', value: 21.6 }],
    skeletalMuscleKg: [{ date: '2026-05-11', value: 31.2 }],
    basalMetabolism: [],
    visceralFatLevel: [],
    intakeCalories: [],
    trainingCalories: [],
    cyclingDistanceKm: [],
  },
};

test('persistTrainingArchive skips when database sync is disabled', async () => {
  const result = await persistTrainingArchive({
    markdownRaw: sampleMarkdown,
    parsed: sampleParsed,
    runStartedAt: new Date('2026-05-12T00:00:00.000Z'),
    runFinishedAt: new Date('2026-05-12T00:00:02.000Z'),
    env: {
      TRAINING_DB_ENABLED: 'false',
    },
  });

  assert.deepEqual(result, {
    status: 'skipped',
    reason: 'disabled',
  });
});

test('persistTrainingArchive writes snapshot and run rows in one transaction', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistTrainingArchive({
    markdownRaw: sampleMarkdown,
    parsed: sampleParsed,
    runStartedAt: new Date('2026-05-12T00:00:00.000Z'),
    runFinishedAt: new Date('2026-05-12T00:00:02.000Z'),
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TRAINING_DB_APP_NAME: 'training-records-dashboard',
      TRAINING_DB_TIMEOUT_MS: '3000',
    },
    runtimeContext: {
      triggerName: 'local-build-data',
      runtimeEnv: 'local',
      actorName: 'tester',
    },
    createClient() {
      return fakeClient;
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.dailyCount, 1);
  assert.equal(result.latestArchivedDate, '2026-05-11');
  assert.match(result.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(result.runId, /^[0-9a-f-]{36}$/);
  assert.equal(calls[0][0], 'connect');
  assert.equal(calls[1][0], 'BEGIN');
  assert.ok(calls.some(([sql]) => /select source_hash\s+from archive\.training_parse_snapshot/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into archive\.training_parse_snapshot/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into archive\.training_day/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into archive\.training_measurement/i.test(sql)));
  assert.ok(calls.some(([sql]) => /insert into archive\.training_parse_run/i.test(sql)));
  assert.equal(calls.at(-2)[0], 'COMMIT');
  assert.equal(calls.at(-1)[0], 'end');
});

test('persistTrainingArchive writes activity and meal rows when parsed data contains them', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
    },
    async end() {
      calls.push(['end']);
    },
  };

  await persistTrainingArchive({
    markdownRaw: sampleMarkdown,
    parsed: {
      ...sampleParsed,
      daily: [
        {
          ...sampleParsed.daily[0],
          activities: [
            {
              time: '08:30',
              type: '燃脂训练',
              rawType: '自由训练',
              detail: '总消耗120千卡，时长00:15:00',
              calories: 120,
              heartRate: 135,
              distanceKm: null,
              avgSpeedKmh: null,
              durationText: '00:15:00',
              durationSeconds: 900,
            },
          ],
          nutrition: {
            totalCalories: 500,
            meals: [
              {
                name: '早餐',
                calories: 500,
                recommendedMin: 300,
                recommendedMax: 600,
              },
            ],
          },
        },
      ],
    },
    runStartedAt: new Date('2026-05-12T00:00:00.000Z'),
    runFinishedAt: new Date('2026-05-12T00:00:02.000Z'),
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    runtimeContext: {
      triggerName: 'local-build-data',
      runtimeEnv: 'local',
      actorName: 'tester',
    },
    createClient() {
      return fakeClient;
    },
  });

  const executedSql = calls.map(([sql]) => sql).filter((sql) => typeof sql === 'string');
  assert.ok(executedSql.some((sql) => /insert into archive\.training_activity/i.test(sql)));
  assert.ok(executedSql.some((sql) => /insert into archive\.training_meal/i.test(sql)));
});

test('persistTrainingArchive writes sleep health metrics into archive sleep rows', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
    },
    async end() {
      calls.push(['end']);
    },
  };

  await persistTrainingArchive({
    markdownRaw: sampleMarkdown,
    parsed: {
      ...sampleParsed,
      daily: [
        {
          ...sampleParsed.daily[0],
          sleep: [
            {
              sleepType: '夜间睡眠',
              sleepStartTime: '23:26',
              sleepEndTime: '06:19',
              nightSleepMinutes: 411,
              totalSleepMinutes: 411,
              napMinutes: null,
              deepSleepMinutes: 145,
              lightSleepMinutes: 195,
              remSleepMinutes: 71,
              awakeMinutes: 2,
              sleepStageText: '深睡2小时25分钟；浅睡3小时15分钟',
              sleepStageDetail: ['深睡 2小时25分钟', '浅睡 3小时15分钟'],
              sleepScore: 81,
              sleepScorePercentile: 77,
              deepSleepRatioPct: 35,
              lightSleepRatioPct: 47,
              remSleepRatioPct: 18,
              deepSleepContinuityScore: 85,
              wakeCount: 1,
              breathingQualityScore: 90,
              averageHeartRateBpm: 68,
              hrvMs: 55,
              averageSpo2Pct: 97,
              averageRespiratoryRate: 16.5,
              analysisText: '睡眠质量良好。',
              suggestionText: '建议睡觉时关灯。',
            },
          ],
        },
      ],
    },
    runStartedAt: new Date('2026-05-12T00:00:00.000Z'),
    runFinishedAt: new Date('2026-05-12T00:00:02.000Z'),
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    runtimeContext: {
      triggerName: 'local-build-data',
      runtimeEnv: 'local',
      actorName: 'tester',
    },
    createClient() {
      return fakeClient;
    },
  });

  const sleepInsert = calls.find(([sql]) => /insert into archive\.training_sleep/i.test(sql));
  assert.ok(sleepInsert);
  assert.match(sleepInsert[0], /sleep_score/i);
  assert.match(sleepInsert[0], /average_heart_rate_bpm/i);
  assert.match(sleepInsert[0], /analysis_text/i);
  assert.match(sleepInsert[0], /\$15::text\[\]/i);
  assert.doesNotMatch(sleepInsert[0], /sleep_stage_detail[\s\S]*jsonb\[\]/i);
  assert.deepEqual(sleepInsert[1][15], [81]);
  assert.deepEqual(sleepInsert[1][16], [77]);
  assert.deepEqual(sleepInsert[1][23], [68]);
  assert.deepEqual(sleepInsert[1][28], ['建议睡觉时关灯。']);
});

test('persistTrainingArchive only updates snapshot and run when source hash is unchanged', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select\s+source_hash\s+from archive\.training_parse_snapshot/i.test(sql)) {
        return { rows: [{ source_hash: params[0] }] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const result = await persistTrainingArchive({
    markdownRaw: sampleMarkdown,
    parsed: sampleParsed,
    runStartedAt: new Date('2026-05-12T00:00:00.000Z'),
    runFinishedAt: new Date('2026-05-12T00:00:02.000Z'),
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    runtimeContext: {
      triggerName: 'local-build-data',
      runtimeEnv: 'local',
      actorName: 'tester',
    },
    createClient() {
      return fakeClient;
    },
  });

  const executedSql = calls.map(([sql]) => sql).filter((sql) => typeof sql === 'string');
  assert.equal(result.status, 'unchanged');
  assert.ok(executedSql.some((sql) => /update archive\.training_parse_snapshot/i.test(sql)));
  assert.ok(executedSql.some((sql) => /insert into archive\.training_parse_run/i.test(sql)));
  assert.ok(!executedSql.some((sql) => /insert into archive\.training_day/i.test(sql)));
  assert.ok(!executedSql.some((sql) => /insert into archive\.training_measurement/i.test(sql)));
  assert.ok(!executedSql.some((sql) => /insert into archive\.training_activity/i.test(sql)));
  assert.ok(!executedSql.some((sql) => /insert into archive\.training_meal/i.test(sql)));
  assert.ok(!executedSql.some((sql) => /insert into archive\.training_sleep/i.test(sql)));
});

test('persistTrainingArchive writes archive child tables with batch unnest upserts', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push([sql, params]);
      if (/select\s+source_hash\s+from archive\.training_parse_snapshot/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    },
  };

  await persistTrainingArchive({
    markdownRaw: sampleMarkdown,
    parsed: {
      ...sampleParsed,
      daily: [
        {
          ...sampleParsed.daily[0],
          measurements: [sampleParsed.daily[0].measurement],
          activities: [
            {
              time: '08:30',
              type: '燃脂训练',
              rawType: '自由训练',
              detail: '总消耗120千卡，时长00:15:00',
              calories: 120,
              heartRate: 135,
              distanceKm: null,
              avgSpeedKmh: null,
              durationText: '00:15:00',
              durationSeconds: 900,
            },
          ],
          nutrition: {
            totalCalories: 500,
            meals: [
              {
                name: '早餐',
                calories: 500,
                recommendedMin: 300,
                recommendedMax: 600,
              },
            ],
          },
          sleep: [
            {
              sleepType: '夜间睡眠',
              sleepStartTime: '23:26',
              sleepEndTime: '06:19',
              totalSleepMinutes: 411,
            },
          ],
        },
      ],
    },
    runStartedAt: new Date('2026-05-12T00:00:00.000Z'),
    runFinishedAt: new Date('2026-05-12T00:00:02.000Z'),
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    runtimeContext: {
      triggerName: 'local-build-data',
      runtimeEnv: 'local',
      actorName: 'tester',
    },
    createClient() {
      return fakeClient;
    },
  });

  for (const table of [
    'training_day',
    'training_measurement',
    'training_activity',
    'training_meal',
    'training_sleep',
  ]) {
    const insert = calls.find(([sql]) =>
      typeof sql === 'string' && new RegExp(`insert into archive\\.${table}`, 'i').test(sql)
    );
    assert.ok(insert, `${table} should be inserted`);
    assert.match(insert[0], /from unnest\(/i, `${table} should use batch unnest`);
  }

  const sleepInsert = calls.find(([sql]) =>
    typeof sql === 'string' && /insert into archive\.training_sleep/i.test(sql)
  );
  assert.match(sleepInsert[0], /\$15::text\[\]/i);
  assert.doesNotMatch(sleepInsert[0], /sleep_stage_detail[\s\S]*jsonb\[\]/i);
});

test('generateTrainingData keeps main outputs when archive sync fails', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-db-archive-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const stderrChunks = [];
  const loggedFailures = [];

  await writeFile(recordPath, sampleMarkdown, 'utf8');

  await generateTrainingData({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    argv: ['--trigger=local-build-data'],
    stdout: { write() {} },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
    persistArchive: async () => {
      throw new Error('database unavailable');
    },
    appendArchiveFailureLog: async (entry) => {
      loggedFailures.push(entry);
    },
  });

  const outputPath = path.join(tempRoot, 'source', '_data', 'training.json');
  const monitorViewPath = path.join(tempRoot, 'source', '_data', 'monitorView.json');
  const debugOutputPath = path.join(tempRoot, '训练数据解析.md');

  assert.ok(JSON.parse(await readFile(outputPath, 'utf8')));
  assert.ok(JSON.parse(await readFile(monitorViewPath, 'utf8')));
  assert.match(await readFile(debugOutputPath, 'utf8'), /训练数据解析排查/);
  assert.equal(loggedFailures.length, 1);
  assert.match(stderrChunks.join(''), /database unavailable/);
});

test('generateTrainingData skips archive sync when build archive write is disabled', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-build-archive-disabled-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const stdoutChunks = [];
  const stderrChunks = [];
  const archiveCalls = [];
  const loggedFailures = [];

  await writeFile(recordPath, sampleMarkdown, 'utf8');

  await generateTrainingData({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TRAINING_BUILD_ARCHIVE_WRITE: 'false',
    },
    argv: ['--trigger=local-build-data'],
    stdout: {
      write(chunk) {
        stdoutChunks.push(String(chunk));
      },
    },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
    persistArchive: async () => {
      archiveCalls.push('persist');
      throw new Error('archive should be skipped');
    },
    appendArchiveFailureLog: async (entry) => {
      loggedFailures.push(entry);
    },
  });

  assert.ok(JSON.parse(await readFile(path.join(tempRoot, 'source', '_data', 'training.json'), 'utf8')));
  assert.ok(JSON.parse(await readFile(path.join(tempRoot, 'source', '_data', 'dashboardView.json'), 'utf8')));
  assert.ok(JSON.parse(await readFile(path.join(tempRoot, 'source', '_data', 'monitorView.json'), 'utf8')));
  assert.match(await readFile(path.join(tempRoot, '训练数据解析.md'), 'utf8'), /训练数据解析排查/);
  assert.deepEqual(archiveCalls, []);
  assert.equal(loggedFailures.length, 0);
  assert.match(stdoutChunks.join(''), /Generated source\/_data\/training\.json/);
  assert.match(stdoutChunks.join(''), /Generated source\/_data\/monitorView\.json/);
  assert.match(stderrChunks.join(''), /\[training-db-archive\] skipped by TRAINING_BUILD_ARCHIVE_WRITE=false/);
});

test('generateTrainingData skips archive sync for strict database snapshots in auto mode', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-build-archive-auto-db-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const stderrChunks = [];
  const archiveCalls = [];

  await writeFile(recordPath, sampleMarkdown, 'utf8');

  await generateTrainingData({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TRAINING_SNAPSHOT_SOURCE: 'database',
      TRAINING_SNAPSHOT_STRICT_DATABASE: 'true',
      TRAINING_BUILD_ARCHIVE_WRITE: 'auto',
    },
    argv: ['--trigger=github-actions-build'],
    stdout: { write() {} },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
    buildSnapshot: async () => sampleParsed,
    persistArchive: async () => {
      archiveCalls.push('persist');
    },
  });

  assert.deepEqual(archiveCalls, []);
  assert.match(stderrChunks.join(''), /\[training-db-archive\] skipped by TRAINING_BUILD_ARCHIVE_WRITE=auto/);
});

test('generateTrainingData keeps archive sync for markdown snapshots in auto mode', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-build-archive-auto-markdown-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const archiveCalls = [];

  await writeFile(recordPath, sampleMarkdown, 'utf8');

  await generateTrainingData({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TRAINING_SNAPSHOT_SOURCE: 'markdown',
      TRAINING_BUILD_ARCHIVE_WRITE: 'auto',
    },
    argv: ['--trigger=local-build-data'],
    stdout: { write() {} },
    stderr: { write() {} },
    persistArchive: async () => {
      archiveCalls.push('persist');
      return { status: 'synced' };
    },
  });

  assert.deepEqual(archiveCalls, ['persist']);
});

test('generateTrainingData can write outputs from the shared snapshot builder', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-build-snapshot-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const syntheticSnapshot = {
    generatedAt: '2026-05-13T00:00:00.000Z',
    latest: {
      measurement: {
        archivedDate: '2026-05-12',
        measuredAt: '2026-05-12 07:00',
        weightKg: 71.8,
        bodyFatPct: 21.1,
      },
      daily: {
        date: '2026-05-12',
      },
    },
    daily: [],
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
  };

  await writeFile(recordPath, sampleMarkdown, 'utf8');

  await generateTrainingData({
    rootDir: tempRoot,
    stdout: { write() {} },
    stderr: { write() {} },
    buildSnapshot: async () => syntheticSnapshot,
    persistArchive: async () => ({ status: 'skipped', reason: 'disabled' }),
  });

  const outputPath = path.join(tempRoot, 'source', '_data', 'training.json');
  const output = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(output.generatedAt, syntheticSnapshot.generatedAt);
  assert.equal(output.latest.measurement.weightKg, 71.8);
});

test('renderTrainingDebugMarkdown includes sleep health metrics for troubleshooting', () => {
  const markdown = renderTrainingDebugMarkdown({
    ...sampleParsed,
    daily: [
      {
        ...sampleParsed.daily[0],
        sleepSummary: {
          totalSleepMinutes: 411,
          nightSleepMinutes: 411,
          sleepStartTime: '23:26',
          sleepEndTime: '06:19',
          deepSleepMinutes: 145,
          lightSleepMinutes: 195,
          remSleepMinutes: 71,
          awakeMinutes: 2,
          sleepScore: 81,
          averageHeartRateBpm: 68,
          hrvMs: 55,
          averageSpo2Pct: 97,
          averageRespiratoryRate: 16.5,
        },
      },
    ],
  });

  assert.match(markdown, /### 睡眠/);
  assert.match(markdown, /总睡眠：411 分钟/);
  assert.match(markdown, /睡眠评分：81 分/);
  assert.match(markdown, /平均心率：68 次\/分钟/);
  assert.match(markdown, /HRV：55 毫秒/);
});

test('generateTrainingData falls back to markdown when database snapshot lacks measurements', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-build-snapshot-fallback-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const outputPath = path.join(tempRoot, 'source', '_data', 'training.json');
  const observedSources = [];
  const stderrChunks = [];

  await writeFile(recordPath, sampleMarkdown, 'utf8');

  await generateTrainingData({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    argv: ['--source=database', '--trigger=github-actions-build'],
    stdout: { write() {} },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
    buildSnapshot: async ({ source }) => {
      observedSources.push(source);
      if (source === 'database') {
        throw new Error('database snapshot is empty or missing measurements');
      }
      return sampleParsed;
    },
    persistArchive: async () => ({ status: 'skipped', reason: 'disabled' }),
  });

  const output = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.deepEqual(observedSources, ['database', 'markdown']);
  assert.equal(output.latest.measurement.weightKg, 72.1);
  assert.match(stderrChunks.join(''), /falling back to markdown/i);
});

test('generateTrainingData falls back to markdown when database snapshot is unavailable', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-build-snapshot-db-timeout-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const outputPath = path.join(tempRoot, 'source', '_data', 'training.json');
  const observedSources = [];
  const stderrChunks = [];

  await writeFile(recordPath, sampleMarkdown, 'utf8');

  await generateTrainingData({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    argv: ['--source=database', '--trigger=github-actions-build'],
    stdout: { write() {} },
    stderr: {
      write(chunk) {
        stderrChunks.push(String(chunk));
      },
    },
    buildSnapshot: async ({ source }) => {
      observedSources.push(source);
      if (source === 'database') {
        throw new Error('database snapshot unavailable: timeout expired');
      }
      return sampleParsed;
    },
    persistArchive: async () => ({ status: 'skipped', reason: 'disabled' }),
  });

  const output = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.deepEqual(observedSources, ['database', 'markdown']);
  assert.equal(output.latest.measurement.weightKg, 72.1);
  assert.match(stderrChunks.join(''), /timeout expired; falling back to markdown/i);
});

test('generateTrainingData does not fall back to markdown in strict database snapshot mode', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-build-snapshot-strict-db-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];
  const stderrChunks = [];

  await writeFile(recordPath, sampleMarkdown, 'utf8');

  await assert.rejects(
    generateTrainingData({
      rootDir: tempRoot,
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
        TRAINING_SNAPSHOT_STRICT_DATABASE: 'true',
      },
      argv: ['--source=database', '--trigger=github-actions-build'],
      stdout: { write() {} },
      stderr: {
        write(chunk) {
          stderrChunks.push(String(chunk));
        },
      },
      buildSnapshot: async ({ source }) => {
        observedSources.push(source);
        throw new Error('database snapshot unavailable: timeout expired');
      },
      persistArchive: async () => ({ status: 'skipped', reason: 'disabled' }),
    }),
    /database snapshot unavailable: timeout expired/i,
  );

  assert.deepEqual(observedSources, ['database']);
  assert.doesNotMatch(stderrChunks.join(''), /falling back to markdown/i);
});

test('generateTrainingData does not hide incomplete database snapshots when database is not configured', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-build-snapshot-no-db-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];

  await writeFile(recordPath, sampleMarkdown, 'utf8');

  await assert.rejects(
    generateTrainingData({
      rootDir: tempRoot,
      env: {
        TRAINING_DB_ENABLED: 'false',
      },
      argv: ['--source=database', '--trigger=github-actions-build'],
      stdout: { write() {} },
      stderr: { write() {} },
      buildSnapshot: async ({ source }) => {
        observedSources.push(source);
        throw new Error('database snapshot is empty or missing measurements');
      },
      persistArchive: async () => ({ status: 'skipped', reason: 'disabled' }),
    }),
    /database snapshot is empty or missing measurements/i,
  );

  assert.deepEqual(observedSources, ['database']);
});

test('appendTrainingArchiveFailureLog writes ndjson entries to the configured runtime path', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'training-db-log-'));

  await appendTrainingArchiveFailureLog({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_LOG_PATH: 'runtime/training-db-sync.ndjson',
    },
    runtimeContext: {
      triggerName: 'github-actions-build',
      runtimeEnv: 'github-actions',
      actorName: 'octocat',
    },
    error: new Error('connection timeout'),
    runStartedAt: new Date('2026-05-12T00:00:00.000Z'),
    runFinishedAt: new Date('2026-05-12T00:00:02.000Z'),
    parsed: sampleParsed,
  });

  const logPath = path.join(tempRoot, 'runtime', 'training-db-sync.ndjson');
  const content = await readFile(logPath, 'utf8');
  const entry = JSON.parse(content.trim());

  assert.equal(entry.triggerName, 'github-actions-build');
  assert.equal(entry.runtimeEnv, 'github-actions');
  assert.equal(entry.actorName, 'octocat');
  assert.equal(entry.error, 'connection timeout');
  assert.equal(entry.latestArchivedDate, '2026-05-11');
});

test('pgsql init schema lives under sql directory', async () => {
  const initSqlPath = path.resolve(process.cwd(), 'sql', 'pgsql17.sql');
  await access(initSqlPath);
});

test('sleep health metric columns are present in canonical SQL schema files', async () => {
  for (const relativePath of [
    'sql/pgsql17.sql',
    'sql/training_records/core.sql',
    'sql/training_records/archive.sql',
  ]) {
    const sql = await readFile(path.resolve(process.cwd(), relativePath), 'utf8');
    assert.match(sql, /sleep_score/i, `${relativePath} should define sleep_score`);
    assert.match(sql, /average_heart_rate_bpm/i, `${relativePath} should define average_heart_rate_bpm`);
    assert.match(sql, /analysis_text/i, `${relativePath} should define analysis_text`);
    assert.match(sql, /suggestion_text/i, `${relativePath} should define suggestion_text`);
  }
});

test('canonical SQL schemas use source identity for cross-channel message and thought keys', async () => {
  const pgsql = await readFile(path.resolve(process.cwd(), 'sql/pgsql17.sql'), 'utf8');
  const ingest = await readFile(path.resolve(process.cwd(), 'sql/training_records/ingest.sql'), 'utf8');
  const core = await readFile(path.resolve(process.cwd(), 'sql/training_records/core.sql'), 'utf8');

  for (const [relativePath, sql] of [
    ['sql/pgsql17.sql', pgsql],
    ['sql/training_records/ingest.sql', ingest],
  ]) {
    assert.match(sql, /source_channel/i, `${relativePath} should store source_channel`);
    assert.match(sql, /source_chat_id/i, `${relativePath} should store source_chat_id`);
    assert.match(sql, /source_message_id/i, `${relativePath} should store source_message_id`);
    assert.match(
      sql,
      /ux_ingest_telegram_message_source_identity[\s\S]*source_channel[\s\S]*source_chat_id[\s\S]*source_message_id/i,
      `${relativePath} should uniquely key ingest messages by source identity`,
    );
    assert.doesNotMatch(
      sql,
      /telegram_message[\s\S]{0,120}message_id\s+bigint\s+primary\s+key/i,
      `${relativePath} should not use global message_id as the only ingest message key`,
    );
  }

  for (const [relativePath, sql] of [
    ['sql/pgsql17.sql', pgsql],
    ['sql/training_records/core.sql', core],
  ]) {
    assert.match(
      sql,
      /ux_core_thought_identity[\s\S]*source_channel[\s\S]*source_chat_id[\s\S]*source_message_id/i,
      `${relativePath} should uniquely key thoughts by source identity`,
    );
    assert.match(
      sql,
      /idx_core_thought_legacy_message_id/i,
      `${relativePath} should keep legacy telegram_message_id lookup indexed`,
    );
  }
});

test('canonical SQL schemas define ingest ai call log for AI audit', async () => {
  for (const relativePath of [
    'sql/pgsql17.sql',
    'sql/training_records/ingest.sql',
  ]) {
    const sql = await readFile(path.resolve(process.cwd(), relativePath), 'utf8');
    assert.match(sql, /ai_call_log/i, `${relativePath} should define ingest.ai_call_log`);
    assert.match(sql, /ai_call_id/i, `${relativePath} should store ai_call_id`);
    assert.match(sql, /idempotency_key/i, `${relativePath} should store idempotency_key`);
    assert.match(sql, /prompt_tokens/i, `${relativePath} should store prompt token usage`);
    assert.match(sql, /completion_tokens/i, `${relativePath} should store completion token usage`);
    assert.match(sql, /total_tokens/i, `${relativePath} should store total token usage`);
    assert.match(sql, /cost_usd/i, `${relativePath} should store nullable AI cost`);
    assert.match(sql, /failure_category/i, `${relativePath} should store failure_category`);
  }
});

test('pgsql init schema defines least-privilege database roles', async () => {
  const sql = await readFile(path.resolve(process.cwd(), 'sql/pgsql17.sql'), 'utf8');

  for (const role of ['training_migrator', 'training_app', 'training_maintenance', 'training_readonly']) {
    assert.match(sql, new RegExp(`create role\\s+${role}\\b`, 'i'), `pgsql17.sql should define ${role}`);
  }

  assert.match(sql, /create database training_records\s+owner training_migrator/i);
  assert.match(sql, /create schema if not exists maintenance authorization training_migrator/i);
  assert.match(sql, /create table if not exists maintenance\.schema_migration/i);
  assert.match(sql, /create schema if not exists archive authorization training_migrator/i);
  assert.match(sql, /create schema if not exists ingest authorization training_migrator/i);
  assert.match(sql, /create schema if not exists core authorization training_migrator/i);

  assert.match(sql, /grant usage on schema core,\s*ingest,\s*archive to training_app,\s*training_maintenance,\s*training_readonly/i);
  assert.match(sql, /grant select on all tables in schema core,\s*ingest,\s*archive to training_readonly/i);
  assert.match(sql, /grant select,\s*insert,\s*update on all tables in schema ingest to training_app/i);
  assert.match(sql, /grant select,\s*insert,\s*update on all tables in schema core to training_app/i);
  assert.match(sql, /grant delete on core\.measurement,\s*core\.activity,\s*core\.meal,\s*core\.sleep to training_app/i);
  assert.match(sql, /grant select,\s*insert,\s*update on archive\.training_parse_snapshot,\s*archive\.training_sleep to training_app/i);
  assert.match(sql, /grant select on maintenance\.schema_migration to training_maintenance,\s*training_readonly/i);
  assert.doesNotMatch(sql, /grant .*maintenance\.schema_migration.*training_app/i);
  assert.doesNotMatch(sql, /grant select,\s*insert,\s*update,\s*delete on all tables in schema archive to training_app/i);
  assert.doesNotMatch(sql, /grant select,\s*insert,\s*update,\s*delete on all tables in schema (?:ingest|core) to training_app/i);
});

test('database rollback SQL preserves legacy ingest and core data tables', async () => {
  const relativePath = 'sql/training_records/rollback_core_code_optimization_01.sql';
  const sql = await readFile(path.resolve(process.cwd(), relativePath), 'utf8');

  assert.match(sql, /drop table if exists ingest\.ai_call_log/i);
  assert.match(sql, /drop index (?:if exists )?ux_ingest_telegram_message_source_identity/i);
  assert.match(sql, /drop index (?:if exists )?ux_core_thought_identity/i);
  assert.doesNotMatch(sql, /drop table\s+(?:if exists\s+)?ingest\.telegram_/i);
  assert.doesNotMatch(sql, /drop table\s+(?:if exists\s+)?core\.(?:measurement|activity|meal|sleep|thought|training_day)/i);
});
