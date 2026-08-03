export function normalizeRecognitionDate(recognition, message) {
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

  const warningDate = normalizeRecognitionWarningDate(recognition, messageDate.year);
  if (warningDate) {
    return warningDate;
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

function normalizeRecognitionWarningDate(recognition, messageYear) {
  if (!Array.isArray(recognition.warnings) || !Number.isInteger(messageYear)) {
    return null;
  }

  const dates = new Set();
  for (const warning of recognition.warnings) {
    const text = String(warning ?? '').trim();
    if (!shouldParseWarningDate(text)) {
      continue;
    }
    const date = normalizeDetectedDateValue(text, messageYear);
    if (date) {
      dates.add(date);
    }
  }

  return dates.size === 1 ? [...dates][0] : null;
}

function shouldParseWarningDate(text) {
  if (!text) {
    return false;
  }

  if (/conflict|conflicting|ambiguous|multiple dates|多个.*日期|多日期|日期冲突|无法确定/.test(text)) {
    return false;
  }

  const imageEvidence = /\b(?:image|screenshot|ocr|header|screen)\b/i.test(text) || /截图|画面|图片/.test(text);
  if (!imageEvidence) {
    return false;
  }

  return shouldParseDateEvidence(text);
}

export function collectFilenameDates(batch) {
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

export function resolveDetectedDate(detectedDates) {
  if (detectedDates.size === 1) {
    return [...detectedDates][0];
  }
  return null;
}

export function resolveSleepArchiveDate(sleep, detectedDate, message, options = {}) {
  const messageYear = dateFromUnix(message?.dateUnix).year;

  const bedtimeDate = extractSleepTimeDate(sleep?.bedtime, messageYear);
  if (bedtimeDate) {
    return bedtimeDate;
  }

  const evidenceSleepStartDate = extractSleepStartDateFromEvidence(options.dateEvidence, messageYear);
  if (evidenceSleepStartDate) {
    return evidenceSleepStartDate;
  }

  const wakeDate = extractSleepTimeDate(sleep?.wakeTime, messageYear);
  if (wakeDate) {
    return shiftDateByDays(wakeDate, -1);
  }

  if (detectedDate && dateEvidenceUsesSleepStartDate(options.dateEvidence)) {
    return detectedDate;
  }
  if (detectedDate) {
    return shiftDateByDays(detectedDate, -1);
  }

  return null;
}

function extractSleepStartDateFromEvidence(dateEvidence, messageYear) {
  const text = String(dateEvidence ?? '').trim();
  if (!text || !Number.isInteger(messageYear)) {
    return null;
  }

  const dateToken = String.raw`(?:\d{4}\s*[-/.年]\s*)?\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?`;
  const patterns = [
    new RegExp(`(${dateToken})\\s*(?:入睡|bedtime|sleep\\s+start)`, 'i'),
    new RegExp(`(?:入睡日期?|bedtime(?:\\s+date)?|sleep\\s+start(?:\\s+date)?)[^\\d]{0,8}(${dateToken})`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const date = extractDateFromText(match?.[1], {
      allowMonthDay: true,
      messageYear,
    });
    if (date) {
      return date;
    }
  }
  return null;
}

function extractSleepTimeDate(value, messageYear) {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }

  const date = extractDateFromText(text, {
    allowMonthDay: true,
    messageYear,
  });
  if (date) {
    return date;
  }

  const slashMonthDay = text.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?=$|[^\d])/);
  if (!slashMonthDay || !Number.isInteger(messageYear)) {
    return null;
  }
  return normalizeDateParts({
    year: messageYear,
    month: Number(slashMonthDay[1]),
    day: Number(slashMonthDay[2]),
    messageYear,
  });
}

function dateEvidenceUsesSleepStartDate(dateEvidence) {
  const text = String(dateEvidence ?? '');
  if (!text.trim()) {
    return false;
  }
  return /(?:sleep|睡眠).*(?:start|bedtime|入睡|开始)|(?:start|bedtime|入睡).*(?:date|日期)|using visible sleep start date/i.test(text);
}

export function shiftDateByDays(dateString, offsetDays) {
  const match = String(dateString ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return dateString ?? null;
  }

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
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
  const slashMonthDayMatch = value.match(/(?:^|[^\d])(\d{1,2})\s*\/\s*(\d{1,2})(?=$|[^\d])/);
  if (slashMonthDayMatch) {
    return {
      month: Number(slashMonthDayMatch[1]),
      day: Number(slashMonthDayMatch[2]),
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

  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(unixSeconds * 1000));
  const partMap = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  return {
    year: Number(partMap.year),
    month: Number(partMap.month),
    day: Number(partMap.day),
  };
}

function formatDateParts(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
