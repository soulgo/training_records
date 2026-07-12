const DAY_MS = 86_400_000;
const MAX_YEAR_DERIVATION_DISTANCE_DAYS = 183;

export function alignObservationDates({ observations, messageSentAt, filename = null }) {
  const sentAt = toValidDate(messageSentAt);
  const aligned = (observations ?? []).map((observation) => alignObservation({ observation, sentAt, filename }));
  return applyBatchAnchor(aligned, sentAt);
}

function applyBatchAnchor(aligned, defaultSentAt) {
  const acceptedDates = [...new Set(aligned
    .filter((item) => item.status === 'accepted' && item.archivedDate && (item.dateConfidence ?? 0) >= 0.8)
    .map((item) => item.archivedDate))];
  if (acceptedDates.length !== 1) return aligned;
  const anchor = aligned.find((item) => item.archivedDate === acceptedDates[0] && (item.dateConfidence ?? 0) >= 0.8);
  const anchorSentAt = toValidDate(anchor?.sourceMessageSentAt) ?? defaultSentAt;
  return aligned.map((item) => {
    if (item.status !== 'needs_review' || !isCompatibleAnchor(anchor, item)) return item;
    const itemSentAt = toValidDate(item.sourceMessageSentAt) ?? defaultSentAt;
    if (!anchorSentAt || !itemSentAt || Math.abs(itemSentAt.getTime() - anchorSentAt.getTime()) > 10 * 60 * 1000) {
      return item;
    }
    return resolved(item, anchor.archivedDate, 'derived_batch_anchor', Math.min(0.8, anchor.dateConfidence));
  });
}

function isCompatibleAnchor(anchor, item) {
  return !anchor?.sourceApp || !item?.sourceApp || anchor.sourceApp === item.sourceApp;
}

function alignObservation({ observation, sentAt, filename }) {
  const evidence = observation?.dateEvidence ?? {};
  const observedDate = normalizeDateKey(observation?.observedDate);

  if (observation?.recordType === 'sleep' && observedDate && hasWakeOnlyDate(observation.fields)) {
    return resolved(observation, shiftDate(observedDate, -1), 'derived_sleep_start', 0.9);
  }
  if (evidence.source === 'visible_full_date' && observedDate) {
    return resolved(observation, observedDate, 'exact_image', observation.confidence);
  }
  if (evidence.source === 'visible_month_day' && sentAt) {
    const derivedDate = deriveClosestMonthDay(evidence.rawText, sentAt);
    if (derivedDate) {
      return resolved(observation, derivedDate, 'derived_message_year', Math.min(0.9, observation.confidence ?? 0.9));
    }
  }
  if (evidence.source === 'visible_filename') {
    const filenameDate = extractFilenameDate(filename);
    if (filenameDate) {
      return resolved(observation, filenameDate, 'filename_fallback', Math.min(0.7, observation.confidence ?? 0.7));
    }
  }
  return {
    ...observation,
    archivedDate: null,
    dateResolution: 'unresolved',
    dateConfidence: null,
    status: 'needs_review',
  };
}

function resolved(observation, archivedDate, dateResolution, dateConfidence) {
  return {
    ...observation,
    archivedDate,
    dateResolution,
    dateConfidence: clampConfidence(dateConfidence),
    status: 'accepted',
  };
}

function deriveClosestMonthDay(rawText, sentAt) {
  const match = String(rawText ?? '').match(/(?:^|\D)(\d{1,2})[\/-](\d{1,2})(?:\D|$)/u);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const sentYear = sentAt.getUTCFullYear();
  const candidates = [sentYear - 1, sentYear, sentYear + 1]
    .map((year) => buildDateKey(year, month, day))
    .filter(Boolean)
    .map((date) => ({ date, distance: Math.abs(Date.parse(`${date}T00:00:00.000Z`) - sentAt.getTime()) / DAY_MS }))
    .filter(({ distance }) => distance <= MAX_YEAR_DERIVATION_DISTANCE_DAYS)
    .sort((left, right) => left.distance - right.distance || left.date.localeCompare(right.date));
  return candidates[0]?.date ?? null;
}

function extractFilenameDate(filename) {
  const match = String(filename ?? '').match(/(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?:\D|$)/u);
  return match ? buildDateKey(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function hasWakeOnlyDate(fields) {
  return Boolean(fields?.wakeTime) && !fields?.bedtime;
}

function shiftDate(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildDateKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function normalizeDateKey(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  return match ? buildDateKey(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function toValidDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : null;
}
