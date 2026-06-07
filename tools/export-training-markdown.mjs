import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportTrainingMarkdown } from './training-db-core.mjs';
import { buildTrainingSnapshot } from './training-snapshot.mjs';
import { getThoughtModuleTags, normalizeThoughtModule } from './lib/thought-modules.mjs';
import { readDirRecursive } from './lib/fs-walk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function exportDerivedTrainingMarkdown(options = {}) {
  const activeRootDir = options.rootDir ?? rootDir;
  const outputPath = options.outputPath ?? path.join(activeRootDir, '训练记录.md');
  const snapshotSource = options.source ?? 'database';
  const buildSnapshot = options.buildTrainingSnapshot ?? buildTrainingSnapshot;
  const snapshotOptions = {
    source: snapshotSource,
    rootDir: activeRootDir,
    env: {
      ...(options.env ?? process.env),
      TRAINING_SNAPSHOT_STRICT_DATABASE: 'true',
    },
    createClient: options.createClient,
    now: options.now,
  };
  const snapshot = await buildSnapshot(snapshotOptions);

  const markdown = (options.exportTrainingMarkdown ?? exportTrainingMarkdown)(snapshot);
  await writeFile(outputPath, markdown, 'utf8');
  const thoughtResult = await exportThoughtMarkdownBackup({
    rootDir: activeRootDir,
    thoughts: snapshot.thoughts ?? [],
  });
  return {
    outputPath,
    snapshot,
    thoughts: thoughtResult,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await exportDerivedTrainingMarkdown();
}

async function exportThoughtMarkdownBackup({ rootDir, thoughts }) {
  const postsDir = path.join(rootDir, 'source', '_posts');
  await mkdir(postsDir, { recursive: true });

  const existingThoughtPosts = await readDirRecursive(postsDir, {
    ignoreMissing: true,
    filter: (entryPath) => /(?:^|[/\\])[^/\\]+-telegram-thought-\d+\.md$/u.test(entryPath),
  });
  await Promise.all(existingThoughtPosts.map((postPath) => rm(postPath, { force: true })));

  const activeThoughts = (thoughts ?? [])
    .filter((thought) => thought?.telegramMessageId && String(thought.body ?? '').trim())
    .sort((left, right) =>
      `${left.date} ${left.time ?? ''} ${left.telegramMessageId}`.localeCompare(
        `${right.date} ${right.time ?? ''} ${right.telegramMessageId}`,
      ),
    );

  for (const thought of activeThoughts) {
    const date = thought.date || formatDateFromUnix(thought.messageDateUnix) || '1970-01-01';
    const time = normalizeThoughtTime(thought.time) ?? '00:00:00';
    const fileName = `${date}-telegram-thought-${thought.telegramMessageId}.md`;
    const postPath = path.join(postsDir, fileName);
    await writeFile(postPath, renderThoughtPost(thought, { date, time }), 'utf8');
  }

  return {
    exportedCount: activeThoughts.length,
    removedCount: existingThoughtPosts.length,
  };
}

function renderThoughtPost(thought, { date, time }) {
  const thoughtModule = normalizeThoughtModule(thought.thoughtModule);
  const tags = Array.isArray(thought.tags) && thought.tags.length > 0
    ? thought.tags
    : getThoughtModuleTags(thoughtModule);
  const lines = [
    '---',
    `date: ${date} ${time}`,
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    `thought_module: ${thoughtModule}`,
    `telegram_message_id: ${thought.telegramMessageId ?? ''}`,
    `telegram_chat_id: ${thought.telegramChatId ?? ''}`,
  ];
  if (Array.isArray(thought.imageRefs) && thought.imageRefs.length > 0) {
    lines.push('photos:');
    for (const photoPath of thought.imageRefs) {
      lines.push(`  - ${photoPath}`);
    }
  }
  lines.push('---', '', String(thought.body ?? '').trim(), '');
  return lines.join('\n');
}

function normalizeThoughtTime(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  if (/^\d{2}:\d{2}:\d{2}$/.test(text)) {
    return text;
  }
  if (/^\d{2}:\d{2}$/.test(text)) {
    return `${text}:00`;
  }
  return null;
}

function formatDateFromUnix(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}
