const DATE_HEADING_RE = /^### (\d{4}-\d{2}-\d{2})\s*$/gm;
const LEVEL4_HEADING_RE = /^#### (.+)$/gm;

export function parseTrainingRecord(markdown) {
  const daily = splitDateSections(markdown).map(({ date, content }) =>
    parseDateSection(date, content),
  );

  const measurements = daily
    .map((entry) => entry.measurement)
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
  };

  return {
    generatedAt: new Date().toISOString(),
    latest: {
      measurement: measurements.at(-1) ?? null,
      daily: daily.at(-1) ?? null,
    },
    daily,
    charts,
  };
}

function splitDateSections(markdown) {
  const matches = [...markdown.matchAll(DATE_HEADING_RE)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : markdown.length;
    return {
      date: match[1],
      content: markdown.slice(start, end).trim(),
    };
  });
}

function parseDateSection(date, content) {
  const blocks = splitLevel4Blocks(content);
  const measurementBlocks = blocks
    .filter((block) => block.heading.includes('体脂秤'))
    .map((block) => parseMeasurementBlock(block, date))
    .filter(Boolean);

  const activities = blocks
    .filter((block) => block.heading.includes('运动截图记录'))
    .flatMap((block) => parseActivityBlock(block.body));

  const nutritionBlock = blocks.find((block) => block.heading.includes('饮食截图记录'));
  const nutrition = nutritionBlock ? parseNutritionBlock(nutritionBlock.body) : emptyNutrition();

  return {
    date,
    measurement: measurementBlocks.at(-1) ?? null,
    measurements: measurementBlocks,
    activities,
    workoutSummary: summarizeActivities(activities),
    nutrition,
  };
}

function splitLevel4Blocks(content) {
  const matches = [...content.matchAll(LEVEL4_HEADING_RE)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : content.length;
    return {
      heading: match[1].trim(),
      body: content.slice(start, end).trim(),
    };
  });
}

function parseMeasurementBlock(block, archivedDate) {
  const measurementBody = extractSubBlock(block.body, '##### 体脂秤数据') ?? block.body;
  const fields = parseBulletFields(measurementBody);

  if (!fields['测量时间']) {
    return null;
  }

  return {
    archivedDate,
    measuredAt: fields['测量时间'],
    bodyScore: parseNumber(fields['身体得分']),
    weightKg: parseWeightKg(fields['体重']),
    bmi: parseNumber(fields['BMI']),
    bodyFatPct: parseNumber(fields['体脂率']),
    skeletalMuscleKg: parseWeightKg(fields['骨骼肌量']),
    visceralFatLevel: parseNumber(fields['内脏脂肪等级']),
    basalMetabolismKcal: parseNumber(fields['基础代谢率']),
    bodyWaterPct: parseNumber(fields['水分率']),
    proteinPct: parseNumber(fields['蛋白质']),
    boneMassKg: parseWeightKg(fields['骨盐量']),
    fatFreeMassKg: parseWeightKg(fields['去脂体重']),
    bodyAge: parseNumber(fields['身体年龄']),
    bodyType: fields['身体类型'] ?? null,
  };
}

function parseBulletFields(content) {
  const fields = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('- ') || !line.includes('：')) {
      continue;
    }
    const [, key, value] = line.match(/^- ([^：]+)：\s*(.+)$/) ?? [];
    if (key) {
      fields[key] = value.trim();
    }
  }
  return fields;
}

function parseActivityBlock(content) {
  const activities = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^- \d{2}:\d{2}\s+/.test(line))
    .map(parseActivityLine);
  const deduped = new Map();
  for (const activity of activities) {
    const key = [
      activity.time,
      activity.type,
      activity.calories ?? 'na',
      activity.durationSeconds,
      activity.distanceKm ?? 'na',
    ].join('|');
    deduped.set(key, activity);
  }
  return [...deduped.values()];
}

function parseActivityLine(line) {
  const [, time, type, detail] = line.match(/^- (\d{2}:\d{2})\s+([^：]+)：(.+)$/) ?? [];
  const durationText = detail?.match(/\d+分\d+秒|\d{2}:\d{2}:\d{2}/)?.[0] ?? null;
  const normalizedType = normalizeActivityType(type);

  return {
    time,
    type: normalizedType,
    rawType: type,
    detail,
    durationText,
    durationSeconds: durationText ? parseDurationSeconds(durationText) : 0,
    calories: parseFirstMatch(detail, /(?:总)?消耗\s*(\d+(?:\.\d+)?)\s*千卡/),
    distanceKm: parseFirstMatch(detail, /(\d+(?:\.\d+)?)\s*公里/),
    avgSpeedKmh: parseFirstMatch(detail, /(?:均速|平均速度)\s*(\d+(?:\.\d+)?)\s*公里\/小时/),
    heartRate: parseFirstMatch(detail, /(?:平均(?:心率)?|记录值|心率)\s*(\d+)\s*次\/分钟/),
  };
}

function summarizeActivities(activities) {
  const countsByType = {};
  let totalDurationSeconds = 0;
  let trainingCalories = 0;
  let cyclingDistanceKm = 0;

  for (const activity of activities) {
    countsByType[activity.type] = (countsByType[activity.type] ?? 0) + 1;
    totalDurationSeconds += activity.durationSeconds;
    if (activity.calories !== null) {
      trainingCalories += activity.calories;
    }
    if (activity.distanceKm !== null && activity.type.includes('骑行')) {
      cyclingDistanceKm += activity.distanceKm;
    }
  }

  return {
    totalActivities: activities.length,
    totalDurationSeconds,
    trainingCalories: roundTo(trainingCalories, 2),
    cyclingDistanceKm: roundTo(cyclingDistanceKm, 2),
    countsByType,
  };
}

function normalizeActivityType(type) {
  if (type === '自由训练' || type.startsWith('燃脂训练')) {
    return '燃脂训练';
  }
  return type;
}

function parseNutritionBlock(content) {
  const summaryBody = extractSubBlock(content, '##### 餐次汇总') ?? '';
  const mealsByName = new Map();
  let totalCalories = null;

  for (const rawLine of summaryBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    const meal = parseNutritionSummaryLine(line);
    if (meal) {
      const existing = mealsByName.get(meal.name);
      if (!existing || meal.isSummary) {
        mealsByName.set(meal.name, {
          name: meal.name,
          calories: meal.calories,
          recommendedMin: meal.recommendedMin,
          recommendedMax: meal.recommendedMax,
          isSummary: meal.isSummary,
        });
      } else if (!existing.isSummary) {
        existing.calories = roundTo(existing.calories + meal.calories, 2);
        existing.recommendedMin = meal.recommendedMin;
        existing.recommendedMax = meal.recommendedMax;
      }
      continue;
    }

    const totalMatch = line.match(/^- 当日截图内已记录总热量：(\d+(?:\.\d+)?)千卡$/);
    if (totalMatch) {
      totalCalories = Number(totalMatch[1]);
    }
  }

  return {
    meals: ['早餐', '午餐', '晚餐', '加餐']
      .map((name) => mealsByName.get(name))
      .filter(Boolean)
      .map(({ isSummary, ...meal }) => meal),
    totalCalories,
  };
}

function parseNutritionSummaryLine(line) {
  const match = line.match(/^- (.+)：\s*(\d+(?:\.\d+)?)\s*千卡，建议范围\s*(\d+)[–-](\d+)\s*千卡$/);
  if (!match) {
    return null;
  }

  const [, rawName, calories, recommendedMin, recommendedMax] = match;
  const mealName = inferMealName(rawName);
  if (!mealName) {
    return null;
  }

  return {
    name: mealName,
    calories: Number(calories),
    recommendedMin: Number(recommendedMin),
    recommendedMax: Number(recommendedMax),
    isSummary: rawName.trim() === mealName,
  };
}

function inferMealName(value) {
  const trimmed = value.trim();
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

  return trimmed.match(/早餐|午餐|晚餐|加餐/)?.[0] ?? null;
}

function emptyNutrition() {
  return {
    meals: [],
    totalCalories: null,
  };
}

function extractSubBlock(content, heading) {
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

function parseWeightKg(value) {
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
  const jin = value.match(/(\d+(?:\.\d+)?)斤/);
  if (jin) {
    return roundTo(Number(jin[1]) * 0.5, 2);
  }
  return null;
}

function parseNumber(value) {
  if (!value) {
    return null;
  }
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseDurationSeconds(value) {
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

function parseFirstMatch(value, regex) {
  const match = value?.match(regex);
  return match ? Number(match[1]) : null;
}

function roundTo(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
