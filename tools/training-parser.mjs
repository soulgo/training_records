import {
  buildTrainingDay,
  buildTrainingSnapshotFromDaily,
  emptyNutrition,
  extractSubBlock,
  inferMealSlot,
  normalizeActivityType,
  parseDurationSeconds,
  parseFirstMatch,
  parseNumber,
  parseWeightKg,
  roundTo,
  splitDateSections,
  splitLevel4Blocks,
} from './training-domain.mjs';

export function parseTrainingRecord(markdown) {
  const daily = splitDateSections(markdown).map(({ date, body }) =>
    parseDateSection(date, body),
  );
  return buildTrainingSnapshotFromDaily(daily);
}

function parseDateSection(date, content) {
  const blocks = splitLevel4Blocks(content);
  const measurementBlocks = blocks
    .filter((block) => block.heading.includes('体脂秤'))
    .map((block) => parseMeasurementBlock(block, date))
    .filter(Boolean);

  const workoutBlocks = blocks
    .filter((block) => block.heading.includes('运动截图记录'))
    .map((block) => parseWorkoutBlock(block.body));
  const activities = workoutBlocks.flatMap((block) => block.activities);
  const workoutDailySummary = workoutBlocks
    .map((block) => block.workoutDailySummary)
    .filter(Boolean)
    .at(-1) ?? null;

  const nutritionBlock = blocks.find((block) => block.heading.includes('饮食截图记录'));
  const nutrition = nutritionBlock ? parseNutritionBlock(nutritionBlock.body) : emptyNutrition();

  return buildTrainingDay({
    date,
    measurements: measurementBlocks,
    activities,
    nutrition,
    workoutDailySummary,
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

function parseWorkoutBlock(content) {
  return {
    activities: parseActivityBlock(content),
    workoutDailySummary: parseWorkoutDailySummary(content),
  };
}

function parseWorkoutDailySummary(content) {
  const summary = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^- (活动热量|锻炼时长|活动小时数)：\s*(.+)$/);
    if (!match) {
      continue;
    }

    if (match[1] === '活动热量') {
      summary.activityCaloriesKcal = parseNumber(match[2]);
    }
    if (match[1] === '锻炼时长') {
      summary.workoutDurationMinutes = parseNumber(match[2]);
    }
    if (match[1] === '活动小时数') {
      summary.activeHours = parseNumber(match[2]);
    }
  }

  return Object.keys(summary).length ? summary : null;
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
  const mealName = inferMealSlot(rawName);
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
