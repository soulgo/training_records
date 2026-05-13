import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDashboardViewModel } from '../tools/dashboard-view.mjs';

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

function buildDay(date) {
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
    nutrition: {
      meals: [],
      totalCalories: null,
      details: [],
    },
  };
}
