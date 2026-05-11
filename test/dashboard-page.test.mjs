import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const trainingDataPath = path.join(rootDir, 'source', '_data', 'training.json');

test('dashboard renders comparison pills for the latest metrics without relying on fixed values', () => {
  execFileSync(process.execPath, ['tools/generate-training-data.mjs'], {
    cwd: rootDir,
    stdio: 'pipe',
  });
  execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
    cwd: rootDir,
    stdio: 'pipe',
  });

  const homepage = readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

  assert.match(homepage, /较前一日(?:下降|新增) [\d.]+%/);
  assert.match(homepage, /comparison-pill comparison-pill--down/);
  assert.match(homepage, /comparison-pill comparison-pill--up/);
  assert.match(homepage, /comparison-pill__arrow">↓<\/span><span>较前一日(?:下降|新增) [\d.]+%/);
  assert.match(homepage, /comparison-pill__arrow">↑<\/span><span>较前一日(?:下降|新增) [\d.]+%/);
});

test('dashboard defaults charts to the latest 30 days and daily cards to the latest 4 days', () => {
  const originalTrainingData = readFileSync(trainingDataPath, 'utf8');
  const syntheticDashboard = buildSyntheticDashboard({ startDate: '2026-03-01', days: 45 });

  try {
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

    const renderedDayCards = homepage.match(/<article class="day-card">/g) ?? [];
    assert.equal(renderedDayCards.length, 4);
    assert.match(homepage, /<h3>2026-04-14<\/h3>/);
    assert.match(homepage, /<h3>2026-04-11<\/h3>/);
    assert.doesNotMatch(homepage, /<h3>2026-04-10<\/h3>/);
  } finally {
    writeFileSync(trainingDataPath, originalTrainingData);
  }
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
