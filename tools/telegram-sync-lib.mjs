const DATE_HEADING_RE = /^### (\d{4}-\d{2}-\d{2})\s*$/gm;
const FINGERPRINT_RE = /^<!-- telegram-fingerprint: ([^ ]+) -->$/m;
const TELEGRAM_SECTION_TAG = '<!-- telegram-sync-section -->';

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
  const detectedDates = new Set();
  const warnings = [];
  const issues = [];
  const measurementCandidates = [];
  const activities = [];
  const nutritionMeals = [];
  const nutritionDetails = [];
  let nutritionTotalCalories = null;

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
      detectedDates.add(normalizedDetectedDate);
    }

    if (recognition.imageType === 'measurement' && recognition.records?.measurement) {
      measurementCandidates.push({
        ...recognition.records.measurement,
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

  if (!explicitDate && detectedDates.size > 1) {
    return {
      status: 'skipped',
      reason: `conflicting detected dates: ${[...detectedDates].join(', ')}`,
      warnings,
      issues,
    };
  }

  const archivedDate = explicitDate ?? resolveDetectedDate(detectedDates);
  if (!archivedDate) {
    return {
      status: 'skipped',
      reason: issues.length > 0 ? issues.join('; ') : 'no reliable archived date',
      warnings,
      issues,
    };
  }

  const measurement = measurementCandidates.at(-1) ?? null;
  const normalizedActivities = normalizeActivities(activities);
  const normalizedNutrition = normalizeNutrition(nutritionMeals, nutritionTotalCalories, nutritionDetails);

  return {
    status: 'ready',
    batchId: batch.batchId,
    archivedDate,
    measurement,
    activities: normalizedActivities,
    nutrition: normalizedNutrition,
    warnings,
    issues,
    confidence: calculateBatchConfidence(recognitions),
    fingerprints: buildFingerprints({
      archivedDate,
      measurement,
      activities: normalizedActivities,
      nutrition: normalizedNutrition,
    }),
  };
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
  const rawDate = recognition.detectedDate?.trim();
  const messageDate = dateFromUnix(message.dateUnix);

  if (rawDate) {
    const parsed = parseDateParts(rawDate);
    if (parsed && isReasonableYear(parsed.year, messageDate.year)) {
      return formatDateParts(parsed.year, parsed.month, parsed.day);
    }

    const fallbackMonthDay = parseMonthDay(recognition.dateEvidence) ?? parseMonthDay(rawDate);
    if (fallbackMonthDay) {
      return formatDateParts(messageDate.year, fallbackMonthDay.month, fallbackMonthDay.day);
    }
  }

  const monthDayFromEvidence = parseMonthDay(recognition.dateEvidence);
  if (monthDayFromEvidence) {
    return formatDateParts(messageDate.year, monthDayFromEvidence.month, monthDayFromEvidence.day);
  }

  return null;
}

function resolveDetectedDate(detectedDates) {
  if (detectedDates.size === 1) {
    return [...detectedDates][0];
  }
  return null;
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

function normalizeNutrition(meals, totalCalories, details) {
  const normalizedMeals = [];
  const seen = new Set();
  for (const meal of meals) {
    const key = `${meal.name}|${meal.calories}|${meal.recommendedMin}|${meal.recommendedMax}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalizedMeals.push({
      name: meal.name,
      calories: Number(meal.calories),
      recommendedMin: Number(meal.recommendedMin),
      recommendedMax: Number(meal.recommendedMax),
    });
  }
  const normalizedDetails = [...new Set((details ?? []).map((item) => item.trim()).filter(Boolean))];
  return {
    meals: normalizedMeals,
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

function buildFingerprints({ archivedDate, measurement, activities, nutrition }) {
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
    nutrition: nutrition.meals.map((meal) =>
      ['n', archivedDate, meal.name, meal.calories].join('-'),
    ),
  };
}

function splitDateSections(markdown) {
  const matches = [...markdown.matchAll(DATE_HEADING_RE)];
  if (!matches.length) {
    return [];
  }

  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : markdown.length;
    return {
      date: match[1],
      body: markdown.slice(start, end).trim(),
    };
  });
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
  if (batchResult.activities?.length) {
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
  if (batchResult.activities?.length) {
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
  for (let index = 0; index < batchResult.activities.length; index += 1) {
    const activity = batchResult.activities[index];
    const fingerprint = batchResult.fingerprints.activities[index];
    lines.push(fingerprintComment(fingerprint));
    lines.push(`- ${normalizeActivityTime(activity.time)} ${activity.type}：${activity.detail}`);
  }
  return lines.join('\n');
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
  const targetIndex = blocks.findIndex((block) => headingPattern.test(`${block.heading}\n`));
  if (targetIndex === -1) {
    return `${sectionBody.trim()}\n\n${nextBlock}`.trim();
  }

  const existingBlock = `${blocks[targetIndex].heading}\n${blocks[targetIndex].body}`.trim();
  const mergedBlock = mergeBlock(existingBlock, nextBlock);
  if (mergedBlock === existingBlock) {
    return sectionBody;
  }

  const rebuiltBlocks = blocks.map((block, index) =>
    index === targetIndex ? mergedBlock : `${block.heading}\n${block.body}`.trim(),
  );
  return rebuiltBlocks.join('\n\n').trim();
}

function splitLevel4Blocks(content) {
  const regex = /^#### .+$/gm;
  const matches = [...content.matchAll(regex)];
  if (!matches.length) {
    return [];
  }
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : content.length;
    return {
      heading: match[0],
      body: content.slice(start, end).trim(),
    };
  });
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

  if (existingBlock.startsWith('#### ') && existingBlock.includes('饮食截图记录')) {
    return mergeNutritionBlock(existingBlock, nextBlock);
  }

  if (!existingBlock.includes(TELEGRAM_SECTION_TAG)) {
    return `${existingBlock.trim()}\n${nextBlock
      .split(/\r?\n/)
      .slice(2)
      .join('\n')}`.trim();
  }

  const filteredLines = nextBlock
    .split(/\r?\n/)
    .filter((line) => line !== TELEGRAM_SECTION_TAG);
  return `${existingBlock.trim()}\n${filteredLines.slice(1).join('\n')}`.trim();
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

function normalizeActivityTime(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/(\d{2}:\d{2})$/);
  return match ? match[1] : trimmed;
}

function mergeNutritionBlock(existingBlock, nextBlock) {
  const heading = existingBlock.split(/\r?\n/)[0];
  const existingSummarySection = extractSubsection(existingBlock, '##### 餐次汇总');
  const existingDetailSection = extractSubsection(existingBlock, '##### 餐次明细');
  const incomingSummarySection = extractSubsection(nextBlock, '##### 餐次汇总');
  const incomingDetailSection = extractSubsection(nextBlock, '##### 餐次明细');

  const existingFingerprints = new Set(
    [...existingBlock.matchAll(/<!-- telegram-fingerprint: ([^ ]+) -->/g)].map((match) => match[1]),
  );

  const mergedSummaryLines = mergeSectionLines(
    existingSummarySection.lines,
    incomingSummarySection.lines,
    existingFingerprints,
  );
  const mergedDetailLines = mergeSectionLines(
    existingDetailSection.lines,
    incomingDetailSection.lines,
    existingFingerprints,
  );

  if (
    arraysEqual(mergedSummaryLines, existingSummarySection.lines) &&
    arraysEqual(mergedDetailLines, existingDetailSection.lines)
  ) {
    return existingBlock;
  }

  const parts = [
    heading,
    TELEGRAM_SECTION_TAG,
    '##### 餐次汇总',
    '',
    ...mergedSummaryLines,
  ];

  if (mergedDetailLines.length) {
    parts.push('');
    parts.push('##### 餐次明细');
    parts.push('');
    parts.push(...mergedDetailLines);
  }

  return parts.join('\n').trim();
}

function extractSubsection(block, heading) {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return { lines: [] };
  }

  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('##### ') && line.trim() !== heading) {
      break;
    }
    if (line.startsWith('#### ')) {
      break;
    }
    if (line === TELEGRAM_SECTION_TAG) {
      continue;
    }
    if (collected.length === 0 && line.trim() === '') {
      continue;
    }
    collected.push(line);
  }

  return { lines: trimTrailingBlankLines(collected) };
}

function mergeSectionLines(existingLines, incomingLines, existingFingerprints) {
  const result = [...existingLines];
  const incomingFingerprints = [...incomingLines.join('\n').matchAll(/<!-- telegram-fingerprint: ([^ ]+) -->/g)].map(
    (match) => match[1],
  );

  if (incomingFingerprints.length && incomingFingerprints.every((fingerprint) => existingFingerprints.has(fingerprint))) {
    return result;
  }

  for (let index = 0; index < incomingLines.length; index += 1) {
    const line = incomingLines[index];
    if (!line.trim()) {
      continue;
    }

    if (line.startsWith('<!-- telegram-fingerprint: ')) {
      const fingerprint = line.match(/<!-- telegram-fingerprint: ([^ ]+) -->/)?.[1];
      if (!fingerprint || existingFingerprints.has(fingerprint)) {
        index += 1;
        continue;
      }
      existingFingerprints.add(fingerprint);
      result.push(line);
      if (index + 1 < incomingLines.length && incomingLines[index + 1].trim()) {
        result.push(incomingLines[index + 1]);
        index += 1;
      }
      continue;
    }

    if (line.startsWith('- 当日截图内已记录总热量：')) {
      const existingTotalIndex = result.findIndex((item) => item.startsWith('- 当日截图内已记录总热量：'));
      if (existingTotalIndex === -1) {
        result.push(line);
      } else {
        result[existingTotalIndex] = line;
      }
      continue;
    }

    if (!result.includes(line)) {
      if (line.startsWith('- ') && result.some((existing) => areEquivalentNutritionLines(existing, line))) {
        continue;
      }
      result.push(line);
    }
  }

  return trimTrailingBlankLines(result);
}

function areEquivalentNutritionLines(left, right) {
  const leftParsed = parseNutritionLine(left);
  const rightParsed = parseNutritionLine(right);
  if (!leftParsed || !rightParsed) {
    return false;
  }
  return (
    leftParsed.calories === rightParsed.calories &&
    leftParsed.recommendedMin === rightParsed.recommendedMin &&
    leftParsed.recommendedMax === rightParsed.recommendedMax &&
    normalizeMealName(leftParsed.name) === normalizeMealName(rightParsed.name)
  );
}

function parseNutritionLine(line) {
  const match = line.match(/^- (.+)：(\d+(?:\.\d+)?)千卡，建议范围(\d+)[–-](\d+)千卡$/);
  if (!match) {
    return null;
  }
  return {
    name: match[1],
    calories: Number(match[2]),
    recommendedMin: Number(match[3]),
    recommendedMax: Number(match[4]),
  };
}

function normalizeMealName(name) {
  return name.replace(/（.*?）/g, '').trim();
}

function trimTrailingBlankLines(lines) {
  const result = [...lines];
  while (result.length && result.at(-1).trim() === '') {
    result.pop();
  }
  return result;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
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
