import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BodyMetricGenerator,
  DashboardGenerator,
  HexoGeneratorAdapter,
  MonitorGenerator,
  TrainingDayGenerator,
} from '../src/adapters/hexo/index.mjs';
import { verifyTelegramWebhookSecret } from '../src/adapters/telegram/index.mjs';

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
      new MonitorGenerator({ buildMonitorViewModel: (input) => ({ monitorDate: input.latest.daily.date }) }),
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
    'monitorView.json',
  ]);
  assert.equal(writes.get('training.json').daily[0].date, '2026-06-03');
  assert.equal(writes.get('body-metrics.json').measurements[0].weightKg, 70.5);
  assert.deepEqual(writes.get('dashboardView.json'), { latestDate: '2026-06-03' });
  assert.deepEqual(writes.get('monitorView.json'), { monitorDate: '2026-06-03' });
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

test('package scripts point migrated jobs at app use-case entrypoints', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

  assert.equal(packageJson.scripts['build:data'], 'node src/app/use-cases/generate-training-data.use-case.mjs');
  assert.equal(packageJson.scripts['sync:telegram'], 'node src/app/use-cases/telegram-sync.use-case.mjs');
});

test('telegram sync use case owns the executable entrypoint and orchestration', async () => {
  const useCase = await readFile('src/app/use-cases/telegram-sync.use-case.mjs', 'utf8');

  assert.match(useCase, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(useCase, /await main\(\)/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync\.mjs/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync-lib\.mjs/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync-status\.mjs/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync-fallback\.mjs/);
  assert.doesNotMatch(useCase, /tools\/telegram-sync-image-processing\.mjs/);
});

test('Feishu enters the shared message sync boundary directly', async () => {
  const useCase = await readFile('src/app/use-cases/feishu-sync.use-case.mjs', 'utf8');

  assert.match(useCase, /runMessageSync/);
  assert.doesNotMatch(useCase, /runTelegramSync/);
});
