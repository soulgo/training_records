import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAiProvider } from '../../adapters/ai/ai-provider.factory.mjs';
import { extractAiResponseContent, normalizeAiUsage, parseAiJsonContent } from '../../core/ai/schema-validator.mjs';
import {
  dailyMonitorReportSchema,
  dailyMonitorReportSchemaVersion,
} from '../../core/ai/daily-monitor-report-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPromptPath = path.resolve(__dirname, '..', '..', '..', 'prompts', 'daily-monitor-report.md');

export function buildDailyMonitorReportContext(snapshot, now = new Date()) {
  const daily = [...(snapshot?.daily ?? [])]
    .filter((day) => day?.date)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const latestDay = daily.at(-1) ?? null;
  const latestMeasurement = snapshot?.latest?.measurement ?? latestDay?.measurement ?? null;
  const recentDays = daily.slice(-7);
  const feedbackByDate = groupFeedbackByDate(snapshot?.bodyFeedback);

  return {
    generatedAt: toIsoString(now),
    dataSource: normalizeSnapshotSource(snapshot?.source),
    latestDate: latestDay?.date ?? snapshot?.latest?.daily?.date ?? latestMeasurement?.archivedDate ?? null,
    latestMeasurement: normalizeMeasurement(latestMeasurement),
    latestDay: normalizeDay(latestDay, feedbackByDate[latestDay?.date] ?? []),
    recentDays: recentDays.map((day) => normalizeDay(day, feedbackByDate[day.date] ?? [])),
  };
}

export async function generateDailyMonitorReport(options = {}) {
  const now = options.now ?? new Date();
  const context = buildDailyMonitorReportContext(options.snapshot, now);
  const env = options.env ?? process.env;

  if (!context.latestDate) {
    return buildFallbackResult(context, 'no_latest_data');
  }

  const dailyReportEnabled = options.dailyReportEnabled === undefined
    ? options.aiProvider ? true : isEnabled(env.DAILY_MONITOR_REPORT_ENABLED)
    : options.dailyReportEnabled === true || isEnabled(options.dailyReportEnabled);

  if (!dailyReportEnabled) {
    return buildFallbackResult(context, 'ai_disabled');
  }

  const aiProvider = options.aiProvider ?? createProviderIfConfigured(env);

  if (!aiProvider) {
    return buildFallbackResult(context, 'ai_not_configured');
  }

  try {
    const response = await aiProvider.requestChatCompletion({
      messages: [
        { role: 'system', content: options.prompt ?? await loadPrompt(options.env ?? process.env) },
        {
          role: 'user',
          content: [
            '以下 data 是唯一可用证据：',
            `data: ${JSON.stringify(context)}`,
          ].join('\n'),
        },
      ],
      responseFormat: aiProvider.capabilities?.jsonObject === false ? undefined : { type: 'json_object' },
      fetchImpl: options.fetchImpl,
      maxAttempts: options.maxAttempts,
      baseDelayMs: options.baseDelayMs,
      logPrefix: '[daily-monitor-report]',
      finalErrorMessage: 'Daily monitor report request failed',
    });

    if (!response.ok) {
      throw new Error(`Daily monitor report failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    const content = extractAiResponseContent(payload, {
      label: 'Daily monitor report',
      schemaName: 'daily_monitor_report',
      schemaVersion: dailyMonitorReportSchemaVersion,
    });
    const report = parseAiJsonContent(content, dailyMonitorReportSchema, {
      schemaName: 'daily_monitor_report',
      schemaVersion: dailyMonitorReportSchemaVersion,
    });

    return {
      status: 'ok',
      source: 'ai',
      model: aiProvider.env?.model ?? null,
      generatedAt: context.generatedAt,
      latestDataDate: context.latestDate,
      report,
      usage: normalizeAiUsage(payload?.usage),
    };
  } catch (error) {
    process.stderr.write(
      `[daily-monitor-report] ${error instanceof Error ? error.message : String(error)}; using rule fallback\n`,
    );
    return buildFallbackResult(context, 'ai_request_failed');
  }
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function createProviderIfConfigured(env) {
  if (!env?.AI_API_KEY || !env?.AI_BASE_URL || !env?.AI_MODEL) {
    return null;
  }
  try {
    return createAiProvider(env);
  } catch (error) {
    process.stderr.write(
      `[daily-monitor-report] ${error instanceof Error ? error.message : String(error)}; using rule fallback\n`,
    );
    return null;
  }
}

async function loadPrompt(env) {
  const configuredPath = String(env?.DAILY_MONITOR_REPORT_PROMPT_PATH ?? '').trim();
  for (const promptPath of [configuredPath, defaultPromptPath].filter(Boolean)) {
    try {
      const content = (await readFile(promptPath, 'utf8')).trim();
      if (content) return content;
    } catch {}
  }
  return '请基于提供的数据输出符合 daily_monitor_report schema 的中文 JSON。';
}

function buildFallbackResult(context, reason) {
  return {
    status: 'fallback',
    source: 'rules',
    reason,
    model: null,
    generatedAt: context.generatedAt,
    latestDataDate: context.latestDate,
    report: buildRuleReport(context),
    usage: normalizeAiUsage(null),
  };
}

function buildRuleReport(context) {
  const day = context.latestDay ?? {};
  const sleepMinutes = day.sleep?.totalSleepMinutes ?? day.sleep?.nightSleepMinutes;
  const workoutMinutes = day.training?.workoutDurationMinutes;
  const trainingCalories = day.training?.trainingCalories;
  const intakeCalories = day.nutrition?.totalCalories;
  const hasFeedback = (day.bodyFeedback ?? []).length > 0;
  const sleepLow = Number.isFinite(Number(sleepMinutes)) && Number(sleepMinutes) < 420;

  return {
    headline: sleepLow ? '今天先把恢复补回来，再决定是否增加训练量。' : '今天按记录保持稳定节奏，优先完成可持续的训练和饮食。',
    training: {
      summary: sleepLow
        ? `最新记录睡眠 ${formatNumber(sleepMinutes)} 分钟，今天不适合追加强度。`
        : trainingCalories || workoutMinutes
          ? '最新训练记录完整，今天根据主观恢复决定维持或小幅推进。'
          : '暂无足够训练数据判断今天的训练负荷。',
      actions: sleepLow
        ? ['安排 20 至 40 分钟低强度活动或休息。', '暂不安排 HIIT 或大重量训练。']
        : ['优先完成一次全身力量训练，控制在 45 至 60 分钟。', '若恢复感差，改为 30 分钟低强度有氧。'],
    },
    nutrition: {
      summary: Number.isFinite(Number(intakeCalories))
        ? `最新记录摄入 ${formatNumber(intakeCalories)} 千卡，继续观察训练量与摄入是否匹配。`
        : '暂无足够饮食数据判断今日摄入是否匹配训练。',
      actions: ['每餐先保证蛋白质，再补充蔬菜和主食。', '避免用过大的热量缺口换取短期掉秤。'],
    },
    recovery: {
      summary: sleepLow ? '睡眠不足，恢复优先级高于增加训练量。' : '暂无明显恢复风险信号，继续保持规律睡眠。',
      actions: [sleepLow ? '今晚把睡眠目标放在至少 7 小时。' : '今晚继续保持固定入睡时间，目标至少 7 小时。'],
    },
    other: {
      summary: hasFeedback ? '最新记录包含身体反馈，训练时要避开会诱发不适的动作。' : '暂无身体反馈支持额外判断。',
      actions: [hasFeedback ? '若疼痛、头晕或胸闷持续，停止诱发动作并寻求专业帮助。' : '如果出现疼痛或异常疲劳，先记录再降低训练负荷。'],
    },
  };
}

function normalizeDay(day, topLevelFeedback = []) {
  if (!day) {
    return null;
  }
  return {
    date: day.date ?? null,
    measurement: normalizeMeasurement(day.measurement),
    training: {
      trainingCalories: toNumberOrNull(day.workoutSummary?.trainingCalories),
      workoutDurationMinutes: resolveWorkoutDurationMinutes(day.workoutSummary),
      countsByType: day.workoutSummary?.countsByType ?? {},
      activities: (day.activities ?? []).slice(0, 5).map((activity) => ({
        time: activity.time ?? activity.activityTime ?? null,
        type: activity.type ?? null,
        detail: activity.detail ?? null,
      })),
    },
    nutrition: {
      totalCalories: toNumberOrNull(day.nutrition?.totalCalories),
      meals: (day.nutrition?.meals ?? []).map((meal) => ({
        name: meal.name ?? null,
        calories: toNumberOrNull(meal.calories),
      })),
    },
    sleep: day.sleepSummary
      ? {
          totalSleepMinutes: toNumberOrNull(day.sleepSummary.totalSleepMinutes),
          nightSleepMinutes: toNumberOrNull(day.sleepSummary.nightSleepMinutes),
          sleepScore: toNumberOrNull(day.sleepSummary.sleepScore),
          deepSleepMinutes: toNumberOrNull(day.sleepSummary.deepSleepMinutes),
          remSleepMinutes: toNumberOrNull(day.sleepSummary.remSleepMinutes),
          hrvMs: toNumberOrNull(day.sleepSummary.hrvMs),
        }
      : null,
    bodyFeedback: (day.bodyFeedback?.length ? day.bodyFeedback : topLevelFeedback).slice(0, 3),
  };
}

function groupFeedbackByDate(entries) {
  return (entries ?? []).reduce((groups, entry) => {
    const date = String(entry?.date ?? '').slice(0, 10);
    if (!date) return groups;
    groups[date] ??= [];
    groups[date].push(entry);
    return groups;
  }, {});
}

function resolveWorkoutDurationMinutes(summary) {
  const explicit = toNumberOrNull(summary?.workoutDurationMinutes);
  if (explicit !== null) return explicit;
  const seconds = toNumberOrNull(summary?.totalDurationSeconds);
  return seconds === null ? null : Math.round((seconds / 60) * 10) / 10;
}

function normalizeMeasurement(measurement) {
  if (!measurement) {
    return null;
  }
  return {
    archivedDate: measurement.archivedDate ?? null,
    weightKg: toNumberOrNull(measurement.weightKg),
    bodyFatPct: toNumberOrNull(measurement.bodyFatPct),
    skeletalMuscleKg: toNumberOrNull(measurement.skeletalMuscleKg),
    basalMetabolismKcal: toNumberOrNull(measurement.basalMetabolismKcal),
  };
}

function normalizeSnapshotSource(source) {
  const normalized = String(source ?? '').trim().toLowerCase();
  return ['database', 'markdown', 'fallback_markdown'].includes(normalized) ? normalized : 'unknown';
}

function toNumberOrNull(value) {
  const numeric = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(numeric) ? null : numeric;
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : '暂无';
}

function toIsoString(value) {
  return typeof value?.toISOString === 'function' ? value.toISOString() : new Date(value ?? Date.now()).toISOString();
}
