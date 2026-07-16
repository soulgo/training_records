export const RECOGNITION_COMPLETENESS_VERSION = 'v1';

const CONDITIONAL_FIELD_RULES = [
  {
    imageType: 'measurement',
    path: 'records.measurement.bodyFatPct',
    aliases: ['体脂率', 'Body Fat Percentage'],
  },
  {
    imageType: 'workout',
    path: 'records.workout.calories',
    aliases: ['活动热量', '活动消耗', '运动消耗', 'Active Energy', 'Active Calories', 'Move'],
  },
  {
    imageType: 'nutrition',
    path: 'records.totalCalories',
    aliases: ['总热量', '总摄入', '已摄入', 'Dietary Energy'],
  },
  {
    imageType: 'sleep',
    path: 'records.sleep.sleepScore',
    aliases: ['睡眠评分', 'Sleep Score'],
  },
];

export function evaluateRecognitionCompleteness({
  recognition,
  ocrDocument = null,
  appProfiles = null,
} = {}) {
  const imageType = recognition?.imageType ?? 'unknown';
  const missingFields = [];
  const conditionalFields = [];
  const reviewFields = normalizeReviewFields(recognition?.semanticGate?.decisions);
  const evidenceCodes = [];

  if (imageType === 'unknown') {
    return buildResult({
      status: 'complete',
      imageType,
      missingFields,
      conditionalFields,
      reviewFields: [],
      evidenceCodes: ['unknown_type'],
      requiresFallback: false,
    });
  }

  evaluateHardContract(recognition, missingFields, evidenceCodes);
  evaluateConditionalContract({
    recognition,
    ocrDocument,
    conditionalFields,
    evidenceCodes,
  });

  const allMissing = unique([...missingFields, ...conditionalFields]);
  const status = reviewFields.length > 0
    ? 'needs_review'
    : allMissing.length > 0 ? 'incomplete' : 'complete';

  return buildResult({
    status,
    imageType,
    missingFields,
    conditionalFields,
    reviewFields,
    evidenceCodes,
    requiresFallback: status !== 'complete',
  });
}

function evaluateHardContract(recognition, missingFields, evidenceCodes) {
  const records = recognition?.records ?? {};
  switch (recognition?.imageType) {
    case 'measurement': {
      if (!isPlainObject(records.measurement)) {
        missingFields.push('records.measurement');
      } else if (!isPositiveFiniteNumber(records.measurement.weightKg)) {
        missingFields.push('records.measurement.weightKg');
      }
      break;
    }
    case 'workout': {
      const activities = validActivities(records.activities);
      const summaryCalories = records.dailyWorkoutSummary?.activityCaloriesKcal;
      if (activities.length === 0 && !isPositiveFiniteNumber(summaryCalories)) {
        missingFields.push('records.activities');
        missingFields.push('records.dailyWorkoutSummary.activityCaloriesKcal');
      }
      break;
    }
    case 'nutrition': {
      if (!isPositiveFiniteNumber(records.totalCalories) && deterministicMealTotal(records.meals) === null) {
        missingFields.push('records.totalCalories');
      } else if (!isPositiveFiniteNumber(records.totalCalories)) {
        evidenceCodes.push('derived:records.totalCalories:meal_sum');
      }
      break;
    }
    case 'sleep': {
      if (!isPlainObject(records.sleep)) {
        missingFields.push('records.sleep');
      } else if (!isPositiveFiniteNumber(records.sleep.totalSleepMinutes) && !isPositiveFiniteNumber(records.sleep.nightSleepMinutes)) {
        missingFields.push('records.sleep.duration');
      }
      break;
    }
    default:
      break;
  }
}

function evaluateConditionalContract({
  recognition,
  ocrDocument,
  conditionalFields,
  evidenceCodes,
}) {
  const evidenceText = buildEvidenceText({ ocrDocument });
  for (const rule of CONDITIONAL_FIELD_RULES) {
    if (rule.imageType !== recognition?.imageType || !matchesAlias(evidenceText.ocr, rule.aliases)) {
      continue;
    }
    if (!hasConditionalValue(recognition, rule.path)) {
      conditionalFields.push(rule.path);
      evidenceCodes.push(`ocr:${rule.path}`);
    }
  }
}

function buildEvidenceText({ ocrDocument }) {
  return {
    ocr: [ocrDocument?.text, ...(ocrDocument?.blocks ?? []).map((block) => block?.text)]
      .filter(Boolean)
      .join('\n'),
  };
}

function hasConditionalValue(recognition, path) {
  if (path === 'records.workout.calories') {
    return isPositiveFiniteNumber(recognition?.records?.dailyWorkoutSummary?.activityCaloriesKcal)
      || validActivities(recognition?.records?.activities).some((activity) => isPositiveFiniteNumber(activity.calories));
  }
  if (path === 'records.sleep.sleepScore') {
    return isFiniteNumber(readPath(recognition, path));
  }
  return isPositiveFiniteNumber(readPath(recognition, path));
}

function validActivities(value) {
  return Array.isArray(value)
    ? value.filter((activity) => nonEmptyString(activity?.time)
      && nonEmptyString(activity?.type)
      && nonEmptyString(activity?.detail))
    : [];
}

function deterministicMealTotal(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const meals = value.filter((meal) => nonEmptyString(meal?.name));
  if (meals.length === 0 || meals.some((meal) => !isPositiveFiniteNumber(meal.calories))) return null;
  return meals.reduce((sum, meal) => sum + meal.calories, 0);
}

function normalizeReviewFields(decisions) {
  if (!Array.isArray(decisions)) return [];
  return unique(decisions
    .filter((decision) => decision?.action === 'review')
    .map((decision) => normalizeSemanticPath(decision?.path))
    .filter(Boolean));
}

function normalizeSemanticPath(path) {
  const normalized = String(path ?? '').trim();
  if (!normalized) return null;
  return normalized.startsWith('records.') ? normalized : `records.${normalized}`;
}

function buildResult({
  status,
  imageType,
  missingFields,
  conditionalFields,
  reviewFields,
  evidenceCodes,
  requiresFallback,
}) {
  return {
    status,
    version: RECOGNITION_COMPLETENESS_VERSION,
    imageType,
    missingFields: unique(missingFields),
    conditionalFields: unique(conditionalFields),
    reviewFields: unique(reviewFields),
    evidenceCodes: unique(evidenceCodes),
    requiresFallback,
  };
}

function readPath(value, path) {
  return String(path).split('.').reduce((current, part) => current?.[part], value);
}

function matchesAlias(text, aliases) {
  const normalizedText = normalizeText(text);
  return Array.isArray(aliases) && aliases.some((alias) => matchesNormalizedAlias(normalizedText, normalizeText(alias)));
}

function matchesNormalizedAlias(text, alias) {
  if (!text || !alias) return false;
  if (!/^[a-z0-9 ]+$/u.test(alias)) {
    return text.includes(alias);
  }
  const pattern = alias
    .split(' ')
    .filter(Boolean)
    .map(escapeRegExp)
    .join('\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, 'u').test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values)];
}
