import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { exportDerivedTrainingMarkdown } from '../tools/export-training-markdown.mjs';

test('exportDerivedTrainingMarkdown still uses database when telegram fallback batches are pending', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const runtimeDir = path.join(tempRoot, 'runtime');
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];

  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, 'telegram-sync-pending.ndjson'),
    `${JSON.stringify({ batch: { batchId: 'pending-1' } })}\n`,
    'utf8',
  );
  await writeFile(recordPath, '# 训练记录\n\n### 2026-04-06\n', 'utf8');

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'false',
    },
    buildTrainingSnapshot: async ({ source }) => {
      observedSources.push(source);
      return {
        generatedAt: '2026-05-13T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-04-06' },
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
    },
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-04-06\n',
  });

  assert.deepEqual(observedSources, ['database']);
  assert.match(await readFile(recordPath, 'utf8'), /2026-04-06/);
});

test('exportDerivedTrainingMarkdown uses database when no telegram fallback batches are pending', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const observedSources = [];
  const observedStrictValues = [];

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    env: {
      TRAINING_SNAPSHOT_STRICT_DATABASE: 'false',
    },
    buildTrainingSnapshot: async ({ source, env }) => {
      observedSources.push(source);
      observedStrictValues.push(env.TRAINING_SNAPSHOT_STRICT_DATABASE);
      return {
        generatedAt: '2026-05-13T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-05-12' },
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
    },
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-05-12\n',
  });

  assert.deepEqual(observedSources, ['database']);
  assert.deepEqual(observedStrictValues, ['true']);
});

test('exportDerivedTrainingMarkdown does not run database schema preflight by default', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push('connect');
    },
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    async end() {
      calls.push('end');
    },
  };

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    ensureCoreSchema: async (client) => {
      await client.query('alter table core.training_day add column if not exists sleep_total_minutes integer null');
    },
    buildTrainingSnapshot: async () => {
      calls.push('snapshot');
      return {
        generatedAt: '2026-06-12T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-06-12' },
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
    },
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-06-12\n',
  });

  assert.deepEqual(calls, ['snapshot']);
});

test('exportDerivedTrainingMarkdown runs database schema preflight when explicitly enabled', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push('connect');
    },
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    async end() {
      calls.push('end');
    },
  };

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED: 'true',
    },
    createClient() {
      return fakeClient;
    },
    ensureCoreSchema: async (client) => {
      await client.query('alter table core.training_day add column if not exists sleep_total_minutes integer null');
    },
    buildTrainingSnapshot: async () => {
      calls.push('snapshot');
      return {
        generatedAt: '2026-06-12T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-06-12' },
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
    },
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-06-12\n',
  });

  assert.deepEqual(calls, [
    'connect',
    'alter table core.training_day add column if not exists sleep_total_minutes integer null',
    'end',
    'snapshot',
  ]);
});

test('exportDerivedTrainingMarkdown removes old Telegram and Feishu derived thought posts before export', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-thoughts-'));
  const postsDir = path.join(tempRoot, 'source', '_posts');
  const telegramPostPath = path.join(postsDir, '2026-06-01-telegram-thought-101.md');
  const feishuPostPath = path.join(postsDir, '2026-06-01-feishu-thought-202.md');
  const legacyPostPath = path.join(postsDir, '2026-06-01-body-feedback-note.md');
  const regularPostPath = path.join(postsDir, '2026-06-01-training-summary.md');

  await mkdir(postsDir, { recursive: true });
  await writeFile(telegramPostPath, 'old telegram thought', 'utf8');
  await writeFile(feishuPostPath, 'old feishu thought', 'utf8');
  await writeFile(
    legacyPostPath,
    `---
date: 2026-06-01 10:00:00
tags:
  - 随想
  - 飞书
telegram_message_id: 303
---

legacy thought
`,
    'utf8',
  );
  await writeFile(regularPostPath, 'keep me', 'utf8');

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-06-12T00:00:00.000Z',
      latest: {
        measurement: null,
        daily: { date: '2026-06-12' },
      },
      daily: [],
      thoughts: [],
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
    }),
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-06-12\n',
  });

  await assert.rejects(access(telegramPostPath), /ENOENT/);
  await assert.rejects(access(feishuPostPath), /ENOENT/);
  await assert.rejects(access(legacyPostPath), /ENOENT/);
  assert.equal(await readFile(regularPostPath, 'utf8'), 'keep me');
});

test('exportDerivedTrainingMarkdown exports only the latest thought for a duplicated id', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-dedupe-thoughts-'));
  const oldPostPath = path.join(
    tempRoot,
    'source',
    '_posts',
    '2026-06-15-feishu-thought-1442054985160403.md',
  );
  const expectedPostPath = path.join(
    tempRoot,
    'source',
    '_posts',
    '2026-06-16-feishu-thought-1442054985160403.md',
  );

  const result = await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-06-16T04:33:38.000Z',
      latest: {
        measurement: null,
        daily: { date: '2026-06-16' },
      },
      daily: [],
      thoughts: [
        {
          date: '2026-06-15',
          time: '18:00',
          body: '旧模块正文',
          thoughtModule: 'misc',
          tags: ['杂七杂八', '随想', '飞书'],
          telegramMessageId: 1442054985160403,
          telegramChatId: null,
          sourceChannel: 'feishu',
          imageRefs: [],
        },
        {
          date: '2026-06-16',
          time: '12:33:38',
          body: '正式 2026 年 6 月 16 日 12:33:38',
          thoughtModule: 'body_feedback',
          tags: ['身体反馈', '随想', '飞书'],
          telegramMessageId: 1442054985160403,
          telegramChatId: null,
          sourceChannel: 'feishu',
          imageRefs: [],
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
    }),
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-06-16\n',
  });

  await assert.rejects(access(oldPostPath), /ENOENT/);
  const post = await readFile(expectedPostPath, 'utf8');
  assert.equal(result.thoughts.exportedCount, 1);
  assert.match(post, /thought_module: body_feedback/);
  assert.match(post, /  - 身体反馈/);
  assert.match(post, /正式 2026 年 6 月 16 日 12:33:38/);
  assert.doesNotMatch(post, /旧模块正文/);
});

test('exportDerivedTrainingMarkdown writes Feishu thought posts with source metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-feishu-thoughts-'));
  const expectedPostPath = path.join(
    tempRoot,
    'source',
    '_posts',
    '2026-06-16-feishu-thought-338182848231024.md',
  );

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    buildTrainingSnapshot: async () => ({
      generatedAt: '2026-06-16T02:20:00.000Z',
      latest: {
        measurement: null,
        daily: { date: '2026-06-16' },
      },
      daily: [],
      thoughts: [
        {
          date: '2026-06-16',
          time: '10:20',
          body: '飞书随想正文',
          thoughtModule: 'workout',
          tags: ['训练', '随想', '飞书'],
          telegramMessageId: 338182848231024,
          telegramChatId: null,
          sourceChannel: 'feishu',
          imageRefs: [],
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
    }),
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-06-16\n',
  });

  const post = await readFile(expectedPostPath, 'utf8');
  assert.match(post, /source_channel: feishu/);
  assert.match(post, /telegram_message_id: 338182848231024/);
  assert.match(post, /telegram_chat_id:\s*\n/);
  assert.match(post, /飞书随想正文/);
});

test('exportDerivedTrainingMarkdown retries transient schema preflight connection timeouts', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const calls = [];
  let clientCount = 0;

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED: 'true',
      TRAINING_DB_PREFLIGHT_RETRY_DELAY_MS: '1',
    },
    createClient() {
      clientCount += 1;
      const clientId = clientCount;
      return {
        async connect() {
          calls.push(`connect:${clientId}`);
          if (clientId === 1) {
            throw new Error('timeout expired');
          }
        },
        async query(sql) {
          calls.push(`query:${clientId}:${sql}`);
          return { rows: [] };
        },
        async end() {
          calls.push(`end:${clientId}`);
        },
      };
    },
    ensureCoreSchema: async (client) => {
      await client.query('alter table core.training_day add column if not exists sleep_total_minutes integer null');
    },
    buildTrainingSnapshot: async () => {
      calls.push('snapshot');
      return {
        generatedAt: '2026-06-12T00:00:00.000Z',
        latest: {
          measurement: null,
          daily: { date: '2026-06-12' },
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
    },
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-06-12\n',
  });

  assert.deepEqual(calls, [
    'connect:1',
    'end:1',
    'connect:2',
    'query:2:alter table core.training_day add column if not exists sleep_total_minutes integer null',
    'end:2',
    'snapshot',
  ]);
});

test('exportDerivedTrainingMarkdown surfaces incomplete database snapshots', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];
  const fakeClient = {
    async connect() {},
    async query() {
      return { rows: [] };
    },
    async end() {},
  };

  await writeFile(recordPath, '# 训练记录\n\n### 2026-04-06\n', 'utf8');

  await assert.rejects(
    exportDerivedTrainingMarkdown({
      rootDir: tempRoot,
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      createClient() {
        return fakeClient;
      },
      ensureCoreSchema: async () => {},
      buildTrainingSnapshot: async ({ source }) => {
        observedSources.push(source);
        throw new Error('database snapshot is empty or missing measurements');
      },
      exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-04-06\n',
    }),
    /database snapshot is empty or missing measurements/i,
  );

  assert.deepEqual(observedSources, ['database']);
  assert.match(await readFile(recordPath, 'utf8'), /2026-04-06/);
});

test('exportDerivedTrainingMarkdown surfaces unavailable database snapshots', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];
  const fakeClient = {
    async connect() {},
    async query() {
      return { rows: [] };
    },
    async end() {},
  };

  await writeFile(recordPath, '# 训练记录\n\n### 2026-05-14\n', 'utf8');

  await assert.rejects(
    exportDerivedTrainingMarkdown({
      rootDir: tempRoot,
      env: {
        TRAINING_DB_ENABLED: 'true',
        TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
      },
      createClient() {
        return fakeClient;
      },
      ensureCoreSchema: async () => {},
      buildTrainingSnapshot: async ({ source }) => {
        observedSources.push(source);
        throw new Error('database snapshot unavailable: timeout expired');
      },
      exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-05-14\n',
    }),
    /database snapshot unavailable: timeout expired/i,
  );

  assert.deepEqual(observedSources, ['database']);
  assert.match(await readFile(recordPath, 'utf8'), /2026-05-14/);
});

test('exportDerivedTrainingMarkdown does not let disabled schema preflight block markdown export', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push('connect');
    },
    async query() {
      throw new Error('permission denied for schema core');
    },
    async end() {
      calls.push('end');
    },
  };

  await writeFile(recordPath, '# 训练记录\n\n### 2026-05-14\n', 'utf8');

  await exportDerivedTrainingMarkdown({
    rootDir: tempRoot,
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_URL: 'postgresql://training_writer:secret@example.com:5432/training_records',
    },
    createClient() {
      return fakeClient;
    },
    ensureCoreSchema: async (client) => {
      await client.query('alter table core.training_day add column if not exists sleep_total_minutes integer null');
    },
    buildTrainingSnapshot: async () => {
      calls.push('snapshot');
      return {
        generatedAt: '2026-06-12T00:00:00.000Z',
        latest: { measurement: null, daily: { date: '2026-06-12' } },
        daily: [],
        charts: {},
      };
    },
    exportTrainingMarkdown: () => '# 训练记录\n\n### 2026-06-12\n',
  });

  assert.deepEqual(calls, ['snapshot']);
  assert.match(await readFile(recordPath, 'utf8'), /2026-06-12/);
});

test('exportDerivedTrainingMarkdown does not hide incomplete database snapshots when database is not configured', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'export-training-markdown-'));
  const recordPath = path.join(tempRoot, '训练记录.md');
  const observedSources = [];

  await writeFile(recordPath, '# 训练记录\n\n### 2026-04-06\n', 'utf8');

  await assert.rejects(
    exportDerivedTrainingMarkdown({
      rootDir: tempRoot,
      source: 'database',
      env: {
        TRAINING_DB_ENABLED: 'false',
      },
      buildTrainingSnapshot: async ({ source }) => {
        observedSources.push(source);
        throw new Error('database snapshot is empty or missing measurements');
      },
    }),
    /database snapshot is empty or missing measurements/i,
  );

  assert.deepEqual(observedSources, ['database']);
});
