import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDashboardViewModel } from '../tools/dashboard-view.mjs';
import { withSharedSiteFixture } from './shared-site-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { readLatestChangelogVersion } = require('../tools/changelog-version.cjs');
const trainingDataPath = path.join(rootDir, 'source', '_data', 'training.json');
const dashboardViewPath = path.join(rootDir, 'source', '_data', 'dashboardView.json');
const actionMonitorViewPath = path.join(rootDir, 'source', '_data', 'actionMonitorView.json');

test('dashboard renders comparison pills for the latest metrics without relying on fixed values', () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());
  const comparisonPillClasses = Array.from(
    homepage.matchAll(/comparison-pill comparison-pill--([a-z]+)/g),
    (match) => match[1],
  );

  assert.match(homepage, /较前一日(?:下降|新增) [\d.]+%/);
  assert.ok(comparisonPillClasses.length > 0, 'expected rendered comparison pills');
  assert.ok(
    comparisonPillClasses.some((className) => className === 'up' || className === 'down'),
    'expected at least one directional comparison pill',
  );
  assert.match(
    homepage,
    /comparison-pill__arrow">(?:↓|↑)<\/span><span>较前一日(?:下降|新增) [\d.]+%/,
  );
});

test('dashboard defaults charts to the latest 30 days and daily cards to the latest 4 days', { concurrency: false }, () => {
  withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);
    const syntheticDashboard = buildSyntheticDashboard({ startDate: '2026-03-01', days: 45 });

    try {
      ensureDataDir();
      writeFixtureFile(trainingDataPath, JSON.stringify(syntheticDashboard, null, 2));
      writeFixtureFile(dashboardViewPath, JSON.stringify(buildDashboardViewModel(syntheticDashboard), null, 2));
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
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
    }
  });
});

test('dashboard chart script keeps full data while sparsifying x-axis labels and preserving full tooltip dates', () => {
  const homepage = renderHomepageWithDashboard(buildSyntheticDashboard({ startDate: '2026-03-01', days: 30 }));
  const script = readFileSync(path.join(rootDir, 'themes', 'cactus', 'source', 'js', 'training-dashboard.js'), 'utf8');
  const payloadMatch = homepage.match(
    /<script id="training-dashboard-data" type="application\/json">([\s\S]*?)<\/script>/,
  );

  assert.ok(payloadMatch, 'expected embedded dashboard payload');
  const payload = JSON.parse(payloadMatch[1]);

  assert.equal(payload.charts.weightKg.length, 30);
  assert.match(script, /function shouldShowDateTick/);
  assert.match(script, /return index === 0 \|\| index === total - 1 \|\| index % interval === 0/);
  assert.match(script, /tooltip:\s*{[\s\S]*title\(items\)/);
  assert.match(script, /return items\?\.\[0\]\?\.label \|\| ''/);
  assert.match(script, /labels: \(charts\.intakeCalories \|\| \[\]\)\.map\(\(point\) => point\.date\)/);
  assert.doesNotMatch(script, /labels: \(charts\.intakeCalories \|\| \[\]\)\.map\(\(point\) => point\.date\.slice\(5\)\)/);
});

test('dashboard chart legends render as top-right labels without filled backgrounds', () => {
  const script = readFileSync(path.join(rootDir, 'themes', 'cactus', 'source', 'js', 'training-dashboard.js'), 'utf8');
  const styles = readFileSync(path.join(rootDir, 'themes', 'cactus', 'source', 'css', 'training-dashboard.styl'), 'utf8');
  const legendItemStyles = styles.match(/^\.chart-legend__item\r?\n([\s\S]*?)(?=^\.[^\s])/m);

  assert.match(script, /setAttribute\('aria-label', '图例：'/);
  assert.match(script, /class="chart-legend__text"/);
  assert.match(script, /class="chart-legend__unit"/);
  assert.ok(legendItemStyles, 'expected chart legend item styles');
  assert.match(styles, /\.chart-card[\s\S]*?position relative/);
  assert.match(styles, /\.chart-heading > div:first-child > span:not\(\.dashboard-section__eyebrow\)/);
  assert.doesNotMatch(styles, /\.chart-heading span\s*\n\s*display block/);
  assert.doesNotMatch(styles, /padding-right min\(50%, 16rem\)/);
  assert.match(styles, /\.chart-legend[\s\S]*?position absolute[\s\S]*?top 1\.08rem[\s\S]*?right 1rem/);
  assert.match(styles, /\.chart-legend[\s\S]*?flex-direction column/);
  assert.match(styles, /\.chart-legend__item[\s\S]*?justify-content flex-end/);
  assert.match(legendItemStyles[1], /padding 0/);
  assert.doesNotMatch(styles, /\.chart-legend__item[\s\S]*?background rgba\(248, 250, 252, 0\.72\)/);
  assert.doesNotMatch(legendItemStyles[1], /background/);
  assert.doesNotMatch(legendItemStyles[1], /border 1px solid/);
});

test('dashboard embeds daily overview pagination controls without changing the default latest 4-day view', { concurrency: false }, () => {
  withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);
    const syntheticDashboard = buildSyntheticDashboard({ startDate: '2026-03-01', days: 9 });

    try {
      ensureDataDir();
      writeFixtureFile(trainingDataPath, JSON.stringify(syntheticDashboard, null, 2));
      writeFixtureFile(dashboardViewPath, JSON.stringify(buildDashboardViewModel(syntheticDashboard), null, 2));
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
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
    }
  });
});

test('dashboard explains that the top card follows the latest measurement day while recent activity stays in the daily cards', () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());

  assert.match(homepage, /每日记录速览/);
  assert.match(homepage, /顶部主卡按最新体脂归档日展示/);
  assert.match(homepage, /最近活动以下方日期卡片为准/);
});

test('dashboard fallback view handles ISO datetime dates from generated data', { concurrency: false }, () => {
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
      writeFixtureFile(trainingDataPath, JSON.stringify(syntheticDashboard, null, 2));
      writeFixtureFile(dashboardViewPath, JSON.stringify({ generatedAt: 'stale' }, null, 2));
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });

      const homepage = readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

      assert.match(homepage, /最新体脂归档日/);
      assert.match(homepage, /2026-03-03/);
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
    }
  });
});

test('homepage keeps the introduction at the bottom and uses a smaller header nav', { concurrency: false }, () => {
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
  assert.match(homepage, /<div id="nav">[\s\S]*<a href="\/action-monitor\/">action 监控<\/a>/);
});

test('homepage uses root-relative asset and navigation paths for custom domain deployment', { concurrency: false }, () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());

  assert.match(homepage, /<link rel="stylesheet" href="\/css\/style\.css">/);
  assert.match(homepage, /<link rel="stylesheet" href="\/css\/training-dashboard\.css">/);
  assert.match(homepage, /<img id="logo" alt class="u-logo" src="\/images\/logo\.png" \/>/);
  assert.match(homepage, /<a class="u-url u-uid" href="\/">/);
  assert.doesNotMatch(homepage, /(?:href|src)="\/training_records\//);
});

test('homepage footer renders the version from the changelog', { concurrency: false }, () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());
  const latestRelease = readLatestChangelogVersion(rootDir);

  assert.ok(latestRelease, 'expected a released version in CHANGELOG.md');
  assert.match(
    homepage,
    new RegExp(`<span class="footer-version"[^>]*>v${latestRelease.version.replace(/\./g, '\\.')}<\\/span>`),
  );
});

test('homepage removes the dashboard hero intro and shows trained day count card', { concurrency: false }, () => {
  const homepage = renderHomepageWithDashboard(buildHomepageDashboard());

  assert.doesNotMatch(homepage, /Markdown · Hexo · GitHub Pages/);
  assert.doesNotMatch(homepage, /<h1>训练记录可视化看板<\/h1>/);
  assert.match(homepage, /已训练天数/);
  assert.match(homepage, /<strong>\d+ 天<\/strong>/);
});

test('homepage places workout duration and trained days directly after training calories in the top metrics area', { concurrency: false }, () => {
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

test('action monitor page renders the module from generated action monitor data', { concurrency: false }, () => {
  const { homepage, actionMonitorPage } = withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);
    const originalActionMonitorView = readOptionalFile(actionMonitorViewPath);

    try {
      ensureDataDir();
      writeFixtureFile(trainingDataPath, JSON.stringify(buildHomepageDashboard(), null, 2));
      writeFixtureFile(
        dashboardViewPath,
        JSON.stringify(buildDashboardViewModel(buildHomepageDashboard()), null, 2),
      );
      writeFixtureFile(actionMonitorViewPath, JSON.stringify({
        title: 'action 监控',
        environment: 'dev',
        updatedTime: '14:30',
        summaryCards: [
          { label: '最近运行', value: '3 次', hint: '近 24 小时' },
          { label: '成功率', value: '100%', hint: '近 20 次' },
        ],
        runs: [
          {
            runId: 1003,
            title: 'chore: release 1.3.2 action monitor',
            workflowName: 'Deploy Cloudflare Pages (Dev)',
            runNumber: 280,
            branch: 'dev',
            actorLogin: 'soulgo',
            commitShortSha: '18ba338',
            statusLabel: '成功',
            tone: 'success',
            timeLabel: '6 minutes ago',
            durationLabel: '5m 42s',
            htmlUrl: 'https://github.com/soulgo/training_records/actions/runs/1003',
            failureCount: 0,
          },
        ],
      }, null, 2));
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      return {
        homepage: readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8'),
        actionMonitorPage: readFileSync(path.join(rootDir, 'public', 'action-monitor', 'index.html'), 'utf8'),
      };
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
      restoreOptionalFile(actionMonitorViewPath, originalActionMonitorView);
    }
  });

  assert.doesNotMatch(homepage, /<section class="action-monitor"/);
  assert.match(actionMonitorPage, /<section class="action-monitor-page"/);
  assert.match(actionMonitorPage, /<section class="action-monitor"/);
  assert.match(actionMonitorPage, /action 监控/);
  assert.match(actionMonitorPage, /Deploy Cloudflare Pages \(Dev\) #280/);
  assert.match(actionMonitorPage, /chore: release 1\.3\.2 action monitor/);
  assert.match(actionMonitorPage, /18ba338/);
  assert.match(actionMonitorPage, /soulgo/);
  assert.match(actionMonitorPage, /dev/);
  assert.match(actionMonitorPage, /5m 42s/);
});

test('action monitor page renders parameter validity status without secret values', { concurrency: false }, () => {
  const actionMonitorPage = withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);
    const originalActionMonitorView = readOptionalFile(actionMonitorViewPath);

    try {
      const snapshot = buildHomepageDashboard();
      ensureDataDir();
      writeFixtureFile(trainingDataPath, JSON.stringify(snapshot, null, 2));
      writeFixtureFile(dashboardViewPath, JSON.stringify(buildDashboardViewModel(snapshot), null, 2));
      writeFixtureFile(actionMonitorViewPath, JSON.stringify({
        title: 'action 监控',
        environment: 'dev',
        updatedTime: '14:30',
        summaryCards: [],
        runs: [],
        parameterValidity: {
          title: '系统参数有效期',
          summaryCards: [
            { label: '监控参数', value: '2 个', hint: 'dev 环境' },
            { label: '即将到期', value: '1 个', hint: '进入预警窗口' },
          ],
          items: [
            {
              key: 'dev.github.secret.AI_API_KEY',
              name: 'AI_API_KEY',
              scope: 'github_actions_secret',
              category: 'ai',
              statusLabel: '即将到期',
              tone: 'warning',
              dueDateLabel: '2026-07-20',
              dueLabel: '剩余 13 天',
              checkedAtLabel: '2026-07-07',
              lastCheckedLabel: '1 minute ago',
              message: '距离到期或复核日期 13 天',
            },
          ],
        },
      }, null, 2));
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      return readFileSync(path.join(rootDir, 'public', 'action-monitor', 'index.html'), 'utf8');
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
      restoreOptionalFile(actionMonitorViewPath, originalActionMonitorView);
    }
  });

  assert.match(actionMonitorPage, /系统参数有效期/);
  assert.match(actionMonitorPage, /AI_API_KEY/);
  assert.match(actionMonitorPage, /github_actions_secret/);
  assert.match(actionMonitorPage, /即将到期/);
  assert.match(actionMonitorPage, /剩余 13 天/);
  assert.doesNotMatch(actionMonitorPage, /sk-live|postgres:\/\/|bot-token-value/);
});

test('action monitor page keeps the module visible when no Action rows were generated', { concurrency: false }, () => {
  const actionMonitorPage = withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);
    const originalActionMonitorView = readOptionalFile(actionMonitorViewPath);

    try {
      const snapshot = buildHomepageDashboard();
      ensureDataDir();
      writeFixtureFile(trainingDataPath, JSON.stringify(snapshot, null, 2));
      writeFixtureFile(dashboardViewPath, JSON.stringify(buildDashboardViewModel(snapshot), null, 2));
      writeFixtureFile(actionMonitorViewPath, JSON.stringify({
        title: 'action 监控',
        environment: 'dev',
        updatedTime: '14:30',
        summaryCards: [],
        runs: [],
      }, null, 2));
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      return readFileSync(path.join(rootDir, 'public', 'action-monitor', 'index.html'), 'utf8');
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
      restoreOptionalFile(actionMonitorViewPath, originalActionMonitorView);
    }
  });

  assert.match(actionMonitorPage, /<section class="action-monitor"/);
  assert.match(actionMonitorPage, /action 监控/);
  assert.match(actionMonitorPage, /dev/);
  assert.match(actionMonitorPage, /暂无 Action 监控数据/);
});

test('action monitor page renders all branch action logs with fifteen-item pagination', { concurrency: false }, () => {
  const actionMonitorPage = withSharedSiteFixture(() => {
    const originalTrainingData = readOptionalFile(trainingDataPath);
    const originalDashboardView = readOptionalFile(dashboardViewPath);
    const originalActionMonitorView = readOptionalFile(actionMonitorViewPath);

    try {
      const snapshot = buildHomepageDashboard();
      ensureDataDir();
      writeFixtureFile(trainingDataPath, JSON.stringify(snapshot, null, 2));
      writeFixtureFile(dashboardViewPath, JSON.stringify(buildDashboardViewModel(snapshot), null, 2));
      writeFixtureFile(actionMonitorViewPath, JSON.stringify({
        title: 'action 监控',
        environment: 'dev',
        updatedTime: '09:20',
        recentWindowLabel: '全部 Action 日志',
        summaryCards: [],
        historyTitle: 'Action 日志',
        historyPageSize: 15,
        historyTotal: 16,
        historyStatus: '1-15 / 共 16 次',
        allRuns: Array.from({ length: 16 }, (_, index) => ({
          runId: 2015 - index,
          title: `action run ${2015 - index}`,
          workflowName: index % 2 === 0 ? 'Deploy Cloudflare Pages (Dev)' : 'CI Tests',
          runNumber: 325 - index,
          branch: 'dev',
          actorLogin: 'soulgo',
          statusLabel: index === 1 ? '失败' : '成功',
          tone: index === 1 ? 'failure' : 'success',
          timeLabel: `${index + 1} hours ago`,
          durationLabel: '45s',
          htmlUrl: `https://github.com/soulgo/training_records/actions/runs/${2015 - index}`,
        })),
      }, null, 2));
      execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
      return readFileSync(path.join(rootDir, 'public', 'action-monitor', 'index.html'), 'utf8');
    } finally {
      restoreOptionalFile(trainingDataPath, originalTrainingData);
      restoreOptionalFile(dashboardViewPath, originalDashboardView);
      restoreOptionalFile(actionMonitorViewPath, originalActionMonitorView);
    }
  });

  const renderedCards = actionMonitorPage.match(/class="action-run action-run--/g) ?? [];

  assert.doesNotMatch(actionMonitorPage, /最近 2 天/);
  assert.match(actionMonitorPage, /全部 Action 日志/);
  assert.match(actionMonitorPage, /Action 日志/);
  assert.match(actionMonitorPage, /data-action-history-grid/);
  assert.match(actionMonitorPage, /data-action-history-nav="next"/);
  assert.match(actionMonitorPage, /id="action-history-data"/);
  assert.match(actionMonitorPage, /data-page-size="15"/);
  assert.match(actionMonitorPage, /1-15 \/ 共 16 次/);
  assert.equal(renderedCards.length, 15);
  assert.match(actionMonitorPage, /action run 2015/);
  assert.match(actionMonitorPage, /action run 2000/);
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
      writeFixtureFile(trainingDataPath, JSON.stringify(snapshot, null, 2));
      writeFixtureFile(dashboardViewPath, JSON.stringify(buildDashboardViewModel(snapshot), null, 2));
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
  writeFixtureFile(filePath, originalContent);
}

function writeFixtureFile(filePath, content) {
  const retryableCodes = new Set(['UNKNOWN', 'EBUSY', 'EPERM']);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      writeFileSync(filePath, content);
      return;
    } catch (error) {
      if (!retryableCodes.has(error?.code) || attempt === 19) {
        throw error;
      }
      sleep(50);
    }
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
