import { resolveDetectedDate } from './sync-dates.adapter.mjs';
import {
  getThoughtModuleTags,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
} from '../../core/thought-modules.mjs';
import {
  inferMealSlot,
  normalizeActivityTime,
  normalizeActivityType,
  normalizeSleepType,
  roundTo,
  toNullableNumber,
} from '../../domain/training/training-domain.mjs';
import { extractCaloriesToken } from './sync-markdown.adapter.mjs';
import { normalizeMessageId } from './sync-commands.adapter.mjs';

export function batchLikelyLostOriginalFilename(batch) {
  return (batch.messages ?? []).some((message) =>
    (message.photos ?? []).some((photo) => photo.source === 'photo' && !photo.fileName),
  );
}

export function normalizeDetectedApp(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function buildSkippedBatchResult(batch, {
  reason,
  warnings = [],
  issues = [],
  dateSources = [],
  dateStages = null,
  detectedApp = null,
  sourceImageCount = 0,
  recognizedImageCount = 0,
  failedImageCount = 0,
  failureCategory = null,
}) {
  const kind = batch.kind ?? 'image';
  const dateConfidence = classifyDateConfidence({
    archivedDate: null,
    dateSources,
    warnings,
    reason,
  });
  return {
    status: 'skipped',
    kind,
    batchId: batch.batchId,
    sourceChannel: batch.sourceChannel ?? 'telegram',
    reason,
    failureCategory,
    failureReason: failureCategory ? reason : null,
    warnings,
    issues,
    dateSources,
    dateConfidence: kind === 'image' ? dateConfidence : null,
    dateStages: kind === 'image'
      ? dateStages ?? buildDateStages({
          archivedDate: null,
          imageDates: new Set(),
          filenameDates: new Set(),
          usedFilenameDate: false,
          dateSources,
          dateConfidence,
        })
      : null,
    detectedApp,
    sourceImageCount,
    recognizedImageCount,
    failedImageCount,
  };
}

export function buildDateStages({
  archivedDate,
  imageDates = new Set(),
  filenameDates = new Set(),
  usedFilenameDate = false,
  dateSources = [],
  dateConfidence = null,
}) {
  const imageDate = resolveDetectedDate(imageDates);
  const filenameDate = resolveDetectedDate(filenameDates);
  const sleepBedtimeSource = dateSources.find((source) => source?.source === 'sleep_bedtime');
  return {
    date_parse: {
      status: imageDate ? 'succeeded' : 'failed',
      resultDate: imageDate ?? null,
    },
    filename_fallback: {
      status: usedFilenameDate ? 'succeeded' : 'skipped',
      resultDate: usedFilenameDate ? filenameDate : null,
    },
    sleep_bedtime_shift: {
      status: sleepBedtimeSource?.detectedDate ? 'succeeded' : 'skipped',
      resultDate: sleepBedtimeSource?.detectedDate ?? null,
    },
    date_confidence_gate: {
      status: ['uncertain', 'missing'].includes(dateConfidence) ? 'manual_intervention' : 'succeeded',
      result: dateConfidence ?? (archivedDate ? 'exact' : 'missing'),
    },
  };
}

export function classifyDateConfidence({
  archivedDate,
  dateSources = [],
  warnings = [],
  reason = '',
  usedFilenameDate = false,
}) {
  const normalizedSources = dateSources
    .map((item) => String(item?.source ?? '').trim())
    .filter(Boolean);
  const uniqueSources = new Set(normalizedSources);
  const warningText = [...warnings, reason].map((item) => String(item ?? '')).join('\n');

  if (
    uniqueSources.has('no_date') && !hasReliableDateSource(uniqueSources) && !usedFilenameDate ||
    /no reliable image or filename date/i.test(warningText)
  ) {
    return 'missing';
  }

  if (!archivedDate) {
    return 'uncertain';
  }

  if (
    (uniqueSources.has('no_date') && !usedFilenameDate) ||
    uniqueSources.has('none') ||
    uniqueSources.has('low_confidence') ||
    uniqueSources.size > 1 ||
    hasUncertainDateWarning(warningText)
  ) {
    return 'uncertain';
  }

  if (usedFilenameDate || uniqueSources.has('sleep_bedtime')) {
    return 'derived';
  }

  return 'exact';
}

function hasReliableDateSource(sources) {
  return sources.has('image') || sources.has('sleep_bedtime');
}

function hasUncertainDateWarning(text) {
  return /缺少年份|补全年份|不确定|无法可靠|混合|日期冲突|conflict|conflicting|ambiguous|multiple dates/i.test(text);
}

export function analyzeThoughtBatch(batch) {
  const message = getThoughtSourceMessage(batch);
  const body = batch.thought?.body?.trim() ?? '';
  const thoughtModule = normalizeThoughtModule(batch.thought?.thoughtModule);
  const hasMarkdownDocument = batchHasMarkdownDocuments(batch);
  const sourceChannel = batch.sourceChannel ?? message?.sourceChannel ?? 'telegram';

  if (batch.thought?.invalidReason) {
    return buildSkippedBatchResult(batch, {
      reason: batch.thought.invalidReason,
      failureCategory: 'user_input',
    });
  }

  if (!body && !hasMarkdownDocument) {
    return buildSkippedBatchResult(batch, {
      reason: 'empty thought body',
    });
  }

  return {
    status: 'ready',
    kind: 'thought',
    batchId: batch.batchId,
    sourceChannel,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    thought: {
      command: batch.thought?.command ?? '/thought',
      body,
      thoughtModule,
      sourceChannel,
      tags: getThoughtModuleTags(thoughtModule, { sourceChannel }),
      telegramMessageId: message?.messageId ?? null,
      telegramChatId: message?.chatId ?? null,
      sourceMessageId: message?.sourceMessageId ?? message?.messageId ?? null,
      sourceChatId: message?.sourceChatId ?? message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

function batchHasMarkdownDocuments(batch) {
  return (batch.messages ?? []).some((message) => (message.markdownDocuments?.length ?? 0) > 0);
}

export function analyzeThoughtEditBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const body = batch.thoughtEdit?.body?.trim() ?? '';
  const targetMessageId = normalizeMessageId(batch.thoughtEdit?.targetMessageId);
  const hasMarkdownDocument = batchHasMarkdownDocuments(batch);
  const sourceChannel = batch.sourceChannel ?? message?.sourceChannel ?? 'telegram';

  if (!targetMessageId) {
    return buildSkippedBatchResult(batch, {
      reason: 'missing target thought message id',
    });
  }

  const hasExplicitModule = Boolean(batch.thoughtEdit?.thoughtModule);
  if (!body && !hasMarkdownDocument && !hasExplicitModule) {
    return buildSkippedBatchResult(batch, {
      reason: 'empty thought body',
    });
  }

  return {
    status: 'ready',
    kind: 'thought_edit',
    batchId: batch.batchId,
    sourceChannel,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    thoughtEdit: {
      command: batch.thoughtEdit?.command ?? '/thought',
      sourceChannel,
      targetMessageId,
      body: body || (hasMarkdownDocument ? body : null),
      thoughtModule: normalizeThoughtModuleOrNull(batch.thoughtEdit?.thoughtModule),
      replacePhotos: Boolean(batch.thoughtEdit?.replacePhotos),
      telegramChatId: message?.chatId ?? null,
      targetSourceMessageId: batch.thoughtEdit?.targetSourceMessageId ?? message?.replySourceMessageId ?? targetMessageId,
      sourceChatId: batch.thoughtEdit?.sourceChatId ?? message?.sourceChatId ?? message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

export function analyzeThoughtDeleteBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const targetMessageId = normalizeMessageId(batch.thoughtDelete?.targetMessageId);
  const sourceChannel = batch.sourceChannel ?? message?.sourceChannel ?? 'telegram';

  if (!targetMessageId) {
    return buildSkippedBatchResult(batch, {
      reason: 'missing target thought message id',
    });
  }

  return {
    status: 'ready',
    kind: 'thought_delete',
    batchId: batch.batchId,
    sourceChannel,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    thoughtDelete: {
      command: batch.thoughtDelete?.command ?? '/随想删',
      sourceChannel,
      targetMessageId,
      telegramChatId: message?.chatId ?? null,
      targetSourceMessageId: batch.thoughtDelete?.targetSourceMessageId ?? message?.replySourceMessageId ?? targetMessageId,
      sourceChatId: batch.thoughtDelete?.sourceChatId ?? message?.sourceChatId ?? message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

function getThoughtSourceMessage(batch) {
  const sourceMessageId = batch.thought?.sourceMessageId ?? null;
  return (
    (batch.messages ?? []).find((message) => message.messageId === sourceMessageId) ??
    batch.messages?.[0] ??
    null
  );
}

export function analyzeAnalysisBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const question = batch.analysis?.question?.trim() ?? '';
  const sourceChannel = batch.sourceChannel ?? message?.sourceChannel ?? 'telegram';

  return {
    status: 'ready',
    kind: 'analysis',
    batchId: batch.batchId,
    sourceChannel,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    analysis: {
      command: batch.analysis?.command ?? '/analysis',
      sourceChannel,
      question,
      telegramMessageId: message?.messageId ?? null,
      telegramChatId: message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

export function analyzeHelpBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const sourceChannel = batch.sourceChannel ?? message?.sourceChannel ?? 'telegram';

  return {
    status: 'ready',
    kind: 'help',
    batchId: batch.batchId,
    sourceChannel,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    help: {
      command: batch.help?.command ?? '/help',
      sourceChannel,
      telegramMessageId: message?.messageId ?? null,
      telegramChatId: message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

export function normalizeActivities(activities) {
  const deduped = new Map();
  for (const activity of activities) {
    const time = normalizeActivityTime(activity.time);
    const type = normalizeActivityType(activity.type);
    const detail = activity.detail?.trim();
    if (!time || !type || !detail) {
      continue;
    }
    const key = `${time}|${type}|${detail}`;
    deduped.set(key, { time, type, detail });
  }
  return [...deduped.values()].sort((left, right) => left.time.localeCompare(right.time));
}

export function mergeWorkoutDailySummary(current, incoming) {
  if (!incoming) {
    return current;
  }
  return {
    activityCaloriesKcal:
      incoming.activityCaloriesKcal ?? current?.activityCaloriesKcal ?? null,
    workoutDurationMinutes:
      incoming.workoutDurationMinutes ?? current?.workoutDurationMinutes ?? null,
    activeHours: incoming.activeHours ?? current?.activeHours ?? null,
  };
}

export function normalizeWorkoutDailySummary(summary) {
  if (!summary) {
    return null;
  }

  const normalized = {
    activityCaloriesKcal: toNullableNumber(summary.activityCaloriesKcal),
    workoutDurationMinutes: toNullableNumber(summary.workoutDurationMinutes),
    activeHours: toNullableNumber(summary.activeHours),
  };

  return normalized.activityCaloriesKcal === null &&
    normalized.workoutDurationMinutes === null &&
    normalized.activeHours === null
    ? null
    : normalized;
}

export function normalizeNutrition(meals, totalCalories, details) {
  const mealMap = new Map();
  for (const meal of meals) {
    const mealName = inferMealSlot(meal.name);
    if (!mealName) {
      continue;
    }
    const existing = mealMap.get(mealName);
    const next = {
      name: mealName,
      calories: Math.round(Number(meal.calories ?? 0)),
      recommendedMin: Number.isFinite(Number(meal.recommendedMin)) ? Math.round(Number(meal.recommendedMin)) : null,
      recommendedMax: Number.isFinite(Number(meal.recommendedMax)) ? Math.round(Number(meal.recommendedMax)) : null,
    };
    if (!existing) {
      mealMap.set(mealName, next);
      continue;
    }
    existing.calories += next.calories;
    existing.recommendedMin = next.recommendedMin;
    existing.recommendedMax = next.recommendedMax;
  }
  const normalizedDetails = [...new Set((details ?? []).map((item) => item.trim()).filter(Boolean))];
  const normalizedMeals = ['早餐', '午餐', '晚餐', '加餐']
    .map((name) => mealMap.get(name))
    .filter(Boolean)
    .map((meal) => ({
      ...meal,
      calories: Math.round(meal.calories),
    }));
  const normalizedTotalCalories =
    totalCalories === null || totalCalories === undefined
      ? sumMealCalories(normalizedMeals)
      : Math.round(Number(totalCalories));
  return {
    meals: normalizedMeals,
    totalCalories: normalizedTotalCalories,
    details: normalizedDetails,
  };
}

function sumMealCalories(meals) {
  if (!meals.length) {
    return null;
  }
  const total = meals.reduce((sum, meal) => sum + Number(meal.calories ?? 0), 0);
  return Math.round(total);
}

export function calculateBatchConfidence(recognitions) {
  if (!recognitions.length) {
    return 0;
  }
  const total = recognitions.reduce((sum, item) => sum + (item.confidence ?? 0), 0);
  return Math.round((total / recognitions.length) * 1000) / 1000;
}

export function buildFingerprints({ archivedDate, measurement, activities, workoutDailySummary, nutrition }) {
  return {
    measurement: measurement
      ? [
          [
            'm',
            archivedDate,
            measurement.measuredAt ?? '',
            measurement.weightKg ?? '',
            measurement.bodyFatPct ?? '',
          ].join('-'),
        ]
      : [],
    activities: activities.map((activity) =>
      ['a', archivedDate, activity.time, activity.type, extractCaloriesToken(activity.detail)].join('-'),
    ),
    workoutDailySummary: workoutDailySummary
      ? [
          [
            'ws',
            archivedDate,
            workoutDailySummary.activityCaloriesKcal ?? 'na',
            workoutDailySummary.workoutDurationMinutes ?? 'na',
            workoutDailySummary.activeHours ?? 'na',
          ].join('-'),
        ]
      : [],
    nutrition: nutrition.meals.map((meal) =>
      ['n', archivedDate, meal.name, meal.calories].join('-'),
    ),
  };
}

export function normalizeMeasurementForArchive(measurement, archivedDate) {
  if (!measurement) {
    return null;
  }

  const normalized = {
    ...measurement,
    weightKg: normalizeWeightValue(measurement.weightKg),
    skeletalMuscleKg: normalizeWeightValue(measurement.skeletalMuscleKg),
    boneMassKg: normalizeWeightValue(measurement.boneMassKg),
    fatFreeMassKg: normalizeWeightValue(measurement.fatFreeMassKg),
  };

  const measuredAt = normalized.measuredAt?.trim();
  if (!measuredAt) {
    return {
      ...normalized,
      measuredAt: archivedDate,
    };
  }

  if (/^\d{2}:\d{2}$/.test(measuredAt)) {
    return {
      ...normalized,
      measuredAt: `${normalized.detectedDate ?? archivedDate} ${measuredAt}`,
    };
  }

  return normalized;
}

export function mergeMeasurementCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  return candidates.reduce((merged, candidate) => mergeMeasurementCandidate(merged, candidate), null);
}

function mergeMeasurementCandidate(current, incoming) {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return { ...incoming };
  }

  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && value !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeWeightValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Number.isFinite(value) ? roundTo(value, 3) : value;
}

export function normalizeSleepRecords(records, archivedDate) {
  const normalized = (records ?? [])
    .map((record) => normalizeSleepRecord(record, archivedDate))
    .filter(Boolean);

  if (normalized.length === 0) {
    return {
      records: [],
      totalSleepMinutes: null,
      nightSleepMinutes: null,
      napMinutes: null,
      sleepStartTime: null,
      sleepEndTime: null,
      deepSleepMinutes: null,
      lightSleepMinutes: null,
      remSleepMinutes: null,
      awakeMinutes: null,
      sleepScore: null,
      sleepScorePercentile: null,
      deepSleepRatioPct: null,
      lightSleepRatioPct: null,
      remSleepRatioPct: null,
      deepSleepContinuityScore: null,
      wakeCount: null,
      breathingQualityScore: null,
      averageHeartRateBpm: null,
      hrvMs: null,
      averageSpo2Pct: null,
      averageRespiratoryRate: null,
      analysisText: null,
      suggestionText: null,
    };
  }

  const latest = normalized.at(-1);
  const sum = (key) => normalized.reduce((total, item) => total + Number(item[key] ?? 0), 0) || null;
  const latestTotalSleepMinutes = deriveTotalSleepMinutes(latest);
  return {
    records: normalized,
    totalSleepMinutes: latestTotalSleepMinutes ?? sum('totalSleepMinutes'),
    nightSleepMinutes: latest.nightSleepMinutes ?? sum('nightSleepMinutes'),
    napMinutes: latest.napMinutes ?? sum('napMinutes'),
    sleepStartTime: latest.bedtime ?? null,
    sleepEndTime: latest.wakeTime ?? null,
    deepSleepMinutes: latest.deepSleepMinutes ?? sum('deepSleepMinutes'),
    lightSleepMinutes: latest.lightSleepMinutes ?? sum('lightSleepMinutes'),
    remSleepMinutes: latest.remSleepMinutes ?? sum('remSleepMinutes'),
    awakeMinutes: latest.awakeMinutes ?? sum('awakeMinutes'),
    sleepScore: latest.sleepScore ?? null,
    sleepScorePercentile: latest.sleepScorePercentile ?? null,
    deepSleepRatioPct: latest.deepSleepRatioPct ?? null,
    lightSleepRatioPct: latest.lightSleepRatioPct ?? null,
    remSleepRatioPct: latest.remSleepRatioPct ?? null,
    deepSleepContinuityScore: latest.deepSleepContinuityScore ?? null,
    wakeCount: latest.wakeCount ?? null,
    breathingQualityScore: latest.breathingQualityScore ?? null,
    averageHeartRateBpm: latest.averageHeartRateBpm ?? null,
    hrvMs: latest.hrvMs ?? null,
    averageSpo2Pct: latest.averageSpo2Pct ?? null,
    averageRespiratoryRate: latest.averageRespiratoryRate ?? null,
    analysisText: latest.analysisText ?? null,
    suggestionText: latest.suggestionText ?? null,
  };
}

export function normalizeSleepRecord(record, archivedDate) {
  if (!record) {
    return null;
  }

  const hasValues = [
    record.totalSleepMinutes,
    record.nightSleepMinutes,
    record.napMinutes,
    record.bedtime,
    record.wakeTime,
    record.deepSleepMinutes,
    record.lightSleepMinutes,
    record.remSleepMinutes,
    record.awakeMinutes,
    record.sleepStageText,
    record.sleepStageDetail,
    record.sleepScore,
    record.sleepScorePercentile,
    record.deepSleepRatioPct,
    record.lightSleepRatioPct,
    record.remSleepRatioPct,
    record.deepSleepContinuityScore,
    record.wakeCount,
    record.breathingQualityScore,
    record.averageHeartRateBpm,
    record.hrvMs,
    record.averageSpo2Pct,
    record.averageRespiratoryRate,
    record.analysisText,
    record.suggestionText,
  ].some((value) => value !== null && value !== undefined && value !== '');

  if (!hasValues) {
    return null;
  }

  return {
    sleepType: normalizeSleepType(record.sleepType ?? '夜间睡眠'),
    bedtime: normalizeClockTime(record.bedtime),
    wakeTime: normalizeClockTime(record.wakeTime),
    nightSleepMinutes: record.nightSleepMinutes ?? null,
    totalSleepMinutes: deriveTotalSleepMinutes(record),
    napMinutes: record.napMinutes ?? null,
    deepSleepMinutes: record.deepSleepMinutes ?? null,
    lightSleepMinutes: record.lightSleepMinutes ?? null,
    remSleepMinutes: record.remSleepMinutes ?? null,
    awakeMinutes: record.awakeMinutes ?? null,
    sleepStageText: record.sleepStageText ?? null,
    sleepStageDetail: Array.isArray(record.sleepStageDetail) ? record.sleepStageDetail : null,
    sleepScore: record.sleepScore ?? null,
    sleepScorePercentile: record.sleepScorePercentile ?? null,
    deepSleepRatioPct: record.deepSleepRatioPct ?? null,
    lightSleepRatioPct: record.lightSleepRatioPct ?? null,
    remSleepRatioPct: record.remSleepRatioPct ?? null,
    deepSleepContinuityScore: record.deepSleepContinuityScore ?? null,
    wakeCount: record.wakeCount ?? null,
    breathingQualityScore: record.breathingQualityScore ?? null,
    averageHeartRateBpm: record.averageHeartRateBpm ?? null,
    hrvMs: record.hrvMs ?? null,
    averageSpo2Pct: record.averageSpo2Pct ?? null,
    averageRespiratoryRate: record.averageRespiratoryRate ?? null,
    analysisText: record.analysisText ?? null,
    suggestionText: record.suggestionText ?? null,
    archivedDate,
  };
}

function deriveTotalSleepMinutes(record) {
  if (!record) {
    return null;
  }
  return record.totalSleepMinutes ?? record.nightSleepMinutes ?? null;
}

function normalizeClockTime(value) {
  if (!value) {
    return null;
  }
  return String(value).match(/(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/)?.slice(1).map((part, index) =>
    index === 0 ? String(Number(part)).padStart(2, '0') : part
  ).join(':') ?? String(value);
}

export function analyzeThoughtMoveBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const targetMessageId = normalizeMessageId(batch.thoughtMove?.targetMessageId);
  const thoughtModule = normalizeThoughtModuleOrNull(batch.thoughtMove?.thoughtModule);
  const sourceChannel = batch.sourceChannel ?? message?.sourceChannel ?? 'telegram';

  if (!targetMessageId) {
    return buildSkippedBatchResult(batch, {
      reason: 'missing target thought message id',
    });
  }

  if (!thoughtModule) {
    return buildSkippedBatchResult(batch, {
      reason: 'missing target thought module',
    });
  }

  return {
    status: 'ready',
    kind: 'thought_move',
    batchId: batch.batchId,
    sourceChannel,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    thoughtMove: {
      command: batch.thoughtMove?.command ?? '/移动',
      sourceChannel,
      targetMessageId,
      thoughtModule,
      tags: getThoughtModuleTags(thoughtModule, { sourceChannel }),
      telegramChatId: message?.chatId ?? null,
      targetSourceMessageId: batch.thoughtMove?.targetSourceMessageId ?? message?.replySourceMessageId ?? targetMessageId,
      sourceChatId: batch.thoughtMove?.sourceChatId ?? message?.sourceChatId ?? message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}
