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

export function resolveSleepArchiveDate(sleep, detectedDate, message) {
  const messageYear = dateFromUnix(message?.dateUnix).year;
  const wakeTime = String(sleep?.wakeTime ?? '').trim();

  const wakeDate = extractDateFromText(wakeTime, {
    allowMonthDay: true,
    messageYear,
  });
  if (wakeDate) {
    return shiftDateByDays(wakeDate, -1);
  }

  const slashMonthDay = wakeTime.match(/(\d{1,2})\/(\d{1,2})/);
  if (slashMonthDay && Number.isInteger(messageYear)) {
    return shiftDateByDays(
      normalizeDateParts({
        year: messageYear,
        month: Number(slashMonthDay[1]),
        day: Number(slashMonthDay[2]),
        messageYear,
      }),
      -1,
    );
  }

  if (detectedDate) {
    return shiftDateByDays(detectedDate, -1);
  }

  return null;
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
