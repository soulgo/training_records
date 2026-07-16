import { createTelegramCommandResolver } from '../../telegram/command-registry.mjs';
import {
  collectFilenameDates,
  normalizeRecognitionDate,
  resolveDetectedDate,
  resolveSleepArchiveDate,
} from './sync-dates.adapter.mjs';
import { applyTelegramSyncToMarkdown } from './sync-markdown.adapter.mjs';
import {
  buildAnalysisBatch,
  buildExplicitThoughtEditBatch,
  buildExplicitThoughtEditBatchFromMessages,
  buildHelpBatch,
  buildThoughtBatch,
  buildThoughtBatchFromMessages,
  buildThoughtDeleteBatch,
  buildThoughtEditBatch,
  buildThoughtMessageKey,
  buildThoughtMoveBatch,
  parseAnalysisCommand,
  parseHelpCommand,
  parseThoughtCommand,
  parseThoughtDeleteCommand,
  parseThoughtEditCommand,
  parseThoughtMoveCommand,
} from './sync-commands.adapter.mjs';
import {
  analyzeAnalysisBatch,
  analyzeHelpBatch,
  analyzeThoughtBatch,
  analyzeThoughtDeleteBatch,
  analyzeThoughtEditBatch,
  analyzeThoughtMoveBatch,
  batchLikelyLostOriginalFilename,
  buildDateStages,
  buildFingerprints,
  buildSkippedBatchResult,
  calculateBatchConfidence,
  classifyDateConfidence,
  mergeMeasurementCandidates,
  mergeWorkoutDailySummary,
  normalizeActivities,
  normalizeDetectedApp,
  normalizeMeasurementForArchive,
  normalizeNutrition,
  normalizeSleepRecord,
  normalizeSleepRecords,
  normalizeWorkoutDailySummary,
} from './sync-analysis.adapter.mjs';

export { applyTelegramSyncToMarkdown };

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
  const messages = [];
  for (const update of updates) {
    const message = update.message ?? update.edited_message;
    if (!message) {
      continue;
    }
    const normalized = normalizeTelegramMessage(update, message);
    normalized.updateType = update.edited_message ? 'edited_message' : 'message';
    messages.push(normalized);
  }
  return groupSourceMessages(messages, options);
}

export function groupSourceMessages(messages, options = {}) {
  const batches = [];
  const albumMap = new Map();
  const knownThoughtMessageKeys = new Set(options.knownThoughtMessageKeys ?? []);

  for (const normalized of messages ?? []) {

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
    batch.messages.sort(compareSourceMessageIdentity);
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

function compareSourceMessageIdentity(left, right) {
  const leftNumber = Number(left.messageId);
  const rightNumber = Number(right.messageId);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left.messageId ?? '').localeCompare(String(right.messageId ?? ''));
}

export function analyzeTelegramBatch(batch, recognitions, options = {}) {
  if (batch.kind === 'help') {
    return analyzeHelpBatch(batch);
  }

  if (batch.kind === 'analysis') {
    return analyzeAnalysisBatch(batch);
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
  const sleepRecords = [];
  const dateSources = [];
  const sourceImageCount = batch.messages.length;
  let recognizedImageCount = 0;
  let detectedApp = null;
  const failedMessageIds = [];
  const dataIssues = [];

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
    detectedApp ??= normalizeDetectedApp(recognition.detectedApp);
    const normalizedDetectedDate = normalizeRecognitionDate(recognition, message);

    for (const warning of recognition.warnings ?? []) {
      warnings.push(warning);
    }

    const archiveDate = recognition.imageType === 'sleep'
      ? resolveSleepArchiveDate(recognition.records?.sleep, normalizedDetectedDate, message, {
          dateEvidence: recognition.dateEvidence,
        })
      : normalizedDetectedDate;

    dateSources.push({
      messageId: message.messageId,
      detectedDate: archiveDate ?? null,
      dateEvidence: recognition.dateEvidence ?? null,
      source: archiveDate ? (archiveDate === normalizedDetectedDate ? 'image' : 'sleep_bedtime') : 'no_date',
    });

    if (recognition.imageType === 'sleep') {
      const sleepRecord = normalizeSleepRecord(recognition.records?.sleep, archiveDate);
      if (!sleepRecord) {
        const issue = `sleep image missing records.sleep for message ${message.messageId}`;
        issues.push(issue);
        dataIssues.push(issue);
        failedMessageIds.push(message.messageId);
        continue;
      }
      if (archiveDate) {
        imageDates.add(archiveDate);
      }
      sleepRecords.push(sleepRecord);
      continue;
    }

    if (archiveDate) {
      imageDates.add(archiveDate);
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

  if (
    dataIssues.length > 0 &&
    measurementCandidates.length === 0 &&
    activities.length === 0 &&
    !workoutDailySummary &&
    nutritionMeals.length === 0 &&
    nutritionTotalCalories === null &&
    nutritionDetails.length === 0 &&
    sleepRecords.length === 0
  ) {
    return buildSkippedBatchResult(batch, {
      reason: dataIssues.join('; '),
      warnings,
      issues,
      dateSources,
      detectedApp,
      sourceImageCount,
      recognizedImageCount,
      failedImageCount: failedMessageIds.length,
      failureCategory: 'ai_service',
    });
  }

  if (imageDates.size > 1) {
    return buildSkippedBatchResult(batch, {
      reason: `conflicting detected dates: ${[...imageDates].sort().join(', ')}`,
      warnings,
      issues,
      dateSources,
      detectedApp,
      sourceImageCount,
      recognizedImageCount,
      failedImageCount: failedMessageIds.length,
    });
  }

  let archivedDate = null;
  let usedFilenameDate = false;
  if (imageDates.size === 1) {
    archivedDate = resolveDetectedDate(imageDates);
    const conflictingFilenameDates = [...filenameDates].filter((date) => date !== archivedDate);
    if (conflictingFilenameDates.length > 0) {
      warnings.push(
        `Filename date(s) ${conflictingFilenameDates.sort().join(', ')} differ from image date ${archivedDate}; using image date.`,
      );
    }
  } else if (filenameDates.size > 1) {
    const dateConfidence = classifyDateConfidence({
      archivedDate: null,
      dateSources,
      warnings,
      reason: `conflicting filename dates: ${[...filenameDates].sort().join(', ')}`,
    });
    return buildSkippedBatchResult(batch, {
      reason: `conflicting filename dates: ${[...filenameDates].sort().join(', ')}`,
      warnings,
      issues,
      dateSources,
      dateStages: buildDateStages({
        archivedDate: null,
        imageDates,
        filenameDates,
        usedFilenameDate,
        dateSources,
        dateConfidence,
      }),
      detectedApp,
      sourceImageCount,
      recognizedImageCount,
      failedImageCount: failedMessageIds.length,
    });
  } else {
    archivedDate = resolveDetectedDate(filenameDates);
    if (archivedDate) {
      usedFilenameDate = true;
      warnings.push(`Using filename date ${archivedDate} for Telegram batch without image dates.`);
    }
  }

  if (!archivedDate) {
    if (filenameDates.size === 0 && batchLikelyLostOriginalFilename(batch)) {
      warnings.push(
        '该 Telegram 图片看起来是以 photo 形式发送，Bot API 通常不会保留原始文件名；若要依赖文件名日期回退，请改为以 document/文件 发送。',
      );
    }
    const reason = issues.length > 0
      ? `${issues.join('; ')}; no reliable image or filename date`
      : 'no reliable image or filename date';
    const dateConfidence = classifyDateConfidence({
      archivedDate: null,
      dateSources,
      warnings,
      reason,
    });
    return buildSkippedBatchResult(batch, {
      reason,
      warnings,
      issues,
      dateSources,
      dateStages: buildDateStages({
        archivedDate: null,
        imageDates,
        filenameDates,
        usedFilenameDate,
        dateSources,
        dateConfidence,
      }),
      detectedApp,
      sourceImageCount,
      recognizedImageCount,
      failedImageCount: failedMessageIds.length,
    });
  }

  const measurement = normalizeMeasurementForArchive(
    mergeMeasurementCandidates(measurementCandidates),
    archivedDate,
  );
  const normalizedActivities = normalizeActivities(activities);
  const normalizedNutrition = normalizeNutrition(nutritionMeals, nutritionTotalCalories, nutritionDetails);
  const normalizedSleep = normalizeSleepRecords(sleepRecords, archivedDate);
  const dateConfidence = classifyDateConfidence({
    archivedDate,
    dateSources,
    warnings,
    usedFilenameDate,
  });

  return {
    status: 'ready',
    batchId: batch.batchId,
    archivedDate,
    detectedApp,
    measurement,
    activities: normalizedActivities,
    workoutDailySummary: normalizeWorkoutDailySummary(workoutDailySummary),
    nutrition: normalizedNutrition,
    sleep: normalizedSleep,
    warnings,
    issues,
    dateSources,
    dateConfidence,
    dateStages: buildDateStages({
      archivedDate,
      imageDates,
      filenameDates,
      usedFilenameDate,
      dateSources,
      dateConfidence,
    }),
    sourceImageCount,
    recognizedImageCount,
    failedImageCount: failedMessageIds.length,
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

export async function processTelegramUpdates({
  markdown,
  updates,
  allowedChatIds,
  recognizeBatch,
  minConfidence,
  previousLastProcessedUpdateId = 0,
}) {
  const grouped = groupTelegramUpdates(updates);
  const batches = [];
  const inboxEntries = [];
  let nextMarkdown = markdown;
  let changed = false;
  let lastProcessedUpdateId = updates.reduce(
    (max, update) => Math.max(max, update.update_id ?? 0),
    previousLastProcessedUpdateId,
  );

  for (const batch of grouped) {
    const isAllowed = batch.messages.every((message) => allowedChatIds.has(message.chatId));
    if (!isAllowed) {
      batches.push({
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
    batches.push({
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
    batches,
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
  const markdownDocument = normalizeTelegramMarkdownDocument(message.document);
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
  const markdownDocuments = markdownDocument ? [markdownDocument] : [];

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
    markdownDocuments,
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

function normalizeTelegramMarkdownDocument(document) {
  if (!document?.file_id) {
    return null;
  }

  const fileName = document.file_name?.trim() || '';
  const mimeType = document.mime_type?.trim() || '';
  const normalizedMimeType = mimeType.toLowerCase().split(';')[0].trim();
  const hasMarkdownExtension = /\.(?:md|markdown)$/i.test(fileName);
  const isMarkdownMimeType = normalizedMimeType === 'text/markdown' || normalizedMimeType === 'text/x-markdown';
  const isPlainMarkdownFile = normalizedMimeType === 'text/plain' && hasMarkdownExtension;
  if (!hasMarkdownExtension && !isMarkdownMimeType && !isPlainMarkdownFile) {
    return null;
  }

  return {
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id,
    fileName: fileName || null,
    mimeType: mimeType || null,
    fileSize: document.file_size ?? null,
    source: 'document',
  };
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
      markdownFileIds: (message.markdownDocuments ?? []).map((document) => document.fileId),
      markdownFileNames: (message.markdownDocuments ?? []).map((document) => document.fileName).filter(Boolean),
    })),
    recognitions,
  };
}
