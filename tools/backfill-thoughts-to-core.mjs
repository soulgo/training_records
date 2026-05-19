import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import frontMatter from 'hexo-front-matter';
import pg from 'pg';

import { resolveTrainingCoreConfig } from './training-db-core.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function backfillThoughtsToCore(options = {}) {
  const activeRootDir = options.rootDir ?? rootDir;
  const thoughtsDir = options.thoughtsDir ?? path.join(activeRootDir, 'source', '_posts');
  const env = options.env ?? process.env;
  const config = resolveTrainingCoreConfig(env);
  if (!config.enabled || !config.url) {
    return {
      status: 'skipped',
      reason: !config.enabled ? 'disabled' : 'missing_url',
      importedCount: 0,
    };
  }

  const createClient =
    options.createClient ??
    ((dbConfig) =>
      new Client({
        connectionString: dbConfig.url,
        connectionTimeoutMillis: dbConfig.timeoutMs,
        application_name: dbConfig.appName,
      }));
  const client = createClient(config);
  const processedAt = options.processedAt ?? new Date();
  const thoughtFiles = (await readDirRecursive(thoughtsDir))
    .filter((filePath) => filePath.endsWith('.md'))
    .filter((filePath) => filePath.includes('-telegram-thought-'))
    .sort((left, right) => left.localeCompare(right));

  let transactionStarted = false;
  let importedCount = 0;
  let skippedCount = 0;

  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    for (const postPath of thoughtFiles) {
      const raw = await readFile(postPath, 'utf8');
      const parsed = frontMatter.parse(raw);
      const thought = normalizeThoughtMarkdown(parsed, postPath, activeRootDir);
      if (!thought) {
        skippedCount++;
        continue;
      }

      await upsertThoughtFromMarkdown(client, thought, processedAt);
      importedCount++;
    }

    await client.query('COMMIT');
    transactionStarted = false;

    return {
      status: 'stored',
      importedCount,
      skippedCount,
      scannedCount: thoughtFiles.length,
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    await client.end();
  }
}

async function upsertThoughtFromMarkdown(client, thought, processedAt) {
  await client.query(
    `
      insert into core.thought (
        telegram_message_id,
        telegram_chat_id,
        source_batch_id,
        command,
        body,
        tags_json,
        message_date_unix,
        markdown_path,
        image_refs_json,
        status,
        deleted_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, 'active', null, $10)
      on conflict (telegram_message_id) do update set
        telegram_chat_id = coalesce(excluded.telegram_chat_id, core.thought.telegram_chat_id),
        source_batch_id = coalesce(excluded.source_batch_id, core.thought.source_batch_id),
        command = excluded.command,
        body = excluded.body,
        tags_json = excluded.tags_json,
        message_date_unix = coalesce(excluded.message_date_unix, core.thought.message_date_unix),
        markdown_path = excluded.markdown_path,
        image_refs_json = excluded.image_refs_json,
        status = excluded.status,
        deleted_at = null,
        updated_at = excluded.updated_at
    `,
    [
      thought.telegramMessageId,
      thought.telegramChatId,
      thought.sourceBatchId,
      '/thought',
      thought.body,
      JSON.stringify(thought.tags),
      thought.messageDateUnix,
      thought.markdownPath,
      JSON.stringify(thought.imageRefs),
      processedAt.toISOString(),
    ],
  );
}

function normalizeThoughtMarkdown(parsed, postPath, activeRootDir) {
  const { _content = '', ...frontMatterData } = parsed ?? {};
  const telegramMessageId = parsePositiveInteger(frontMatterData.telegram_message_id);
  if (!telegramMessageId) {
    return null;
  }

  const body = String(_content ?? '').trim();
  if (!body) {
    return null;
  }

  const telegramChatId = parseBigIntValue(frontMatterData.telegram_chat_id);
  const tags = Array.isArray(frontMatterData.tags) && frontMatterData.tags.length > 0
    ? frontMatterData.tags
    : ['训练', '随想', 'Telegram'];
  const imageRefs = Array.isArray(frontMatterData.photos) ? frontMatterData.photos : [];
  const markdownPath = normalizePath(path.relative(activeRootDir, postPath));

  return {
    telegramMessageId,
    telegramChatId,
    sourceBatchId: null,
    body,
    tags,
    messageDateUnix: parseThoughtDateUnix(frontMatterData.date),
    markdownPath,
    imageRefs,
  };
}

async function readDirRecursive(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    const nextPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await readDirRecursive(nextPath)));
    } else {
      result.push(nextPath);
    }
  }

  return result;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseBigIntValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseThoughtDateUnix(value) {
  if (!value) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const localDateTime = text.match(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/u,
  );
  const parsed = new Date(
    localDateTime ? `${text.replace(' ', 'T')}+08:00` : text,
  );

  const time = parsed.getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await backfillThoughtsToCore();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
