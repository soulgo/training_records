import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDashboardViewModel } from '../tools/dashboard-view.mjs';
import { withSharedSiteFixture } from './shared-site-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const trainingDataPath = path.join(rootDir, 'source', '_data', 'training.json');
const dashboardViewPath = path.join(rootDir, 'source', '_data', 'dashboardView.json');

test('dashboard renders comparison pills for the latest metrics without relying on fixed values', () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());

  assert.match(homepage, /较前一日(?:下降|新增) [\d.]+%/);
  assert.match(homepage, /comparison-pill comparison-pill--down/);
  assert.match(homepage, /comparison-pill comparison-pill--up/);
  assert.match(homepage, /comparison-pill__arrow">↓<\/span><span>较前一日(?:下降|新增) [\d.]+%/);
  assert.match(homepage, /comparison-pill__arrow">↑<\/span><span>较前一日(?:下降|新增) [\d.]+%/);
});

test('dashboard defaults charts to the latest 30 days and daily cards to the latest 4 days', () => {
  withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const syntheticDashboard = buildSyntheticDashboard({ startDate: '2026-03-01', days: 45 });

    try {
      ensureDataDir();
      writeFileSync(trainingDataPath, JSON.stringify(syntheticDashboard, null, 2));
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });

      const homepage = readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
      const payloadMatch = homepage.match(
        /<script id="training-dashboard-data" type="application\/json">([\s\S]*?)<\/script>/,
      );

      assert.ok(payloadMatch, 'expected embedded dashboard payload');

      const payload = JSON.parse(payloadMatch[1]);

      assert.equal(payload.charts.weightKg.length, 30);
      assert.equal(payload.charts.weightKg[0].date, '2026-03-16');
      assert.equal(payload.charts.weightKg.at(-1).date, '2026-04-14');
      assert.equal(payload.charts.bodyFatPct.length, 30);
      assert.ok(payload.charts.trainingCalories.every((point) => point.date >= '2026-03-16'));
      assert.ok(payload.charts.cyclingDistanceKm.every((point) => point.date >= '2026-03-16'));

      const firstDailyGridMatch = homepage.match(/<div class="daily-grid"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/);
      assert.ok(firstDailyGridMatch, 'expected rendered daily grid');

      const renderedDayCards = firstDailyGridMatch[1].match(/<article class="day-card">/g) ?? [];
      assert.equal(renderedDayCards.length, 4);
      assert.match(homepage, /<h3>2026-04-14<\/h3>/);
      assert.match(homepage, /<h3>2026-04-11<\/h3>/);
      assert.doesNotMatch(homepage, /<h3>2026-04-10<\/h3>/);
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
    }
  });
});

test('dashboard embeds daily overview pagination controls without changing the default latest 4-day view', () => {
  withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const syntheticDashboard = buildSyntheticDashboard({ startDate: '2026-03-01', days: 9 });

    try {
      ensureDataDir();
      writeFileSync(trainingDataPath, JSON.stringify(syntheticDashboard, null, 2));
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });

      const homepage = readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

      assert.match(homepage, /class="daily-section__status"[^>]*>1-4 \/ 共 9 天<\/span>/);
      assert.match(homepage, /class="daily-section__pager"[^>]*>/);
      assert.match(homepage, /<button[^>]*data-daily-nav="prev"[^>]*disabled[^>]*>较新<\/button>/);
      assert.match(homepage, /<button[^>]*data-daily-nav="next"[^>]*>较早<\/button>/);
      assert.match(homepage, /<div class="daily-grid" data-daily-grid><article class="day-card">/);
      assert.match(homepage, /<script id="daily-overview-data" type="application\/json"[^>]*>/);
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
    }
  });
});

test('dashboard fallback view handles ISO datetime dates from generated data', () => {
  withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);
    const syntheticDashboard = buildSyntheticDashboard({ startDate: '2026-03-01', days: 3 });
    const latestDay = syntheticDashboard.daily.at(-1);

    latestDay.date = `${latestDay.date}T00:00:00.000Z`;
    latestDay.measurement.archivedDate = latestDay.date;
    syntheticDashboard.latest = {
      measurement: latestDay.measurement,
      daily: latestDay,
    };

    try {
      ensureDataDir();
      writeFileSync(trainingDataPath, JSON.stringify(syntheticDashboard, null, 2));
      writeFileSync(dashboardViewPath, JSON.stringify({ generatedAt: 'stale' }, null, 2));
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });

      const homepage = readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

      assert.match(homepage, /最新归档日期/);
      assert.match(homepage, /2026-03-03/);
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
    }
  });
});

test('homepage keeps the introduction at the bottom and uses a smaller header nav', () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());
  const noteIndex = homepage.indexOf('<div class="dashboard-note">');
  const dailyIndex = homepage.indexOf('<section class="daily-section">');
  const heroIndex = homepage.indexOf('<section class="hero-metrics">');

  assert.equal(homepage.includes('<div class="dashboard-copy">'), false);
  assert.ok(noteIndex > dailyIndex, 'expected note to be below the daily section');
  assert.ok(noteIndex > heroIndex, 'expected note to be below the metrics section');
  assert.match(homepage, /<div class="dashboard-note">/);
  assert.match(homepage, /这里展示的是基于仓库中/);
  assert.match(homepage, /<div id="nav">[\s\S]*<a href="\/">训练记录<\/a>/);
});

test('homepage uses root-relative asset and navigation paths for custom domain deployment', () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());

  assert.match(homepage, /<link rel="stylesheet" href="\/css\/style\.css">/);
  assert.match(homepage, /<link rel="stylesheet" href="\/css\/training-dashboard\.css">/);
  assert.match(homepage, /<img id="logo" alt class="u-logo" src="\/images\/logo\.png" \/>/);
  assert.match(homepage, /<a class="u-url u-uid" href="\/">/);
  assert.doesNotMatch(homepage, /(?:href|src)="\/training_records\//);
});

test('homepage removes the dashboard hero intro and shows trained day count card', () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());

  assert.doesNotMatch(homepage, /Markdown · Hexo · GitHub Pages/);
  assert.doesNotMatch(homepage, /<h1>训练记录可视化看板<\/h1>/);
  assert.match(homepage, /已训练天数/);
  assert.match(homepage, /<strong>\d+ 天<\/strong>/);
});

test('homepage places workout duration and trained days directly after training calories in the top metrics area', () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());
  const heroSectionMatch = homepage.match(/<section class="hero-metrics">([\s\S]*?)<\/section>/);
  const metricGridMatch = homepage.match(/<section class="metric-grid">([\s\S]*?)<\/section>/);

  assert.ok(heroSectionMatch, 'expected hero metrics section');
  assert.ok(metricGridMatch, 'expected metric grid section');
  assert.match(
    heroSectionMatch[1],
    /训练消耗[\s\S]*锻炼时长[\s\S]*已训练天数/,
  );
  assert.doesNotMatch(metricGridMatch[1], /锻炼时长/);
  assert.doesNotMatch(metricGridMatch[1], /已训练天数/);
});

function buildSyntheticDashboard({ startDate, days }) {
  const daily = [];
  const charts = {
    weightKg: [],
    bodyFatPct: [],
    skeletalMuscleKg: [],
    basalMetabolism: [],
    visceralFatLevel: [],
    intakeCalories: [],
    trainingCalories: [],
    cyclingDistanceKm: [],
  };

  for (let index = 0; index < days; index += 1) {
    const date = addDays(startDate, index);
    const measurement = {
      archivedDate: date,
      measuredAt: `${date} 07:00`,
      bodyScore: 75,
      weightKg: 70 + index * 0.1,
      bmi: 22 + index * 0.01,
      bodyFatPct: 20 + index * 0.05,
      skeletalMuscleKg: 30 + index * 0.03,
      visceralFatLevel: 8,
      basalMetabolismKcal: 1500 + index,
      bodyWaterPct: 50,
      proteinPct: 23,
      boneMassKg: 3,
      fatFreeMassKg: 56,
      bodyAge: 30,
      bodyType: '标准型',
    };
    const trainingCalories = index % 5 === 0 ? 0 : 400 + index;
    const cyclingDistanceKm = index % 4 === 0 ? 0 : Number((5 + index * 0.1).toFixed(2));
    const workoutSummary = {
      totalActivities: 2,
      totalDurationSeconds: 3600,
      trainingCalories,
      cyclingDistanceKm,
      countsByType: {
        户外骑行: cyclingDistanceKm > 0 ? 1 : 0,
        力量训练: trainingCalories > 0 ? 1 : 0,
      },
    };
    const nutrition = {
      meals: [],
      totalCalories: 1600 + index,
    };

    daily.push({
      date,
      measurement,
      measurements: [measurement],
      activities: [],
      workoutSummary,
      nutrition,
    });

    charts.weightKg.push({ date, value: measurement.weightKg });
    charts.bodyFatPct.push({ date, value: measurement.bodyFatPct });
    charts.skeletalMuscleKg.push({ date, value: measurement.skeletalMuscleKg });
    charts.basalMetabolism.push({ date, value: measurement.basalMetabolismKcal });
    charts.visceralFatLevel.push({ date, value: measurement.visceralFatLevel });
    charts.intakeCalories.push({ date, value: nutrition.totalCalories });
    if (trainingCalories > 0) {
      charts.trainingCalories.push({ date, value: trainingCalories });
    }
    if (cyclingDistanceKm > 0) {
      charts.cyclingDistanceKm.push({ date, value: cyclingDistanceKm });
    }
  }

  return {
    generatedAt: '2026-05-11T00:00:00.000Z',
    latest: {
      measurement: daily.at(-1).measurement,
      daily: daily.at(-1),
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

function buildHomepageDashboard() {
  const snapshot = buildSyntheticDashboard({ startDate: '2026-04-01', days: 6 });
  const previousDay = snapshot.daily.at(-2);
  const latestDay = snapshot.daily.at(-1);

  previousDay.measurement.weightKg = 72.6;
  previousDay.measurement.bodyFatPct = 22.1;
  previousDay.measurement.bodyWaterPct = 50.2;
  previousDay.measurement.proteinPct = 23.2;
  previousDay.measurement.basalMetabolismKcal = 1586;
  previousDay.measurement.visceralFatLevel = 8;
  previousDay.measurement.skeletalMuscleKg = 30.4;
  previousDay.measurement.bodyAge = 31;
  previousDay.nutrition.totalCalories = 1604;
  previousDay.workoutSummary.trainingCalories = 640;
  previousDay.workoutSummary.workoutDurationMinutes = 58;
  previousDay.workoutSummary.totalDurationSeconds = 3480;
  previousDay.workoutSummary.activeHours = 11;
  previousDay.workoutSummary.cyclingDistanceKm = 6.2;
  previousDay.workoutSummary.totalActivities = 3;
  previousDay.workoutSummary.countsByType = {
    户外骑行: 1,
    力量训练: 1,
    燃脂训练: 1,
  };

  latestDay.measurement.weightKg = 72.2;
  latestDay.measurement.bodyFatPct = 22.6;
  latestDay.measurement.bodyWaterPct = 49.8;
  latestDay.measurement.proteinPct = 23.5;
  latestDay.measurement.basalMetabolismKcal = 1581;
  latestDay.measurement.visceralFatLevel = 8;
  latestDay.measurement.skeletalMuscleKg = 30.35;
  latestDay.measurement.bodyAge = 32;
  latestDay.nutrition.totalCalories = 1588;
  latestDay.workoutSummary.trainingCalories = 780;
  latestDay.workoutSummary.workoutDurationMinutes = 72;
  latestDay.workoutSummary.totalDurationSeconds = 4320;
  latestDay.workoutSummary.activeHours = 13;
  latestDay.workoutSummary.cyclingDistanceKm = 4.8;
  latestDay.workoutSummary.totalActivities = 4;
  latestDay.workoutSummary.countsByType = {
    户外骑行: 2,
    力量训练: 1,
    爬楼: 1,
  };

  snapshot.latest = {
    measurement: latestDay.measurement,
    daily: latestDay,
  };

  const lastIndex = snapshot.charts.weightKg.length - 1;
  const previousIndex = lastIndex - 1;
  snapshot.charts.weightKg[previousIndex].value = previousDay.measurement.weightKg;
  snapshot.charts.weightKg[lastIndex].value = latestDay.measurement.weightKg;
  snapshot.charts.bodyFatPct[previousIndex].value = previousDay.measurement.bodyFatPct;
  snapshot.charts.bodyFatPct[lastIndex].value = latestDay.measurement.bodyFatPct;
  snapshot.charts.skeletalMuscleKg[previousIndex].value = previousDay.measurement.skeletalMuscleKg;
  snapshot.charts.skeletalMuscleKg[lastIndex].value = latestDay.measurement.skeletalMuscleKg;
  snapshot.charts.basalMetabolism[previousIndex].value = previousDay.measurement.basalMetabolismKcal;
  snapshot.charts.basalMetabolism[lastIndex].value = latestDay.measurement.basalMetabolismKcal;
  snapshot.charts.visceralFatLevel[previousIndex].value = previousDay.measurement.visceralFatLevel;
  snapshot.charts.visceralFatLevel[lastIndex].value = latestDay.measurement.visceralFatLevel;
  snapshot.charts.intakeCalories[previousIndex].value = previousDay.nutrition.totalCalories;
  snapshot.charts.intakeCalories[lastIndex].value = latestDay.nutrition.totalCalories;
  snapshot.charts.trainingCalories[snapshot.charts.trainingCalories.length - 2].value = previousDay.workoutSummary.trainingCalories;
  snapshot.charts.trainingCalories[snapshot.charts.trainingCalories.length - 1].value = latestDay.workoutSummary.trainingCalories;
  snapshot.charts.cyclingDistanceKm[snapshot.charts.cyclingDistanceKm.length - 2].value = previousDay.workoutSummary.cyclingDistanceKm;
  snapshot.charts.cyclingDistanceKm[snapshot.charts.cyclingDistanceKm.length - 1].value = latestDay.workoutSummary.cyclingDistanceKm;

  return snapshot;
}

function renderHomepageWithDashboard(snapshot) {
  return withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);

    try {
      ensureDataDir();
      writeFileSync(trainingDataPath, JSON.stringify(snapshot, null, 2));
      writeFileSync(dashboardViewPath, JSON.stringify(buildDashboardViewModel(snapshot), null, 2));
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      return readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
    }
  });
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
