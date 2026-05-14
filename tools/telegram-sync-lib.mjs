const FINGERPRINT_RE = /^<!-- telegram-fingerprint: ([^ ]+) -->$/m;
const TELEGRAM_SECTION_TAG = '<!-- telegram-sync-section -->';

import {
  inferMealSlot,
  normalizeActivityTime,
  roundTo,
  splitDateSections,
  splitLevel4Blocks,
  toNullableNumber,
} from './training-domain.mjs';

export function groupTelegramUpdates(updates) {
  const batches = [];
  const albumMap = new Map();

  for (const update of updates) {
    const message = update.message ?? update.edited_message;
    if (!message?.photo?.length) {
      continue;
    }

    const normalized = normalizeTelegramMessage(update, message);
    if (normalized.mediaGroupId) {
      let batch = albumMap.get(normalized.mediaGroupId);
      if (!batch) {
        batch = {
          batchId: normalized.mediaGroupId,
          messages: [],
        };
        albumMap.set(normalized.mediaGroupId, batch);
        batches.push(batch);
      }
      batch.messages.push(normalized);
      continue;
    }

    batches.push({
      batchId: `single-${normalized.messageId}`,
      messages: [normalized],
    });
  }

  for (const batch of batches) {
    batch.messages.sort((left, right) => left.messageId - right.messageId);
  }

  return batches;
}

export function analyzeTelegramBatch(batch, recognitions, options = {}) {
  const minConfidence = options.minConfidence ?? 0.75;
  const recognitionMap = new Map(recognitions.map((item) => [item.messageId, item]));
  const explicitDate = extractBatchExplicitDate(batch);
  const primaryDetectedDates = new Set();
  const measurementDates = new Set();
  const warnings = [];
  const issues = [];
  const measurementCandidates = [];
  const activities = [];
  let workoutDailySummary = null;
  const nutritionMeals = [];
  const nutritionDetails = [];
  let nutritionTotalCalories = null;

  if (explicitDate) {
    primaryDetectedDates.add(explicitDate);
  }

  for (const message of batch.messages) {
    const recognition = recognitionMap.get(message.messageId);
    if (!recognition) {
      issues.push(`missing recognition for message ${message.messageId}`);
      continue;
    }
    if ((recognition.confidence ?? 0) < minConfidence) {
      issues.push(`low confidence for message ${message.messageId}`);
      continue;
    }

    const normalizedDetectedDate = normalizeRecognitionDate(recognition, message);

    for (const warning of recognition.warnings ?? []) {
      warnings.push(warning);
    }

    if (normalizedDetectedDate) {
      if (recognition.imageType === 'measurement') {
        measurementDates.add(normalizedDetectedDate);
      } else {
        primaryDetectedDates.add(normalizedDetectedDate);
      }
    }

    if (recognition.imageType === 'measurement' && recognition.records?.measurement) {
      measurementCandidates.push({
        ...recognition.records.measurement,
        detectedDate: normalizedDetectedDate,
        measuredAt:
          recognition.records.measurement.measuredAt ??
          normalizedDetectedDate ??
          null,
      });
    }
    if (recognition.imageType === 'workout' && Array.isArray(recognition.records?.activities)) {
      for (const activity of recognition.records.activities) {
        activities.push(activity);
      }
    }
    if (recognition.imageType === 'workout' && recognition.records?.dailyWorkoutSummary) {
      workoutDailySummary = mergeWorkoutDailySummary(
        workoutDailySummary,
        recognition.records.dailyWorkoutSummary,
      );
    }
    if (recognition.imageType === 'nutrition') {
      for (const meal of recognition.records?.meals ?? []) {
        nutritionMeals.push(meal);
      }
      for (const detail of recognition.records?.details ?? []) {
        nutritionDetails.push(detail);
      }
      if (recognition.records?.totalCalories !== null && recognition.records?.totalCalories !== undefined) {
        nutritionTotalCalories = recognition.records.totalCalories;
      }
    }
  }

  const allDetectedDates = new Set([...primaryDetectedDates, ...measurementDates]);
  if (allDetectedDates.size > 1) {
    return buildSkippedBatchResult(batch, {
      reason: `conflicting detected dates: ${[...allDetectedDates].sort().join(', ')}`,
      warnings,
      issues,
    });
  }

  const archivedDate =
    explicitDate ??
    resolveDetectedDate(primaryDetectedDates) ??
    resolveDetectedDate(measurementDates);
  if (!archivedDate) {
    return buildSkippedBatchResult(batch, {
      reason: issues.length > 0 ? issues.join('; ') : 'no reliable archived date',
      warnings,
      issues,
    });
  }

  const measurement = normalizeMeasurementForArchive(measurementCandidates.at(-1) ?? null, archivedDate);
  const normalizedActivities = normalizeActivities(activities);
  const normalizedNutrition = normalizeNutrition(nutritionMeals, nutritionTotalCalories, nutritionDetails);

  return {
    status: 'ready',
    batchId: batch.batchId,
    archivedDate,
    measurement,
    activities: normalizedActivities,
    workoutDailySummary: normalizeWorkoutDailySummary(workoutDailySummary),
    nutrition: normalizedNutrition,
    warnings,
    issues,
    confidence: calculateBatchConfidence(recognitions),
    fingerprints: buildFingerprints({
      archivedDate,
      measurement,
      activities: normalizedActivities,
      workoutDailySummary: normalizeWorkoutDailySummary(workoutDailySummary),
      nutrition: normalizedNutrition,
    }),
  };
}

export function processTelegramBatch(batch, recognitions, options = {}) {
  return analyzeTelegramBatch(batch, recognitions, options);
}

export function applyTelegramSyncToMarkdown(markdown, batchResult) {
  const nextSection = renderDateSection(batchResult);
  const sections = splitDateSections(markdown);
  const targetIndex = sections.findIndex((section) => section.date === batchResult.archivedDate);

  if (targetIndex === -1) {
    const mergedSections = [...sections, { date: batchResult.archivedDate, body: nextSection }];
    mergedSections.sort((left, right) => left.date.localeCompare(right.date));
    return {
      changed: true,
      markdown: stitchSections(markdown, mergedSections),
    };
  }

  const currentSection = sections[targetIndex];
  const mergedBody = mergeDateSection(currentSection.body, batchResult);
  if (mergedBody === currentSection.body) {
    return {
      changed: false,
      markdown,
    };
  }

  const nextSections = sections.slice();
  nextSections[targetIndex] = { ...currentSection, body: mergedBody };
  return {
    changed: true,
    markdown: stitchSections(markdown, nextSections),
  };
}

export async function processTelegramUpdates({
  markdown,
  updates,
  allowedChatIds,
  recognizeBatch,
  minConfidence,
}) {
  const grouped = groupTelegramUpdates(updates);
  const batchResults = [];
  const inboxEntries = [];
  let nextMarkdown = markdown;
  let changed = false;
  let lastProcessedUpdateId = updates.reduce(
    (max, update) => Math.max(max, update.update_id ?? 0),
    0,
  );

  for (const batch of grouped) {
    const isAllowed = batch.messages.every((message) => allowedChatIds.has(message.chatId));
    if (!isAllowed) {
      batchResults.push({
        batchId: batch.batchId,
        status: 'ignored',
        reason: 'unauthorized chat',
        updateIds: batch.messages.map((message) => message.updateId),
      });
      continue;
    }

    const recognitions = await recognizeBatch(batch);
    const analyzed = analyzeTelegramBatch(batch, recognitions, { minConfidence });
    batchResults.push({
      ...analyzed,
      updateIds: batch.messages.map((message) => message.updateId),
    });

    inboxEntries.push(
      buildInboxEntry({
        batch,
        recognitions,
        analyzed,
      }),
    );

    if (analyzed.status !== 'ready') {
      continue;
    }

    const applied = applyTelegramSyncToMarkdown(nextMarkdown, analyzed);
    nextMarkdown = applied.markdown;
    changed ||= applied.changed;
  }

  return {
    changed,
    markdown: nextMarkdown,
    lastProcessedUpdateId,
    batchResults,
    inboxEntries,
  };
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const limit = Math.max(1, Math.floor(concurrency || 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeTelegramMessage(update, message) {
  return {
    updateId: update.update_id,
    messageId: message.message_id,
    mediaGroupId: message.media_group_id ?? null,
    caption: message.caption ?? '',
    text: message.text ?? '',
    chatId: message.chat?.id ?? null,
    dateUnix: message.date ?? null,
    photos: (message.photo ?? []).map((photo) => ({
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
    })),
  };
}

function extractBatchExplicitDate(batch) {
  for (const message of batch.messages) {
    const explicitDate = extractDateFromText(`${message.caption}\n${message.text}`);
    if (explicitDate) {
      return explicitDate;
    }
  }
  return null;
}

function normalizeRecognitionDate(recognition, message) {
  const messageDate = dateFromUnix(message.dateUnix);
  const rawDate = recognition.detectedDate?.trim();

  if (rawDate) {
    const normalizedRawDate = normalizeDetectedDateValue(rawDate, messageDate.year);
    if (normalizedRawDate) {
      return normalizedRawDate;
    }
  }

  const measurementDate = normalizeMeasurementRecognitionDate(recognition, messageDate.year);
  if (measurementDate) {
    return measurementDate;
  }

  const evidenceDate = normalizeDetectedDateValue(recognition.dateEvidence, messageDate.year);
  if (evidenceDate) {
    return evidenceDate;
  }

  return null;
}

function normalizeMeasurementRecognitionDate(recognition, messageYear) {
  if (recognition.imageType !== 'measurement') {
    return null;
  }

  const measuredAt = recognition.records?.measurement?.measuredAt?.trim();
  if (!measuredAt) {
    return null;
  }

  return normalizeDetectedDateValue(measuredAt, messageYear);
}

function normalizeDetectedDateValue(value, messageYear) {
  if (!value) {
    return null;
  }

  const directDate = extractDateFromText(value);
  if (directDate) {
    const parsed = parseDateParts(directDate);
    if (parsed && isReasonableYear(parsed.year, messageYear)) {
      return formatDateParts(parsed.year, parsed.month, parsed.day);
    }
  }

  const monthDay = parseMonthDay(value);
  if (monthDay) {
    return formatDateParts(messageYear, monthDay.month, monthDay.day);
  }

  return null;
}

function resolveDetectedDate(detectedDates) {
  if (detectedDates.size === 1) {
    return [...detectedDates][0];
  }
  return null;
}

function buildSkippedBatchResult(batch, { reason, warnings = [], issues = [] }) {
  return {
    status: 'skipped',
    batchId: batch.batchId,
    reason,
    warnings,
    issues,
  };
}

function normalizeActivities(activities) {
  const deduped = new Map();
  for (const activity of activities) {
    const time = normalizeActivityTime(activity.time);
    const type = activity.type?.trim();
    const detail = activity.detail?.trim();
    if (!time || !type || !detail) {
      continue;
    }
    const key = `${time}|${type}|${detail}`;
    deduped.set(key, { time, type, detail });
  }
  return [...deduped.values()].sort((left, right) => left.time.localeCompare(right.time));
}

function mergeWorkoutDailySummary(current, incoming) {
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

function normalizeWorkoutDailySummary(summary) {
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

function normalizeNutrition(meals, totalCalories, details) {
  const mealMap = new Map();
  for (const meal of meals) {
    const mealName = inferMealSlot(meal.name);
    if (!mealName) {
      continue;
    }
    const existing = mealMap.get(mealName);
    const next = {
      name: mealName,
      calories: Number(meal.calories ?? 0),
      recommendedMin: Number(meal.recommendedMin),
      recommendedMax: Number(meal.recommendedMax),
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
  return {
    meals: ['早餐', '午餐', '晚餐', '加餐']
      .map((name) => mealMap.get(name))
      .filter(Boolean)
      .map((meal) => ({
        ...meal,
        calories: roundTo(meal.calories, 2),
      })),
    totalCalories: totalCalories === null || totalCalories === undefined ? null : Number(totalCalories),
    details: normalizedDetails,
  };
}

function calculateBatchConfidence(recognitions) {
  if (!recognitions.length) {
    return 0;
  }
  const total = recognitions.reduce((sum, item) => sum + (item.confidence ?? 0), 0);
  return Math.round((total / recognitions.length) * 1000) / 1000;
}

function buildFingerprints({ archivedDate, measurement, activities, workoutDailySummary, nutrition }) {
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

function stitchSections(originalMarkdown, sections) {
  const prefixMatch = originalMarkdown.match(/^[\s\S]*?(?=^### \d{4}-\d{2}-\d{2}\s*$)/m);
  const prefix = prefixMatch ? prefixMatch[0].trimEnd() : '';
  const body = sections
    .map((section) => `### ${section.date}\n\n${section.body.trim()}`)
    .join('\n\n');
  return `${prefix ? `${prefix}\n\n` : ''}${body}\n`;
}

function mergeDateSection(body, batchResult) {
  let nextBody = body.trim();

  if (batchResult.measurement) {
    nextBody = upsertBlock(nextBody, /#### .*体脂秤.*(?:\n|$)/, renderMeasurementBlock(batchResult));
  }
  if (batchResult.activities?.length || batchResult.workoutDailySummary) {
    nextBody = upsertBlock(nextBody, /#### .*运动截图记录(?:\n|$)/, renderActivitiesBlock(batchResult));
  }
  if (batchResult.nutrition?.meals?.length || batchResult.nutrition?.totalCalories !== null) {
    nextBody = upsertBlock(nextBody, /#### .*饮食截图记录(?:\n|$)/, renderNutritionBlock(batchResult));
  }

  return nextBody;
}

function renderDateSection(batchResult) {
  const parts = [];

  if (batchResult.measurement) {
    parts.push(renderMeasurementBlock(batchResult));
  }
  if (batchResult.activities?.length || batchResult.workoutDailySummary) {
    parts.push(renderActivitiesBlock(batchResult));
  }
  if (batchResult.nutrition?.meals?.length || batchResult.nutrition?.totalCalories !== null) {
    parts.push(renderNutritionBlock(batchResult));
  }

  return parts.join('\n\n').trim();
}

function renderMeasurementBlock(batchResult) {
  const measurement = batchResult.measurement;
  const lines = [
    '#### 当日体脂秤截图记录',
    '',
    TELEGRAM_SECTION_TAG,
    fingerprintComment(batchResult.fingerprints.measurement[0]),
    `- 测量时间：${measurement.measuredAt ?? batchResult.archivedDate}`,
  ];

  appendMetric(lines, '身体得分', measurement.bodyScore, '分');
  appendMetric(lines, '体重', measurement.weightKg, ' kg');
  appendMetric(lines, 'BMI', measurement.bmi);
  appendMetric(lines, '体脂率', measurement.bodyFatPct, '%');
  appendMetric(lines, '骨骼肌量', measurement.skeletalMuscleKg, ' kg');
  appendMetric(lines, '内脏脂肪等级', measurement.visceralFatLevel);
  appendMetric(lines, '基础代谢率', measurement.basalMetabolismKcal, ' kcal/日');
  appendMetric(lines, '水分率', measurement.bodyWaterPct, '%');
  appendMetric(lines, '蛋白质', measurement.proteinPct, '%');
  appendMetric(lines, '骨盐量', measurement.boneMassKg, ' kg');
  appendMetric(lines, '去脂体重', measurement.fatFreeMassKg, ' kg');
  appendMetric(lines, '身体年龄', measurement.bodyAge, '岁');
  if (measurement.bodyType) {
    lines.push(`- 身体类型：${measurement.bodyType}`);
  }

  return lines.join('\n');
}

function renderActivitiesBlock(batchResult) {
  const lines = ['#### 当日运动截图记录', '', TELEGRAM_SECTION_TAG];

  if (batchResult.workoutDailySummary) {
    lines.push(fingerprintComment(batchResult.fingerprints.workoutDailySummary[0]));
    lines.push('##### 当日活动总览');
    lines.push('');
    appendMetric(lines, '活动热量', batchResult.workoutDailySummary.activityCaloriesKcal, '千卡');
    appendMetric(lines, '锻炼时长', batchResult.workoutDailySummary.workoutDurationMinutes, '分钟');
    appendMetric(lines, '活动小时数', batchResult.workoutDailySummary.activeHours, '小时');
  }

  if (batchResult.activities.length) {
    lines.push('');
    lines.push('##### 活动明细');
    lines.push('');
  }

  for (let index = 0; index < batchResult.activities.length; index += 1) {
    const activity = batchResult.activities[index];
    const fingerprint = batchResult.fingerprints.activities[index];
    lines.push(fingerprintComment(fingerprint));
    lines.push(`- ${normalizeActivityTime(activity.time)} ${activity.type}：${activity.detail}`);
  }
  return lines.join('\n');
}

function normalizeMeasurementForArchive(measurement, archivedDate) {
  if (!measurement) {
    return null;
  }

  const measuredAt = measurement.measuredAt?.trim();
  if (!measuredAt) {
    return {
      ...measurement,
      measuredAt: archivedDate,
    };
  }

  if (/^\d{2}:\d{2}$/.test(measuredAt)) {
    const { detectedDate, ...rest } = measurement;
    return {
      ...rest,
      measuredAt: `${measurement.detectedDate ?? archivedDate} ${measuredAt}`,
    };
  }

  const { detectedDate, ...normalized } = measurement;
  return normalized;
}

function renderNutritionBlock(batchResult) {
  const nutrition = batchResult.nutrition;
  const lines = [
    `#### ${batchResult.archivedDate} 饮食截图记录`,
    '',
    TELEGRAM_SECTION_TAG,
    '##### 餐次汇总',
    '',
  ];

  for (let index = 0; index < nutrition.meals.length; index += 1) {
    const meal = nutrition.meals[index];
    const fingerprint = batchResult.fingerprints.nutrition[index];
    lines.push(fingerprintComment(fingerprint));
    lines.push(
      `- ${meal.name}：${meal.calories}千卡，建议范围${meal.recommendedMin}–${meal.recommendedMax}千卡`,
    );
  }

  if (nutrition.totalCalories !== null) {
    lines.push(`- 当日截图内已记录总热量：${nutrition.totalCalories}千卡`);
  }

  if (nutrition.details?.length) {
    lines.push('');
    lines.push('##### 餐次明细');
    lines.push('');
    for (const detail of nutrition.details) {
      lines.push(`- ${detail}`);
    }
  }

  return lines.join('\n');
}

function upsertBlock(sectionBody, headingPattern, nextBlock) {
  const blocks = splitLevel4Blocks(sectionBody);
  const targetIndex = blocks.findIndex((block) => headingPattern.test(`${block.headingLine}\n`));
  if (targetIndex === -1) {
    return `${sectionBody.trim()}\n\n${nextBlock}`.trim();
  }

  const existingBlock = `${blocks[targetIndex].headingLine}\n${blocks[targetIndex].body}`.trim();
  const mergedBlock = mergeBlock(existingBlock, nextBlock);
  if (mergedBlock === existingBlock) {
    return sectionBody;
  }

  const rebuiltBlocks = blocks.map((block, index) =>
    index === targetIndex ? mergedBlock : `${block.headingLine}\n${block.body}`.trim(),
  );
  return rebuiltBlocks.join('\n\n').trim();
}

function mergeBlock(existingBlock, nextBlock) {
  const existingFingerprints = new Set(
    [...existingBlock.matchAll(/<!-- telegram-fingerprint: ([^ ]+) -->/g)].map((match) => match[1]),
  );
  const incomingFingerprints = [...nextBlock.matchAll(/<!-- telegram-fingerprint: ([^ ]+) -->/g)].map(
    (match) => match[1],
  );

  if (incomingFingerprints.length > 0 && incomingFingerprints.every((fingerprint) => existingFingerprints.has(fingerprint))) {
    return existingBlock;
  }

  if (!existingBlock.includes(TELEGRAM_SECTION_TAG)) {
    return `${existingBlock.trim()}\n${nextBlock
      .split(/\r?\n/)
      .slice(2)
      .join('\n')}`.trim();
  }

  return nextBlock.trim();
}

function buildInboxEntry({ batch, recognitions, analyzed }) {
  return {
    batchId: batch.batchId,
    processedAt: new Date().toISOString(),
    status: analyzed.status,
    archivedDate: analyzed.archivedDate ?? null,
    reason: analyzed.reason ?? null,
    warnings: analyzed.warnings ?? [],
    issues: analyzed.issues ?? [],
    messages: batch.messages.map((message) => ({
      updateId: message.updateId,
      messageId: message.messageId,
      mediaGroupId: message.mediaGroupId,
      chatId: message.chatId,
      caption: message.caption,
      text: message.text,
      dateUnix: message.dateUnix,
      photoFileIds: message.photos.map((photo) => photo.fileId),
      photoFileUniqueIds: message.photos.map((photo) => photo.fileUniqueId),
    })),
    recognitions,
  };
}

function appendMetric(lines, label, value, suffix = '') {
  if (value === null || value === undefined || value === '') {
    return;
  }
  lines.push(`- ${label}：${formatValue(value)}${suffix}`);
}

function formatValue(value) {
  if (typeof value !== 'number') {
    return String(value);
  }
  return Number.isInteger(value) ? String(value) : String(value);
}

function fingerprintComment(value) {
  return `<!-- telegram-fingerprint: ${value} -->`;
}

function extractDateFromText(text) {
  const normalized = text.replace(/[./年]/g, '-').replace(/[月]/g, '-').replace(/[日]/g, '');
  const match = normalized.match(/\b(\d{4}-\d{1,2}-\d{1,2})\b/);
  if (!match) {
    return null;
  }
  const [year, month, day] = match[1].split('-').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateParts(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function parseMonthDay(value) {
  if (!value) {
    return null;
  }
  const monthDayMatch = value.match(/(\d{1,2})月(\d{1,2})日/);
  if (monthDayMatch) {
    return {
      month: Number(monthDayMatch[1]),
      day: Number(monthDayMatch[2]),
    };
  }
  const isoLikeMatch = value.match(/\b\d{4}-(\d{2})-(\d{2})\b/);
  if (isoLikeMatch) {
    return {
      month: Number(isoLikeMatch[1]),
      day: Number(isoLikeMatch[2]),
    };
  }
  return null;
}

function isReasonableYear(year, messageYear) {
  return year >= messageYear - 1 && year <= messageYear + 1;
}

function dateFromUnix(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function formatDateParts(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractCaloriesToken(detail) {
  const match = detail.match(/(\d+(?:\.\d+)?)千卡/);
  return match ? match[1] : 'na';
}
