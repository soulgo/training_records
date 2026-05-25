import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import frontMatter from 'hexo-front-matter';

import { parseTrainingRecord } from './training-parser.mjs';
import { readTrainingSnapshotFromDatabase } from './training-db-core.mjs';
import { readDirRecursive } from './lib/fs-walk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..');
const incompleteDatabaseSnapshotPattern = /database snapshot is empty or missing measurements/i;
const unavailableDatabaseSnapshotPattern = /^database snapshot unavailable:/i;

export async function buildTrainingSnapshot(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const source = options.source ?? resolveSnapshotSource(options.env);

  if (source === 'database') {
    try {
      const snapshot = await readTrainingSnapshotFromDatabase({
        env: options.env,
        createClient: options.createClient,
        now: options.now,
        dateFrom: options.dateFrom,
        dateTo: options.dateTo,
      });
      if (isRenderableSnapshot(snapshot) || options.dateFrom || options.dateTo) {
        return snapshot;
      }
      throw new Error('database snapshot is empty or missing measurements');
    } catch (error) {
      if (isIncompleteDatabaseSnapshotError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`database snapshot unavailable: ${message}`);
    }
  }

  return readTrainingSnapshotFromMarkdown(rootDir, options.now);
}

export function resolveSnapshotSource(env = process.env) {
  const configured = String(env?.TRAINING_SNAPSHOT_SOURCE ?? 'markdown').trim().toLowerCase();
  return configured === 'database' ? 'database' : 'markdown';
}

export function isIncompleteDatabaseSnapshotError(error) {
  return error instanceof Error && incompleteDatabaseSnapshotPattern.test(error.message);
}

export function isUnavailableDatabaseSnapshotError(error) {
  return error instanceof Error && unavailableDatabaseSnapshotPattern.test(error.message);
}

async function readTrainingSnapshotFromMarkdown(rootDir, now) {
  const markdown = await readFile(path.join(rootDir, '训练记录.md'), 'utf8');
  const snapshot = parseTrainingRecord(markdown);
  const bodyFeedback = await readBodyFeedbackFromMarkdown(rootDir);
  const nextSnapshot = {
    ...snapshot,
    bodyFeedback,
  };
  if (!now) {
    return nextSnapshot;
  }
  return {
    ...nextSnapshot,
    generatedAt: now.toISOString(),
  };
}

function isRenderableSnapshot(snapshot) {
  return (snapshot?.daily?.length ?? 0) > 0 && snapshot?.latest?.measurement;
}

async function readBodyFeedbackFromMarkdown(rootDir) {
  const postsDir = path.join(rootDir, 'source', '_posts');
  const postPaths = await readDirRecursive(postsDir, {
    filter: (entryPath) => /(?:^|[/\\])[^/\\]+-telegram-thought-\d+\.md$/u.test(entryPath),
  });

  const entries = [];
  for (const postPath of postPaths) {
    try {
      const parsed = frontMatter.parse(await readFile(postPath, 'utf8'));
      if (parsed.thought_module !== 'body_feedback') {
        continue;
      }
      const dateParts = normalizeFeedbackDateParts(parsed.date);
      entries.push({
        date: dateParts.date,
        time: dateParts.time,
        body: String(parsed._content ?? '').trim(),
        telegramMessageId: toNumberOrNull(parsed.telegram_message_id),
        telegramChatId: toNumberOrNull(parsed.telegram_chat_id),
        markdownPath: toPortableRelativePath(path.relative(rootDir, postPath)),
        source: 'markdown',
      });
    } catch {}
  }

  return entries
    .filter((entry) => entry.date && entry.body)
    .sort(compareFeedbackEntries);
}

function normalizeFeedbackDateParts(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatFeedbackDateParts(value);
  }

  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (match) {
    return {
      date: match[1],
      time: match[2] ?? null,
    };
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return formatFeedbackDateParts(parsed);
  }

  return {
    date: null,
    time: null,
  };
}

function formatFeedbackDateParts(date) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function compareFeedbackEntries(left, right) {
  return `${left.date} ${left.time ?? ''}`.localeCompare(`${right.date} ${right.time ?? ''}`);
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toPortableRelativePath(value) {
  return String(value ?? '').split(path.sep).join('/');
}
