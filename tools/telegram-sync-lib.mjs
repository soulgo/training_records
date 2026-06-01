import {
  inferMealSlot,
  normalizeActivityType,
  normalizeActivityTime,
  roundTo,
  splitDateSections,
  splitLevel4Blocks,
  toNullableNumber,
} from './training-domain.mjs';
import {
  DEFAULT_THOUGHT_MODULE,
  getThoughtModuleTags,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
  resolveThoughtModuleLabel,
} from './lib/thought-modules.mjs';
import { appendMetric } from './lib/markdown-render.mjs';
import { createTelegramCommandResolver } from '../src/telegram/commands.mjs';
import { isTelegramHelpText } from '../src/telegram/commands.mjs';

const FINGERPRINT_RE = /^<!-- telegram-fingerprint: ([^ ]+) -->$/m;
const TELEGRAM_SECTION_TAG = '<!-- telegram-sync-section -->';

const telegramCommandResolver = createTelegramCommandResolver({
  move: {
    match(normalized) {
      return parseThoughtMoveCommand(normalized.text);
    },
    build(normalized) {
      return buildThoughtMoveBatch(normalized);
    },
  },
  delete: {
    match(normalized) {
      return parseThoughtDeleteCommand(normalized.text);
    },
    build(normalized) {
      return buildThoughtDeleteBatch(normalized);
    },
  },
  analysis: {
    match(normalized) {
      return parseAnalysisCommand(normalized.text);
    },
    build(normalized) {
      return buildAnalysisBatch(normalized);
    },
  },
  ai_agent: {
    match(normalized) {
      return parseAiAgentCommand(normalized.text);
    },
    build(normalized) {
      return buildAiAgentBatch(normalized);
    },
  },
  help: {
    match(normalized) {
      return parseHelpCommand(normalized.text);
    },
    build(normalized) {
      return buildHelpBatch(normalized);
    },
  },
  explicit_edit: {
    match(normalized, context) {
      if (normalized.updateType !== 'message' || normalized.mediaGroupId) {
        return null;
      }
      return (
        context.parsedThoughtEdit ??
        parseThoughtEditCommand(normalized.text) ??
        parseThoughtEditCommand(normalized.caption)
      );
    },
    build(normalized, context, parsedThoughtEdit) {
      return buildExplicitThoughtEditBatch(normalized, parsedThoughtEdit);
    },
  },
  edited_message: {
    match(normalized, context) {
      if (normalized.updateType !== 'edited_message') {
        return null;
      }
      return context.knownThoughtMessageKeys.has(buildThoughtMessageKey(normalized.chatId, normalized.messageId))
        ? { targetMessageId: normalized.messageId }
        : null;
    },
    build(normalized) {
      return buildThoughtEditBatch(normalized);
    },
  },
  reply_edit: {
    match(normalized, context) {
      const parsedThought =
        context.parsedThought ??
        parseThoughtCommand(normalized.text) ??
        parseThoughtCommand(normalized.caption);
      if (
        !parsedThought ||
        !normalized.replyToMessageId ||
        !context.knownThoughtMessageKeys.has(buildThoughtMessageKey(normalized.chatId, normalized.replyToMessageId))
      ) {
        return null;
      }
      return { targetMessageId: normalized.replyToMessageId };
    },
    build(normalized) {
      return buildThoughtEditBatch(normalized, {
        targetMessageId: normalized.replyToMessageId,
      });
    },
  },
  thought: {
    match(normalized, context) {
      if (normalized.updateType !== 'message' || normalized.mediaGroupId) {
        return null;
      }
      return context.parsedThought ?? parseThoughtCommand(normalized.text) ?? parseThoughtCommand(normalized.caption);
    },
    build(normalized) {
      return buildThoughtBatch(normalized);
    },
    effects(normalized) {
      return [
        {
          type: 'knownThoughtMessageKey',
          key: buildThoughtMessageKey(normalized.chatId, normalized.messageId),
        },
      ];
    },
  },
});

export function groupTelegramUpdates(updates, options = {}) {
  const batches = [];
  const albumMap = new Map();
  const knownThoughtMessageKeys = new Set(options.knownThoughtMessageKeys ?? []);

  for (const update of updates) {
    const message = update.message ?? update.edited_message;
    if (!message) {
      continue;
    }

    const normalized = normalizeTelegramMessage(update, message);
    normalized.updateType = update.edited_message ? 'edited_message' : 'message';

    const parsedThoughtEdit = parseThoughtEditCommand(normalized.text) ?? parseThoughtEditCommand(normalized.caption);
    const parsedThought = parseThoughtCommand(normalized.text) ?? parseThoughtCommand(normalized.caption);
    if (parsedThought && normalized.updateType === 'message') {
      knownThoughtMessageKeys.add(buildThoughtMessageKey(normalized.chatId, normalized.messageId));
    }

    const resolution = telegramCommandResolver.resolve(normalized, {
      knownThoughtMessageKeys,
      parsedThought,
      parsedThoughtEdit,
      buildThoughtMessageKey,
    });
    if (resolution) {
      for (const effect of resolution.effects ?? []) {
        if (effect?.type === 'knownThoughtMessageKey' && effect.key) {
          knownThoughtMessageKeys.add(effect.key);
        }
      }
      batches.push(resolution.batch);
      continue;
    }

    if (normalized.mediaGroupId && normalized.photos.length > 0) {
      let batch = albumMap.get(normalized.mediaGroupId);
      if (!batch) {
        batch = {
          kind: 'image',
          batchId: normalized.mediaGroupId,
          messages: [],
        };
        albumMap.set(normalized.mediaGroupId, batch);
        batches.push(batch);
      }
      batch.messages.push(normalized);
      continue;
    }

    if (normalized.photos.length === 0) {
      continue;
    }

    batches.push({
      kind: 'image',
      batchId: `single-${normalized.messageId}`,
      messages: [normalized],
    });
  }

  for (const batch of batches) {
    batch.messages.sort((left, right) => left.messageId - right.messageId);
    if (batch.kind === 'image') {
      const thoughtEditBatch = buildExplicitThoughtEditBatchFromMessages(batch.messages);
      if (thoughtEditBatch) {
        Object.assign(batch, thoughtEditBatch);
        continue;
      }
      const thoughtBatch = buildThoughtBatchFromMessages(batch.messages);
      if (thoughtBatch) {
        Object.assign(batch, thoughtBatch);
      }
    }
  }

  return batches;
}

export function analyzeTelegramBatch(batch, recognitions, options = {}) {
  if (batch.kind === 'help') {
    return analyzeHelpBatch(batch);
  }

  if (batch.kind === 'analysis') {
    return analyzeAnalysisBatch(batch);
  }

  if (batch.kind === 'ai_agent') {
    return analyzeAiAgentBatch(batch);
  }

  if (batch.kind === 'thought_edit') {
    return analyzeThoughtEditBatch(batch);
  }

  if (batch.kind === 'thought_delete') {
    return analyzeThoughtDeleteBatch(batch);
  }

  if (batch.kind === 'thought_move') {
    return analyzeThoughtMoveBatch(batch);
  }

  if (batch.kind === 'thought') {
    return analyzeThoughtBatch(batch);
  }

  const minConfidence = options.minConfidence ?? 0.75;
  const recognitionMap = new Map(recognitions.map((item) => [item.messageId, item]));
  const imageDates = new Set();
  const filenameDates = collectFilenameDates(batch);
  const warnings = [];
  const issues = [];
  const measurementCandidates = [];
  const activities = [];
  let workoutDailySummary = null;
  const nutritionMeals = [];
  const nutritionDetails = [];
  let nutritionTotalCalories = null;
  const dateSources = [];
  const sourceImageCount = batch.messages.length;
  let recognizedImageCount = 0;
  const failedMessageIds = [];

  for (const message of batch.messages) {
    const recognition = recognitionMap.get(message.messageId);
    if (!recognition) {
      issues.push(`missing recognition for message ${message.messageId}`);
      failedMessageIds.push(message.messageId);
      dateSources.push({
        messageId: message.messageId,
        detectedDate: null,
        dateEvidence: null,
        source: 'none',
      });
      continue;
    }
    if ((recognition.confidence ?? 0) < minConfidence) {
      issues.push(`low confidence for message ${message.messageId}`);
      failedMessageIds.push(message.messageId);
      dateSources.push({
        messageId: message.messageId,
        detectedDate: recognition.detectedDate ?? null,
        dateEvidence: recognition.dateEvidence ?? null,
        source: 'low_confidence',
      });
      continue;
    }

    recognizedImageCount += 1;
    const normalizedDetectedDate = normalizeRecognitionDate(recognition, message);

    for (const warning of recognition.warnings ?? []) {
      warnings.push(warning);
    }

    if (normalizedDetectedDate) {
      imageDates.add(normalizedDetectedDate);
    }

    dateSources.push({
      messageId: message.messageId,
      detectedDate: normalizedDetectedDate ?? null,
      dateEvidence: recognition.dateEvidence ?? null,
      source: normalizedDetectedDate ? 'image' : 'no_date',
    });

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

  if (imageDates.size > 1) {
    return buildSkippedBatchResult(batch, {
      reason: `conflicting detected dates: ${[...imageDates].sort().join(', ')}`,
      warnings,
      issues,
      dateSources,
      sourceImageCount,
      recognizedImageCount,
      failedImageCount: sourceImageCount - recognizedImageCount,
    });
  }

  let archivedDate = null;
  if (imageDates.size === 1) {
    archivedDate = resolveDetectedDate(imageDates);
    const conflictingFilenameDates = [...filenameDates].filter((date) => date !== archivedDate);
    if (conflictingFilenameDates.length > 0) {
      warnings.push(
        `Filename date(s) ${conflictingFilenameDates.sort().join(', ')} differ from image date ${archivedDate}; using image date.`,
      );
    }
  } else if (filenameDates.size > 1) {
    return buildSkippedBatchResult(batch, {
      reason: `conflicting filename dates: ${[...filenameDates].sort().join(', ')}`,
      warnings,
      issues,
      dateSources,
      sourceImageCount,
      recognizedImageCount,
      failedImageCount: sourceImageCount - recognizedImageCount,
    });
  } else {
    archivedDate = resolveDetectedDate(filenameDates);
    if (archivedDate) {
      warnings.push(`Using filename date ${archivedDate} for Telegram batch without image dates.`);
    }
  }

  if (!archivedDate) {
    if (filenameDates.size === 0 && batchLikelyLostOriginalFilename(batch)) {
      warnings.push(
        '该 Telegram 图片看起来是以 photo 形式发送，Bot API 通常不会保留原始文件名；若要依赖文件名日期回退，请改为以 document/文件 发送。',
      );
    }
    return buildSkippedBatchResult(batch, {
      reason: issues.length > 0
        ? `${issues.join('; ')}; no reliable image or filename date`
        : 'no reliable image or filename date',
      warnings,
      issues,
      dateSources,
      sourceImageCount,
      recognizedImageCount,
      failedImageCount: sourceImageCount - recognizedImageCount,
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
    dateSources,
    sourceImageCount,
    recognizedImageCount,
    failedImageCount: sourceImageCount - recognizedImageCount,
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
        kind: batch.kind ?? 'image',
        batchId: batch.batchId,
        status: 'ignored',
        reason: 'unauthorized chat',
        updateIds: batch.messages.map((message) => message.updateId),
      });
      continue;
    }

    const recognitions = batch.kind === 'image' ? await recognizeBatch(batch) : [];
    const analyzed = analyzeTelegramBatch(batch, recognitions, { minConfidence });
    batchResults.push({
      kind: batch.kind ?? analyzed.kind ?? 'image',
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

    if (analyzed.status !== 'ready' || batch.kind !== 'image') {
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
  const documentImage = normalizeTelegramImageDocument(message.document);
  const photos = (message.photo ?? []).map((photo) => ({
    fileId: photo.file_id,
    fileUniqueId: photo.file_unique_id,
    width: photo.width ?? null,
    height: photo.height ?? null,
    fileSize: photo.file_size ?? null,
    fileName: null,
    mimeType: null,
    source: 'photo',
  }));
  if (documentImage) {
    photos.push(documentImage);
  }

  return {
    kind: 'message',
    updateId: update.update_id,
    messageId: message.message_id,
    mediaGroupId: message.media_group_id ?? null,
    caption: message.caption ?? '',
    text: message.text ?? '',
    chatId: message.chat?.id ?? null,
    dateUnix: message.date ?? null,
    replyToMessageId: message.reply_to_message?.message_id ?? null,
    photos,
  };
}

function buildThoughtBatch(message) {
  return buildThoughtBatchFromMessages([message]);
}

function buildThoughtEditBatch(message, options = {}) {
  const parsedEditBody = extractEditedThoughtBody(message);
  const targetMessageId = normalizeMessageId(
    options.targetMessageId ?? message.replyToMessageId ?? message.messageId,
  );

  return {
    kind: 'thought_edit',
    batchId: `thought-edit-${message.messageId}`,
    messages: [message],
    thoughtEdit: {
      command:
        parseThoughtCommand(message.text)?.command ??
        parseThoughtCommand(message.caption)?.command ??
        '/thought',
      targetMessageId,
      body: parsedEditBody.body,
      thoughtModule: parsedEditBody.moduleExplicit ? normalizeThoughtModule(parsedEditBody.moduleKey) : null,
    },
  };
}

function buildExplicitThoughtEditBatch(message, parsedThoughtEdit) {
  return {
    kind: 'thought_edit',
    batchId: `thought-edit-${message.messageId}`,
    messages: [message],
    thoughtEdit: {
      command: parsedThoughtEdit.command,
      targetMessageId: parsedThoughtEdit.targetMessageId,
      body: parsedThoughtEdit.body,
      thoughtModule: parsedThoughtEdit.moduleExplicit ? normalizeThoughtModule(parsedThoughtEdit.moduleKey) : null,
      replacePhotos: message.photos.length > 0,
    },
  };
}

function buildExplicitThoughtEditBatchFromMessages(messages) {
  const parsedEntry = findThoughtEditCommandEntry(messages);
  if (!parsedEntry) {
    return null;
  }

  const { message, parsedThoughtEdit } = parsedEntry;
  return {
    kind: 'thought_edit',
    batchId: `thought-edit-${message.messageId}`,
    messages,
    thoughtEdit: {
      command: parsedThoughtEdit.command,
      targetMessageId: parsedThoughtEdit.targetMessageId,
      body: parsedThoughtEdit.body,
      thoughtModule: parsedThoughtEdit.moduleExplicit ? normalizeThoughtModule(parsedThoughtEdit.moduleKey) : null,
      replacePhotos: messages.some((item) => (item.photos?.length ?? 0) > 0),
    },
  };
}

function buildThoughtDeleteBatch(message) {
  const parsedDelete = parseThoughtDeleteCommand(message.text);
  if (!parsedDelete) {
    return null;
  }

  return {
    kind: 'thought_delete',
    batchId: `thought-delete-${message.messageId}`,
    messages: [message],
    thoughtDelete: {
      command: parsedDelete.command,
      targetMessageId: parsedDelete.targetMessageId ?? message.replyToMessageId ?? null,
      requestedTargetText: parsedDelete.requestedTargetText,
      replyToMessageId: message.replyToMessageId,
    },
  };
}

function buildThoughtBatchFromMessages(messages) {
  const parsedEntry = findThoughtCommandEntry(messages);
  if (!parsedEntry) {
    return null;
  }

  const { message, parsedThought } = parsedEntry;
  if (!parsedThought) {
    return null;
  }

  return {
    kind: 'thought',
    batchId: `thought-${message.messageId}`,
    messages,
    thought: {
      command: parsedThought.command,
      body: parsedThought.body,
      thoughtModule: normalizeThoughtModule(parsedThought.moduleKey),
      sourceMessageId: message.messageId,
    },
  };
}

function buildThoughtMoveBatch(message) {
  const parsedMove = parseThoughtMoveCommand(message.text);
  if (!parsedMove) {
    return null;
  }

  return {
    kind: 'thought_move',
    batchId: `thought-move-${message.messageId}`,
    messages: [message],
    thoughtMove: {
      command: parsedMove.command,
      targetMessageId: parsedMove.targetMessageId ?? message.replyToMessageId ?? null,
      requestedTargetText: parsedMove.requestedTargetText,
      replyToMessageId: message.replyToMessageId,
      thoughtModule: parsedMove.thoughtModule,
    },
  };
}

function buildAnalysisBatch(message) {
  const parsedAnalysis = parseAnalysisCommand(message.text);
  if (!parsedAnalysis) {
    return null;
  }

  return {
    kind: 'analysis',
    batchId: `analysis-${message.messageId}`,
    messages: [message],
    analysis: {
      command: parsedAnalysis.command,
      question: parsedAnalysis.question,
    },
  };
}

function buildAiAgentBatch(message) {
  const parsedAiAgent = parseAiAgentCommand(message.text);
  if (!parsedAiAgent) {
    return null;
  }

  return {
    kind: 'ai_agent',
    batchId: `ai-${message.messageId}`,
    messages: [message],
    aiAgent: {
      command: parsedAiAgent.command,
      question: parsedAiAgent.question,
    },
  };
}

function buildHelpBatch(message) {
  const parsedHelp = parseHelpCommand(message.text);
  if (!parsedHelp) {
    return null;
  }

  return {
    kind: 'help',
    batchId: `help-${message.messageId}`,
    messages: [message],
    help: {
      command: parsedHelp.command,
    },
  };
}

function normalizeTelegramImageDocument(document) {
  if (!document?.file_id) {
    return null;
  }

  const fileName = document.file_name?.trim() || '';
  const mimeType = document.mime_type?.trim() || '';
  const isImageMimeType = mimeType.toLowerCase().startsWith('image/');
  const hasImageExtension = /\.(?:jpe?g|png|webp|gif|bmp|heic|heif|tiff?)$/i.test(fileName);
  if (!isImageMimeType && !hasImageExtension) {
    return null;
  }

  return {
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id,
    width: null,
    height: null,
    fileSize: document.file_size ?? null,
    fileName: fileName || null,
    mimeType: mimeType || null,
    source: 'document',
  };
}

function normalizeRecognitionDate(recognition, message) {
  const messageDate = dateFromUnix(message.dateUnix);
  const rawDate = recognition.detectedDate?.trim();

  if (rawDate && shouldParseDateEvidence(recognition.dateEvidence)) {
    const normalizedRawDate = normalizeDetectedDateValue(rawDate, messageDate.year);
    if (normalizedRawDate) {
      return normalizedRawDate;
    }
  }

  const measurementDate = normalizeMeasurementRecognitionDate(recognition, messageDate.year);
  if (measurementDate) {
    return measurementDate;
  }

  const evidenceDate = shouldParseDateEvidence(recognition.dateEvidence)
    ? normalizeDetectedDateValue(recognition.dateEvidence, messageDate.year)
    : null;
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

  const directDate = extractDateFromText(value, {
    messageYear,
    reasonableYear: true,
  });
  if (directDate) {
    return directDate;
  }

  const monthDay = parseMonthDay(value);
  if (Number.isInteger(messageYear) && monthDay && isValidDateParts(messageYear, monthDay.month, monthDay.day)) {
    return formatDateParts(messageYear, monthDay.month, monthDay.day);
  }

  return null;
}

function collectFilenameDates(batch) {
  const dates = new Set();
  for (const message of batch.messages ?? []) {
    for (const photo of message.photos ?? []) {
      const date = extractFilenameDate(photo.fileName, dateFromUnix(message.dateUnix).year);
      if (date) {
        dates.add(date);
      }
    }
  }
  return dates;
}

function extractFilenameDate(fileName, messageYear) {
  if (!fileName) {
    return null;
  }

  return extractDateFromText(fileName, {
    messageYear,
    allowCompact: true,
    allowMonthDay: true,
    reasonableYear: true,
  });
}

function shouldParseDateEvidence(dateEvidence) {
  if (!dateEvidence) {
    return true;
  }

  const externalOnly = /\b(?:caption|text|filename|file\s*name)\b/i.test(dateEvidence);
  const imageEvidence = /\b(?:image|screenshot|ocr|header|screen)\b/i.test(dateEvidence) || /截图|画面|图片/.test(dateEvidence);
  return !externalOnly || imageEvidence;
}

function batchLikelyLostOriginalFilename(batch) {
  return (batch.messages ?? []).some((message) =>
    (message.photos ?? []).some((photo) => photo.source === 'photo' && !photo.fileName),
  );
}

function resolveDetectedDate(detectedDates) {
  if (detectedDates.size === 1) {
    return [...detectedDates][0];
  }
  return null;
}

function buildSkippedBatchResult(batch, { reason, warnings = [], issues = [], dateSources = [], sourceImageCount = 0, recognizedImageCount = 0, failedImageCount = 0 }) {
  return {
    status: 'skipped',
    kind: batch.kind ?? 'image',
    batchId: batch.batchId,
    reason,
    warnings,
    issues,
    dateSources,
    sourceImageCount,
    recognizedImageCount,
    failedImageCount,
  };
}

function analyzeThoughtBatch(batch) {
  const message = getThoughtSourceMessage(batch);
  const body = batch.thought?.body?.trim() ?? '';
  const thoughtModule = normalizeThoughtModule(batch.thought?.thoughtModule);

  if (!body) {
    return buildSkippedBatchResult(batch, {
      reason: 'empty thought body',
    });
  }

  return {
    status: 'ready',
    kind: 'thought',
    batchId: batch.batchId,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    thought: {
      command: batch.thought?.command ?? '/thought',
      body,
      thoughtModule,
      tags: getThoughtModuleTags(thoughtModule),
      telegramMessageId: message?.messageId ?? null,
      telegramChatId: message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

function analyzeThoughtEditBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const body = batch.thoughtEdit?.body?.trim() ?? '';
  const targetMessageId = normalizeMessageId(batch.thoughtEdit?.targetMessageId);

  if (!targetMessageId) {
    return buildSkippedBatchResult(batch, {
      reason: 'missing target thought message id',
    });
  }

  if (!body) {
    return buildSkippedBatchResult(batch, {
      reason: 'empty thought body',
    });
  }

  return {
    status: 'ready',
    kind: 'thought_edit',
    batchId: batch.batchId,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    thoughtEdit: {
      command: batch.thoughtEdit?.command ?? '/thought',
      targetMessageId,
      body,
      thoughtModule: normalizeThoughtModuleOrNull(batch.thoughtEdit?.thoughtModule),
      replacePhotos: Boolean(batch.thoughtEdit?.replacePhotos),
      telegramChatId: message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

function analyzeThoughtDeleteBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const targetMessageId = normalizeMessageId(batch.thoughtDelete?.targetMessageId);

  if (!targetMessageId) {
    return buildSkippedBatchResult(batch, {
      reason: 'missing target thought message id',
    });
  }

  return {
    status: 'ready',
    kind: 'thought_delete',
    batchId: batch.batchId,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    thoughtDelete: {
      command: batch.thoughtDelete?.command ?? '/随想删',
      targetMessageId,
      telegramChatId: message?.chatId ?? null,
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

function analyzeAnalysisBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const question = batch.analysis?.question?.trim() ?? '';

  return {
    status: 'ready',
    kind: 'analysis',
    batchId: batch.batchId,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    analysis: {
      command: batch.analysis?.command ?? '/analysis',
      question,
      telegramMessageId: message?.messageId ?? null,
      telegramChatId: message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

function analyzeAiAgentBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const question = batch.aiAgent?.question?.trim() ?? '';

  return {
    status: 'ready',
    kind: 'ai_agent',
    batchId: batch.batchId,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    aiAgent: {
      command: batch.aiAgent?.command ?? '/ai',
      question,
      telegramMessageId: message?.messageId ?? null,
      telegramChatId: message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

function analyzeHelpBatch(batch) {
  const message = batch.messages?.[0] ?? null;

  return {
    status: 'ready',
    kind: 'help',
    batchId: batch.batchId,
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    help: {
      command: batch.help?.command ?? '/help',
      telegramMessageId: message?.messageId ?? null,
      telegramChatId: message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

function normalizeActivities(activities) {
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
  const normalizedMeals = ['早餐', '午餐', '晚餐', '加餐']
    .map((name) => mealMap.get(name))
    .filter(Boolean)
    .map((meal) => ({
      ...meal,
      calories: roundTo(meal.calories, 2),
    }));
  const normalizedTotalCalories =
    totalCalories === null || totalCalories === undefined
      ? sumMealCalories(normalizedMeals)
      : Number(totalCalories);
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
  return roundTo(total, 2);
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
    nextBody = upsertBlock(nextBody, /#### .*运动截图记录(?:\n|$)/, renderActivitiesBlock(batchResult), {
      mergeBlock: mergeWorkoutBlock,
    });
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
    const { detectedDate, ...rest } = normalized;
    return {
      ...rest,
      measuredAt: `${normalized.detectedDate ?? archivedDate} ${measuredAt}`,
    };
  }

  const { detectedDate, ...finalNormalized } = normalized;
  return finalNormalized;
}

function normalizeWeightValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return Number.isFinite(value) ? roundTo(value, 3) : value;
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

function upsertBlock(sectionBody, headingPattern, nextBlock, options = {}) {
  const targetRange = findLevel4BlockRange(sectionBody, headingPattern);
  if (!targetRange) {
    return `${sectionBody.trim()}\n\n${nextBlock}`.trim();
  }

  const originalChunk = sectionBody.slice(targetRange.start, targetRange.end);
  const existingBlock = originalChunk.trim();
  const merge = options.mergeBlock ?? mergeBlock;
  const mergedBlock = merge(existingBlock, nextBlock);
  if (mergedBlock === existingBlock) {
    return sectionBody;
  }

  const separator = originalChunk.match(/\s*$/)?.[0] ?? '\n\n';
  return `${sectionBody.slice(0, targetRange.start)}${mergedBlock}${separator}${sectionBody.slice(targetRange.end)}`.trim();
}

function findLevel4BlockRange(sectionBody, headingPattern) {
  const matches = [...sectionBody.matchAll(/^#### .+$/gm)];
  const targetIndex = matches.findIndex((match) => headingPattern.test(`${match[0]}\n`));
  if (targetIndex === -1) {
    return null;
  }

  return {
    start: matches[targetIndex].index,
    end: targetIndex + 1 < matches.length ? matches[targetIndex + 1].index : sectionBody.length,
  };
}

function mergeBlock(existingBlock, nextBlock) {
  const incoming = nextBlock.trim();
  if (!incoming) {
    return existingBlock;
  }

  if (incoming === existingBlock.trim()) {
    return existingBlock;
  }

  return incoming;
}

function mergeWorkoutBlock(existingBlock, nextBlock) {
  const existing = splitWorkoutBlock(existingBlock);
  const incoming = splitWorkoutBlock(nextBlock);
  const summaryBody = incoming.summaryBody ?? existing.summaryBody;
  const activityBody = incoming.activityBody
    ? mergeActivityBodies(existing.activityBody, incoming.activityBody)
    : existing.activityBody;
  const lines = [existing.headingLine ?? incoming.headingLine ?? '#### 当日运动截图记录', '', TELEGRAM_SECTION_TAG];

  if (summaryBody) {
    lines.push('');
    lines.push('##### 当日活动总览');
    lines.push('');
    lines.push(stripLevel5Heading(summaryBody, '当日活动总览').trim());
  }

  if (activityBody) {
    lines.push('');
    lines.push('##### 活动明细');
    lines.push('');
    lines.push(stripLevel5Heading(activityBody, '活动明细').trim());
  }

  return lines.join('\n').trim();
}

function splitWorkoutBlock(block) {
  const [headingLine = '#### 当日运动截图记录', ...bodyLines] = block.trim().split(/\r?\n/);
  const body = bodyLines.join('\n').trim();
  return {
    headingLine,
    summaryBody: extractLevel5Body(body, '当日活动总览'),
    activityBody: extractLevel5Body(body, '活动明细') ?? extractLegacyActivityBody(body),
  };
}

function extractLevel5Body(content, heading) {
  const block = splitLevel5Blocks(content).find((item) => item.heading === heading);
  return block ? block.body.trim() : null;
}

function splitLevel5Blocks(content) {
  const matches = [...content.matchAll(/^##### (.+)$/gm)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : content.length;
    return {
      headingLine: match[0],
      heading: match[1].trim(),
      body: content.slice(start, end).trim(),
    };
  });
}

function stripLevel5Heading(content, heading) {
  const trimmed = content.trim();
  const headingLine = `##### ${heading}`;
  return trimmed.startsWith(headingLine) ? trimmed.slice(headingLine.length).trim() : trimmed;
}

function extractLegacyActivityBody(content) {
  const entries = parseActivityEntries(content);
  return entries.length ? renderActivityEntries(entries) : null;
}

function mergeActivityBodies(existingBody, incomingBody) {
  const entriesByKey = new Map();
  for (const entry of parseActivityEntries(existingBody ?? '')) {
    entriesByKey.set(entry.key, entry);
  }
  for (const entry of parseActivityEntries(incomingBody ?? '')) {
    entriesByKey.set(entry.key, entry);
  }
  const entries = [...entriesByKey.values()].sort((left, right) =>
    left.time === right.time ? left.line.localeCompare(right.line) : left.time.localeCompare(right.time),
  );
  return entries.length ? renderActivityEntries(entries) : null;
}

function parseActivityEntries(content) {
  const entries = [];
  let pendingFingerprint = null;

  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const fingerprint = line.match(/^<!-- telegram-fingerprint: ([^ ]+) -->$/)?.[1] ?? null;
    if (fingerprint) {
      pendingFingerprint = fingerprint.startsWith('a-') ? line : null;
      continue;
    }

    const activityMatch = line.match(/^- (\d{2}:\d{2})\s+([^：]+)：(.+)$/);
    if (!activityMatch) {
      pendingFingerprint = null;
      continue;
    }

    const [, time, type, detail] = activityMatch;
    const normalizedType = normalizeActivityType(type);
    entries.push({
      key: `activity:${time}|${normalizedType}`,
      time,
      line: `- ${time} ${normalizedType}：${detail.trim()}`,
      fingerprint: pendingFingerprint,
    });
    pendingFingerprint = null;
  }

  return entries;
}

function renderActivityEntries(entries) {
  const lines = [];
  for (const entry of entries) {
    if (entry.fingerprint) {
      lines.push(entry.fingerprint);
    }
    lines.push(entry.line);
  }
  return lines.join('\n');
}

function buildInboxEntry({ batch, recognitions, analyzed }) {
  return {
    kind: batch.kind ?? 'image',
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
      photoFileNames: message.photos.map((photo) => photo.fileName).filter(Boolean),
    })),
    recognitions,
  };
}

function parseThoughtCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(/^(\/(?:thought|随想)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u);
  if (!match) {
    return null;
  }

  return buildThoughtCommandPayload(match[1], match[2]);
}

function analyzeThoughtMoveBatch(batch) {
  const message = batch.messages?.[0] ?? null;
  const targetMessageId = normalizeMessageId(batch.thoughtMove?.targetMessageId);
  const thoughtModule = normalizeThoughtModuleOrNull(batch.thoughtMove?.thoughtModule);

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
    archivedDate: null,
    warnings: [],
    issues: [],
    confidence: 1,
    thoughtMove: {
      command: batch.thoughtMove?.command ?? '/移动',
      targetMessageId,
      thoughtModule,
      tags: getThoughtModuleTags(thoughtModule),
      telegramChatId: message?.chatId ?? null,
      messageDateUnix: message?.dateUnix ?? null,
    },
  };
}

function parseThoughtEditCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(
    /^(\/(?:thought-edit|thoughtedit|edit-thought|编随想|随想编)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u,
  );
  if (!match) {
    return null;
  }

  const rawBody = match[2].trim();
  const bodyMatch = rawBody.match(/^(\d+)\s+([\s\S]+)$/u);
  if (!bodyMatch) {
    return null;
  }

  const parsedBody = parseThoughtModuleBody(bodyMatch[2]);
  return {
    command: match[1],
    targetMessageId: Number(bodyMatch[1]),
    body: parsedBody.body,
    moduleKey: parsedBody.moduleKey,
    moduleExplicit: parsedBody.moduleExplicit,
  };
}

function extractEditedThoughtBody(message) {
  const parsedThought = parseThoughtCommand(message.text) ?? parseThoughtCommand(message.caption);
  if (parsedThought) {
    return {
      body: parsedThought.body,
      moduleKey: parsedThought.moduleKey,
      moduleExplicit: parsedThought.moduleExplicit,
    };
  }
  return parseThoughtModuleBody(message.text?.trim() || message.caption?.trim() || '');
}

function parseThoughtDeleteCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(
    /^(\/(?:thought-delete|thoughtdel|delete-thought|删随想|随想删)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u,
  );
  if (!match) {
    return null;
  }

  const requestedTargetText = match[2].trim();
  const idMatch = requestedTargetText.match(/^(\d+)\b/);

  return {
    command: match[1],
    requestedTargetText,
    targetMessageId: idMatch ? Number(idMatch[1]) : null,
  };
}

function buildThoughtMessageKey(chatId, messageId) {
  return `${chatId ?? ''}:${messageId ?? ''}`;
}

function normalizeMessageId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseThoughtMoveCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(
    /^(\/(?:move|移动|thought|随想)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u,
  );
  if (!match) {
    return null;
  }

  const command = match[1];
  const requestedTargetText = match[2].trim();
  const idAndModuleMatch = requestedTargetText.match(/^(\d+)\s+(\S+)$/u);
  if (idAndModuleMatch) {
    const thoughtModule = resolveThoughtModuleLabel(idAndModuleMatch[2]);
    return thoughtModule
      ? {
          command,
          requestedTargetText,
          targetMessageId: Number(idAndModuleMatch[1]),
          thoughtModule,
        }
      : null;
  }

  if (/^\/(?:thought|随想)(?:@[A-Za-z0-9_]+)?$/u.test(command)) {
    return null;
  }

  const thoughtModule = resolveThoughtModuleLabel(requestedTargetText);
  if (!thoughtModule) {
    return null;
  }

  return {
    command,
    requestedTargetText,
    targetMessageId: null,
    thoughtModule,
  };
}

function buildThoughtCommandPayload(command, rawBody) {
  const parsedBody = parseThoughtModuleBody(rawBody);
  return {
    command,
    body: parsedBody.body,
    moduleKey: parsedBody.moduleKey,
    moduleExplicit: parsedBody.moduleExplicit,
  };
}

function parseThoughtModuleBody(rawBody) {
  const body = String(rawBody ?? '').trim();
  const match = body.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return {
      moduleKey: DEFAULT_THOUGHT_MODULE,
      moduleExplicit: false,
      body,
    };
  }

  const moduleKey = resolveThoughtModuleLabel(match[1]);
  if (!moduleKey) {
    return {
      moduleKey: DEFAULT_THOUGHT_MODULE,
      moduleExplicit: false,
      body,
    };
  }

  return {
    moduleKey,
    moduleExplicit: true,
    body: (match[2] ?? '').trim(),
  };
}

function findThoughtCommandEntry(messages) {
  for (const message of messages ?? []) {
    for (const text of [message.text, message.caption]) {
      const parsedThought = parseThoughtCommand(text);
      if (parsedThought) {
        return {
          message,
          parsedThought,
        };
      }
    }
  }
  return null;
}

function findThoughtEditCommandEntry(messages) {
  for (const message of messages ?? []) {
    for (const text of [message.text, message.caption]) {
      const parsedThoughtEdit = parseThoughtEditCommand(text);
      if (parsedThoughtEdit) {
        return {
          message,
          parsedThoughtEdit,
        };
      }
    }
  }
  return null;
}

function parseAnalysisCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(/^(\/(?:analysis|分析)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u);
  if (!match) {
    return null;
  }

  return {
    command: match[1],
    question: match[2].trim(),
  };
}

function parseAiAgentCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmedStart = text.trimStart();
  const match = trimmedStart.match(/^(\/(?:ai|智能助手)(?:@[A-Za-z0-9_]+)?)(?=$|\s)([\s\S]*)$/u);
  if (!match) {
    return null;
  }

  return {
    command: match[1],
    question: match[2].trim(),
  };
}

function parseHelpCommand(text) {
  if (!isTelegramHelpText(text)) {
    return null;
  }

  return {
    command: String(text).trim(),
  };
}

function fingerprintComment(value) {
  return `<!-- telegram-fingerprint: ${value} -->`;
}

function extractDateFromText(text, options = {}) {
  if (!text) {
    return null;
  }

  const messageYear = options.messageYear;
  const normalized = text.replace(/[./_年]/g, '-').replace(/[月]/g, '-').replace(/[日]/g, '');
  const directMatch = normalized.match(/(?:^|[^\d])(\d{4})-(\d{1,2})-(\d{1,2})(?=$|[^\d])/);
  if (directMatch) {
    return normalizeDateParts({
      year: Number(directMatch[1]),
      month: Number(directMatch[2]),
      day: Number(directMatch[3]),
      messageYear,
      reasonableYear: options.reasonableYear,
    });
  }

  if (options.allowCompact) {
    const compactMatch = text.match(/(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?=$|[^\d])/);
    if (compactMatch) {
      return normalizeDateParts({
        year: Number(compactMatch[1]),
        month: Number(compactMatch[2]),
        day: Number(compactMatch[3]),
        messageYear,
        reasonableYear: options.reasonableYear,
      });
    }
  }

  if (options.allowMonthDay) {
    const monthDay = parseMonthDay(text);
    if (Number.isInteger(messageYear) && monthDay) {
      return normalizeDateParts({
        year: messageYear,
        month: monthDay.month,
        day: monthDay.day,
        messageYear,
        reasonableYear: false,
      });
    }
  }

  return null;
}

function normalizeDateParts({
  year,
  month,
  day,
  messageYear,
  reasonableYear = false,
}) {
  if (!isValidDateParts(year, month, day)) {
    return null;
  }
  if (reasonableYear && Number.isInteger(messageYear) && !isReasonableYear(year, messageYear)) {
    return null;
  }
  return formatDateParts(year, month, day);
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
  const monthDayMatch = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (monthDayMatch) {
    return {
      month: Number(monthDayMatch[1]),
      day: Number(monthDayMatch[2]),
    };
  }
  const isoLikeMatch = value
    .replace(/[./_年]/g, '-')
    .replace(/[月]/g, '-')
    .replace(/[日]/g, '')
    .match(/(?:^|[^\d])\d{4}-(\d{1,2})-(\d{1,2})(?=$|[^\d])/);
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

function isValidDateParts(year, month, day) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function dateFromUnix(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) {
    return {
      year: null,
      month: null,
      day: null,
    };
  }

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
