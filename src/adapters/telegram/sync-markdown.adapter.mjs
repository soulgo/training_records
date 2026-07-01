import {
  normalizeActivityType,
  normalizeActivityTime,
  splitDateSections,
} from '../../domain/training/training-domain.mjs';
import { appendMetric } from '../../shared/markdown-render.mjs';

const TELEGRAM_SECTION_TAG = '<!-- telegram-sync-section -->';

export function applyTelegramSyncToMarkdown(markdown, batchResult) {
  const nextSection = renderDateSection(batchResult);
  const sections = splitDateSections(markdown);
  const targetIndex = sections.findIndex((section) => section.date === batchResult.archivedDate);

  if (targetIndex === -1) {
    const mergedSections = [...sections, { date: batchResult.archivedDate, body: nextSection }];
    mergedSections.sort((left, right) => left.date.localeCompare(right.date));
    return {
      changed: true,
      markdown: stitchSections(markdown, mergedSections),
    };
  }

  const currentSection = sections[targetIndex];
  const mergedBody = mergeDateSection(currentSection.body, batchResult);
  if (mergedBody === currentSection.body) {
    return {
      changed: false,
      markdown,
    };
  }

  const nextSections = sections.slice();
  nextSections[targetIndex] = { ...currentSection, body: mergedBody };
  return {
    changed: true,
    markdown: stitchSections(markdown, nextSections),
  };
}

function stitchSections(originalMarkdown, sections) {
  const prefixMatch = originalMarkdown.match(/^[\s\S]*?(?=^### \d{4}-\d{2}-\d{2}\s*$)/m);
  const prefix = prefixMatch ? prefixMatch[0].trimEnd() : '';
  const body = sections
    .map((section) => `### ${section.date}\n\n${section.body.trim()}`)
    .join('\n\n');
  return `${prefix ? `${prefix}\n\n` : ''}${body}\n`;
}

function mergeDateSection(body, batchResult) {
  let nextBody = body.trim();

  if (batchResult.measurement) {
    nextBody = upsertBlock(nextBody, /#### .*体脂秤.*(?:\n|$)/, renderMeasurementBlock(batchResult));
  }
  if (batchResult.activities?.length || batchResult.workoutDailySummary) {
    nextBody = upsertBlock(nextBody, /#### .*运动截图记录(?:\n|$)/, renderActivitiesBlock(batchResult), {
      mergeBlock: mergeWorkoutBlock,
    });
  }
  if (batchResult.nutrition?.meals?.length || batchResult.nutrition?.totalCalories !== null) {
    nextBody = upsertBlock(nextBody, /#### .*饮食截图记录(?:\n|$)/, renderNutritionBlock(batchResult));
  }
  if (batchResult.sleep && (batchResult.sleep.records?.length || batchResult.sleep.totalSleepMinutes !== null)) {
    nextBody = upsertBlock(nextBody, /#### .*睡眠截图记录(?:\n|$)/, renderSleepBlock(batchResult));
  }

  return nextBody;
}

function renderDateSection(batchResult) {
  const parts = [];

  if (batchResult.measurement) {
    parts.push(renderMeasurementBlock(batchResult));
  }
  if (batchResult.activities?.length || batchResult.workoutDailySummary) {
    parts.push(renderActivitiesBlock(batchResult));
  }
  if (batchResult.nutrition?.meals?.length || batchResult.nutrition?.totalCalories !== null) {
    parts.push(renderNutritionBlock(batchResult));
  }
  if (batchResult.sleep && (batchResult.sleep.records?.length || batchResult.sleep.totalSleepMinutes !== null)) {
    parts.push(renderSleepBlock(batchResult));
  }

  return parts.join('\n\n').trim();
}

function renderMeasurementBlock(batchResult) {
  const measurement = batchResult.measurement;
  const lines = [
    '#### 当日体脂秤截图记录',
    '',
    TELEGRAM_SECTION_TAG,
    fingerprintComment(batchResult.fingerprints.measurement[0]),
    `- 测量时间：${measurement.measuredAt ?? batchResult.archivedDate}`,
  ];

  appendMetric(lines, '身体得分', measurement.bodyScore, '分');
  appendMetric(lines, '体重', measurement.weightKg, ' kg');
  appendMetric(lines, 'BMI', measurement.bmi);
  appendMetric(lines, '体脂率', measurement.bodyFatPct, '%');
  appendMetric(lines, '骨骼肌量', measurement.skeletalMuscleKg, ' kg');
  appendMetric(lines, '内脏脂肪等级', measurement.visceralFatLevel);
  appendMetric(lines, '基础代谢率', measurement.basalMetabolismKcal, ' kcal/日');
  appendMetric(lines, '水分率', measurement.bodyWaterPct, '%');
  appendMetric(lines, '蛋白质', measurement.proteinPct, '%');
  appendMetric(lines, '骨盐量', measurement.boneMassKg, ' kg');
  appendMetric(lines, '去脂体重', measurement.fatFreeMassKg, ' kg');
  appendMetric(lines, '身体年龄', measurement.bodyAge, '岁');
  if (measurement.bodyType) {
    lines.push(`- 身体类型：${measurement.bodyType}`);
  }

  return lines.join('\n');
}

function renderActivitiesBlock(batchResult) {
  const lines = ['#### 当日运动截图记录', '', TELEGRAM_SECTION_TAG];

  if (batchResult.workoutDailySummary) {
    lines.push(fingerprintComment(batchResult.fingerprints.workoutDailySummary[0]));
    lines.push('##### 当日活动总览');
    lines.push('');
    appendMetric(lines, '活动热量', batchResult.workoutDailySummary.activityCaloriesKcal, '千卡');
    appendMetric(lines, '锻炼时长', batchResult.workoutDailySummary.workoutDurationMinutes, '分钟');
    appendMetric(lines, '活动小时数', batchResult.workoutDailySummary.activeHours, '小时');
  }

  if (batchResult.activities.length) {
    lines.push('');
    lines.push('##### 活动明细');
    lines.push('');
  }

  for (let index = 0; index < batchResult.activities.length; index += 1) {
    const activity = batchResult.activities[index];
    const fingerprint = batchResult.fingerprints.activities[index];
    lines.push(fingerprintComment(fingerprint));
    lines.push(`- ${normalizeActivityTime(activity.time)} ${activity.type}：${activity.detail}`);
  }
  return lines.join('\n');
}

function renderNutritionBlock(batchResult) {
  const nutrition = batchResult.nutrition;
  const lines = [
    `#### ${batchResult.archivedDate} 饮食截图记录`,
    '',
    TELEGRAM_SECTION_TAG,
    '##### 餐次汇总',
    '',
  ];

  for (let index = 0; index < nutrition.meals.length; index += 1) {
    const meal = nutrition.meals[index];
    const fingerprint = batchResult.fingerprints.nutrition[index];
    lines.push(fingerprintComment(fingerprint));
    lines.push(
      `- ${meal.name}：${meal.calories}千卡，建议范围${meal.recommendedMin}–${meal.recommendedMax}千卡`,
    );
  }

  if (nutrition.totalCalories !== null) {
    lines.push(`- 当日截图内已记录总热量：${nutrition.totalCalories}千卡`);
  }

  if (nutrition.details?.length) {
    lines.push('');
    lines.push('##### 餐次明细');
    lines.push('');
    for (const detail of nutrition.details) {
      lines.push(`- ${detail}`);
    }
  }

  return lines.join('\n');
}

function renderSleepBlock(batchResult) {
  const sleep = batchResult.sleep ?? { records: [] };
  const lines = [
    `#### ${batchResult.archivedDate} 睡眠截图记录`,
    '',
    TELEGRAM_SECTION_TAG,
  ];

  if (sleep.records?.length) {
    lines.push('##### 睡眠明细');
    lines.push('');
    for (const record of sleep.records) {
      lines.push(`- 睡眠类型：${record.sleepType ?? '夜间睡眠'}`);
      if (record.bedtime || record.wakeTime) {
        lines.push(`- 入睡/起床：${record.bedtime ?? 'null'} → ${record.wakeTime ?? 'null'}`);
      }
      appendMetric(lines, '总睡眠', record.totalSleepMinutes, '分钟');
      appendMetric(lines, '夜间睡眠', record.nightSleepMinutes, '分钟');
      appendMetric(lines, '午睡', record.napMinutes, '分钟');
      appendMetric(lines, '深睡', record.deepSleepMinutes, '分钟');
      appendMetric(lines, '浅睡', record.lightSleepMinutes, '分钟');
      appendMetric(lines, '快动眼睡眠', record.remSleepMinutes, '分钟');
      appendMetric(lines, '清醒', record.awakeMinutes, '分钟');
      appendMetric(lines, '睡眠评分', record.sleepScore, '分');
      appendMetric(lines, '超过用户', record.sleepScorePercentile, '%');
      appendMetric(lines, '深睡比例', record.deepSleepRatioPct, '%');
      appendMetric(lines, '浅睡比例', record.lightSleepRatioPct, '%');
      appendMetric(lines, '快速眼动比例', record.remSleepRatioPct, '%');
      appendMetric(lines, '深睡连续性', record.deepSleepContinuityScore, '分');
      appendMetric(lines, '清醒次数', record.wakeCount, '次');
      appendMetric(lines, '呼吸质量', record.breathingQualityScore, '分');
      appendMetric(lines, '平均心率', record.averageHeartRateBpm, '次/分钟');
      appendMetric(lines, '平均心率变异性', record.hrvMs, '毫秒');
      appendMetric(lines, '平均血氧饱和度', record.averageSpo2Pct, '%');
      appendMetric(lines, '平均呼吸率', record.averageRespiratoryRate, '次/分钟');
      if (record.sleepStageText) {
        lines.push(`- 睡眠阶段：${record.sleepStageText}`);
      }
      if (Array.isArray(record.sleepStageDetail) && record.sleepStageDetail.length) {
        lines.push('- 睡眠阶段明细：');
        for (const detail of record.sleepStageDetail) {
          lines.push(`  - ${detail}`);
        }
      }
      if (record.analysisText) {
        lines.push(`- 睡眠解读：${record.analysisText}`);
      }
      if (record.suggestionText) {
        lines.push(`- 睡眠建议：${record.suggestionText}`);
      }
    }
  }

  if (!sleep.records?.length) {
    appendMetric(lines, '总睡眠', sleep.totalSleepMinutes, '分钟');
    appendMetric(lines, '夜间睡眠', sleep.nightSleepMinutes, '分钟');
    appendMetric(lines, '午睡', sleep.napMinutes, '分钟');
    appendMetric(lines, '深睡', sleep.deepSleepMinutes, '分钟');
    appendMetric(lines, '浅睡', sleep.lightSleepMinutes, '分钟');
    appendMetric(lines, '快动眼睡眠', sleep.remSleepMinutes, '分钟');
    appendMetric(lines, '清醒', sleep.awakeMinutes, '分钟');
  }

  return lines.join('\n');
}

function upsertBlock(sectionBody, headingPattern, nextBlock, options = {}) {
  const targetRange = findLevel4BlockRange(sectionBody, headingPattern);
  if (!targetRange) {
    return `${sectionBody.trim()}\n\n${nextBlock}`.trim();
  }

  const originalChunk = sectionBody.slice(targetRange.start, targetRange.end);
  const existingBlock = originalChunk.trim();
  const merge = options.mergeBlock ?? mergeBlock;
  const mergedBlock = merge(existingBlock, nextBlock);
  if (mergedBlock === existingBlock) {
    return sectionBody;
  }

  const separator = originalChunk.match(/\s*$/)?.[0] ?? '\n\n';
  return `${sectionBody.slice(0, targetRange.start)}${mergedBlock}${separator}${sectionBody.slice(targetRange.end)}`.trim();
}

function findLevel4BlockRange(sectionBody, headingPattern) {
  const matches = [...sectionBody.matchAll(/^#### .+$/gm)];
  const targetIndex = matches.findIndex((match) => headingPattern.test(`${match[0]}\n`));
  if (targetIndex === -1) {
    return null;
  }

  return {
    start: matches[targetIndex].index,
    end: targetIndex + 1 < matches.length ? matches[targetIndex + 1].index : sectionBody.length,
  };
}

function mergeBlock(existingBlock, nextBlock) {
  const incoming = nextBlock.trim();
  if (!incoming) {
    return existingBlock;
  }

  if (incoming === existingBlock.trim()) {
    return existingBlock;
  }

  return incoming;
}

function mergeWorkoutBlock(existingBlock, nextBlock) {
  const existing = splitWorkoutBlock(existingBlock);
  const incoming = splitWorkoutBlock(nextBlock);
  const summaryBody = incoming.summaryBody ?? existing.summaryBody;
  const activityBody = incoming.activityBody
    ? mergeActivityBodies(existing.activityBody, incoming.activityBody)
    : existing.activityBody;
  const lines = [existing.headingLine ?? incoming.headingLine ?? '#### 当日运动截图记录', '', TELEGRAM_SECTION_TAG];

  if (summaryBody) {
    lines.push('');
    lines.push('##### 当日活动总览');
    lines.push('');
    lines.push(stripLevel5Heading(summaryBody, '当日活动总览').trim());
  }

  if (activityBody) {
    lines.push('');
    lines.push('##### 活动明细');
    lines.push('');
    lines.push(stripLevel5Heading(activityBody, '活动明细').trim());
  }

  return lines.join('\n').trim();
}

function splitWorkoutBlock(block) {
  const [headingLine = '#### 当日运动截图记录', ...bodyLines] = block.trim().split(/\r?\n/);
  const body = bodyLines.join('\n').trim();
  return {
    headingLine,
    summaryBody: extractLevel5Body(body, '当日活动总览'),
    activityBody: extractLevel5Body(body, '活动明细') ?? extractLegacyActivityBody(body),
  };
}

function extractLevel5Body(content, heading) {
  const block = splitLevel5Blocks(content).find((item) => item.heading === heading);
  return block ? block.body.trim() : null;
}

function splitLevel5Blocks(content) {
  const matches = [...content.matchAll(/^##### (.+)$/gm)];
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

function stripLevel5Heading(content, heading) {
  const trimmed = content.trim();
  const headingLine = `##### ${heading}`;
  return trimmed.startsWith(headingLine) ? trimmed.slice(headingLine.length).trim() : trimmed;
}

function extractLegacyActivityBody(content) {
  const entries = parseActivityEntries(content);
  return entries.length ? renderActivityEntries(entries) : null;
}

function mergeActivityBodies(existingBody, incomingBody) {
  const entriesByKey = new Map();
  for (const entry of parseActivityEntries(existingBody ?? '')) {
    entriesByKey.set(entry.key, entry);
  }
  for (const entry of parseActivityEntries(incomingBody ?? '')) {
    entriesByKey.set(entry.key, entry);
  }
  const entries = [...entriesByKey.values()].sort((left, right) =>
    left.time === right.time ? left.line.localeCompare(right.line) : left.time.localeCompare(right.time),
  );
  return entries.length ? renderActivityEntries(entries) : null;
}

function parseActivityEntries(content) {
  const entries = [];
  let pendingFingerprint = null;

  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const fingerprint = line.match(/^<!-- telegram-fingerprint: ([^ ]+) -->$/)?.[1] ?? null;
    if (fingerprint) {
      pendingFingerprint = fingerprint.startsWith('a-') ? line : null;
      continue;
    }

    const activityMatch = line.match(/^- (\d{2}:\d{2})\s+([^：]+)：(.+)$/);
    if (!activityMatch) {
      pendingFingerprint = null;
      continue;
    }

    const [, time, type, detail] = activityMatch;
    const normalizedType = normalizeActivityType(type);
    entries.push({
      key: `activity:${time}|${normalizedType}`,
      time,
      line: `- ${time} ${normalizedType}：${detail.trim()}`,
      fingerprint: pendingFingerprint,
    });
    pendingFingerprint = null;
  }

  return entries;
}

function renderActivityEntries(entries) {
  const lines = [];
  for (const entry of entries) {
    if (entry.fingerprint) {
      lines.push(entry.fingerprint);
    }
    lines.push(entry.line);
  }
  return lines.join('\n');
}

function fingerprintComment(value) {
  return `<!-- telegram-fingerprint: ${value} -->`;
}

export function extractCaloriesToken(detail) {
  const match = detail.match(/(\d+(?:\.\d+)?)千卡/);
  return match ? match[1] : 'na';
}
