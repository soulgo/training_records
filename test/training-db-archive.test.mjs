import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendTrainingArchiveFailureLog,
  persistTrainingArchive,
} from '../tools/training-db-archive.mjs';
import { generateTrainingData } from '../tools/generate-training-data.mjs';

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
  assert.match(calls[2][0], /insert into archive\.training_parse_snapshot/i);
  assert.match(calls[3][0], /insert into archive\.training_parse_run/i);
  assert.equal(calls[4][0], 'COMMIT');
  assert.equal(calls[5][0], 'end');
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
  const debugOutputPath = path.join(tempRoot, '训练数据解析.md');

  assert.ok(JSON.parse(await readFile(outputPath, 'utf8')));
  assert.match(await readFile(debugOutputPath, 'utf8'), /训练数据解析排查/);
  assert.equal(loggedFailures.length, 1);
  assert.match(stderrChunks.join(''), /database unavailable/);
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
