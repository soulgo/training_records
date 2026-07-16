import {
  AiProviderError,
  AiSchemaError,
  validateAiJsonValue,
} from '../../core/ai/schema-validator.mjs';
import { buildRecognitionSchema } from '../../core/ai/telegram-recognition-schema.mjs';
import { applyRecognitionSemanticGate } from '../../core/ai/recognition-semantic-validator.mjs';

export async function parseAiResponsePayload(response, { schemaName, schemaVersion }) {
  if (typeof response.text === 'function') {
    const body = await response.text();
    const payload = parseAiJsonContentToValue(body, { schemaName, schemaVersion });
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return {
        ...payload,
        __aiResponseContentType: response.headers?.get?.('content-type') ?? null,
      };
    }
    return payload;
  }

  return response.json();
}

export function parseRecognitionContent(content, { schemaName, schemaVersion }) {
  const value = parseAiJsonContentToValue(content, { schemaName, schemaVersion });
  const normalized = normalizeRecognitionPayload(value);

  validateAiJsonValue(normalized, buildRecognitionSchema(), {
    schemaName,
    schemaVersion,
    allowAdditionalProperties: true,
  });

  return applyRecognitionSemanticGate(normalized);
}

function parseAiJsonContentToValue(content, { schemaName, schemaVersion }) {
  const normalizedContent = typeof content === 'string' ? content.trim() : content;

  if (normalizedContent === '' || normalizedContent === null || normalizedContent === undefined) {
    throw new AiProviderError(`${schemaName} returned empty content`, {
      schemaName,
      schemaVersion,
      path: '$',
    });
  }

  if (typeof normalizedContent !== 'string') {
    return normalizedContent;
  }

  const candidates = collectJsonCandidates(normalizedContent);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const error = new AiSchemaError(`${schemaName} returned invalid JSON`, {
    cause: lastError,
    schemaName,
    schemaVersion,
    path: '$',
  });
  error.summary = buildSafeAiContentSummary({
    content: normalizedContent,
    contentType: null,
    parseStage: 'json_parse',
  });
  throw error;
}

function collectJsonCandidates(content) {
  const trimmed = String(content ?? '').trim();
  const candidates = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) {
    candidates.push(fenced);
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0) {
    const withoutDataPrefix = lines.map((line) => line.replace(/^data:\s*/i, '')).join('');
    if (withoutDataPrefix && withoutDataPrefix !== trimmed) {
      candidates.push(withoutDataPrefix);
    }
  }

  const jsonStart = trimmed.search(/[\[{]/);
  const jsonEnd = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    candidates.push(trimmed.slice(jsonStart, jsonEnd + 1).trim());
  }

  candidates.push(...extractBalancedJsonCandidates(trimmed));

  return [...new Set(candidates.filter(Boolean))];
}

function extractBalancedJsonCandidates(content) {
  const candidates = [];
  const text = String(content ?? '');

  for (let index = 0; index < text.length; index += 1) {
    const startChar = text[index];
    if (startChar !== '{' && startChar !== '[') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let cursor = index; cursor < text.length; cursor += 1) {
      const char = text[cursor];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        depth += 1;
        continue;
      }

      if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(index, cursor + 1).trim());
          break;
        }
      }
    }
  }

  return candidates;
}

function normalizeRecognitionPayload(value) {
  if (!isPlainObject(value)) {
    return value;
  }

  const records = isPlainObject(value.records) ? value.records : {};
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  const missingMeasurementData = value.imageType === 'measurement' && !isPlainObject(records.measurement);
  return {
    ...value,
    detectedApp: value.detectedApp ?? null,
    confidence: missingMeasurementData
      ? Math.min(Number.isFinite(value.confidence) ? value.confidence : 0, 0.5)
      : value.confidence,
    warnings: missingMeasurementData
      ? [...warnings, 'measurement image missing measurement data']
      : warnings,
    records: {
      measurement: records.measurement ?? null,
      activities: normalizeRecognitionActivities(records.activities),
      meals: normalizeRecognitionMeals(records.meals),
      totalCalories: normalizeRecognitionNumber(records.totalCalories),
      details: normalizeRecognitionDetails(records.details),
      dailyWorkoutSummary: records.dailyWorkoutSummary ?? null,
      sleep: normalizeRecognitionSleep(records.sleep ?? null),
    },
  };
}

function normalizeRecognitionMeals(meals) {
  if (!Array.isArray(meals)) {
    return [];
  }

  return meals
    .map((meal) => {
      if (!isPlainObject(meal)) {
        return null;
      }
      const calories = normalizeRecognitionNumber(meal.calories);
      if (calories === null) {
        return null;
      }
      return {
        name: String(meal.name ?? '').trim() || '未命名餐次',
        calories,
        recommendedMin: normalizeRecognitionNumber(meal.recommendedMin),
        recommendedMax: normalizeRecognitionNumber(meal.recommendedMax),
      };
    })
    .filter(Boolean);
}

function normalizeRecognitionActivities(activities) {
  if (!Array.isArray(activities)) {
    return [];
  }
  return activities
    .filter(isPlainObject)
    .map((activity) => ({
      ...activity,
      durationSeconds: normalizeRecognitionNumber(activity.durationSeconds),
      calories: normalizeRecognitionNumber(activity.calories),
      heartRate: normalizeRecognitionNumber(activity.heartRate),
      distanceKm: normalizeRecognitionNumber(activity.distanceKm),
      avgSpeedKmh: normalizeRecognitionNumber(activity.avgSpeedKmh),
    }));
}

function normalizeRecognitionNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '');
    if (!normalized) {
      return null;
    }
    const exact = Number(normalized);
    if (Number.isFinite(exact)) {
      return exact;
    }
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const extracted = Number(match[0]);
      return Number.isFinite(extracted) ? extracted : null;
    }
  }
  return null;
}

function normalizeRecognitionDetails(details) {
  if (Array.isArray(details)) {
    return details;
  }

  if (details === null || details === undefined) {
    return [];
  }

  if (typeof details === 'string') {
    const trimmed = details.trim();
    return trimmed ? [trimmed] : [];
  }

  if (isPlainObject(details)) {
    return Object.values(details)
      .flatMap((item) => normalizeRecognitionDetails(item))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return details;
}

function normalizeRecognitionSleep(sleep) {
  if (sleep === null || sleep === undefined) {
    return null;
  }

  if (!isPlainObject(sleep)) {
    return sleep;
  }

  const nullableFields = [
    'sleepType',
    'bedtime',
    'wakeTime',
    'nightSleepMinutes',
    'totalSleepMinutes',
    'napMinutes',
    'deepSleepMinutes',
    'lightSleepMinutes',
    'remSleepMinutes',
    'awakeMinutes',
    'sleepStageText',
    'sleepScore',
    'sleepScorePercentile',
    'deepSleepRatioPct',
    'lightSleepRatioPct',
    'remSleepRatioPct',
    'deepSleepContinuityScore',
    'wakeCount',
    'breathingQualityScore',
    'averageHeartRateBpm',
    'hrvMs',
    'averageSpo2Pct',
    'averageRespiratoryRate',
    'analysisText',
    'suggestionText',
  ];
  const normalized = Object.fromEntries(nullableFields.map((field) => [field, sleep[field] ?? null]));

  return {
    ...normalized,
    sleepStageDetail: normalizeRecognitionDetails(sleep.sleepStageDetail),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function summarizeRecognitionFailure(response) {
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().includes('application/json')) {
      const payload = await response.json();
      const message =
        payload?.error?.message ??
        payload?.message ??
        payload?.detail ??
        payload?.details ??
        null;
      return summarizeErrorText(message);
    }

    return summarizeErrorText(await response.text());
  } catch {
    return null;
  }
}

function summarizeErrorText(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return null;
  }
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function buildSafeAiContentSummary({ content, contentType, parseStage }) {
  return {
    contentType: String(contentType ?? '').split(';', 1)[0].trim() || null,
    parseStage,
    snippet: summarizeAiContentSnippet(content),
  };
}

export function logRecognitionParseFailure(error, { schemaName, schemaVersion, contentType }) {
  const summary = error?.summary ?? null;
  const payload = {
    schemaName,
    schemaVersion,
    contentType: String(contentType ?? '').split(';', 1)[0].trim() || null,
    message: error instanceof Error ? error.message : String(error),
    summary,
  };
  process.stderr.write(`[telegram-sync] recognition parse failure: ${JSON.stringify(payload)}\n`);
}

export function summarizeAiContentSnippet(content) {
  const text = String(content ?? '')
    .replace(/https:\/\/api\.telegram\.org\/file\/bot[^\s"'<>]+/gi, '[telegram-file-url]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
