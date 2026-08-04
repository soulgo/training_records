import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDailyMonitorReportContext,
  generateDailyMonitorReport,
} from '../src/app/use-cases/daily-monitor-report.use-case.mjs';
import { buildMonitorViewModel } from '../src/site/monitor-view.mjs';

const snapshot = {
  source: 'database',
  bodyFeedback: [{ date: '2026-08-04', time: '09:00', body: '右膝有轻微不适' }],
  generatedAt: '2026-08-04T01:00:00.000Z',
  latest: {
    measurement: {
      archivedDate: '2026-08-04',
      weightKg: 68.4,
      bodyFatPct: 18.2,
      skeletalMuscleKg: 30.8,
    },
    daily: {
      date: '2026-08-04',
    },
  },
  daily: [
    {
      date: '2026-08-03',
      workoutSummary: { trainingCalories: 420, workoutDurationMinutes: 60, countsByType: { 力量训练: 1 } },
      nutrition: { totalCalories: 1900, meals: [{ name: '晚餐', calories: 800 }] },
      sleepSummary: { totalSleepMinutes: 420, sleepScore: 82 },
    },
    {
      date: '2026-08-04',
      measurement: {
        archivedDate: '2026-08-04',
        weightKg: 68.4,
        bodyFatPct: 18.2,
        skeletalMuscleKg: 30.8,
      },
      workoutSummary: { trainingCalories: 360, workoutDurationMinutes: 48, countsByType: { 骑行: 1 } },
      nutrition: { totalCalories: 1750, meals: [{ name: '早餐', calories: 450 }] },
      sleepSummary: { totalSleepMinutes: 330, sleepScore: 71 },
      activities: [{ time: '07:30', type: '骑行', detail: '通勤' }],
    },
  ],
};

const validReport = {
  headline: '今天先降低强度，优先补足恢复。',
  training: {
    summary: '昨天力量训练后今天睡眠不足，适合安排轻量活动。',
    actions: ['进行 30 分钟低强度骑行或快走。', '今天不追加高强度间歇。'],
  },
  nutrition: {
    summary: '今日摄入记录偏少，训练后要保证规律进餐。',
    actions: ['每餐优先安排蛋白质和蔬菜。', '训练后补水并完成一顿完整餐。'],
  },
  recovery: {
    summary: '睡眠 5.5 小时，恢复优先级高于增加训练量。',
    actions: ['今晚尽量提前入睡，目标至少 7 小时。'],
  },
  other: {
    summary: '当前没有足够的身体反馈记录支持额外判断。',
    actions: ['如出现持续疼痛或异常疲劳，记录并降低负荷。'],
  },
};

test('daily report context anchors recommendations to the latest day and recent window', () => {
  const context = buildDailyMonitorReportContext(snapshot, new Date('2026-08-04T02:00:00.000Z'));

  assert.equal(context.latestDate, '2026-08-04');
  assert.equal(context.latestDay.sleep.totalSleepMinutes, 330);
  assert.equal(context.recentDays.length, 2);
  assert.equal(context.latestMeasurement.weightKg, 68.4);
  assert.equal(context.dataSource, 'database');
  assert.deepEqual(context.latestDay.bodyFeedback, [{ date: '2026-08-04', time: '09:00', body: '右膝有轻微不适' }]);
});

test('generateDailyMonitorReport validates the AI report and returns the report source', async () => {
  const calls = [];
  const result = await generateDailyMonitorReport({
    snapshot,
    now: new Date('2026-08-04T02:00:00.000Z'),
    aiProvider: {
      env: { model: 'daily-coach-test' },
      async requestChatCompletion(input) {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          async json() {
            return { choices: [{ message: { content: JSON.stringify(validReport) } }] };
          },
        };
      },
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'ai');
  assert.equal(result.model, 'daily-coach-test');
  assert.deepEqual(result.report, validReport);
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[1].content, /2026-08-04/);
  assert.match(calls[0].messages[1].content, /330/);
});

test('generateDailyMonitorReport does not call AI when the site report switch is disabled', async () => {
  let requestCount = 0;
  const result = await generateDailyMonitorReport({
    snapshot,
    dailyReportEnabled: false,
    aiProvider: {
      env: { model: 'daily-coach-test' },
      async requestChatCompletion() {
        requestCount += 1;
        throw new Error('AI should not be called');
      },
    },
  });

  assert.equal(result.status, 'fallback');
  assert.equal(result.reason, 'ai_disabled');
  assert.equal(requestCount, 0);
});

test('generateDailyMonitorReport does not call AI when the snapshot has no latest date', async () => {
  let requestCount = 0;
  const result = await generateDailyMonitorReport({
    snapshot: { daily: [], latest: {} },
    aiProvider: {
      env: { model: 'daily-coach-test' },
      async requestChatCompletion() {
        requestCount += 1;
        throw new Error('AI should not be called');
      },
    },
  });

  assert.equal(result.status, 'fallback');
  assert.equal(result.reason, 'no_latest_data');
  assert.equal(requestCount, 0);
});

test('generateDailyMonitorReport falls back when an AI advice section is invalid', async () => {
  const incomplete = structuredClone(validReport);
  incomplete.training.actions = [];
  const result = await generateDailyMonitorReport({
    snapshot,
    aiProvider: {
      env: { model: 'daily-coach-test' },
      async requestChatCompletion() {
        return {
          ok: true,
          status: 200,
          async json() {
            return { choices: [{ message: { content: JSON.stringify(incomplete) } }] };
          },
        };
      },
    },
  });

  assert.equal(result.status, 'fallback');
  assert.equal(result.reason, 'ai_request_failed');
});

test('monitor view exposes the daily report and omits the legacy chart payload', () => {
  const view = buildMonitorViewModel(snapshot, {
    dailyReport: {
      status: 'ok',
      source: 'ai',
      generatedAt: '2026-08-04T02:00:00.000Z',
      report: validReport,
    },
  });

  assert.equal(view.title, '每日训练报告');
  assert.equal(view.dailyReport.report.headline, validReport.headline);
  assert.equal(view.latestDataDate, '2026-08-04');
  assert.equal('chartPayload' in view, false);
  assert.equal('trendCards' in view, false);
});
