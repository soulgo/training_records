import {
  buildTrainingDay,
  buildTrainingSnapshotFromDaily,
  emptyNutrition,
  emptySleep,
  extractSubBlock,
  inferMealSlot,
  normalizeActivityType,
  normalizeSleepType,
  parseDurationSeconds,
  parseFirstMatch,
  parseMinutesText,
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
  const sleepBlock = blocks.find((block) => block.heading.includes('睡眠截图记录') || block.heading.includes('睡眠记录'));
  const sleep = sleepBlock ? parseSleepBlock(sleepBlock.body) : emptySleep();

  return buildTrainingDay({
    date,
    measurements: measurementBlocks,
    activities,
    nutrition,
    sleep,
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
  const detailsBody = extractSubBlock(content, '##### 餐次明细') ?? '';
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

    const normalizedTotal = parseNutritionTotalLine(line);
    if (normalizedTotal !== null) {
      totalCalories = normalizedTotal;
    }
  }

  if (totalCalories === null) {
    for (const rawLine of content.split(/\r?\n/)) {
      const fallbackTotal = parseNutritionTotalLine(rawLine.trim());
      if (fallbackTotal !== null) {
        totalCalories = fallbackTotal;
        break;
      }
    }
  }

  return {
    meals: ['早餐', '午餐', '晚餐', '加餐']
      .map((name) => mealsByName.get(name))
      .filter(Boolean)
      .map(({ isSummary, ...meal }) => meal),
    totalCalories,
    details: parseNutritionDetails(detailsBody),
  };
}

function parseSleepBlock(content) {
  const detailBody = extractSubBlock(content, '##### 睡眠明细') ?? content;
  const recordChunks = splitSleepRecordChunks(detailBody);
  const records = recordChunks.map(parseSleepRecordChunk).filter(hasSleepRecordValue);
  if (records.length === 0) {
    return emptySleep();
  }

  return {
    records,
    ...records.at(-1),
  };
}

function parseSleepRecordChunk(content) {
  const fields = parseBulletFields(content);
  const sleepType = normalizeSleepType(fields['睡眠类型']);
  const [bedtimeFromPair, wakeTimeFromPair] = parseSleepTimePair(fields['入睡/起床']);
  const record = {
    sleepType,
    bedtime: bedtimeFromPair ?? fields['入睡时间'] ?? fields['开始时间'] ?? null,
    wakeTime: wakeTimeFromPair ?? fields['起床时间'] ?? fields['结束时间'] ?? null,
    nightSleepMinutes: parseMinutesText(fields['夜间睡眠']) ?? parseMinutesText(fields['睡眠时长']) ?? null,
    totalSleepMinutes: parseMinutesText(fields['总睡眠']) ?? parseMinutesText(fields['睡眠总时长']) ?? null,
    napMinutes: parseMinutesText(fields['午睡']) ?? parseMinutesText(fields['小睡']) ?? null,
    deepSleepMinutes: parseMinutesText(fields['深睡']) ?? null,
    lightSleepMinutes: parseMinutesText(fields['浅睡']) ?? null,
    remSleepMinutes:
      parseMinutesText(fields['快动眼睡眠']) ??
      parseMinutesText(fields['快速眼动']) ??
      parseMinutesText(fields['REM']) ??
      null,
    awakeMinutes: parseMinutesText(fields['清醒']) ?? null,
    sleepStageText: fields['睡眠阶段'] ?? null,
    sleepStageDetail: parseSleepStageDetail(content),
    sleepScore: parseNumber(fields['睡眠评分']),
    sleepScorePercentile: parseNumber(fields['超过用户']),
    deepSleepRatioPct: parseNumber(fields['深睡比例']),
    lightSleepRatioPct: parseNumber(fields['浅睡比例']),
    remSleepRatioPct: parseNumber(fields['快速眼动比例']),
    deepSleepContinuityScore: parseNumber(fields['深睡连续性']),
    wakeCount: parseNumber(fields['清醒次数']),
    breathingQualityScore: parseNumber(fields['呼吸质量']),
    averageHeartRateBpm: parseNumber(fields['平均心率']),
    hrvMs: parseNumber(fields['平均心率变异性']),
    averageSpo2Pct: parseNumber(fields['平均血氧饱和度']),
    averageRespiratoryRate: parseNumber(fields['平均呼吸率']),
    analysisText: fields['睡眠解读'] ?? null,
    suggestionText: fields['睡眠建议'] ?? null,
  };

  return {
    ...record,
    sleepStartTime: record.bedtime,
    sleepEndTime: record.wakeTime,
  };
}

function parseNutritionDetails(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^- (.+)$/)?.[1]?.trim())
    .filter(Boolean);
}

function splitSleepRecordChunks(content) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  let current = [];

  for (const line of lines) {
    if (/^- 睡眠类型：/.test(line.trim()) && current.some((item) => item.trim())) {
      chunks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }

  if (current.some((item) => item.trim())) {
    chunks.push(current.join('\n'));
  }

  return chunks.length ? chunks : [content];
}

function parseSleepTimePair(value) {
  if (!value) {
    return [null, null];
  }
  const [start, end] = String(value).split(/\s*(?:→|->|>)\s*/).map((item) => item?.trim()).filter(Boolean);
  return [start ?? null, end ?? null];
}

function parseSleepStageDetail(content) {
  const lines = content.split(/\r?\n/);
  const details = [];
  let collecting = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^- 睡眠阶段明细：\s*$/.test(line.trim())) {
      collecting = true;
      continue;
    }
    if (collecting) {
      const nested = line.match(/^\s+- (.+)$/)?.[1]?.trim();
      if (nested) {
        details.push(nested);
        continue;
      }
      if (line.trim().startsWith('- ')) {
        break;
      }
    }
  }

  return details.length ? details : null;
}

function hasSleepRecordValue(record) {
  return Object.entries(record).some(([key, value]) => {
    if (key === 'sleepType') {
      return false;
    }
    return value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
  });
}

function parseNutritionSummaryLine(line) {
  const match = line.match(/^- (.+?)[:：]\s*(\d+(?:\.\d+)?)\s*(?:千卡|kcal)(?:，?\s*建议范围\s*(\d+)[–-](\d+)\s*(?:千卡|kcal))?$/i);
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
    recommendedMin: recommendedMin ? Number(recommendedMin) : null,
    recommendedMax: recommendedMax ? Number(recommendedMax) : null,
    isSummary: rawName.trim() === mealName,
  };
}

function parseNutritionTotalLine(line) {
  const normalized = line.replace(/\s+/g, '').replace(/^[-•]/, '');
  if (!/(?:总热量|已记录总热量|当日截图内已记录总热量|摄入总热量)/i.test(normalized)) {
    return null;
  }

  const numericMatch = normalized.match(/(\d+(?:\.\d+)?)(?:千卡|kcal)/i);
  if (numericMatch) {
    return Number(numericMatch[1]);
  }

  const fallbackNumber = normalized.match(/(\d+(?:\.\d+)?)/)?.[1];
  return fallbackNumber ? Number(fallbackNumber) : null;
}
