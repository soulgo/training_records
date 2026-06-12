import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDashboardViewModel } from '../src/site/dashboard-view.mjs';

test('dashboard view normalizes database date objects before calculating chart windows', () => {
  const view = buildDashboardViewModel({
    generatedAt: '2026-05-13T00:00:00.000Z',
    latest: {
      measurement: { archivedDate: new Date('2026-05-12T00:00:00.000Z'), weightKg: 72 },
      daily: buildDay(new Date('2026-05-12T00:00:00.000Z')),
    },
    daily: [
      buildDay('2026-04-12'),
      buildDay('2026-04-13'),
      buildDay(new Date('2026-05-12T00:00:00.000Z')),
    ],
    charts: {
      weightKg: [
        { date: '2026-04-12', value: 73 },
        { date: '2026-04-13', value: 72.8 },
        { date: '2026-05-12', value: 72 },
      ],
    },
  });

  assert.equal(view.latestDashboardDate, '2026-05-12');
  assert.equal(view.latestMeasurement.archivedDate, '2026-05-12');
  assert.equal(view.latestDay.date, '2026-05-12');
  assert.deepEqual(
    view.chartPayload.charts.weightKg.map((point) => point.date),
    ['2026-04-13', '2026-05-12'],
  );
});

test('dashboard view falls back to the latest valid daily date when latest dates are malformed', () => {
  const view = buildDashboardViewModel({
    generatedAt: '2026-05-13T00:00:00.000Z',
    latest: {
      measurement: { archivedDate: 'Invalid Date', weightKg: 72 },
      daily: buildDay('not-a-date'),
    },
    daily: [buildDay('2026-05-10'), buildDay('not-a-date')],
    charts: {
      weightKg: [
        { date: '2026-05-10', value: 72.5 },
        { date: '2026-05-11', value: 72.3 },
      ],
    },
  });

  assert.equal(view.latestDashboardDate, '2026-05-10');
  assert.equal(view.chartPayload.charts.weightKg.length, 2);
});

test('dashboard sleep cards use the latest day that has sleep data', () => {
  const view = buildDashboardViewModel({
    generatedAt: '2026-06-04T00:00:00.000Z',
    latest: {
      measurement: { archivedDate: '2026-06-04', weightKg: 72.1 },
      daily: buildDay('2026-06-04', {
        measurement: { archivedDate: '2026-06-04', weightKg: 72.1 },
        trainingCalories: 240,
      }),
    },
    daily: [
      buildDay('2026-06-03', {
        sleepSummary: {
          totalSleepMinutes: 411,
          nightSleepMinutes: 411,
          napMinutes: null,
          deepSleepMinutes: 145,
          lightSleepMinutes: 195,
          remSleepMinutes: 71,
          awakeMinutes: null,
          sleepStartTime: '23:26',
          sleepEndTime: '06:19',
          sleepScore: 81,
          deepSleepRatioPct: 35,
          lightSleepRatioPct: 47,
          remSleepRatioPct: 18,
        },
      }),
      buildDay('2026-06-04', {
        measurement: { archivedDate: '2026-06-04', weightKg: 72.1 },
        trainingCalories: 240,
      }),
    ],
    charts: {
      weightKg: [{ date: '2026-06-04', value: 72.1 }],
    },
  });

  assert.match(view.sleepCards[0].valueHtml, /411/);
  assert.match(view.sleepCards[1].valueHtml, /145/);
  assert.match(view.sleepCards[1].valueHtml, /195/);
  assert.match(view.sleepCards[2].valueHtml, /35/);
  assert.match(view.sleepCards[2].valueHtml, /47/);
});

test('dashboard sleep cards ignore incomplete latest sleep metrics without duration', () => {
  const view = buildDashboardViewModel({
    generatedAt: '2026-06-05T00:00:00.000Z',
    latest: {
      measurement: { archivedDate: '2026-06-05', weightKg: 72.1 },
      daily: buildDay('2026-06-05', {
        measurement: { archivedDate: '2026-06-05', weightKg: 72.1 },
        sleepSummary: {
          totalSleepMinutes: null,
          nightSleepMinutes: null,
          napMinutes: null,
          deepSleepMinutes: 82,
          lightSleepMinutes: 271,
          remSleepMinutes: 85,
          awakeMinutes: 15,
          sleepScore: 79,
        },
      }),
    },
    daily: [
      buildDay('2026-06-03', {
        sleepSummary: {
          totalSleepMinutes: 411,
          nightSleepMinutes: 411,
          napMinutes: null,
          deepSleepMinutes: 145,
          lightSleepMinutes: 115,
          remSleepMinutes: 111,
          awakeMinutes: null,
        },
      }),
      buildDay('2026-06-04', {
        sleepSummary: {
          totalSleepMinutes: 473,
          nightSleepMinutes: 473,
          napMinutes: null,
          deepSleepMinutes: 60,
          lightSleepMinutes: 276,
          remSleepMinutes: 85,
          awakeMinutes: 52,
          deepSleepRatioPct: 18,
          lightSleepRatioPct: 63,
        },
      }),
      buildDay('2026-06-05', {
        measurement: { archivedDate: '2026-06-05', weightKg: 72.1 },
        sleepSummary: {
          totalSleepMinutes: null,
          nightSleepMinutes: null,
          napMinutes: null,
          deepSleepMinutes: 82,
          lightSleepMinutes: 271,
          remSleepMinutes: 85,
          awakeMinutes: 15,
          sleepScore: 79,
        },
      }),
    ],
    charts: {},
  });

  assert.match(view.sleepCards[0].valueHtml, /473/);
  assert.match(view.sleepCards[1].valueHtml, /60/);
  assert.match(view.sleepCards[1].valueHtml, /276/);
  assert.match(view.sleepCards[2].valueHtml, /18/);
  assert.match(view.sleepCards[2].valueHtml, /63/);
});

test('dashboard sleep cards fall back to night sleep when total duration is missing', () => {
  const view = buildDashboardViewModel({
    generatedAt: '2026-06-12T00:00:00.000Z',
    latest: {
      measurement: { archivedDate: '2026-06-11', weightKg: 71.2 },
      daily: buildDay('2026-06-11', {
        measurement: { archivedDate: '2026-06-11', weightKg: 71.2 },
        sleepSummary: {
          totalSleepMinutes: null,
          nightSleepMinutes: 372,
          napMinutes: null,
          deepSleepMinutes: 109,
          lightSleepMinutes: 175,
          remSleepMinutes: 88,
          awakeMinutes: null,
          sleepScore: 78,
          deepSleepRatioPct: 29,
          lightSleepRatioPct: 48,
        },
      }),
    },
    daily: [
      buildDay('2026-06-11', {
        measurement: { archivedDate: '2026-06-11', weightKg: 71.2 },
        sleepSummary: {
          totalSleepMinutes: null,
          nightSleepMinutes: 372,
          napMinutes: null,
          deepSleepMinutes: 109,
          lightSleepMinutes: 175,
          remSleepMinutes: 88,
          awakeMinutes: null,
          sleepScore: 78,
          deepSleepRatioPct: 29,
          lightSleepRatioPct: 48,
        },
      }),
    ],
    charts: {},
  });

  assert.match(view.sleepCards[0].valueHtml, /372/);
  assert.equal(view.recentDays[0].sleepLabel, '372 分钟');
});

test('dashboard view model keeps the stable rendering contract for overview cards and charts', () => {
  const view = buildDashboardViewModel({
    generatedAt: '2026-05-13T00:00:00.000Z',
    latest: {
      measurement: {
        archivedDate: '2026-05-12',
        weightKg: 72.5,
      },
      daily: buildDay('2026-05-12', {
        measurement: { archivedDate: '2026-05-12', weightKg: 72.5 },
        trainingCalories: 330,
        workoutDurationMinutes: 45,
        cyclingDistanceKm: 3.2,
        totalCalories: 1560,
        sleepSummary: {
          totalSleepMinutes: 420,
          nightSleepMinutes: 390,
          napMinutes: 30,
          deepSleepMinutes: 110,
          lightSleepMinutes: 240,
          remSleepMinutes: 70,
          awakeMinutes: 20,
          sleepStartTime: '23:15',
          sleepEndTime: '06:25',
        },
        countsByType: { 力量训练: 1 },
      }),
    },
    daily: [
      buildDay('2026-05-09', {
        measurement: { archivedDate: '2026-05-09', weightKg: 73.2 },
        trainingCalories: 0,
        workoutDurationMinutes: null,
        totalCalories: null,
      }),
      buildDay('2026-05-10', {
        trainingCalories: 420,
        totalDurationSeconds: 3600,
        cyclingDistanceKm: 5,
        totalCalories: 1480,
        countsByType: { 燃脂训练: 1 },
      }),
      buildDay('2026-05-11', {
        trainingCalories: 0,
        totalCalories: 1520,
      }),
      buildDay('2026-05-12', {
        measurement: { archivedDate: '2026-05-12', weightKg: 72.5 },
        trainingCalories: 330,
        workoutDurationMinutes: 45,
        cyclingDistanceKm: 3.2,
        totalCalories: 1560,
        sleepSummary: {
          totalSleepMinutes: 420,
          nightSleepMinutes: 390,
          napMinutes: 30,
          deepSleepMinutes: 110,
          lightSleepMinutes: 240,
          remSleepMinutes: 70,
          awakeMinutes: 20,
          sleepStartTime: '23:15',
          sleepEndTime: '06:25',
        },
        countsByType: { 力量训练: 1 },
      }),
    ],
    charts: {
      weightKg: [
        { date: '2026-04-12', value: 74 },
        { date: '2026-04-13', value: 73.8 },
        { date: '2026-05-12', value: 72.5 },
      ],
      trainingCalories: [
        { date: '2026-05-10', value: 420 },
        { date: '2026-05-12', value: 330 },
      ],
    },
  });

  assert.deepEqual(
    Object.keys(view).sort(),
    [
      'chartCards',
      'chartPayload',
      'chartWindowDays',
      'dailyCardLimit',
      'dailyOverviewEntries',
      'dailyOverviewHint',
      'dailyOverviewTotal',
      'generatedAt',
      'latestDashboardDate',
      'latestDay',
      'latestMeasurement',
      'overviewMeta',
      'overviewStats',
      'previousDay',
      'primaryMetrics',
      'recentDays',
      'secondaryMetrics',
      'sleepCards',
      'totalArchivedDays',
      'trainedDays',
    ].sort(),
  );
  assert.equal(view.generatedAt, '2026-05-13T00:00:00.000Z');
  assert.equal(view.latestDashboardDate, '2026-05-12');
  assert.equal(view.chartWindowDays, 30);
  assert.equal(view.dailyCardLimit, 4);
  assert.equal(view.dailyOverviewTotal, 4);
  assert.equal(view.trainedDays, 2);
  assert.equal(view.totalArchivedDays, 4);
  assert.equal(view.latestMeasurement.archivedDate, '2026-05-12');
  assert.equal(view.latestDay.date, '2026-05-12');
  assert.equal(view.previousDay.date, '2026-05-11');
  assert.deepEqual(
    view.recentDays.map((day) => ({
      date: day.date,
      weightLabel: day.weightLabel,
      activityCount: day.activityCount,
      trainingCaloriesLabel: day.trainingCaloriesLabel,
      workoutDurationLabel: day.workoutDurationLabel,
      cyclingDistanceLabel: day.cyclingDistanceLabel,
      nutritionCaloriesLabel: day.nutritionCaloriesLabel,
      tags: day.tags,
    })),
    [
      {
        date: '2026-05-12',
        weightLabel: '72.50 kg',
        activityCount: '1',
        trainingCaloriesLabel: '330 kcal',
        workoutDurationLabel: '45 分钟',
        cyclingDistanceLabel: '3.20 km',
        nutritionCaloriesLabel: '1560 kcal',
        tags: ['力量训练 × 1'],
      },
      {
        date: '2026-05-11',
        weightLabel: '无体脂数据',
        activityCount: '0',
        trainingCaloriesLabel: '0 kcal',
        workoutDurationLabel: '—',
        cyclingDistanceLabel: '0 km',
        nutritionCaloriesLabel: '1520 kcal',
        tags: [],
      },
      {
        date: '2026-05-10',
        weightLabel: '无体脂数据',
        activityCount: '1',
        trainingCaloriesLabel: '420 kcal',
        workoutDurationLabel: '1小时0分',
        cyclingDistanceLabel: '5 km',
        nutritionCaloriesLabel: '1480 kcal',
        tags: ['燃脂训练 × 1'],
      },
      {
        date: '2026-05-09',
        weightLabel: '73.20 kg',
        activityCount: '0',
        trainingCaloriesLabel: '0 kcal',
        workoutDurationLabel: '—',
        cyclingDistanceLabel: '0 km',
        nutritionCaloriesLabel: '—',
        tags: [],
      },
    ],
  );
  assert.match(view.recentDays[0].cardHtml, /<article class="day-card">/);
  assert.match(view.recentDays[0].cardHtml, /力量训练 × 1/);
  assert.match(view.primaryMetrics[0].comparisonHtml, /hero-card__comparison/);
  assert.match(view.secondaryMetrics[0].comparisonHtml, /metric-card__comparison/);
  assert.match(view.sleepCards[0].comparisonHtml, /metric-card__comparison/);
  assert.deepEqual(
    view.sleepCards.map((card) => card.title),
    ['总睡眠', '深睡 / 浅睡', '深睡 / 浅睡比例'],
  );
  assert.deepEqual(
    view.chartPayload.charts.weightKg.map((point) => point.date),
    ['2026-04-13', '2026-05-12'],
  );
  assert.deepEqual(
    view.chartPayload.charts.trainingCalories.map((point) => point.date),
    ['2026-05-10', '2026-05-12'],
  );
});

function buildDay(date, overrides = null) {
  if (overrides) {
    return {
      date,
      measurement: overrides.measurement ?? null,
      measurements: overrides.measurement ? [overrides.measurement] : [],
      activities:
        overrides.trainingCalories || overrides.workoutDurationMinutes || overrides.totalDurationSeconds
          ? [
              {
                time: '19:00',
                type: Object.keys(overrides.countsByType ?? {})[0] ?? '力量训练',
                detail: '测试训练记录',
              },
            ]
          : [],
      workoutSummary: {
        totalActivities: overrides.trainingCalories || overrides.workoutDurationMinutes || overrides.totalDurationSeconds ? 1 : 0,
        totalDurationSeconds: overrides.totalDurationSeconds ?? 0,
        trainingCalories: overrides.trainingCalories ?? 0,
        workoutDurationMinutes: overrides.workoutDurationMinutes ?? null,
        activeHours: overrides.activeHours ?? null,
        cyclingDistanceKm: overrides.cyclingDistanceKm ?? 0,
        countsByType: overrides.countsByType ?? {},
      },
      sleepSummary: overrides.sleepSummary ?? {
        totalSleepMinutes: null,
        nightSleepMinutes: null,
        napMinutes: null,
        deepSleepMinutes: null,
        lightSleepMinutes: null,
        remSleepMinutes: null,
        awakeMinutes: null,
        sleepStartTime: null,
        sleepEndTime: null,
      },
      nutrition: {
        meals: [],
        totalCalories: overrides.totalCalories ?? null,
        details: [],
      },
    };
  }

  return {
    date,
    measurement: null,
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
    sleepSummary: {
      totalSleepMinutes: null,
      nightSleepMinutes: null,
      napMinutes: null,
      deepSleepMinutes: null,
      lightSleepMinutes: null,
      remSleepMinutes: null,
      awakeMinutes: null,
      sleepStartTime: null,
      sleepEndTime: null,
    },
    nutrition: {
      meals: [],
      totalCalories: null,
      details: [],
    },
  };
}
