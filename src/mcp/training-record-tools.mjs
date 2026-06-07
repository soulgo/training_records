import path from 'node:path';

import { buildDashboardViewModel } from '../../tools/dashboard-view.mjs';
import { exportTrainingMarkdown } from '../../tools/training-db-core.mjs';
import {
  collectTextMatches,
  compareFeedbackDesc,
  limitItems,
  loadSnapshot,
  McpToolError,
  omitKey,
  readThoughtPosts,
  resolveEffectiveSource,
  safeReadTextFile,
  summarizeMatch,
} from './tool-support.mjs';

export async function getSnapshotTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  return {
    data: args.include_body_feedback === false
      ? omitKey(snapshot, 'bodyFeedback')
      : snapshot,
    source: snapshot.source ?? resolveEffectiveSource(args.source, context.env),
    generatedAt: snapshot.generatedAt,
  };
}

export async function getDailyRecordsTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const types = Array.isArray(args.types) && args.types.length ? new Set(args.types) : null;
  const days = (snapshot.daily ?? []).map((day) => {
    if (!types) {
      return day;
    }
    const projected = { date: day.date };
    for (const type of types) {
      projected[type] = day[type] ?? null;
    }
    return projected;
  });
  return {
    data: { days },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

export async function getLatestStatusTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const bodyFeedback = [...(snapshot.bodyFeedback ?? [])].sort(compareFeedbackDesc);
  return {
    data: {
      latestMeasurement: snapshot.latest?.measurement ?? null,
      latestDay: snapshot.latest?.daily ?? null,
      bodyFeedbackLatest: bodyFeedback[0] ?? null,
    },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

export async function getMeasurementsTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const measurements = limitItems(
    snapshot.daily
      .flatMap((day) => day.measurements ?? (day.measurement ? [day.measurement] : []))
      .filter(Boolean),
    args.limit,
  );
  return {
    data: { measurements },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

export async function getActivitiesTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const activityType = String(args.activity_type ?? '').trim();
  let activities = snapshot.daily.flatMap((day) =>
    (day.activities ?? []).map((activity) => ({
      date: day.date,
      ...activity,
    })),
  );
  if (activityType) {
    activities = activities.filter((activity) =>
      String(activity.type ?? '').includes(activityType) ||
      String(activity.rawType ?? '').includes(activityType),
    );
  }
  return {
    data: { activities: limitItems(activities, args.limit) },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

export async function getNutritionTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  return {
    data: {
      days: snapshot.daily.map((day) => ({
        date: day.date,
        nutrition: day.nutrition ?? null,
      })),
    },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

export async function getBodyFeedbackTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const keyword = String(args.keyword ?? '').trim();
  let feedback = snapshot.bodyFeedback ?? [];
  if (keyword) {
    feedback = feedback.filter((entry) => String(entry.body ?? '').includes(keyword));
  }
  return {
    data: { feedback: limitItems(feedback, args.limit) },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

export async function getDashboardViewTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  return {
    data: buildDashboardViewModel(snapshot),
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

export async function getChartDataTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  const requested = Array.isArray(args.metrics) && args.metrics.length
    ? new Set(args.metrics)
    : null;
  const charts = Object.fromEntries(
    Object.entries(snapshot.charts ?? {})
      .filter(([metric]) => !requested || requested.has(metric)),
  );
  return {
    data: { charts },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

export async function searchRecordsTool(args, context) {
  const query = String(args.query ?? '').trim();
  if (!query) {
    throw new McpToolError('INVALID_ARGUMENT', 'query is required', { retryable: false });
  }

  const types = Array.isArray(args.types) && args.types.length
    ? new Set(args.types)
    : new Set(['snapshot', 'markdown', 'thought']);
  const matches = [];

  if (types.has('snapshot')) {
    const snapshot = await loadSnapshot(args, context);
    for (const day of snapshot.daily ?? []) {
      const text = JSON.stringify(day);
      if (text.includes(query)) {
        matches.push({
          source: 'snapshot',
          date: day.date,
          text: summarizeMatch(text, query, args.include_raw),
        });
      }
    }
  }

  if (types.has('markdown')) {
    const markdownPath = path.join(context.rootDir, '训练记录.md');
    const markdown = await safeReadTextFile(markdownPath);
    collectTextMatches(matches, {
      source: 'markdown',
      text: markdown,
      query,
      includeRaw: args.include_raw,
      path: '训练记录.md',
    });
  }

  if (types.has('thought')) {
    for (const post of await readThoughtPosts(context.rootDir)) {
      collectTextMatches(matches, {
        source: 'thought',
        text: post.body,
        query,
        includeRaw: args.include_raw,
        path: post.markdownPath,
        date: post.date,
      });
    }
  }

  return {
    data: { matches: limitItems(matches, args.limit ?? 20) },
    source: resolveEffectiveSource(args.source, context.env),
  };
}

export async function getMarkdownRecordTool(args, context) {
  const snapshot = await loadSnapshot(args, context);
  return {
    data: { markdown: exportTrainingMarkdown(snapshot) },
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}
