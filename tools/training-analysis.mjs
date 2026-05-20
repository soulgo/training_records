import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTrainingSnapshot as buildTrainingSnapshotFromSource } from './training-snapshot.mjs';
import { buildTrainingAnalysisPrompt } from './training-prompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultQuestion = '请根据最近训练、体脂、饮食数据给出今天/明天的训练建议';
const defaultTrainingGoal = '增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。';

export async function generateTrainingAnalysisReply(options = {}) {
  const rawEnv = options.env ?? process.env;
  const env = normalizeAnalysisEnv(rawEnv);
  const question = normalizeAnalysisQuestion(options.question);
  const trainingGoal = normalizeTrainingGoal(options.trainingGoal ?? rawEnv.TRAINING_ANALYSIS_GOAL);
  const snapshot =
    options.snapshot ??
    (await (options.buildTrainingSnapshot ?? buildTrainingSnapshotFromSource)({
      rootDir: options.rootDir ?? rootDir,
      env: options.env ?? process.env,
      now: options.now,
    }));
  const prompt = await buildTrainingAnalysisPrompt({
    env: options.env ?? process.env,
    trainingGoal,
  });
  const summary = buildTrainingAnalysisSummary(snapshot, options.now ?? new Date());
  const focus = inferTrainingAnalysisFocus(question);
  const content = await requestTrainingAnalysis({
    env,
    prompt,
    question,
    trainingGoal,
    focus,
    summary,
    fetchImpl: options.fetchImpl ?? fetch,
  });

  const reply = normalizeTelegramReply(content);
  if (!reply) {
    throw new Error('Training analysis returned empty content');
  }
  return reply;
}

export async function loadTrainingAnalysisPrompt(env = process.env) {
  return buildTrainingAnalysisPrompt({ env });
}

export function buildTrainingAnalysisSummary(snapshot, now = new Date()) {
  const daily = [...(snapshot?.daily ?? [])].filter((day) => day?.date).sort((left, right) =>
    String(left.date).localeCompare(String(right.date)),
  );
  const latestDay = daily.at(-1) ?? null;
  const latestMeasurement = snapshot?.latest?.measurement ?? latestDay?.measurement ?? null;
  const recent7 = daily.slice(-7);
  const recent30 = daily.slice(-30);
  const measurements = daily
    .flatMap((day) => day.measurements ?? (day.measurement ? [day.measurement] : []))
    .filter(Boolean);

  return {
    generatedAt: toIsoString(now),
    totalDays: daily.length,
    latestDate: latestDay?.date ?? null,
    latestMeasurement: normalizeMeasurement(latestMeasurement),
    recent7: summarizeWindow(recent7),
    recent30: summarizeWindow(recent30),
    measurementTrend7: summarizeMeasurementTrend(measurements.slice(-7)),
    measurementTrend30: summarizeMeasurementTrend(measurements.slice(-30)),
    latestDays: daily.slice(-5).map((day) => ({
      date: day.date,
      weightKg: day.measurement?.weightKg ?? null,
      bodyFatPct: day.measurement?.bodyFatPct ?? null,
      skeletalMuscleKg: day.measurement?.skeletalMuscleKg ?? null,
      trainingCalories: toNumberOrNull(day.workoutSummary?.trainingCalories),
      workoutDurationMinutes: resolveWorkoutDurationMinutes(day),
      activityTypes: Object.entries(day.workoutSummary?.countsByType ?? {})
        .filter(([, count]) => Number(count) > 0)
        .map(([type, count]) => `${type}x${count}`),
      intakeCalories: toNumberOrNull(day.nutrition?.totalCalories),
    })),
  };
}

export function normalizeAnalysisQuestion(question) {
  const normalized = question?.trim();
  return normalized || defaultQuestion;
}

export function normalizeTrainingGoal(trainingGoal) {
  const normalized = trainingGoal?.trim();
  return normalized || defaultTrainingGoal;
}

export function inferTrainingAnalysisFocus(question) {
  const normalized = normalizeAnalysisQuestion(question);
  const hasSevenDayRequest = hasRecentSevenDayRequest(normalized);
  const hasThirtyDayRequest = hasRecentThirtyDayRequest(normalized);
  const hasNearTermTrainingRequest = hasNearTermTrainingIntent(normalized);

  // Returns compact focus: w=window, m=measurementTrend, q=timeframe, p=policy code.
  // Policy codes map to full text in the system prompt (回答时间窗策略 section).
  if (hasSevenDayRequest && !hasThirtyDayRequest) {
    return {
      w: 'recent7',
      m: 'measurementTrend7',
      q: '最近7天',
      p: 'no_recent30',
    };
  }

  if (hasThirtyDayRequest && !hasSevenDayRequest) {
    return {
      w: 'recent30',
      m: 'measurementTrend30',
      q: '最近30天',
      p: 'recent7_supplement',
    };
  }

  if (hasSevenDayRequest && hasThirtyDayRequest) {
    return {
      w: 'explicit_mixed',
      m: 'explicit_mixed',
      q: '用户同时点名最近7天和最近30天',
      p: 'explicit_mixed',
    };
  }

  if (hasNearTermTrainingRequest) {
    return {
      w: 'recent7',
      m: 'measurementTrend7',
      q: '今天/明天训练建议',
      p: 'near_term',
    };
  }

  return {
    w: 'recent7',
    m: 'measurementTrend7',
    q: '默认最近7天',
    p: 'default_recent7',
  };
}

export function splitTelegramMessage(text, maxLength = 3900) {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const parts = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakIndex = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf('。'));
    const splitAt = breakIndex > maxLength * 0.5 ? breakIndex + 1 : maxLength;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

function normalizeAnalysisEnv(env) {
  const apiKey = env.AI_API_KEY;
  const baseUrl = env.AI_BASE_URL;
  const model = env.AI_MODEL;

  for (const [name, value] of [
    ['AI_API_KEY', apiKey],
    ['AI_BASE_URL', baseUrl],
    ['AI_MODEL', model],
  ]) {
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
  };
}

async function requestTrainingAnalysis({ env, prompt, question, trainingGoal, focus, summary, fetchImpl }) {
  const response = await fetchImpl(`${env.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.apiKey}`,
    },
    body: JSON.stringify({
      model: env.model,
      messages: [
        {
          role: 'system',
          content: prompt,
        },
        {
          role: 'user',
          content: [
            `Q: ${question}`,
            `focus: ${JSON.stringify(focus)}`,
            `data: ${JSON.stringify(summary)}`,
          ].join('\n'),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Training analysis failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Training analysis returned empty content');
  }
  return content;
}

function normalizeTelegramReply(content) {
  return String(content ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function hasRecentSevenDayRequest(question) {
  return /(?:最近|近|过去|前|这|本)?\s*(?:7|七)\s*天/u.test(question)
    || /(?:最近|近|过去|这|本)?\s*(?:一|1)\s*周/u.test(question);
}

function hasRecentThirtyDayRequest(question) {
  return /(?:最近|近|过去|前)?\s*(?:30|三十)\s*天/u.test(question)
    || /(?:最近|近|过去)?\s*(?:一|1)\s*个?\s*月/u.test(question);
}

function hasNearTermTrainingIntent(question) {
  return /今天|明天|今晚|明早|下一次|下次|怎么练|训练安排|训练建议|计划/u.test(question);
}

function summarizeWindow(days) {
  const trainedDays = days.filter((day) => (day.workoutSummary?.trainingCalories ?? 0) > 0).length;
  const totalTrainingCalories = sum(days.map((day) => day.workoutSummary?.trainingCalories));
  const totalWorkoutMinutes = sum(days.map(resolveWorkoutDurationMinutes));
  const totalCyclingKm = sum(days.map((day) => day.workoutSummary?.cyclingDistanceKm));
  const intakeValues = days.map((day) => day.nutrition?.totalCalories).filter(isFiniteNumber);
  const activityCounts = {};

  for (const day of days) {
    for (const [type, count] of Object.entries(day.workoutSummary?.countsByType ?? {})) {
      activityCounts[type] = (activityCounts[type] ?? 0) + Number(count || 0);
    }
  }

  return {
    days: days.length,
    trainedDays,
    totalTrainingCalories: roundTo(totalTrainingCalories, 1),
    avgTrainingCaloriesPerDay: average(days.map((day) => day.workoutSummary?.trainingCalories)),
    totalWorkoutMinutes: roundTo(totalWorkoutMinutes, 1),
    avgWorkoutMinutesPerTrainedDay: trainedDays ? roundTo(totalWorkoutMinutes / trainedDays, 1) : null,
    totalCyclingKm: roundTo(totalCyclingKm, 2),
    avgIntakeCalories: intakeValues.length ? roundTo(sum(intakeValues) / intakeValues.length, 1) : null,
    activityCounts,
  };
}

function summarizeMeasurementTrend(measurements) {
  const first = measurements.find(Boolean) ?? null;
  const latest = measurements.at(-1) ?? null;
  if (!first || !latest) {
    return {
      count: measurements.length,
      weightDeltaKg: null,
      bodyFatDeltaPct: null,
      skeletalMuscleDeltaKg: null,
    };
  }

  return {
    count: measurements.length,
    fromDate: first.archivedDate ?? null,
    toDate: latest.archivedDate ?? null,
    weightDeltaKg: diff(latest.weightKg, first.weightKg),
    bodyFatDeltaPct: diff(latest.bodyFatPct, first.bodyFatPct),
    skeletalMuscleDeltaKg: diff(latest.skeletalMuscleKg, first.skeletalMuscleKg),
  };
}

function normalizeMeasurement(measurement) {
  if (!measurement) {
    return null;
  }
  return {
    archivedDate: measurement.archivedDate ?? null,
    measuredAt: measurement.measuredAt ?? null,
    weightKg: toNumberOrNull(measurement.weightKg),
    bodyFatPct: toNumberOrNull(measurement.bodyFatPct),
    skeletalMuscleKg: toNumberOrNull(measurement.skeletalMuscleKg),
    basalMetabolismKcal: toNumberOrNull(measurement.basalMetabolismKcal),
    visceralFatLevel: toNumberOrNull(measurement.visceralFatLevel),
  };
}

function resolveWorkoutDurationMinutes(day) {
  const explicit = day?.workoutSummary?.workoutDurationMinutes;
  if (isFiniteNumber(explicit)) {
    return Number(explicit);
  }
  const seconds = day?.workoutSummary?.totalDurationSeconds;
  return isFiniteNumber(seconds) ? roundTo(Number(seconds) / 60, 1) : null;
}

function average(values) {
  const numeric = values.filter(isFiniteNumber);
  return numeric.length ? roundTo(sum(numeric) / numeric.length, 1) : null;
}

function sum(values) {
  return values.filter(isFiniteNumber).reduce((total, value) => total + Number(value), 0);
}

function diff(next, previous) {
  if (!isFiniteNumber(next) || !isFiniteNumber(previous)) {
    return null;
  }
  return roundTo(Number(next) - Number(previous), 2);
}

function toNumberOrNull(value) {
  return isFiniteNumber(value) ? Number(value) : null;
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function roundTo(value, precision) {
  const factor = 10 ** precision;
  return Math.round(Number(value) * factor) / factor;
}

function toIsoString(value) {
  return typeof value?.toISOString === 'function' ? value.toISOString() : new Date().toISOString();
}
