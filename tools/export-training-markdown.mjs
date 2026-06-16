import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { ensureCoreSchema as ensureCoreSchemaDefault } from '../src/adapters/postgres/schema-preflight.pg.mjs';
import { resolveTrainingCoreConfig } from '../src/db/training/config.mjs';
import { exportTrainingMarkdown } from './training-db-core.mjs';
import { buildTrainingSnapshot } from './training-snapshot.mjs';
import { getThoughtModuleTags, normalizeThoughtModule } from './lib/thought-modules.mjs';
import { readDirRecursive } from './lib/fs-walk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const { Client } = pg;

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
  await runDatabaseSchemaPreflight({
    env: snapshotOptions.env,
    createClient: options.createClient,
    ensureCoreSchema: options.ensureCoreSchema,
    stderr: options.stderr,
  });
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

async function runDatabaseSchemaPreflight(options = {}) {
  const config = resolveTrainingCoreConfig(options.env);
  if (!config.enabled || !config.url) {
    return;
  }

  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));
  const ensureCoreSchema = options.ensureCoreSchema ?? ensureCoreSchemaDefault;
  const maxAttempts = parsePositiveInteger(options.env?.TRAINING_DB_PREFLIGHT_MAX_ATTEMPTS, 3);
  const retryDelayMs = parseNonNegativeInteger(options.env?.TRAINING_DB_PREFLIGHT_RETRY_DELAY_MS, 500);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = createClient(config);
    try {
      await client.connect();
      await ensureCoreSchema(client);
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientDatabasePreflightError(error)) {
        throw error;
      }
      options.stderr?.write?.(
        `[training-db-export] schema preflight failed: ${formatErrorMessage(error)}; retrying (${attempt}/${maxAttempts})\n`,
      );
      await delay(retryDelayMs);
    } finally {
      await client.end();
    }
  }
}

function isTransientDatabasePreflightError(error) {
  const code = String(error?.code ?? '').trim();
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(code)) {
    return true;
  }

  const message = formatErrorMessage(error);
  return /timeout expired|connect timeout|connection timeout|terminating connection|connection terminated|too many connections|remaining connection slots/i.test(message);
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function delay(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function exportThoughtMarkdownBackup({ rootDir, thoughts }) {
  const postsDir = path.join(rootDir, 'source', '_posts');
  await mkdir(postsDir, { recursive: true });

  const existingThoughtPosts = await readDirRecursive(postsDir, {
    ignoreMissing: true,
    filter: (entryPath) => /(?:^|[/\\])[^/\\]+-(?:telegram|feishu)-thought-\d+\.md$/u.test(entryPath),
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
    const sourceChannel = normalizeThoughtSourceChannel(thought.sourceChannel);
    const channelSlug = sourceChannel === 'feishu' ? 'feishu' : 'telegram';
    const fileName = `${date}-${channelSlug}-thought-${thought.telegramMessageId}.md`;
    const postPath = path.join(postsDir, fileName);
    await writeFile(postPath, renderThoughtPost(thought, { date, time, sourceChannel }), 'utf8');
  }

  return {
    exportedCount: activeThoughts.length,
    removedCount: existingThoughtPosts.length,
  };
}

function renderThoughtPost(thought, { date, time, sourceChannel }) {
  const thoughtModule = normalizeThoughtModule(thought.thoughtModule);
  const tags = Array.isArray(thought.tags) && thought.tags.length > 0
    ? thought.tags
    : getThoughtModuleTags(thoughtModule, { sourceChannel });
  const lines = [
    '---',
    `date: ${date} ${time}`,
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    `thought_module: ${thoughtModule}`,
  ];
  if (sourceChannel !== 'telegram') {
    lines.push(`source_channel: ${sourceChannel}`);
  }
  lines.push(
    `telegram_message_id: ${thought.telegramMessageId ?? ''}`,
    `telegram_chat_id: ${thought.telegramChatId ?? ''}`,
  );
  if (Array.isArray(thought.imageRefs) && thought.imageRefs.length > 0) {
    lines.push('photos:');
    for (const photoPath of thought.imageRefs) {
      lines.push(`  - ${photoPath}`);
    }
  }
  lines.push('---', '', String(thought.body ?? '').trim(), '');
  return lines.join('\n');
}

function normalizeThoughtSourceChannel(value) {
  return String(value ?? '').trim() === 'feishu' ? 'feishu' : 'telegram';
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
