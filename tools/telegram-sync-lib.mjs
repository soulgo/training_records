import {
  inferMealSlot,
  normalizeActivityType,
  normalizeActivityTime,
  roundTo,
  toNullableNumber,
  normalizeSleepType,
} from './training-domain.mjs';
import {
  DEFAULT_THOUGHT_MODULE,
  getThoughtModuleTags,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
  resolveThoughtModuleLabel,
} from './lib/thought-modules.mjs';
import {
  collectFilenameDates,
  normalizeRecognitionDate,
  resolveDetectedDate,
  resolveSleepArchiveDate,
} from './telegram-sync-dates.mjs';
import {
  applyTelegramSyncToMarkdown,
  extractCaloriesToken,
} from './telegram-sync-markdown.mjs';
import { createTelegramCommandResolver } from '../src/telegram/commands.mjs';
import { isTelegramHelpText } from '../src/telegram/commands.mjs';

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
    const normalizedDetectedDate = normalizeRecognitionDate(recognition, message);

    for (const warning of recognition.warnings ?? []) {
      warnings.push(warning);
    }

    const archiveDate = recognition.imageType === 'sleep'
      ? resolveSleepArchiveDate(recognition.records?.sleep, normalizedDetectedDate, message)
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
      sourceImageCount,
      recognizedImageCount,
      failedImageCount: failedMessageIds.length,
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
      failedImageCount: failedMessageIds.length,
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
      failedImageCount: failedMessageIds.length,
    });
  }

  const measurement = normalizeMeasurementForArchive(measurementCandidates.at(-1) ?? null, archivedDate);
  const normalizedActivities = normalizeActivities(activities);
  const normalizedNutrition = normalizeNutrition(nutritionMeals, nutritionTotalCalories, nutritionDetails);
  const normalizedSleep = normalizeSleepRecords(sleepRecords, archivedDate);

  return {
    status: 'ready',
    batchId: batch.batchId,
    archivedDate,
    measurement,
    activities: normalizedActivities,
    workoutDailySummary: normalizeWorkoutDailySummary(workoutDailySummary),
    nutrition: normalizedNutrition,
    sleep: normalizedSleep,
    warnings,
    issues,
    dateSources,
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

function batchLikelyLostOriginalFilename(batch) {
  return (batch.messages ?? []).some((message) =>
    (message.photos ?? []).some((photo) => photo.source === 'photo' && !photo.fileName),
  );
}

function buildSkippedBatchResult(batch, {
  reason,
  warnings = [],
  issues = [],
  dateSources = [],
  sourceImageCount = 0,
  recognizedImageCount = 0,
  failedImageCount = 0,
  failureCategory = null,
}) {
  return {
    status: 'skipped',
    kind: batch.kind ?? 'image',
    batchId: batch.batchId,
    reason,
    failureCategory,
    failureReason: failureCategory ? reason : null,
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

function normalizeSleepRecords(records, archivedDate) {
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
  return {
    records: normalized,
    totalSleepMinutes: latest.totalSleepMinutes ?? sum('totalSleepMinutes'),
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
function normalizeSleepRecord(record, archivedDate) {
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
    totalSleepMinutes: record.totalSleepMinutes ?? null,
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

function normalizeClockTime(value) {
  if (!value) {
    return null;
  }
  return String(value).match(/(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/)?.slice(1).map((part, index) =>
    index === 0 ? String(Number(part)).padStart(2, '0') : part
  ).join(':') ?? String(value);
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

function parseHelpCommand(text) {
  if (!isTelegramHelpText(text)) {
    return null;
  }

  return {
    command: String(text).trim(),
  };
}
