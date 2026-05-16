import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateTrainingAnalysisReply,
  inferTrainingAnalysisFocus,
  normalizeTrainingGoal,
} from '../tools/training-analysis.mjs';

test('inferTrainingAnalysisFocus respects explicit recent-week requests', () => {
  const focus = inferTrainingAnalysisFocus('分析近一周训练及体脂数据，提供快速瘦腹建议。');

  assert.equal(focus.primaryWindow, 'recent7');
  assert.equal(focus.primaryMeasurementTrend, 'measurementTrend7');
  assert.equal(focus.requestedTimeframe, '最近7天');
  assert.match(focus.otherWindowPolicy, /不要引用 recent30/);
});

test('inferTrainingAnalysisFocus uses 30-day data only when requested', () => {
  const focus = inferTrainingAnalysisFocus('看一下最近30天训练和体脂趋势');

  assert.equal(focus.primaryWindow, 'recent30');
  assert.equal(focus.primaryMeasurementTrend, 'measurementTrend30');
  assert.equal(focus.requestedTimeframe, '最近30天');
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
  assert.match(userMessage.content, /训练者长期目标：增肌减腹/);
  assert.match(userMessage.content, /回答时间窗与证据约束/);
  assert.match(userMessage.content, /"primaryWindow": "recent7"/);
  assert.match(userMessage.content, /"primaryMeasurementTrend": "measurementTrend7"/);
  assert.match(userMessage.content, /不要引用 recent30/);
  assert.match(reply, /近7天训练稳定/);
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
  };
}
