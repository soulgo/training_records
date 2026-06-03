const DATE_HEADING_RE = /^### (\d{4}-\d{2}-\d{2})\s*$/gm;
const LEVEL4_HEADING_RE = /^#### (.+)$/gm;

export function splitDateSections(markdown) {
  const matches = [...markdown.matchAll(DATE_HEADING_RE)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : markdown.length;
    return {
      date: match[1],
      body: markdown.slice(start, end).trim(),
    };
  });
}

export function splitLevel4Blocks(content) {
  const matches = [...content.matchAll(LEVEL4_HEADING_RE)];
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

export function extractSubBlock(content, heading) {
  const start = content.indexOf(heading);
  if (start === -1) {
    return null;
  }
  const bodyStart = start + heading.length;
  const remainder = content.slice(bodyStart);
  const nextHeadingOffset = remainder.search(/\n##### /);
  const body = nextHeadingOffset === -1 ? remainder : remainder.slice(0, nextHeadingOffset);
  return body.trim();
}

export function emptyNutrition() {
  return {
    meals: [],
    totalCalories: null,
    details: [],
  };
}

export function emptySleep() {
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
  };
}

export function inferMealSlot(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (/^(早餐|午餐|晚餐|加餐)$/.test(trimmed)) {
    return trimmed;
  }

  const parenthetical = trimmed.match(/[（(]([^）)]+)[）)]/);
  if (parenthetical) {
    const fromParentheses = parenthetical[1].match(/早餐|午餐|晚餐|加餐/)?.[0];
    if (fromParentheses) {
      return fromParentheses;
    }
  }

  const mealType = trimmed.match(/早餐|午餐|晚餐|加餐/)?.[0];
  if (mealType) {
    return mealType;
  }

  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }

  return null;
}

export function normalizeNutritionTotalLabel(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^(?:当日截图内已记录|当日已记录|已记录|摄入|总)?\s*总热量[:：]?\s*/i, '').trim();
}

export function normalizeActivityType(type) {
  const normalized = type?.trim();
  const aliases = {
    outdoor_cycling: '户外骑行',
    stair_climbing: '爬楼',
    traditional_strength_training: '力量训练',
    mixed_cardio: '燃脂训练',
  };
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  if (normalized === '自由训练' || normalized?.startsWith('燃脂训练')) {
    return '燃脂训练';
  }
  return normalized;
}

export function normalizeSleepType(type) {
  const normalized = type?.trim();
  if (!normalized) {
    return '夜间睡眠';
  }
  if (/午睡|小睡|nap/i.test(normalized)) {
    return '午睡';
  }
  if (/夜间|睡眠/i.test(normalized)) {
    return '夜间睡眠';
  }
  return normalized;
}

export function normalizeActivityTime(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/(\d{2}:\d{2})$/);
  return match ? match[1] : trimmed;
}

export function parseWeightKg(value) {
  if (!value) {
    return null;
  }
  const approxKg = value.match(/约\s*(\d+(?:\.\d+)?)\s*kg/i);
  if (approxKg) {
    return Number(approxKg[1]);
  }
  const kg = value.match(/(\d+(?:\.\d+)?)\s*kg/i);
  if (kg) {
    return Number(kg[1]);
  }
  const jin = value.match(/(\d+(?:\.\d+)?)\s*斤/);
  if (jin) {
    return roundTo(Number(jin[1]) * 0.5, 3);
  }
  return null;
}

export function parseNumber(value) {
  if (!value) {
    return null;
  }
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function parseDurationSeconds(value) {
  if (value.includes(':')) {
    const [hours, minutes, seconds] = value.split(':').map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  }
  const match = value.match(/(\d+)分(\d+)秒/);
  if (!match) {
    return 0;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parseFirstMatch(value, regex) {
  const match = value?.match(regex);
  return match ? Number(match[1]) : null;
}

export function parseMinutesText(value) {
  if (!value) return null;
  const match = String(value).match(/(\d+)小时(?:(\d+)分)?|(?:(\d+)分)(?:(\d+)秒)?/);
  if (!match) return null;
  if (match[1]) {
    return Number(match[1]) * 60 + Number(match[2] ?? 0);
  }
  return Number(match[3] ?? 0);
}

export function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function roundTo(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function summarizeActivities(activities, workoutDailySummary = null) {
  const countsByType = {};
  let totalDurationSeconds = 0;
  let explicitTrainingCalories = 0;
  let cyclingDistanceKm = 0;

  for (const activity of activities) {
    countsByType[activity.type] = (countsByType[activity.type] ?? 0) + 1;
    totalDurationSeconds += activity.durationSeconds ?? 0;
    if (activity.calories !== null && activity.calories !== undefined) {
      explicitTrainingCalories += activity.calories;
    }
    if (activity.distanceKm !== null && activity.distanceKm !== undefined && activity.type?.includes('骑行')) {
      cyclingDistanceKm += activity.distanceKm;
    }
  }

  return {
    totalActivities: activities.length,
    totalDurationSeconds,
    trainingCalories: roundTo(
      workoutDailySummary?.activityCaloriesKcal ?? explicitTrainingCalories,
      2,
    ),
    workoutDurationMinutes: workoutDailySummary?.workoutDurationMinutes ?? null,
    activeHours: workoutDailySummary?.activeHours ?? null,
    cyclingDistanceKm: roundTo(cyclingDistanceKm, 2),
    countsByType,
  };
}

export function summarizeSleep(sleepRecords) {
  const records = sleepRecords.filter(Boolean);
  if (!records.length) {
    return emptySleep();
  }
  const latest = records.at(-1);
  const sum = (key) => records.reduce((total, item) => total + Number(item[key] ?? 0), 0) || null;
  return {
    records,
    totalSleepMinutes: latest.totalSleepMinutes ?? sum('totalSleepMinutes'),
    nightSleepMinutes: latest.nightSleepMinutes ?? sum('nightSleepMinutes'),
    napMinutes: latest.napMinutes ?? sum('napMinutes'),
    sleepStartTime: latest.sleepStartTime ?? null,
    sleepEndTime: latest.sleepEndTime ?? null,
    deepSleepMinutes: latest.deepSleepMinutes ?? sum('deepSleepMinutes'),
    lightSleepMinutes: latest.lightSleepMinutes ?? sum('lightSleepMinutes'),
    remSleepMinutes: latest.remSleepMinutes ?? sum('remSleepMinutes'),
    awakeMinutes: latest.awakeMinutes ?? sum('awakeMinutes'),
  };
}

export function buildTrainingDay({
  date,
  measurements = [],
  activities = [],
  nutrition = emptyNutrition(),
  sleep = emptySleep(),
  workoutDailySummary = null,
}) {
  return {
    date,
    measurement: measurements.at(-1) ?? null,
    measurements,
    activities,
    sleep: sleep.records ?? [],
    sleepSummary: summarizeSleep(sleep.records ?? []),
    workoutSummary: summarizeActivities(activities, workoutDailySummary),
    nutrition: {
      meals: nutrition.meals ?? [],
      totalCalories: nutrition.totalCalories ?? null,
      details: nutrition.details ?? [],
    },
  };
}

export function buildTrainingSnapshotFromDaily(daily, generatedAt = new Date().toISOString()) {
  const measurements = daily
    .flatMap((entry) => entry.measurements ?? (entry.measurement ? [entry.measurement] : []))
    .filter(Boolean);

  const charts = {
    weightKg: measurements.map((entry) => ({ date: entry.archivedDate, value: entry.weightKg })),
    bodyFatPct: measurements.map((entry) => ({ date: entry.archivedDate, value: entry.bodyFatPct })),
    skeletalMuscleKg: measurements.map((entry) => ({
      date: entry.archivedDate,
      value: entry.skeletalMuscleKg,
    })),
    basalMetabolism: measurements.map((entry) => ({
      date: entry.archivedDate,
      value: entry.basalMetabolismKcal,
    })),
    visceralFatLevel: measurements.map((entry) => ({
      date: entry.archivedDate,
      value: entry.visceralFatLevel,
    })),
    intakeCalories: daily
      .filter((entry) => entry.nutrition.totalCalories !== null)
      .map((entry) => ({ date: entry.date, value: entry.nutrition.totalCalories })),
    trainingCalories: daily
      .filter((entry) => entry.workoutSummary.trainingCalories > 0)
      .map((entry) => ({ date: entry.date, value: entry.workoutSummary.trainingCalories })),
    cyclingDistanceKm: daily
      .filter((entry) => entry.workoutSummary.cyclingDistanceKm > 0)
      .map((entry) => ({ date: entry.date, value: entry.workoutSummary.cyclingDistanceKm })),
    sleepMinutes: daily
      .filter((entry) => entry.sleepSummary?.totalSleepMinutes !== null)
      .map((entry) => ({ date: entry.date, value: entry.sleepSummary?.totalSleepMinutes ?? null })),
  };

  return {
    generatedAt,
    latest: {
      measurement: measurements.at(-1) ?? null,
      daily: daily.at(-1) ?? null,
    },
    daily,
    charts,
  };
}
