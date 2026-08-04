import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDashboardViewModel } from '../src/site/dashboard-view.mjs';
import { buildMonitorViewModel } from '../src/site/monitor-view.mjs';
import {
  readFixtureFile,
  restoreFixtureFile,
  withSharedSiteFixture,
  writeFixtureFile,
} from './shared-site-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const trainingDataPath = path.join(rootDir, 'source', '_data', 'training.json');
const dashboardViewPath = path.join(rootDir, 'source', '_data', 'dashboardView.json');
const monitorViewPath = path.join(rootDir, 'source', '_data', 'monitorView.json');

test('monitor view model summarizes the latest day and daily report facts', () => {
  const snapshot = buildMonitorSnapshot({ startDate: '2026-05-01', days: 36 });
  const monitorView = buildMonitorViewModel(snapshot, {
    weightGoalKg: 65,
    sleepTargetMinutes: 420,
    calorieRecommendedMax: 1700,
  });

  assert.equal(monitorView.title, '每日训练报告');
  assert.equal(monitorView.latestDataDate, '2026-06-05');
  assert.equal(monitorView.summaryCards.length, 4);
  assert.deepEqual(
    monitorView.summaryCards.map((card) => card.id),
    ['weight', 'bodyFat', 'sleep', 'calories'],
  );
  assert.equal(monitorView.summaryCards[0].value, '68.5 kg');
  assert.equal(monitorView.summaryCards[0].hint, '目标 65 kg');
  assert.equal(monitorView.summaryCards[1].delta, '较上次 -0.3%');
  assert.equal(monitorView.summaryCards[2].value, '81 分');
  assert.equal(monitorView.summaryCards[3].delta, '+180 kcal');
  assert.deepEqual(monitorView.facts.body.map((item) => item.label), ['骨骼肌量', '基础代谢', '体脂率']);
  assert.deepEqual(monitorView.facts.training.map((item) => item.label), ['训练时长', '训练消耗', '训练类型']);
  assert.deepEqual(monitorView.facts.nutrition.map((item) => item.label), ['总摄入', '已记录餐次', '建议上限']);
  assert.deepEqual(monitorView.facts.recovery.map((item) => item.label), ['睡眠时长', '睡眠评分', 'HRV']);
  assert.equal(monitorView.dataQuality.completenessPct, 100);
  assert.equal(monitorView.dataQuality.missingItems.length, 0);
  assert.ok(
    monitorView.alerts.some((alert) => alert.includes('睡眠 5.2 小时偏少')),
    'expected low-sleep alert',
  );
  assert.ok(
    monitorView.alerts.some((alert) => alert.includes('摄入超过建议上限 180 kcal')),
    'expected calorie overage alert',
  );
});

test('monitor view treats the snapshot latest measurement as current body data', () => {
  const monitorView = buildMonitorViewModel({
    latest: {
      measurement: { archivedDate: '2026-06-05', weightKg: 68.5 },
      daily: { date: '2026-06-05' },
    },
    daily: [{
      date: '2026-06-05',
      workoutSummary: { trainingCalories: 400, workoutDurationMinutes: 40 },
      nutrition: { totalCalories: 1800, meals: [] },
      sleepSummary: { totalSleepMinutes: 420 },
    }],
  });

  assert.doesNotMatch(monitorView.dataQuality.missingItems.join('、'), /体测/);
});

test('monitor view does not infer a calorie limit from a zero recommendation', () => {
  const monitorView = buildMonitorViewModel({
    latest: { daily: { date: '2026-06-05' } },
    daily: [{
      date: '2026-06-05',
      nutrition: { totalCalories: 564, meals: [{ recommendedMax: 0 }] },
    }],
  });

  assert.equal(monitorView.facts.nutrition.find((item) => item.id === 'limit').value, '待设置');
  assert.equal(monitorView.summaryCards.find((card) => card.id === 'calories').delta, '');
  assert.doesNotMatch(monitorView.alerts.join('、'), /超过建议上限/);
});

test('monitor view uses activity types when the workout summary has no type counts', () => {
  const monitorView = buildMonitorViewModel({
    latest: { daily: { date: '2026-06-05' } },
    daily: [{
      date: '2026-06-05',
      activities: [{ type: '力量训练' }, { type: '力量训练' }, { type: '骑行' }],
      workoutSummary: { trainingCalories: 400, workoutDurationMinutes: 40, countsByType: {} },
    }],
  });

  assert.equal(monitorView.facts.training.find((item) => item.id === 'types').value, '力量训练、骑行');
});

test('monitor page renders the daily report panel without legacy charts', { concurrency: false }, () => {
  withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);
    const originalMonitorView = readOptionalFile(monitorViewPath);
    const snapshot = buildMonitorSnapshot({ startDate: '2026-05-01', days: 36 });

    try {
      ensureDataDir();
      writeFixtureFile(trainingDataPath, JSON.stringify(snapshot, null, 2));
      writeFixtureFile(dashboardViewPath, JSON.stringify(buildDashboardViewModel(snapshot), null, 2));
      writeFixtureFile(
        monitorViewPath,
        JSON.stringify(
          buildMonitorViewModel(snapshot, {
            weightGoalKg: 65,
            sleepTargetMinutes: 420,
            calorieRecommendedMax: 1700,
            dailyReport: {
              status: 'ok',
              source: 'ai',
              latestDataDate: '2026-06-05',
              report: {
                headline: '今天以恢复为先。',
                training: { summary: '不追加高强度。', actions: ['安排 30 分钟低强度活动。'] },
                nutrition: { summary: '保证蛋白质。', actions: ['完成规律餐次。'] },
                recovery: { summary: '今晚早点睡。', actions: ['目标睡眠 7 小时。'] },
                other: { summary: '暂无其他风险。', actions: ['继续记录身体反馈。'] },
              },
            },
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
      const monitorStyles = readFileSync(
        path.join(rootDir, 'themes', 'cactus', 'source', 'css', 'training-monitor.styl'),
        'utf8',
      );
      assert.match(monitorPage, /<section class="monitor-page">/);
      assert.match(monitorPage, /每日训练报告/);
      assert.match(monitorPage, /今天以恢复为先/);
      assert.match(monitorPage, /AI 已生成/);
      assert.match(monitorPage, /<a href="\/monitor\/">每日报告<\/a>/);
      assert.match(monitorPage, /训练建议/);
      assert.match(monitorPage, /饮食建议/);
      assert.match(monitorPage, /恢复建议/);
      assert.match(monitorPage, /其他提醒/);
      assert.match(monitorPage, /最新数据/);
      assert.match(monitorPage, /数据状态/);
      assert.doesNotMatch(monitorPage, /<canvas id="monitor-/);
      assert.doesNotMatch(monitorPage, /training-monitor-data/);
      assert.doesNotMatch(monitorPage, /chart.umd.min.js/);
      assert.match(monitorStyles, /\.monitor-report-panel/);
      assert.doesNotMatch(monitorStyles, /\.monitor-chart-card/);
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
    const cyclingDistanceKm = index < 24 ? 0 : 12.5;

    daily.push({
      date,
      measurement,
      measurements: [measurement],
      activities: [{
        time: '08:00',
        type: index % 2 === 0 ? '骑行' : '力量训练',
        durationSeconds: 3240,
        calories: trainingCalories,
        heartRate: 128,
        distanceKm: cyclingDistanceKm,
      }],
      workoutSummary: {
        totalActivities: trainingCalories > 0 ? 1 : 0,
        trainingCalories,
        workoutDurationMinutes: 54,
        totalDurationSeconds: 3240,
        activeHours: trainingCalories > 0 ? 9 : null,
        cyclingDistanceKm,
        countsByType: trainingCalories > 0
          ? (index % 2 === 0 ? { 骑行: 1 } : { 力量训练: 1 })
          : {},
      },
      nutrition: {
        totalCalories,
        meals: [{ name: '晚餐', calories: totalCalories, recommendedMin: 1200, recommendedMax: 1700 }],
      },
      sleep: [],
      sleepSummary: {
        totalSleepMinutes,
        nightSleepMinutes: totalSleepMinutes,
        deepSleepMinutes: 90,
        lightSleepMinutes: 250,
        remSleepMinutes: 70,
        awakeMinutes: 20,
        sleepScore,
        averageHeartRateBpm: 62,
        hrvMs: 45,
        averageSpo2Pct: 97,
        averageRespiratoryRate: 15,
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
  latestDay.sleepSummary.deepSleepMinutes = 78;
  latestDay.sleepSummary.remSleepMinutes = 62;
  latestDay.sleepSummary.awakeMinutes = 28;
  latestDay.sleepSummary.sleepScore = 81;
  latestDay.sleepSummary.hrvMs = 42;
  latestDay.sleepSummary.averageSpo2Pct = 96;
  latestDay.sleepSummary.averageRespiratoryRate = 16;
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
  return readFixtureFile(filePath);
}

function restoreOptionalFile(filePath, originalContent) {
  restoreFixtureFile(filePath, originalContent);
}
