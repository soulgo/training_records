import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDashboardViewModel } from '../tools/dashboard-view.mjs';
import { buildMonitorViewModel } from '../tools/monitor-view.mjs';
import { withSharedSiteFixture } from './shared-site-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const trainingDataPath = path.join(rootDir, 'source', '_data', 'training.json');
const dashboardViewPath = path.join(rootDir, 'source', '_data', 'dashboardView.json');
const monitorViewPath = path.join(rootDir, 'source', '_data', 'monitorView.json');

test('monitor view model summarizes cross-domain progress, trends, continuity, and alerts', () => {
  const snapshot = buildMonitorSnapshot({ startDate: '2026-05-01', days: 36 });
  const monitorView = buildMonitorViewModel(snapshot, {
    weightGoalKg: 65,
    sleepTargetMinutes: 420,
    calorieRecommendedMax: 1700,
  });

  assert.equal(monitorView.title, '健身监控总览');
  assert.equal(monitorView.latestDataDate, '2026-06-05');
  assert.equal(monitorView.summaryCards.length, 4);
  assert.deepEqual(
    monitorView.summaryCards.map((card) => card.id),
    ['weight', 'bodyFat', 'sleep', 'calorieBalance'],
  );
  assert.equal(monitorView.summaryCards[0].value, '68.5 kg');
  assert.equal(monitorView.summaryCards[0].progressLabel, '目标达成 95%');
  assert.equal(monitorView.summaryCards[1].secondary, '较上次 -0.3%');
  assert.equal(monitorView.summaryCards[2].value, '81 分');
  assert.equal(monitorView.summaryCards[3].secondary, '摄入超建议 180 kcal');

  assert.equal(monitorView.trendCards.length, 4);
  assert.deepEqual(
    monitorView.trendCards.map((card) => card.chartId),
    ['monitor-calorie-chart', 'monitor-body-chart', 'monitor-sleep-chart', 'monitor-workout-chart'],
  );
  assert.equal(monitorView.chartPayload.windowDays, 30);
  assert.equal(monitorView.chartPayload.charts.weightKg.length, 30);
  assert.equal(monitorView.chartPayload.charts.sleepTotalMinutes.at(-1).value, 312);
  assert.equal(monitorView.chartPayload.charts.sleepScore.at(-1).value, 81);
  assert.equal(monitorView.chartPayload.charts.workoutDurationMinutes.at(-1).value, 54);

  assert.match(monitorView.continuityText, /连续锻炼 12 天/);
  assert.match(monitorView.continuityText, /睡眠达标连续 5 天/);
  assert.ok(
    monitorView.alerts.some((alert) => alert.includes('昨日睡眠 5.2h 偏少')),
    'expected low-sleep alert',
  );
  assert.ok(
    monitorView.alerts.some((alert) => alert.includes('今日摄入已超建议上限 180 kcal')),
    'expected calorie overage alert',
  );
});

test('monitor page renders at /monitor with the generated view model and chart payload', { concurrency: false }, () => {
  withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);
    const originalMonitorView = readOptionalFile(monitorViewPath);
    const snapshot = buildMonitorSnapshot({ startDate: '2026-05-01', days: 36 });

    try {
      ensureDataDir();
      writeFileSync(trainingDataPath, JSON.stringify(snapshot, null, 2));
      writeFileSync(dashboardViewPath, JSON.stringify(buildDashboardViewModel(snapshot), null, 2));
      writeFileSync(
        monitorViewPath,
        JSON.stringify(
          buildMonitorViewModel(snapshot, {
            weightGoalKg: 65,
            sleepTargetMinutes: 420,
            calorieRecommendedMax: 1700,
          }),
          null,
          2,
        ),
      );
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });

      const monitorPage = readFileSync(path.join(rootDir, 'public', 'monitor', 'index.html'), 'utf8');
      const cardMatches = monitorPage.match(/<article class="monitor-progress-card/g) ?? [];
      const payloadMatch = monitorPage.match(
        /<script id="training-monitor-data" type="application\/json">([\s\S]*?)<\/script>/,
      );

      assert.match(monitorPage, /<section class="monitor-page">/);
      assert.match(monitorPage, /健身监控总览/);
      assert.match(monitorPage, /<a href="\/monitor\/">监控<\/a>/);
      assert.equal(cardMatches.length, 4);
      assert.match(monitorPage, /<canvas id="monitor-calorie-chart"><\/canvas>/);
      assert.match(monitorPage, /<canvas id="monitor-body-chart"><\/canvas>/);
      assert.match(monitorPage, /连续锻炼 12 天/);
      assert.match(monitorPage, /昨日睡眠 5.2h 偏少/);
      assert.ok(payloadMatch, 'expected embedded monitor payload');

      const payload = JSON.parse(payloadMatch[1]);
      assert.equal(payload.windowDays, 30);
      assert.equal(payload.charts.weightKg.length, 30);
      assert.equal(payload.charts.sleepScore.at(-1).value, 81);
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
      restoreOptionalFile(monitorViewPath, originalMonitorView);
    }
  });
});

function buildMonitorSnapshot({ startDate, days }) {
  const daily = [];
  const charts = {
    weightKg: [],
    bodyFatPct: [],
    skeletalMuscleKg: [],
    intakeCalories: [],
    trainingCalories: [],
  };

  for (let index = 0; index < days; index += 1) {
    const date = addDays(startDate, index);
    const measurement = {
      archivedDate: date,
      measuredAt: `${date} 07:30`,
      weightKg: Number((72 - index * 0.1).toFixed(1)),
      bodyFatPct: Number((22 - index * 0.1).toFixed(1)),
      skeletalMuscleKg: Number((30 + index * 0.02).toFixed(1)),
      basalMetabolismKcal: 1560 + index,
      visceralFatLevel: 8,
      bmi: 22,
      bodyWaterPct: 50,
      proteinPct: 23,
      bodyAge: 30,
      bodyType: '标准',
    };
    const trainingCalories = index < 24 ? 0 : 800;
    const totalSleepMinutes = index < 30 ? 360 : 430;
    const sleepScore = index < 30 ? 72 : 84;
    const totalCalories = 1500;

    daily.push({
      date,
      measurement,
      measurements: [measurement],
      activities: [{
        time: '08:00',
        type: '力量训练',
        durationSeconds: 3240,
        calories: trainingCalories,
        heartRate: 128,
      }],
      workoutSummary: {
        totalActivities: trainingCalories > 0 ? 1 : 0,
        trainingCalories,
        workoutDurationMinutes: 54,
        totalDurationSeconds: 3240,
        cyclingDistanceKm: 0,
        countsByType: trainingCalories > 0 ? { 力量训练: 1 } : {},
      },
      nutrition: {
        totalCalories,
        meals: [{ name: '晚餐', calories: totalCalories }],
      },
      sleep: [],
      sleepSummary: {
        totalSleepMinutes,
        nightSleepMinutes: totalSleepMinutes,
        sleepScore,
        averageHeartRateBpm: 62,
      },
    });

    charts.weightKg.push({ date, value: measurement.weightKg });
    charts.bodyFatPct.push({ date, value: measurement.bodyFatPct });
    charts.skeletalMuscleKg.push({ date, value: measurement.skeletalMuscleKg });
    charts.intakeCalories.push({ date, value: totalCalories });
    charts.trainingCalories.push({ date, value: trainingCalories });
  }

  const latestDay = daily.at(-1);
  const previousDay = daily.at(-2);
  latestDay.measurement.weightKg = 68.5;
  latestDay.measurement.bodyFatPct = 18.2;
  latestDay.nutrition.totalCalories = 1880;
  latestDay.nutrition.meals[0].calories = 1880;
  latestDay.sleepSummary.totalSleepMinutes = 312;
  latestDay.sleepSummary.nightSleepMinutes = 312;
  latestDay.sleepSummary.sleepScore = 81;
  previousDay.measurement.weightKg = 68.7;
  previousDay.measurement.bodyFatPct = 18.5;
  previousDay.sleepSummary.sleepScore = 78;

  const latestIndex = charts.weightKg.length - 1;
  const previousIndex = latestIndex - 1;
  charts.weightKg[latestIndex].value = latestDay.measurement.weightKg;
  charts.weightKg[previousIndex].value = previousDay.measurement.weightKg;
  charts.bodyFatPct[latestIndex].value = latestDay.measurement.bodyFatPct;
  charts.bodyFatPct[previousIndex].value = previousDay.measurement.bodyFatPct;
  charts.intakeCalories[latestIndex].value = latestDay.nutrition.totalCalories;

  return {
    generatedAt: '2026-06-05T10:32:00.000Z',
    latest: {
      measurement: latestDay.measurement,
      daily: latestDay,
    },
    daily,
    charts,
  };
}

function addDays(startDate, offset) {
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function ensureDataDir() {
  mkdirSync(path.dirname(trainingDataPath), { recursive: true });
}

function readOptionalFile(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}

function restoreOptionalFile(filePath, originalContent) {
  if (originalContent === null) {
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
    return;
  }
  writeFileSync(filePath, originalContent);
}
