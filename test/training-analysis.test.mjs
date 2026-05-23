import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateTrainingAnalysisReply,
  inferTrainingAnalysisFocus,
  loadTrainingAnalysisPrompt,
  normalizeTrainingGoal,
  buildTrainingAnalysisSummary,
} from '../tools/training-analysis.mjs';

test('inferTrainingAnalysisFocus respects explicit recent-week requests', () => {
  const focus = inferTrainingAnalysisFocus('分析近一周训练及体脂数据，提供快速瘦腹建议。');

  assert.equal(focus.w, 'recent7');
  assert.equal(focus.m, 'measurementTrend7');
  assert.equal(focus.q, '最近7天');
  assert.equal(focus.p, 'no_recent30');
});

test('inferTrainingAnalysisFocus uses 30-day data only when requested', () => {
  const focus = inferTrainingAnalysisFocus('看一下最近30天训练和体脂趋势');

  assert.equal(focus.w, 'recent30');
  assert.equal(focus.m, 'measurementTrend30');
  assert.equal(focus.q, '最近30天');
  assert.equal(focus.p, 'recent7_supplement');
});

test('normalizeTrainingGoal defaults to muscle gain and belly-fat reduction', () => {
  const goal = normalizeTrainingGoal('');

  assert.match(goal, /增肌减腹/);
  assert.match(goal, /骨骼肌/);
  assert.match(goal, /腰围和腹部脂肪/);
});

test('generateTrainingAnalysisReply sends time-window constraints to the model', async () => {
  let requestPayload = null;

  const reply = await generateTrainingAnalysisReply({
    env: {
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
    },
    question: '分析近一周训练及体脂数据，提供快速瘦腹建议。',
    snapshot: buildSyntheticSnapshot(),
    now: new Date('2026-05-16T00:00:00.000Z'),
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://example.com/v1/chat/completions');
      requestPayload = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: [
                    '数据结论',
                    '1. 近7天训练稳定。',
                    '恢复风险',
                    '1. 注意恢复。',
                    '饮食观察',
                    '1. 稳住蛋白质。',
                    '下一步行动',
                    '1. 今天中低强度训练。',
                  ].join('\n'),
                },
              },
            ],
          };
        },
      };
    },
  });

  assert.equal(requestPayload.model, 'gpt-test');
  const userMessage = requestPayload.messages.find((message) => message.role === 'user');
  assert.match(userMessage.content, /focus:/);
  assert.match(userMessage.content, /data:/);
  assert.match(userMessage.content, /"dataSource"\s*:\s*"database"/);
  assert.match(userMessage.content, /"coverage"/);
  assert.match(userMessage.content, /"trainingLoad"/);
  assert.match(userMessage.content, /"strengthCardioBalance"/);
  assert.match(userMessage.content, /"bodyCompositionRisk"/);
  assert.match(userMessage.content, /"nutritionSignal"/);
  assert.match(userMessage.content, /"recoverySignal"/);
  assert.match(userMessage.content, /"w"\s*:\s*"recent7"/);
  assert.match(userMessage.content, /"m"\s*:\s*"measurementTrend7"/);
  assert.match(userMessage.content, /"p"\s*:\s*"no_recent30"/);
  assert.match(reply, /近7天训练稳定/);
});

test('generateTrainingAnalysisReply falls back to markdown snapshot when database snapshot is incomplete', async () => {
  const calls = [];
  let requestPayload = null;

  const reply = await generateTrainingAnalysisReply({
    env: {
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
      TRAINING_SNAPSHOT_SOURCE: 'database',
    },
    question: '分析最近半个月训练和饮食情况',
    now: new Date('2026-05-16T00:00:00.000Z'),
    buildTrainingSnapshot: async (options) => {
      calls.push(options.source ?? 'default');
      if ((options.source ?? 'default') === 'default') {
        throw new Error('database snapshot is empty or missing measurements');
      }
      return buildSyntheticSnapshot();
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: '数据结论：已回退到 Markdown 快照继续分析。',
              },
            },
          ],
        };
      },
    }),
  });

  assert.equal(reply, '数据结论：已回退到 Markdown 快照继续分析。');
  assert.deepEqual(calls, ['default', 'markdown']);
});

test('generateTrainingAnalysisReply retries transient 502 responses', async () => {
  let attempts = 0;

  const reply = await generateTrainingAnalysisReply({
    env: {
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
    },
    question: '分析最近7天训练',
    snapshot: buildSyntheticSnapshot(),
    now: new Date('2026-05-16T00:00:00.000Z'),
    baseDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, status: 502 };
      }
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: '数据结论：第二次请求成功。',
                },
              },
            ],
          };
        },
      };
    },
  });

  assert.equal(reply, '数据结论：第二次请求成功。');
  assert.equal(attempts, 2);
});

test('generateTrainingAnalysisReply preserves the final HTTP error after retry exhaustion', async () => {
  let attempts = 0;

  await assert.rejects(
    generateTrainingAnalysisReply({
      env: {
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
      },
      question: '分析最近7天训练',
      snapshot: buildSyntheticSnapshot(),
      now: new Date('2026-05-16T00:00:00.000Z'),
      baseDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return { ok: false, status: 502 };
      },
    }),
    /Training analysis failed with HTTP 502/,
  );

  assert.equal(attempts, 3);
});

test('generateTrainingAnalysisReply does not retry non-retryable HTTP errors', async () => {
  let attempts = 0;

  await assert.rejects(
    generateTrainingAnalysisReply({
      env: {
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://example.com/v1',
        AI_MODEL: 'gpt-test',
      },
      question: '分析最近7天训练',
      snapshot: buildSyntheticSnapshot(),
      now: new Date('2026-05-16T00:00:00.000Z'),
      baseDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return { ok: false, status: 403 };
      },
    }),
    /Training analysis failed with HTTP 403/,
  );

  assert.equal(attempts, 1);
});

test('generateTrainingAnalysisReply retries transient network errors', async () => {
  let attempts = 0;

  const reply = await generateTrainingAnalysisReply({
    env: {
      AI_API_KEY: 'key',
      AI_BASE_URL: 'https://example.com/v1',
      AI_MODEL: 'gpt-test',
    },
    question: '分析最近7天训练',
    snapshot: buildSyntheticSnapshot(),
    now: new Date('2026-05-16T00:00:00.000Z'),
    baseDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('socket hang up');
      }
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: '数据结论：网络重试后成功。',
                },
              },
            ],
          };
        },
      };
    },
  });

  assert.equal(reply, '数据结论：网络重试后成功。');
  assert.equal(attempts, 2);
});

test('loadTrainingAnalysisPrompt reads the compiled prompt by default', async () => {
  const prompt = await loadTrainingAnalysisPrompt({
    TRAINING_ANALYSIS_PROMPT_PATH: '',
  });

  assert.match(prompt, /训练数据分析助手/);
  assert.match(prompt, /## 输出要求/);
  assert.match(prompt, /## 回答时间窗策略（focus\.p 代码对照）/);
  assert.match(prompt, /## 数据阅读规则/);
  assert.match(prompt, /## 科学依据维护说明/);
});

test('buildTrainingAnalysisSummary exposes richer data signals', () => {
  const payload = buildTrainingAnalysisSummary(buildSyntheticSnapshot(), new Date('2026-05-16T00:00:00.000Z'));

  assert.equal(payload.dataSource, 'database');
  assert.match(JSON.stringify(payload.coverage), /recent7/);
  assert.match(JSON.stringify(payload.trainingLoad), /recent7/);
  assert.match(JSON.stringify(payload.strengthCardioBalance), /recent7/);
  assert.match(payload.bodyCompositionRisk.status, /fat_loss_good|muscle_loss_risk|stalled|insufficient_data/);
  assert.equal(typeof payload.nutritionSignal.avgIntakeCalories === 'number' || payload.nutritionSignal.avgIntakeCalories === null, true);
  assert.ok(Array.isArray(payload.latestDays));
  assert.ok(payload.latestDays[0].workoutDetails.length <= 3);
  assert.equal(typeof payload.latestDays[0].hasStrengthTraining, 'boolean');
  assert.equal(typeof payload.latestDays[0].nutritionComplete, 'boolean');
});

test('buildTrainingAnalysisSummary marks muscle loss risk when weight and muscle both fall', () => {
  const daily = [
    {
      date: '2026-05-01',
      measurement: {
        archivedDate: '2026-05-01',
        weightKg: 76,
        bodyFatPct: 24.5,
        skeletalMuscleKg: 30,
      },
      workoutSummary: {
        trainingCalories: 200,
        workoutDurationMinutes: 30,
        cyclingDistanceKm: 0,
        countsByType: {},
      },
      nutrition: { totalCalories: 1500 },
    },
    {
      date: '2026-05-08',
      measurement: {
        archivedDate: '2026-05-08',
        weightKg: 75,
        bodyFatPct: 24.4,
        skeletalMuscleKg: 29.4,
      },
      workoutSummary: {
        trainingCalories: 120,
        workoutDurationMinutes: 18,
        cyclingDistanceKm: 0,
        countsByType: {},
      },
      nutrition: { totalCalories: 1400 },
    },
  ];

  const payload = buildTrainingAnalysisSummary(
    {
      daily,
      latest: {
        daily: daily.at(-1),
        measurement: daily.at(-1).measurement,
      },
      source: 'database',
    },
    new Date('2026-05-16T00:00:00.000Z'),
  );

  assert.equal(payload.bodyCompositionRisk.status, 'muscle_loss_risk');
});

test('buildTrainingAnalysisSummary marks recovery pressure on sustained load', () => {
  const daily = Array.from({ length: 5 }, (_, index) => ({
    date: `2026-05-0${index + 1}`,
    measurement: {
      archivedDate: `2026-05-0${index + 1}`,
      weightKg: 75 - index * 0.1,
      bodyFatPct: 24.5,
      skeletalMuscleKg: 30,
    },
    workoutSummary: {
      trainingCalories: 420,
      workoutDurationMinutes: 75,
      activeHours: 2,
      cyclingDistanceKm: 3,
      countsByType: {
        力量训练: 1,
        HIIT: 1,
      },
    },
    nutrition: { totalCalories: 1450 },
  }));

  const payload = buildTrainingAnalysisSummary(
    {
      daily,
      latest: {
        daily: daily.at(-1),
        measurement: daily.at(-1).measurement,
      },
      source: 'database',
    },
    new Date('2026-05-16T00:00:00.000Z'),
  );

  assert.equal(payload.recoverySignal.shouldRecover, true);
  assert.equal(payload.strengthCardioBalance.recent7.hiitDays > 0, true);
  assert.equal(payload.strengthCardioBalance.recent7.strengthDays > 0, true);
});

function buildSyntheticSnapshot() {
  const start = new Date('2026-04-16T00:00:00.000Z');
  const daily = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const archivedDate = date.toISOString().slice(0, 10);

    return {
      date: archivedDate,
      measurement: {
        archivedDate,
        weightKg: Number((75 - index * 0.05).toFixed(2)),
        bodyFatPct: Number((25 - index * 0.03).toFixed(2)),
        skeletalMuscleKg: Number((30 + index * 0.01).toFixed(2)),
      },
      workoutSummary: {
        trainingCalories: 380 + index,
        workoutDurationMinutes: 55 + (index % 3) * 5,
        cyclingDistanceKm: index % 2 === 0 ? 4.2 : 0,
        countsByType: {
          力量训练: index % 2 === 0 ? 1 : 0,
          燃脂训练: index % 2 === 1 ? 1 : 0,
        },
      },
      nutrition: {
        totalCalories: 1500 + index,
      },
    };
  });

  return {
    daily,
    latest: {
      daily: daily.at(-1),
      measurement: daily.at(-1).measurement,
    },
    source: 'database',
  };
}
