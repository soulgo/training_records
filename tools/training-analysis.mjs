import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTrainingSnapshot as buildTrainingSnapshotFromSource } from './training-snapshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultAnalysisPromptPath = path.join(rootDir, 'prompts', 'training-analysis.md');
const defaultQuestion = '请根据最近训练、体脂、饮食数据给出今天/明天的训练建议';
const fallbackAnalysisPrompt =
  '你是训练数据分析助手。请根据用户问题和训练数据摘要，输出 Telegram 友好的中文短回复，包含数据结论、恢复风险、饮食观察、下一步行动。不要编造缺失数据，不做医疗诊断。';

export async function generateTrainingAnalysisReply(options = {}) {
  const env = normalizeAnalysisEnv(options.env ?? process.env);
  const question = normalizeAnalysisQuestion(options.question);
  const snapshot =
    options.snapshot ??
    (await (options.buildTrainingSnapshot ?? buildTrainingSnapshotFromSource)({
      rootDir: options.rootDir ?? rootDir,
      env: options.env ?? process.env,
      now: options.now,
    }));
  const prompt = await loadTrainingAnalysisPrompt(options.env ?? process.env);
  const summary = buildTrainingAnalysisSummary(snapshot, options.now ?? new Date());
  const content = await requestTrainingAnalysis({
    env,
    prompt,
    question,
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
  const promptPath = env.TRAINING_ANALYSIS_PROMPT_PATH?.trim() || defaultAnalysisPromptPath;

  try {
    const prompt = await readFile(promptPath, 'utf8');
    const trimmed = prompt.trim();
    return trimmed || fallbackAnalysisPrompt;
  } catch {
    return fallbackAnalysisPrompt;
  }
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

async function requestTrainingAnalysis({ env, prompt, question, summary, fetchImpl }) {
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
            `用户问题：${question}`,
            '',
            '训练数据摘要：',
            JSON.stringify(summary, null, 2),
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
