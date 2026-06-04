import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTrainingSnapshot as buildTrainingSnapshotFromSource,
  isIncompleteDatabaseSnapshotError,
  isUnavailableDatabaseSnapshotError,
} from './training-snapshot.mjs';
import { buildTrainingAnalysisPrompt } from './training-prompt.mjs';
import { roundTo } from './training-domain.mjs';
import { createAiProvider } from '../src/ai/provider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultQuestion = '请根据最近训练、体脂、饮食数据给出今天/明天的训练建议';
const defaultTrainingGoal = '增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。';
const ANALYSIS_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export async function generateTrainingAnalysisReply(options = {}) {
  const rawEnv = options.env ?? process.env;
  const question = normalizeAnalysisQuestion(options.question);
  const trainingGoal = normalizeTrainingGoal(options.trainingGoal ?? rawEnv.TRAINING_ANALYSIS_GOAL);
  const aiProvider = options.aiProvider ?? createAiProvider(rawEnv);
  const snapshot =
    options.snapshot ??
    (await loadSnapshotForAnalysis(options));
  const prompt = await buildTrainingAnalysisPrompt({
    env: options.env ?? process.env,
    trainingGoal,
  });
  const summary = buildTrainingAnalysisSummary(snapshot, options.now ?? new Date());
  const focus = inferTrainingAnalysisFocus(question);
  const content = await requestTrainingAnalysis({
    aiProvider,
    prompt,
    question,
    focus,
    summary,
    fetchImpl: options.fetchImpl ?? fetch,
    maxAttempts: options.maxAttempts,
    baseDelayMs: options.baseDelayMs,
  });

  const reply = normalizeTelegramReply(content);
  if (!reply) {
    throw new Error('Training analysis returned empty content');
  }
  return reply;
}

async function loadSnapshotForAnalysis(options) {
  const buildTrainingSnapshot = options.buildTrainingSnapshot ?? buildTrainingSnapshotFromSource;
  const snapshotOptions = {
    rootDir: options.rootDir ?? rootDir,
    env: options.env ?? process.env,
    now: options.now,
  };

  try {
    const snapshot = await buildTrainingSnapshot(snapshotOptions);
    return {
      ...snapshot,
      source: String(snapshotOptions.env?.TRAINING_SNAPSHOT_SOURCE ?? '').trim().toLowerCase() === 'database'
        ? 'database'
        : 'markdown',
    };
  } catch (error) {
    if (!canFallbackToMarkdownSnapshot(error, snapshotOptions.env)) {
      throw error;
    }
    const snapshot = await buildTrainingSnapshot({
      ...snapshotOptions,
      source: 'markdown',
    });
    return {
      ...snapshot,
      source: 'fallback_markdown',
    };
  }
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
  const source = normalizeSnapshotSource(snapshot?.source);
  const coverage = buildCoverageSummary(daily, recent7, recent30);
  const recent7Load = summarizeWindow(recent7);
  const recent30Load = summarizeWindow(recent30);
  const recent7Recovery = summarizeRecoverySignal(recent7);
  const latestRecovery = summarizeRecoverySignal(daily.slice(-5));
  const bodyCompositionRisk = assessBodyCompositionRisk(measurements, recent7);
  const nutritionSignal = assessNutritionSignal(recent7, latestDay);
  const bodyFeedback = summarizeBodyFeedback(snapshot?.bodyFeedback ?? [], recent7, daily.slice(-5));

  return {
    generatedAt: toIsoString(now),
    dataSource: source,
    totalDays: daily.length,
    coverage,
    latestDate: latestDay?.date ?? null,
    latestMeasurement: normalizeMeasurement(latestMeasurement),
    recent7: recent7Load,
    recent30: recent30Load,
    measurementTrend7: summarizeMeasurementTrend(measurements.slice(-7)),
    measurementTrend30: summarizeMeasurementTrend(measurements.slice(-30)),
    trainingLoad: buildTrainingLoadSummary(recent7, recent30),
    strengthCardioBalance: buildStrengthCardioBalanceSummary(recent7, recent30),
    bodyCompositionRisk,
    nutritionSignal,
    bodyFeedback,
    recoverySignal: {
      recent7: recent7Recovery,
      latest5: latestRecovery,
      shouldRecover: recent7Recovery.shouldRecover || latestRecovery.shouldRecover,
    },
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
      sleepSummary: summarizeSleepForAnalysis(day.sleepSummary),
      workoutDetails: summarizeLatestActivityDetails(day.activities ?? []),
      bodyFeedback: bodyFeedback.byDate[day.date] ?? [],
      hasStrengthTraining: hasStrengthTraining(day),
      hasCardio: hasCardioTraining(day),
      hasHighIntensity: hasHighIntensityTraining(day),
      nutritionComplete: hasNutritionRecord(day),
    })),
  };
}

function summarizeSleepForAnalysis(sleep) {
  if (!sleep || sleep.totalSleepMinutes === null || sleep.totalSleepMinutes === undefined) {
    return null;
  }
  return {
    totalSleepMinutes: toNumberOrNull(sleep.totalSleepMinutes),
    nightSleepMinutes: toNumberOrNull(sleep.nightSleepMinutes),
    sleepStartTime: sleep.sleepStartTime ?? null,
    sleepEndTime: sleep.sleepEndTime ?? null,
    deepSleepMinutes: toNumberOrNull(sleep.deepSleepMinutes),
    lightSleepMinutes: toNumberOrNull(sleep.lightSleepMinutes),
    remSleepMinutes: toNumberOrNull(sleep.remSleepMinutes),
    deepSleepRatioPct: toNumberOrNull(sleep.deepSleepRatioPct),
    lightSleepRatioPct: toNumberOrNull(sleep.lightSleepRatioPct),
    remSleepRatioPct: toNumberOrNull(sleep.remSleepRatioPct),
    sleepScore: toNumberOrNull(sleep.sleepScore),
    deepSleepContinuityScore: toNumberOrNull(sleep.deepSleepContinuityScore),
    wakeCount: toNumberOrNull(sleep.wakeCount),
    breathingQualityScore: toNumberOrNull(sleep.breathingQualityScore),
    averageHeartRateBpm: toNumberOrNull(sleep.averageHeartRateBpm),
    hrvMs: toNumberOrNull(sleep.hrvMs),
    averageSpo2Pct: toNumberOrNull(sleep.averageSpo2Pct),
    averageRespiratoryRate: toNumberOrNull(sleep.averageRespiratoryRate),
    analysisText: sleep.analysisText ?? null,
    suggestionText: sleep.suggestionText ?? null,
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
  const intent = inferAnalysisIntent(normalized);
  const responseMode = responseModeForIntent(intent);
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
      intent,
      responseMode,
    };
  }

  if (hasThirtyDayRequest && !hasSevenDayRequest) {
    return {
      w: 'recent30',
      m: 'measurementTrend30',
      q: '最近30天',
      p: 'recent7_supplement',
      intent,
      responseMode,
    };
  }

  if (hasSevenDayRequest && hasThirtyDayRequest) {
    return {
      w: 'explicit_mixed',
      m: 'explicit_mixed',
      q: '用户同时点名最近7天和最近30天',
      p: 'explicit_mixed',
      intent,
      responseMode,
    };
  }

  if (hasNearTermTrainingRequest) {
    return {
      w: 'recent7',
      m: 'measurementTrend7',
      q: '今天/明天训练建议',
      p: 'near_term',
      intent,
      responseMode,
    };
  }

  return {
    w: 'recent7',
    m: 'measurementTrend7',
    q: intent === 'pain_discomfort' ? '疼痛/不适问题默认最近7天' : '默认最近7天',
    p: 'default_recent7',
    intent,
    responseMode,
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

function canFallbackToMarkdownSnapshot(error, env) {
  if (
    !isIncompleteDatabaseSnapshotError(error) &&
    !isUnavailableDatabaseSnapshotError(error)
  ) {
    return false;
  }

  return String(env?.TRAINING_SNAPSHOT_SOURCE ?? '').trim().toLowerCase() === 'database';
}

async function requestTrainingAnalysis({
  aiProvider,
  prompt,
  question,
  focus,
  summary,
  fetchImpl,
  maxAttempts,
  baseDelayMs,
}) {
  const response = await aiProvider.requestChatCompletion({
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
    fetchImpl,
    maxAttempts,
    baseDelayMs,
    retryableStatuses: ANALYSIS_RETRYABLE_STATUSES,
    logPrefix: '[training-analysis]',
    finalErrorMessage: 'Training analysis request failed',
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

function inferAnalysisIntent(question) {
  if (hasPainDiscomfortIntent(question)) {
    return 'pain_discomfort';
  }
  if (hasNutritionIntent(question)) {
    return 'nutrition';
  }
  if (hasBodyCompositionIntent(question)) {
    return 'body_composition';
  }
  if (hasRecoveryIntent(question)) {
    return 'recovery';
  }
  if (hasNearTermTrainingIntent(question) || hasTrainingPlanIntent(question)) {
    return 'training_plan';
  }
  return 'general';
}

function responseModeForIntent(intent) {
  return {
    training_plan: 'training_plan',
    nutrition: 'nutrition_review',
    body_composition: 'body_composition_review',
    recovery: 'recovery_review',
    pain_discomfort: 'symptom_triage',
    general: 'general_review',
  }[intent] ?? 'general_review';
}

function hasPainDiscomfortIntent(question) {
  const symptomPattern = /疼|痛|酸痛|酸胀|酸疼|发酸|肿|红肿|发热|麻|刺痛|抽筋|拉伤|扭伤|损伤|不适|僵硬|受限/u;
  if (symptomPattern.test(question)) {
    return true;
  }

  const symptomContext = '怎么回事|啥原因|什么原因|原因|恢复|休息|按压|伸直|疼|痛|酸|肿|麻|刺痛|抽筋|僵硬|不适|红肿|发热|受限';
  return new RegExp(
    `(?:肱二头肌|二头肌|右臂|左臂|手臂|肩|肘|腕|膝|踝|腰|背|臀|髋).*(?:${symptomContext})|(?:${symptomContext}).*(?:肱二头肌|二头肌|右臂|左臂|手臂|肩|肘|腕|膝|踝|腰|背|臀|髋)`,
    'u',
  ).test(question);
}

function hasNutritionIntent(question) {
  return /饮食|吃|摄入|热量|蛋白|碳水|脂肪|餐|早餐|午餐|晚餐|加餐|饿|饱|补剂|营养/u.test(question);
}

function hasBodyCompositionIntent(question) {
  return /体重|体脂|骨骼肌|肌肉|腰围|腹|肚子|减脂|增肌|掉秤|瘦|胖|围度|BMI/u.test(question);
}

function hasRecoveryIntent(question) {
  return /恢复|疲劳|累|休息|睡眠|精神|状态|过度训练|乏力|心率|压力/u.test(question);
}

function hasTrainingPlanIntent(question) {
  return /训练|力量|有氧|HIIT|骑行|跑步|爬楼|哑铃|拉伸|练/u.test(question);
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

function buildCoverageSummary(daily, recent7, recent30) {
  return {
    totalDays: daily.length,
    recent7: buildWindowCoverage(recent7),
    recent30: buildWindowCoverage(recent30),
    latest5: buildWindowCoverage(daily.slice(-5)),
  };
}

function buildWindowCoverage(days) {
  return {
    days: days.length,
    workoutDays: days.filter((day) => hasWorkoutRecord(day)).length,
    measurementDays: days.filter((day) => Boolean(day.measurement)).length,
    nutritionDays: days.filter((day) => hasNutritionRecord(day)).length,
  };
}

function buildTrainingLoadSummary(recent7, recent30) {
  return {
    recent7: buildLoadMetrics(recent7),
    recent30: buildLoadMetrics(recent30),
  };
}

function buildLoadMetrics(days) {
  const activeDays = days.filter((day) => hasWorkoutRecord(day));
  const restStreakDays = getCurrentRestStreak(days);
  const workoutStreakDays = getCurrentWorkoutStreak(days);

  return {
    days: days.length,
    trainedDays: activeDays.length,
    totalWorkoutMinutes: roundTo(sum(days.map(resolveWorkoutDurationMinutes)), 1),
    avgWorkoutMinutesPerTrainedDay: activeDays.length
      ? roundTo(sum(activeDays.map(resolveWorkoutDurationMinutes)) / activeDays.length, 1)
      : null,
    totalTrainingCalories: roundTo(sum(days.map((day) => day.workoutSummary?.trainingCalories)), 1),
    avgTrainingCaloriesPerDay: average(days.map((day) => day.workoutSummary?.trainingCalories)),
    totalCyclingKm: roundTo(sum(days.map((day) => day.workoutSummary?.cyclingDistanceKm)), 2),
    activeHours: roundTo(sum(days.map((day) => day.workoutSummary?.activeHours)), 1),
    workoutStreakDays,
    restStreakDays,
  };
}

function buildStrengthCardioBalanceSummary(recent7, recent30) {
  return {
    recent7: buildBalanceMetrics(recent7),
    recent30: buildBalanceMetrics(recent30),
  };
}

function buildBalanceMetrics(days) {
  let strengthSessions = 0;
  let cardioSessions = 0;
  let hiitSessions = 0;
  let strengthDays = 0;
  let cardioDays = 0;
  let hiitDays = 0;
  let cyclingDays = 0;
  const activityTypes = {};

  for (const day of days) {
    let hasStrength = false;
    let hasCardio = false;
    let hasHiit = false;
    const typeEntries = Object.entries(day.workoutSummary?.countsByType ?? {});
    for (const [type, count] of typeEntries) {
      const normalizedType = String(type);
      const numericCount = Number(count || 0);
      if (numericCount <= 0) {
        continue;
      }
      activityTypes[normalizedType] = (activityTypes[normalizedType] ?? 0) + numericCount;
      if (normalizedType.includes('力量')) {
        strengthSessions += numericCount;
        hasStrength = true;
      }
      if (normalizedType.includes('骑行') || normalizedType.includes('有氧') || normalizedType.includes('燃脂')) {
        cardioSessions += numericCount;
        hasCardio = true;
      }
      if (normalizedType.includes('HIIT') || normalizedType.includes('间歇')) {
        hiitSessions += numericCount;
        hasHiit = true;
      }
    }
    if ((day.workoutSummary?.cyclingDistanceKm ?? 0) > 0) {
      cyclingDays += 1;
      hasCardio = true;
      if (!typeEntries.some(([type]) => /骑行|有氧|燃脂|跑|走/u.test(String(type)))) {
        cardioSessions += 1;
      }
    }
    if (hasStrength) {
      strengthDays += 1;
    }
    if (hasCardio) {
      cardioDays += 1;
    }
    if (hasHiit) {
      hiitDays += 1;
    }
  }

  return {
    days: days.length,
    strengthSessions,
    cardioSessions,
    hiitSessions,
    strengthDays,
    cardioDays,
    hiitDays,
    cyclingDays,
    activityTypes,
  };
}

function assessBodyCompositionRisk(measurements, recent7) {
  const latest = measurements.at(-1) ?? null;
  const previous = measurements.at(-2) ?? null;
  const delta = summarizeMeasurementTrend(recent7.flatMap((day) => day.measurements ?? (day.measurement ? [day.measurement] : [])));
  const weightDeltaKg = delta.weightDeltaKg;
  const bodyFatDeltaPct = delta.bodyFatDeltaPct;
  const skeletalMuscleDeltaKg = delta.skeletalMuscleDeltaKg;

  if (!latest || !previous) {
    return {
      status: 'insufficient_data',
      weightDeltaKg: null,
      bodyFatDeltaPct: null,
      skeletalMuscleDeltaKg: null,
      note: '暂无足够数据',
    };
  }

  if (
    isFiniteNumber(weightDeltaKg) &&
    weightDeltaKg < 0 &&
    isFiniteNumber(skeletalMuscleDeltaKg) &&
    skeletalMuscleDeltaKg < 0
  ) {
    return {
      status: 'muscle_loss_risk',
      weightDeltaKg,
      bodyFatDeltaPct,
      skeletalMuscleDeltaKg,
      note: '体重下降伴随骨骼肌下降，优先保肌',
    };
  }

  if (
    isFiniteNumber(bodyFatDeltaPct) &&
    bodyFatDeltaPct < 0 &&
    (!isFiniteNumber(skeletalMuscleDeltaKg) || skeletalMuscleDeltaKg >= 0)
  ) {
    return {
      status: 'fat_loss_good',
      weightDeltaKg,
      bodyFatDeltaPct,
      skeletalMuscleDeltaKg,
      note: '体脂下降且骨骼肌未明显流失',
    };
  }

  return {
    status: 'stalled',
    weightDeltaKg,
    bodyFatDeltaPct,
    skeletalMuscleDeltaKg,
    note: '变化不明显，继续看训练与饮食一致性',
  };
}

function assessNutritionSignal(recent7, latestDay) {
  const intakeValues = recent7.map((day) => day.nutrition?.totalCalories).filter(isFiniteNumber);
  const avgIntakeCalories = intakeValues.length ? roundTo(sum(intakeValues) / intakeValues.length, 1) : null;
  const nutritionDays = recent7.filter((day) => hasNutritionRecord(day)).length;
  const trainingDays = recent7.filter((day) => hasWorkoutRecord(day)).length;
  const highLoad = recent7.filter((day) => isHighLoadDay(day)).length;

  const lowIntakeRisk =
    isFiniteNumber(avgIntakeCalories) &&
    isFiniteNumber(latestDay?.measurement?.weightKg) &&
    avgIntakeCalories < latestDay.measurement.weightKg * 28;

  return {
    avgIntakeCalories,
    nutritionDays,
    lowIntakeRisk,
    highLoadLowIntakeRisk: highLoad >= 3 && lowIntakeRisk,
    note: lowIntakeRisk ? '训练量不低但摄入偏低，注意恢复与保肌' : '摄入暂无明显低于训练需求的信号',
    trainingDays,
  };
}

function summarizeRecoverySignal(days) {
  const trainingDays = days.filter((day) => hasWorkoutRecord(day)).length;
  const workoutStreakDays = getCurrentWorkoutStreak(days);
  const restStreakDays = getCurrentRestStreak(days);
  const latestDay = days.at(-1) ?? null;
  const recentHighLoadDays = days.filter((day) => isHighLoadDay(day)).length;

  return {
    trainingDays,
    workoutStreakDays,
    restStreakDays,
    recentHighLoadDays,
    lastDayWasTraining: hasWorkoutRecord(latestDay),
    shouldRecover: recentHighLoadDays >= 3 || workoutStreakDays >= 4,
  };
}

function summarizeLatestActivityDetails(activities) {
  return activities
    .slice(0, 3)
    .map((activity) => {
      const time = normalizeActivityTimeForAnalysis(activity.time ?? activity.activityTime ?? '');
      return [time, activity.type, activity.detail].filter(Boolean).join(' ');
    })
    .filter(Boolean);
}

function summarizeBodyFeedback(entries, recent7Days, latest5Days) {
  const normalizedEntries = (entries ?? [])
    .map(normalizeBodyFeedbackEntry)
    .filter((entry) => entry.date && entry.body)
    .sort((left, right) => compareBodyFeedbackEntries(left, right));
  const recent7Dates = new Set(recent7Days.map((day) => day.date));
  const latest5Dates = new Set(latest5Days.map((day) => day.date));
  const recent7 = normalizedEntries.filter((entry) => recent7Dates.has(entry.date));
  const latest = [...normalizedEntries]
    .sort((left, right) => compareBodyFeedbackEntries(right, left))
    .slice(0, 5);
  const byDate = {};

  for (const entry of normalizedEntries.filter((item) => latest5Dates.has(item.date))) {
    const dayEntries = byDate[entry.date] ?? [];
    dayEntries.push(entry);
    byDate[entry.date] = dayEntries.slice(-3);
  }

  return {
    total: normalizedEntries.length,
    recent7,
    latest,
    byDate,
    hasRecentDiscomfort: recent7.length > 0,
  };
}

function normalizeBodyFeedbackEntry(entry) {
  return {
    date: String(entry?.date ?? '').trim(),
    time: entry?.time ? String(entry.time).trim() : null,
    body: String(entry?.body ?? '').trim(),
    telegramMessageId: toNumberOrNull(entry?.telegramMessageId),
    markdownPath: entry?.markdownPath ?? null,
    source: entry?.source ?? null,
  };
}

function compareBodyFeedbackEntries(left, right) {
  return `${left.date} ${left.time ?? ''}`.localeCompare(`${right.date} ${right.time ?? ''}`);
}

function hasWorkoutRecord(day) {
  return Boolean(day?.workoutSummary) && (
    (day?.workoutSummary?.trainingCalories ?? 0) > 0 ||
    (day?.activities?.length ?? 0) > 0 ||
    (day?.workoutSummary?.workoutDurationMinutes ?? 0) > 0
  );
}

function hasNutritionRecord(day) {
  return Boolean(day?.nutrition) && (
    (day?.nutrition?.meals?.length ?? 0) > 0 ||
    day?.nutrition?.totalCalories !== null && day?.nutrition?.totalCalories !== undefined
  );
}

function hasStrengthTraining(day) {
  return Object.keys(day?.workoutSummary?.countsByType ?? {}).some((type) => String(type).includes('力量'));
}

function hasCardioTraining(day) {
  return (
    (day?.workoutSummary?.cyclingDistanceKm ?? 0) > 0 ||
    Object.keys(day?.workoutSummary?.countsByType ?? {}).some((type) =>
      /骑行|有氧|燃脂|跑|走|HIIT|间歇/u.test(String(type)),
    )
  );
}

function hasHighIntensityTraining(day) {
  return Object.keys(day?.workoutSummary?.countsByType ?? {}).some((type) =>
    /HIIT|间歇|冲刺/u.test(String(type)),
  );
}

function isHighLoadDay(day) {
  const workoutMinutes = resolveWorkoutDurationMinutes(day) ?? 0;
  const trainingCalories = day?.workoutSummary?.trainingCalories ?? 0;
  return workoutMinutes >= 60 || trainingCalories >= 350 || hasHighIntensityTraining(day);
}

function getCurrentWorkoutStreak(days) {
  let streak = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (!hasWorkoutRecord(days[index])) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function getCurrentRestStreak(days) {
  let streak = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (hasWorkoutRecord(days[index])) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function normalizeSnapshotSource(source) {
  const normalized = String(source ?? '').trim().toLowerCase();
  if (normalized === 'database' || normalized === 'markdown' || normalized === 'fallback_markdown') {
    return normalized;
  }
  return 'unknown';
}

function normalizeActivityTimeForAnalysis(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.match(/(\d{2}:\d{2})$/)?.[1] ?? trimmed;
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

function toIsoString(value) {
  return typeof value?.toISOString === 'function' ? value.toISOString() : new Date().toISOString();
}
