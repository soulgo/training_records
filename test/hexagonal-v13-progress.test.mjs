import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { TrainingSnapshotService } from '../src/core/services/training-snapshot-service.mjs';
import {
  BodyMetricGenerator,
  DashboardGenerator,
  HexoGeneratorAdapter,
  TrainingDayGenerator,
} from '../src/adapters/hexo/index.mjs';
import { verifyTelegramWebhookSecret } from '../src/adapters/telegram/index.mjs';

test('TrainingSnapshotService builds snapshots from repository daily records', async () => {
  const service = new TrainingSnapshotService({
    trainingRepository: {
      async findByDates(dates) {
        assert.deepEqual(dates, ['2026-06-03', '2026-06-04']);
        return [
          {
            date: '2026-06-03',
            measurement: { weightKg: 70.5 },
            measurements: [{ weightKg: 70.5 }],
            activities: [{ type: '骑行', durationSeconds: 600 }],
            workoutSummary: { totalActivities: 1, totalDurationSeconds: 600, trainingCalories: 120 },
            nutrition: { meals: [], totalCalories: null, details: [] },
            sleep: [],
            sleepSummary: { records: [], totalSleepMinutes: null },
          },
        ];
      },
    },
    now: () => new Date('2026-06-10T00:00:00.000Z'),
  });

  const snapshot = await service.buildByDates(['2026-06-03', '2026-06-04']);

  assert.equal(snapshot.generatedAt, '2026-06-10T00:00:00.000Z');
  assert.equal(snapshot.daily.length, 1);
  assert.equal(snapshot.latest.daily.date, '2026-06-03');
});

test('HexoGeneratorAdapter coordinates split generators into JSON payloads', async () => {
  const snapshot = {
    generatedAt: '2026-06-10T00:00:00.000Z',
    daily: [
      {
        date: '2026-06-03',
        measurements: [{ weightKg: 70.5 }],
        activities: [{ type: '骑行' }],
        workoutSummary: { totalActivities: 1 },
        nutrition: { meals: [], totalCalories: 900, details: [] },
        sleepSummary: { totalSleepMinutes: 411 },
      },
    ],
    latest: { daily: { date: '2026-06-03' } },
  };
  const writes = new Map();
  const adapter = new HexoGeneratorAdapter({
    generators: [
      new TrainingDayGenerator(),
      new BodyMetricGenerator(),
      new DashboardGenerator({ buildDashboardViewModel: (input) => ({ latestDate: input.latest.daily.date }) }),
    ],
    writeJson: async (relativePath, payload) => {
      writes.set(relativePath, payload);
    },
  });

  const result = await adapter.generate({ snapshot });

  assert.deepEqual(result.outputs, [
    'training.json',
    'body-metrics.json',
    'dashboardView.json',
  ]);
  assert.equal(writes.get('training.json').daily[0].date, '2026-06-03');
  assert.equal(writes.get('body-metrics.json').measurements[0].weightKg, 70.5);
  assert.deepEqual(writes.get('dashboardView.json'), { latestDate: '2026-06-03' });
});

test('verifyTelegramWebhookSecret rejects missing or wrong Telegram secret header', () => {
  assert.equal(
    verifyTelegramWebhookSecret({
      headers: { 'x-telegram-bot-api-secret-token': 'expected' },
      secretToken: 'expected',
    }),
    true,
  );
  assert.throws(
    () => verifyTelegramWebhookSecret({
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      secretToken: 'expected',
    }),
    /Invalid Telegram webhook secret/,
  );
  assert.throws(
    () => verifyTelegramWebhookSecret({
      headers: {},
      secretToken: 'expected',
    }),
    /Missing Telegram webhook secret/,
  );
});

test('job wrappers delegate to app use-case modules instead of tools directly', async () => {
  for (const relativePath of [
    'src/jobs/generate-training-data-job.mjs',
    'src/jobs/telegram-sync-job.mjs',
    'src/jobs/training-analysis-job.mjs',
  ]) {
    const source = await readFile(relativePath, 'utf8');
    assert.match(source, /src\/app|app\/use-cases|\.\.\/app\/use-cases/);
    assert.doesNotMatch(source, /\.\.\/\.\.\/tools\//);
  }
});

test('tools compatibility modules re-export src implementations for migrated boundaries', async () => {
  const configFacade = await readFile('tools/training-db-config.mjs', 'utf8');
  const thoughtModulesFacade = await readFile('tools/lib/thought-modules.mjs', 'utf8');
  const dbWriteFacade = await readFile('tools/training-db-write.mjs', 'utf8');
  const postgresAdapterIndex = await readFile('src/adapters/postgres/index.mjs', 'utf8');

  assert.match(configFacade, /\.\.\/src\/db\/training\/config\.mjs/);
  assert.match(thoughtModulesFacade, /\.\.\/\.\.\/src\/core\/thought-modules\.mjs/);
  assert.match(dbWriteFacade, /\.\.\/src\/adapters\/postgres\//);
  assert.doesNotMatch(dbWriteFacade, /\.\.\/src\/db\/training\/write\.mjs/);
  assert.match(postgresAdapterIndex, /core-day-repository\.pg\.mjs/);
  assert.match(postgresAdapterIndex, /archive-repository\.pg\.mjs/);
});

test('package scripts point migrated jobs at app use-case entrypoints', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

  assert.equal(packageJson.scripts['build:data'], 'node src/app/use-cases/generate-training-data.use-case.mjs');
  assert.equal(packageJson.scripts['sync:telegram'], 'node src/app/use-cases/telegram-sync.use-case.mjs');
});

test('telegram sync primary CLI is thin and app use-case owns orchestration', async () => {
  const toolEntrypoint = await readFile('tools/telegram-sync.mjs', 'utf8');
  const useCase = await readFile('src/app/use-cases/telegram-sync.use-case.mjs', 'utf8');
  const srcBatchAdapter = await readFile('src/telegram/sync-batch.mjs', 'utf8');

  assert.match(toolEntrypoint, /src\/app\/use-cases\/telegram-sync\.use-case\.mjs/);
  assert.doesNotMatch(toolEntrypoint, /from ['"]\.\/telegram-sync-lib\.mjs/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync\.mjs/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync-lib\.mjs/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync-status\.mjs/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync-fallback\.mjs/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync-image-processing\.mjs/);
  assert.match(srcBatchAdapter, /adapters\/telegram\/sync-batch\.adapter\.mjs/);
});
